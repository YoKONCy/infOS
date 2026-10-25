import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDrizzleConnection,
  closeDrizzleConnection,
  type DrizzleDb,
} from '@infos/backend/database'
import { ConversationQueueRepository } from '@infos/backend/repositories/conversationQueue.repo'
import { conversationQueueItems, threadMessages } from '@infos/backend/database/schema'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let db: DrizzleDb
let repo: ConversationQueueRepository
const temporaryRoot = fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))
const temporaryDirectories: string[] = []
const input = (content: string) => ({ threadId: 't', agentId: 'pero', content })
beforeEach(() => {
  db = createDrizzleConnection(':memory:')
  repo = new ConversationQueueRepository(db)
})
afterEach(() => {
  closeDrizzleConnection(db)
  for (const directory of temporaryDirectories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(temporaryRoot))
      throw new Error('测试清理路径超出 TEMP 目录')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('消息队列持久派发与恢复', () => {
  it('任务结果按稳定编号只入队一次，不能编辑成用户消息', () => {
    const event = {
      ...input('后台结果'),
      taskResultEvent: { deliveryId: 'delivery', taskId: 'task' },
    }
    repo.enqueue('task-result:delivery', event)
    repo.enqueue('task-result:delivery', event)
    const [entry] = repo.snapshot('t').items
    expect(repo.snapshot('t').items).toHaveLength(1)
    expect(() => repo.mutate('t', entry!.id, entry!.revision, { content: '改写指令' })).toThrow(
      '任务交付事件不能改写',
    )
    repo.mutate('t', entry!.id, entry!.revision, { cancel: true })
    expect(repo.get(entry!.id)?.state).toBe('cancelled')
    expect(db.select().from(threadMessages).all()).toEqual([])
  })
  it('重开数据库只保留未发送消息，中断条目不能重新派发或生成用户消息', () => {
    closeDrizzleConnection(db)
    mkdirSync(temporaryRoot, { recursive: true })
    const directory = mkdtempSync(join(temporaryRoot, 'conversation-queue-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'queue.db')
    db = createDrizzleConnection(databasePath)
    repo = new ConversationQueueRepository(db)
    repo.enqueue('disk', input('已确认入队的请求'))
    repo.claim('t')
    repo.enqueue('pending', input('用户原文待发送'))
    closeDrizzleConnection(db)
    db = createDrizzleConnection(databasePath)
    repo = new ConversationQueueRepository(db)
    repo.recover()
    expect(repo.snapshot('t')).toMatchObject({
      paused: true,
      items: [{ id: 'pending', state: 'queued', input: { content: '用户原文待发送' } }],
    })
    expect(repo.get('disk')?.state).toBe('interrupted')
    repo.pause('t', false)
    expect(repo.claim('t')?.id).toBe('pending')
    expect(db.select().from(threadMessages).all()).toEqual([])
  })
  it('相同提交身份只入队一次；确认、领取、结算互相隔离', () => {
    repo.enqueue('a', input('第一条'))
    repo.enqueue('a', input('网络重试'))
    repo.enqueue('b', input('第二条'))
    expect(repo.snapshot('t').items.map((item) => item.input.content)).toEqual(['第一条', '第二条'])
    expect(repo.claim('t')?.id).toBe('a')
    expect(repo.claim('t')).toBeUndefined()
    repo.settle('a', 'completed')
    expect(repo.claim('t')?.id).toBe('b')
    expect(db.select().from(threadMessages).all()).toEqual([])
  })

  it('调序使用版本校验；立即提交优先，但暂停后不会偷偷执行', () => {
    const a = repo.enqueue('a', input('第一条'))
    const b = repo.enqueue('b', input('第二条'))
    repo.reorder('t', [
      { id: b.id, revision: b.revision },
      { id: a.id, revision: a.revision },
    ])
    expect(() => repo.mutate('t', a.id, a.revision, { content: '过期编辑' })).toThrow('另一客户端')
    repo.mutate('t', a.id, repo.get(a.id)!.revision, { immediate: true })
    expect(repo.snapshot('t').items[0]?.id).toBe(a.id)
    repo.pause('t', true)
    expect(repo.claim('t')).toBeUndefined()
    expect(repo.get(a.id)?.immediate).toBe(false)
  })

  it('重新创建仓储后保留消息，并将执行中断项冻结，绝不自动重新派发', () => {
    repo.enqueue('a', input('可能已经写入过文件'))
    repo.enqueue('b', input('下一条'))
    repo.claim('t')
    const restored = new ConversationQueueRepository(db)
    restored.recover()
    expect(restored.snapshot('t')).toMatchObject({
      paused: true,
      items: [{ id: 'b', state: 'queued' }],
    })
    expect(restored.get('a')?.state).toBe('interrupted')
    expect(restored.claim('t')).toBeUndefined()
  })

  it('停用旧版未发送的合成续接项并清除检查点，不生成新的消息对', () => {
    repo.enqueue('a:continue', input('旧版本合成的续接提示词'))
    db.update(conversationQueueItems)
      .set({ checkpointJson: '[{"role":"tool","content":"旧结果"}]' })
      .run()
    repo.recover()
    expect(repo.snapshot('t').items).toEqual([])
    expect(repo.get('a:continue')?.state).toBe('cancelled')
    expect(db.select().from(conversationQueueItems).get()?.checkpointJson).toBeNull()
    repo.pause('t', false)
    expect(repo.claim('t')).toBeUndefined()
    expect(db.select().from(threadMessages).all()).toEqual([])
  })

  it('旧回合结束后用户可正常发送原文，不复制旧输入或新建合成续接项', () => {
    repo.enqueue('a', input('上一条消息'))
    repo.claim('t')
    repo.settle('a', 'interrupted')
    repo.pause('t', true)
    repo.enqueue('b', input('用户自己发出的后续指令'))
    expect(repo.snapshot('t').paused).toBe(false)
    expect(repo.claim('t')).toMatchObject({ id: 'b', input: { content: '用户自己发出的后续指令' } })
    expect(repo.get('a')?.state).toBe('interrupted')
    expect(db.select().from(conversationQueueItems).all()).toHaveLength(2)
  })

  it('历史清除撤销恢复副本与待发送内容，不能从旧检查点重新注入', () => {
    repo.enqueue('a', input('不能重新出现的消息'))
    repo.claim('t')
    db.update(conversationQueueItems)
      .set({ checkpointJson: '[{"role":"user","content":"历史内容"}]' })
      .run()
    repo.historyChanged('t', true)
    expect(repo.snapshot('t').items).toEqual([])
    const row = db
      .select()
      .from(conversationQueueItems)
      .where(eq(conversationQueueItems.id, 'a'))
      .get()!
    expect(row.checkpointJson).toBeNull()
    expect(row.inputJson).not.toContain('不能重新出现')
  })

  it('退回编辑原子退出派发队列，重开仓储仍保留原文、附件和工作区材料', () => {
    repo.enqueue('edit', {
      ...input('待编辑原文'),
      attachmentIds: ['file'],
      imageMode: 'native',
      workspaceContext: { filePath: 'index.html', fileHash: 'hash' },
    })
    const queued = repo.get('edit')!
    repo.mutate('t', queued.id, queued.revision, { draft: true })
    const restored = new ConversationQueueRepository(db)
    restored.recover()
    expect(restored.snapshot('t').items).toEqual([])
    expect(restored.snapshot('t').drafts).toMatchObject([
      {
        id: 'edit',
        state: 'draft',
        input: {
          content: '待编辑原文',
          attachmentIds: ['file'],
          workspaceContext: { fileHash: 'hash' },
        },
      },
    ])
    expect(restored.referencesAttachment('file')).toBe(true)
    expect(restored.claim('t')).toBeUndefined()
    const draft = restored.get('edit')!
    restored.mutate('t', draft.id, draft.revision, { cancel: true })
    expect(restored.snapshot('t').drafts).toEqual([])
    expect(restored.referencesAttachment('file')).toBe(false)
    expect(db.select().from(threadMessages).all()).toEqual([])
  })

  it('执行器先领取时不能退回编辑，失败操作不改变已有执行状态', () => {
    repo.enqueue('race', input('执行中的请求'))
    const original = repo.get('race')!
    repo.claim('t')
    expect(() => repo.mutate('t', original.id, original.revision, { draft: true })).toThrow()
    expect(repo.get('race')?.state).toBe('running')
  })

  it('删除回滚撤销旧分支的待发与未接收草稿，其他会话不受影响，旧版本不能重新提交', () => {
    repo.enqueue('pending', input('旧分支待发'))
    repo.enqueue('draft', input('旧分支草稿'))
    const previous = repo.get('pending')!
    const draft = repo.get('draft')!
    repo.mutate('t', draft.id, draft.revision, { draft: true })
    repo.enqueue('other', { threadId: 'other', content: '另一个会话' })
    repo.historyChanged('t', false, true)
    repo.pause('t', false)
    expect(repo.snapshot('t').items).toEqual([])
    expect(repo.snapshot('t').drafts).toEqual([])
    expect(repo.claim('t')).toBeUndefined()
    expect(repo.get('pending')?.state).toBe('cancelled')
    expect(() => repo.mutate('t', previous.id, previous.revision, { immediate: true })).toThrow()
    expect(repo.snapshot('other').items).toHaveLength(1)
  })
})
