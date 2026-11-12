import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDrizzleConnection, closeDrizzleConnection } from '../../../src/database'
import { agentLocations, groupChatRooms, groupChatMessages, kernelOutboxEvents } from '../../../src/database/schema'
import { ThreadRepository } from '../../../src/repositories/thread.repo'
import { ConfigRepository } from '../../../src/repositories/config.repo'
import { PetStateService } from '../../../src/services/agent/petStateService'
import { GroupChatService } from '../../../src/services/stronghold/groupChatService'
import { SillyTavernVariableStore } from '../../../src/services/prompt/sillyTavernVariables'
import { DEFAULT_CHARACTER_STATE } from '@infos/shared'
import { RuntimeStateService } from '../../../src/services/runtime/runtimeStateService'
import { StrongholdRoundService } from '../../../src/services/stronghold/strongholdRoundService'
import { ResetService } from '../../../src/services/maintenance/resetService'
import { FlowStateRepository } from '../../../src/repositories/flowState.repo'

let db: ReturnType<typeof createDrizzleConnection>
let threads: ThreadRepository
beforeEach(() => {
  db = createDrizzleConnection(':memory:')
  threads = new ThreadRepository(db)
})
afterEach(() => closeDrizzleConnection(db))

describe('主侧会话的数据生命周期', () => {
  it.each(['prepare', 'execute'] as const)('据点在 %s 期间新增的回应接收者持续保留', async (stage) => {
    db.insert(agentLocations).values([{ agentId: 'pero', roomId: 'living' }, { agentId: 'nana', roomId: 'living' }]).run()
    const chat = new GroupChatService(db, () => true)
    const message = await chat.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '大家聊聊', pairId: 'round', requestReplies: true })
    let started!: () => void
    let proceed!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { proceed = resolve })
    const executed: string[] = []
    const rounds = new StrongholdRoundService(
      chat,
      { getRoomAgents: async () => ['pero', 'nana'] } as never,
      { decideNextTurn: async () => {
        if (stage === 'prepare') { started(); await gate }
        return { agentIds: ['pero'], reason: '接续伙伴' }
      } } as never,
      { execute: async (_room: string, agentId: string) => {
        executed.push(agentId)
        if (stage === 'execute' && agentId === 'pero') { started(); await gate }
        return { summonedAgentIds: [] }
      } } as never,
      { listAgents: () => ['pero', 'nana'].map((id) => ({ id, isEnabled: true })) } as never,
      { getThread: (id: string) => threads.getThread(id) } as never,
      { broadcast: async () => {} } as never,
    )
    const running = rounds.kick(message.id)
    await entered
    try {
      expect(await chat.requestRepliesTo(message.id, ['nana'], false)).toBe(true)
    } finally {
      proceed()
      await running
    }
    expect(executed).toEqual(stage === 'prepare' ? ['nana'] : ['pero', 'nana'])
    expect(chat.getReplyIntent(message.id)?.intent).toMatchObject({ status: 'completed', completed: executed, queue: [] })
  })

  it('逻辑导入降为侧线的旧亲历保留归档，新据点只读取当前主线', async () => {
    const original = threads.ensureMainThread('pero')
    db.insert(agentLocations).values({ agentId: 'pero', roomId: 'living' }).run()
    const chat = new GroupChatService(db, () => true)
    const old = await chat.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '归档经历', pairId: 'old' })
    db.$client.prepare("UPDATE threads SET thread_kind='side' WHERE id=?").run(original.id)
    const current = threads.ensureMainThread('pero')

    expect(await chat.getVisibleHistoryPairs('pero')).toEqual([])
    expect(await chat.requestRepliesTo(old.id, ['pero'])).toBe(false)
    await chat.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '当前经历', pairId: 'new' })
    expect((await chat.getVisibleHistoryPairs('pero')).map((item) => item.content)).toEqual(['当前经历'])
    expect((await threads.queryExperiences(current.id)).map((item) => item.content)).toEqual(['当前经历'])
    expect((await threads.queryExperiences(original.id)).map((item) => item.content)).toEqual(['归档经历'])
    expect((await chat.getHistory('living')).map((item) => item.content)).toEqual(['归档经历', '当前经历'])
  })

  it('同一交流的其他消息仍有效时，已撤回来源阻止迟到回复提交', async () => {
    const main = threads.ensureMainThread('pero')
    const chat = new GroupChatService(db, () => true)
    await chat.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '共同话题', pairId: 'round' })
    const source = await chat.sendMessage({ roomId: 'living', senderId: 'nana', role: 'assistant', content: '待撤回的问题', pairId: 'round' })
    db.update(groupChatMessages).set({ status: 'deleted' }).where(eq(groupChatMessages.id, source.id)).run()

    await expect(chat.sendMessage({ roomId: 'living', senderId: 'pero', role: 'assistant', content: '迟到回复', pairId: 'round',
      execution: { threadId: main.id, generation: 1, sourcePairId: 'round', sourceMessageId: source.id },
    })).rejects.toThrow('STRONGHOLD_SOURCE_WITHDRAWN')
    expect((await chat.getHistory('living')).map((item) => item.content)).toEqual(['共同话题'])
  })

  it('角色进入其他据点后，模型历史按当前房间选择自己的亲历', async () => {
    threads.ensureMainThread('pero')
    db.insert(groupChatRooms).values([
      { id: 'living', name: '客厅', creatorId: 'system' },
      { id: 'study', name: '书房', creatorId: 'system' },
    ]).run()
    db.insert(agentLocations).values({ agentId: 'pero', roomId: 'living' }).run()
    const chat = new GroupChatService(db, (id) => id === 'pero')
    await chat.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '客厅的话题' })
    db.update(agentLocations).set({ roomId: 'study' }).where(eq(agentLocations.agentId, 'pero')).run()
    await chat.sendMessage({ roomId: 'study', senderId: 'user', role: 'user', content: '书房的话题' })
    expect((await chat.getVisibleHistoryByBudget('pero', 16384, 'living')).map((message) => message.content))
      .toEqual(['客厅的话题'])
    expect((await chat.getVisibleHistoryByBudget('pero', 16384, 'study')).map((message) => message.content))
      .toEqual(['书房的话题'])
  })

  it('全量清空记录保留主线和共享状态，旧变量提交失效并保留全局值', async () => {
    const main = threads.ensureMainThread('pero')
    await threads.createThread({ id: 'side', agentId: 'pero', channel: 'desktop' })
    await threads.appendMessage({ threadId: main.id, role: 'user', content: '当前状态来源', pairId: 'state' })
    const states = new PetStateService(db)
    await states.update('pero', { mind: '继续读书' }, { threadId: main.id, pairId: 'state', generation: 1 })
    const variables = new SillyTavernVariableStore(new ConfigRepository(db))
    const scope = `desktop:pero:${main.id}`
    await variables.commit({ id: randomUUID(), scope, effects: {
      local: [{ name: 'scene', after: '客厅', write: true }],
      global: [{ name: 'nickname', after: '朋友', write: true }],
    } })
    const old = await variables.snapshot(scope)
    const reset = new ResetService(db)
    await variables.clearConversationScopes((configuration) => reset.clearLogs(configuration))
    expect(await threads.getThread(main.id)).toMatchObject({ generation: 2, messageCount: 0 })
    expect(await threads.getThread('side')).toBeUndefined()
    expect(await states.get('pero', main.id)).toMatchObject({ mind: '继续读书' })
    expect(await variables.snapshot(scope)).toMatchObject({ local: {}, global: { nickname: '朋友' } })
    await expect(variables.commit({ id: randomUUID(), scope, epoch: old.epoch, scopeEpoch: old.scopeEpoch,
      effects: { local: [], global: [{ name: 'nickname', before: '朋友', after: '旧执行', write: true }] },
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('据点回复意图跨服务重建继续投递，主线重置使尚未执行的旧目标失效', async () => {
    const main = threads.ensureMainThread('pero')
    db.insert(groupChatRooms).values({ id: 'living', name: '客厅', creatorId: 'system' }).run()
    db.insert(agentLocations).values({ agentId: 'pero', roomId: 'living' }).run()
    const chat = new GroupChatService(db, (id) => id === 'pero')
    let executions = 0
    const createRounds = () => new StrongholdRoundService(
      chat,
      { getRoomAgents: async () => ['pero'] } as never,
      { decideNextTurn: async () => ({ agentIds: ['pero'], reason: '提及角色' }) } as never,
      { execute: async (roomId: string, senderId: string, pairId: string) => {
        executions++
        await chat.sendMessage({ roomId, senderId, pairId, role: 'assistant', content: '恢复后的回复',
          execution: { threadId: main.id, generation: 1, sourcePairId: pairId },
        })
        return { summonedAgentIds: [] }
      } } as never,
      { listAgents: () => [{ id: 'pero', isEnabled: true }] } as never,
      { getThread: (id: string) => threads.getThread(id) } as never,
      { broadcast: async () => {} } as never,
    )
    const message = await chat.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '请回应', pairId: 'wake', requestReplies: true })
    await createRounds().prepare(message.id)
    const restored = createRounds()
    await restored.kick(message.id)
    await restored.kick(message.id)
    expect(executions).toBe(1)
    expect(chat.getReplyIntent(message.id)?.intent).toMatchObject({ status: 'completed', completed: ['pero'] })
    expect((await chat.getHistory('living')).map((item) => item.content)).toEqual(['请回应', '恢复后的回复'])
    const stale = await chat.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '旧代次请求', pairId: 'stale', requestReplies: true })
    await threads.resetMainThread(main.id)
    await createRounds().kick(stale.id)
    expect(executions).toBe(1)
    expect(chat.getReplyIntent(stale.id)?.intent.status).toBe('completed')
  })

  it('旧执行的退出回调只释放自己的运行占用', () => {
    const runtime = new RuntimeStateService()
    runtime.registerTask('main', 'pero')
    const oldSignal = runtime.getAbortSignal('main')!
    runtime.cancelTask('main')
    runtime.unregisterTask('main')
    runtime.registerTask('main', 'pero')
    const freshSignal = runtime.getAbortSignal('main')!
    try {
      runtime.unregisterTask('main', oldSignal)
      expect(runtime.getAbortSignal('main')).toBe(freshSignal)
      expect(runtime.listActiveTasks()).toMatchObject([{ threadId: 'main', state: 'running' }])
    } finally {
      runtime.unregisterTask('main', freshSignal)
    }
  })

  it('同一场景回复重复投递只保留一条公共消息和一组亲历', async () => {
    const main = threads.ensureMainThread('pero')
    db.insert(groupChatRooms).values({ id: 'living', name: '客厅', creatorId: 'system' }).run()
    const group = new GroupChatService(db, (id) => id === 'pero')
    const source = await group.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '你好', pairId: 'round' })
    const input = {
      roomId: 'living', senderId: 'pero', role: 'assistant' as const, content: '欢迎', pairId: 'round',
      execution: { threadId: main.id, generation: 1, sourcePairId: 'round' },
    }
    const first = await group.sendMessage(input)
    const repeated = await group.sendMessage({ ...input, content: '重复结果' })
    expect(repeated.id).toBe(first.id)
    expect(db.select().from(groupChatMessages).all().map((row) => row.content)).toEqual(['你好', '欢迎'])
    expect((await threads.queryExperiences(main.id)).map((item) => item.content)).toEqual(['欢迎'])
    expect(db.select().from(kernelOutboxEvents).all()).toHaveLength(2)
    await group.deleteMessagePair('living', source.id)
    await expect(group.sendMessage(input)).rejects.toThrow('STRONGHOLD_SOURCE_WITHDRAWN')
  })

  it('变量与主线代次一起重置，旧全局写入失效，新局部写入继续提交', async () => {
    const main = await threads.ensureMainThread('pero')
    const variables = new SillyTavernVariableStore(new ConfigRepository(db))
    const scope = `desktop:pero:${main.id}`
    await variables.commit({ id: randomUUID(), scope, effects: {
      local: [{ name: 'scene', after: '客厅', write: true }],
      global: [{ name: 'shared', after: '保留', write: true }],
    } })
    const previous = await variables.snapshot(scope)
    await variables.resetThread(main.id, (configuration) => threads.resetMainThread(main.id, configuration))
    await expect(variables.commit({ id: randomUUID(), scope, epoch: previous.epoch,
      scopeEpoch: previous.scopeEpoch, effects: { local: [], global: [{ name: 'shared', before: '保留', after: '旧执行覆盖', write: true }] },
    })).rejects.toMatchObject({ code: 'CONFLICT' })
    const fresh = await variables.snapshot(scope)
    expect(fresh).toMatchObject({ local: {}, global: { shared: '保留' }, scopeEpoch: 1 })
    await variables.commit({ id: randomUUID(), scope, epoch: fresh.epoch, scopeEpoch: fresh.scopeEpoch,
      effects: { local: [{ name: 'scene', after: '书房', write: true }], global: [] },
    })
    expect((await variables.snapshot(scope)).local).toEqual({ scene: '书房' })
    expect((await threads.getThread(main.id))?.generation).toBe(2)
  })

  it('共享状态按角色版本提交，撤回侧线贡献保留后续主线变更，重置保留持续状态', async () => {
    const main = await threads.ensureMainThread('pero')
    await threads.createThread({ id: 'side', agentId: 'pero', channel: 'desktop' })
    await threads.appendMessage({ threadId: 'side', role: 'user', content: '侧线', pairId: 'side-pair' })
    await threads.appendMessage({ threadId: main.id, role: 'user', content: '主线', pairId: 'main-pair' })
    const states = new PetStateService(db)
    const firstVersion = { revision: 0 }
    const secondVersion = { revision: 0 }
    await states.update('pero', { mood: '期待' }, { threadId: 'side', pairId: 'side-pair', generation: 1, characterStateVersion: firstVersion })
    await expect(states.update('pero', { mind: '写日记' }, { threadId: main.id, pairId: 'main-pair', generation: 1, characterStateVersion: secondVersion })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await states.get('pero', main.id))?.mind).toBe(DEFAULT_CHARACTER_STATE.mind)
    await states.update('pero', { mind: '写日记', commitments: '周末一起读书' }, { threadId: main.id, pairId: 'main-pair', generation: 1, characterStateVersion: secondVersion })
    expect(await states.get('pero', 'side')).toMatchObject({ mood: '期待', mind: '写日记' })
    await states.rollbackPairs('side', ['side-pair'])
    expect(await states.get('pero', main.id)).toMatchObject({ mood: DEFAULT_CHARACTER_STATE.mood, mind: '写日记' })
    await threads.resetMainThread(main.id)
    expect(await states.get('pero', main.id)).toMatchObject({ mind: '写日记', commitments: '周末一起读书' })
    await expect(states.update('pero', { mood: '旧执行' }, { threadId: main.id, pairId: 'main-pair', generation: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('同一轮中每条消息分别固定在场者，旁听经历重启可读，重置只切换自身经历代次', async () => {
    const pero = await threads.ensureMainThread('pero')
    const nana = await threads.ensureMainThread('nana')
    db.insert(groupChatRooms).values([
      { id: 'living', name: '客厅', creatorId: 'system' },
      { id: 'study', name: '书房', creatorId: 'system' },
    ]).run()
    db.insert(agentLocations).values([{ agentId: 'pero', roomId: 'living' }, { agentId: 'nana', roomId: 'living' }]).run()
    const group = new GroupChatService(db, (id) => ['pero', 'nana'].includes(id))
    await group.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '第一条', pairId: 'round' })
    db.update(agentLocations).set({ roomId: 'study' }).where(eq(agentLocations.agentId, 'nana')).run()
    await group.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '第二条', pairId: 'round' })
    expect((await threads.queryExperiences(pero.id)).map((item) => item.content)).toEqual(['第一条', '第二条'])
    expect((await threads.queryExperiences(nana.id)).map((item) => item.content)).toEqual(['第一条'])
    const restored = new GroupChatService(db, (id) => ['pero', 'nana'].includes(id))
    expect((await restored.getVisibleHistoryPairs('nana')).map((item) => item.content)).toEqual(['第一条'])
    const flow = new FlowStateRepository(db)
    await flow.save({ threadId: pero.id, agentId: 'pero', currentGoal: '整理客厅', generation: 1 })
    await flow.save({ threadId: nana.id, agentId: 'nana', currentGoal: '继续读书', generation: 1 })
    await threads.resetMainThread(pero.id)
    expect(await flow.get(pero.id, 'pero')).toBeNull()
    expect(await flow.get(nana.id, 'nana')).toMatchObject({ currentGoal: '继续读书' })
    expect(await threads.queryExperiences(pero.id)).toEqual([])
    expect((await threads.queryExperiences(nana.id)).map((item) => item.content)).toEqual(['第一条'])
    await group.sendMessage({ roomId: 'living', senderId: 'user', role: 'user', content: '新代次', pairId: 'new-round' })
    expect((await threads.queryExperiences(pero.id)).map((item) => item.content)).toEqual(['新代次'])
  })
})
