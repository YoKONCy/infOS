import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createDrizzleConnection,
  closeDrizzleConnection,
  type DrizzleDb,
} from '@infos/backend/database'
import { achievements, threadMessages } from '@infos/backend/database/schema'
import { ThreadRepository } from '@infos/backend/repositories/thread.repo'
import { AchievementRepository } from '@infos/backend/repositories/achievement.repo'

let db: DrizzleDb
let messages: ThreadRepository
let records: AchievementRepository
beforeEach(() => {
  db = createDrizzleConnection(':memory:')
  messages = new ThreadRepository(db)
  records = new AchievementRepository(db)
})
afterEach(() => closeDrizzleConnection(db))

describe('成就事实与 Steam 归属', () => {
  it('跨角色只保留首次回复的达成事实，配对客户端之间互相隔离', async () => {
    const first = await messages.appendMessage({
      threadId: 'first-thread',
      role: 'assistant',
      content: '你好，很高兴见到你。',
      agentId: 'pero',
      achievement: { subjectId: 'owner', id: 'fresh_start' },
    })
    await messages.appendMessage({
      threadId: 'second-thread',
      role: 'assistant',
      content: '欢迎回来。',
      agentId: 'penora',
      achievement: { subjectId: 'owner', id: 'fresh_start' },
    })
    expect(records.get('owner', 'fresh_start')?.sourceMessageId).toBe(first.id)
    expect(records.get('other-device', 'fresh_start')).toBeUndefined()
  })

  it('达成记录写入失败时一起回滚回复，不留下已回复却漏记成就的半状态', async () => {
    // 空身份违反非空约束，模拟同一事务内成就写入失败。
    await expect(
      messages.appendMessage({
        threadId: 'atomic-thread',
        role: 'assistant',
        content: '事务尚未提交。',
        achievement: { subjectId: null as never, id: 'fresh_start' },
      }),
    ).rejects.toThrow()
    const rows = db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.threadId, 'atomic-thread'))
      .all()
    expect(rows).toEqual([])
  })

  it('尚未达成不能认领，首次绑定后其他 Steam 账号不能覆盖或确认提交', async () => {
    const firstAccount = '76561198000000001'
    const otherAccount = '76561198000000002'
    expect(records.claimSteamAccount('owner', 'fresh_start', firstAccount)).toBe(false)
    await messages.appendMessage({
      threadId: 'thread',
      role: 'assistant',
      content: '你好。',
      achievement: { subjectId: 'owner', id: 'fresh_start' },
    })
    expect(records.claimSteamAccount('owner', 'fresh_start', firstAccount)).toBe(true)
    expect(records.claimSteamAccount('owner', 'fresh_start', otherAccount)).toBe(false)
    records.markSteamSubmitted('owner', 'fresh_start', otherAccount)
    expect(records.get('owner', 'fresh_start')?.steamSubmittedAt).toBeNull()
    records.markSteamSubmitted('owner', 'fresh_start', firstAccount)
    const receipt = db.select().from(achievements).get()!
    expect(receipt.steamAccountId).toBe(firstAccount)
    expect(receipt.steamSubmittedAt).toEqual(expect.any(String))
  })
})
