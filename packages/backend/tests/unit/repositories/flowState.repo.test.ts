import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flowStateRevisions } from '@infos/backend/database/schema'
import { FlowStateRepository } from '@infos/backend/repositories/flowState.repo'

let db: ReturnType<typeof createDrizzleConnection>

describe('FlowStateRepository 对话检查点回退', () => {
  beforeEach(() => {
    db = createDrizzleConnection(':memory:')
  })

  afterEach(() => closeDrizzleConnection(db))

  it('A 与 D 更新心流时，撤销 D 后恢复到 A 完成后的状态', async () => {
    const repo = new FlowStateRepository(db as never)

    await repo.save({
      threadId: 'thread-1',
      agentId: 'nana',
      pairId: 'A',
      currentGoal: '主持海龟汤',
      privateFacts: 'A 的汤底',
    })
    await repo.save({
      threadId: 'thread-1',
      agentId: 'nana',
      pairId: 'D',
      currentGoal: '继续主持并回应新线索',
      privateFacts: 'D 更新后的汤底进度',
    })

    await repo.rollbackPairs('thread-1', ['D'])

    expect(await repo.get('thread-1', 'nana')).toMatchObject({
      currentGoal: '主持海龟汤',
      privateFacts: 'A 的汤底',
    })
  })

  it('清空写入真实修订，并可按该轮次回退', async () => {
    const repo = new FlowStateRepository(db as never)
    await repo.save({
      threadId: 'thread-1',
      agentId: 'nana',
      pairId: 'A',
      currentGoal: '目标',
      privateFacts: '事实',
    })
    await repo.clear('thread-1', 'nana', 'D')
    expect(await repo.get('thread-1', 'nana')).toMatchObject({ currentGoal: '', privateFacts: '' })
    expect(await db.select().from(flowStateRevisions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pairId: 'D',
          beforeCurrentGoal: '目标',
          beforePrivateFacts: '事实',
          afterCurrentGoal: '',
          afterPrivateFacts: '',
        }),
      ]),
    )
    await repo.rollbackPairs('thread-1', ['D'])
    expect(await repo.get('thread-1', 'nana')).toMatchObject({
      currentGoal: '目标',
      privateFacts: '事实',
    })
  })

  it('同一待撤销轮次多次更新时恢复到该轮开始前的状态', async () => {
    const repo = new FlowStateRepository(db as never)
    await repo.save({
      threadId: 'thread-1',
      agentId: 'nana',
      pairId: 'A',
      currentGoal: 'A 目标',
      privateFacts: 'A 事实',
    })
    await repo.save({
      threadId: 'thread-1',
      agentId: 'nana',
      pairId: 'D',
      currentGoal: 'D 第一次',
      privateFacts: 'A 事实',
    })
    await repo.save({
      threadId: 'thread-1',
      agentId: 'nana',
      pairId: 'D',
      currentGoal: 'D 第二次',
      privateFacts: 'D 事实',
    })

    await repo.rollbackPairs('thread-1', ['D'])

    expect(await repo.get('thread-1', 'nana')).toMatchObject({
      currentGoal: 'A 目标',
      privateFacts: 'A 事实',
    })
  })

  it('撤回据点贡献时重放后续私聊补丁，保留显式重复设置', async () => {
    const repo = new FlowStateRepository(db)
    await repo.save({ threadId: 'main-1', agentId: 'pero', pairId: 'initial', currentGoal: '准备出门', privateFacts: '先看天气' })
    await repo.save({ threadId: 'main-1', agentId: 'pero', pairId: 'room-1', currentGoal: '和 Nana 商量出游', privateFacts: '可能下雨' })
    await repo.save({ threadId: 'main-1', agentId: 'pero', pairId: 'private-1', currentGoal: '和 Nana 商量出游' })
    await repo.rollbackPairs('main-1', ['room-1'])
    expect(await repo.get('main-1', 'pero')).toMatchObject({ currentGoal: '和 Nana 商量出游', privateFacts: '先看天气' })
    await repo.rollbackPairs('main-1', ['private-1'])
    expect(await repo.get('main-1', 'pero')).toMatchObject({ currentGoal: '准备出门', privateFacts: '先看天气' })
  })
})
