import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { BackupRow, StrongholdActivity, StrongholdInvitation, StrongholdWatch } from '@infos/shared'
import { createDrizzleConnection, closeDrizzleConnection } from '../../../src/database'
import { agentLocations, groupChatRooms, groupChatMessages, strongholdRooms } from '../../../src/database/schema'
import { ThreadRepository } from '../../../src/repositories/thread.repo'
import { GroupChatService } from '../../../src/services/stronghold/groupChatService'
import { StrongholdLifeService, type LifeScope } from '../../../src/services/stronghold/strongholdLifeService'
import { ResetService } from '../../../src/services/maintenance/resetService'
import { mergeBackupRecords } from '../../../src/services/backup/backupRecords'
import { StrongholdService } from '../../../src/services/stronghold/strongholdService'
import { StrongholdLifeContextProvider } from '../../../src/services/stronghold/strongholdLifeContext'
import { StrongholdRoundService } from '../../../src/services/stronghold/strongholdRoundService'

let db: ReturnType<typeof createDrizzleConnection>
let threads: ThreadRepository
let chat: GroupChatService
let life: StrongholdLifeService
let autonomous: Set<string>
const roomId = 'living'

function scope(agentId: string, pairId = 'operation'): LifeScope {
  return { ...life.ref(agentId)!, roomId, pairId }
}
function createActivity(agentId = 'pero', operation = 'create'): StrongholdActivity {
  return life.activities.execute(scope(agentId), operation, { action: 'create', title: '一起读书' }) as StrongholdActivity
}
function send(senderId: string, content: string, purpose?: string, addressedTo?: string[]) {
  return chat.commitMessage({ roomId, senderId, role: senderId === 'user' ? 'user' : 'assistant', content,
    pairId: `message:${content}`, metadata: purpose ? { lifeResult: { state: 'conversing', purpose, addressedTo } } : {} })
}
function reply(source: ReturnType<typeof send>, senderId: string, content: string, purpose: string, addressedTo?: string[], summon = false) {
  const ref = life.ref(senderId)!
  return chat.commitMessage({ roomId, senderId, content, role: 'assistant', pairId: source.pairId!,
    execution: { threadId: ref.threadId, generation: ref.generation, sourcePairId: source.pairId!, sourceMessageId: source.id },
    mentions: summon ? addressedTo : [], requestReplies: summon,
    metadata: { lifeResult: { state: 'conversing', purpose, addressedTo } } })
}
function settle(source: ReturnType<typeof send>, agentId: string) {
  const intent = chat.getReplyIntent(source.id)!.intent
  chat.saveReplyIntent(source.id, { ...intent, queue: [], completed: [...intent.completed, agentId], status: 'completed' })
}
function bindLife() {
  chat.setLifeLifecycle((message) => life.onMessage(message),
    (message, agentId, options) => life.admitReply(message, agentId, options),
    (message) => life.canResumeReply(message))
}
beforeEach(() => {
  db = createDrizzleConnection(':memory:')
  threads = new ThreadRepository(db)
  autonomous = new Set(['pero', 'nana', 'keromi'])
  db.insert(strongholdRooms).values({ id: roomId, name: '客厅', facilityId: 1 }).run()
  db.insert(groupChatRooms).values({ id: roomId, name: '客厅', creatorId: 'system' }).run()
  for (const agentId of autonomous) {
    threads.ensureMainThread(agentId)
    db.insert(agentLocations).values({ agentId, roomId }).run()
  }
  chat = new GroupChatService(db, () => true)
  life = new StrongholdLifeService(db, chat, () => true, (id) => autonomous.has(id))
  bindLife()
})
afterEach(() => { vi.restoreAllMocks(); closeDrizzleConnection(db) })

describe('据点生活闭环', () => {
  it('本次发言检索只带直接关联活动，其他关注与当前目标由各自触发来源选择', () => {
    const activity = createActivity()
    life.activities.execute(scope('nana'), 'other-activity', { action: 'create', title: '研究晚餐菜单' })
    life.commitParticipation(scope('pero'), { state: 'available', activityId: activity.id })
    life.watches.execute(scope('pero'), 'unmatched-watch', {
      action: 'set', intent: '留意晚餐菜单', condition: { kind: 'environment', key: 'music' },
    })
    const unrelated = send('user', '窗外好像下雨了')
    expect(life.retrievalQuery('pero', roomId, unrelated.id, '准备晚饭')).toBe('user\n窗外好像下雨了')
    const source = chat.commitMessage({ roomId, senderId: 'pero', role: 'assistant', content: '读到小猫回家的那一段了',
      metadata: { lifeResult: { state: 'conversing', activityId: activity.id } } })
    expect(life.retrievalQuery('nana', roomId, source.id)).toBe('一起读书\npero\n读到小猫回家的那一段了')
  })

  it('关注检索合并本次命中意图和已领取事件，执行中新到达的内容留给后续', () => {
    const source = send('user', '留意娜娜说的话和灯光变化')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    life.watches.execute(owner, 'message-query', {
      action: 'set', intent: '听娜娜讲昨晚的梦', continuous: true, condition: { kind: 'message', actorId: 'nana' },
    })
    life.watches.execute(owner, 'light-query', {
      action: 'set', intent: '看看灯光是否适合读书', condition: { kind: 'environment', key: 'light' },
    })
    send('nana', '昨晚梦到了海边的小猫')
    const changed = life.emit(scope('user'), 'query-light', {
      kind: 'environment', actorId: 'user', key: 'light', details: { before: '白色', after: '暖黄', text: '调整了房间环境' },
    })
    life.recover()
    life.watches.beginProcessing({ ...owner, sourceMessageId: changed.id })
    send('nana', '现在想聊晚餐')
    expect(life.retrievalQuery('pero', roomId, changed.id).split('\n')).toEqual([
      '听娜娜讲昨晚的梦', '看看灯光是否适合读书', 'user', 'light', '白色', '暖黄', 'nana', '昨晚梦到了海边的小猫',
    ])
  })

  it('到时关注使用实际意图检索，空闲执行按当前目标与本人有效活动检索', () => {
    const source = send('user', '过会儿提醒我休息')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    life.watches.execute(owner, 'time-query', { action: 'set', intent: '提醒主人休息', condition: { kind: 'time', at: Date.now() - 1000 } })
    life.recover()
    const due = life.watches.list(owner, roomId)[0]!.requestMessageId!
    expect(life.retrievalQuery('pero', roomId, due)).toBe('提醒主人休息')
    expect(life.retrievalQuery('pero', roomId)).toBe('')
    const activity = createActivity()
    life.activities.execute(scope('nana'), 'unrelated-idle', { action: 'create', title: '研究晚餐菜单' })
    expect(life.retrievalQuery('pero', roomId, undefined, '和伙伴分享小猫的故事')).toBe('和伙伴分享小猫的故事\n一起读书')
    life.activities.execute(scope('pero'), 'end-idle', { action: 'end', id: activity.id, revision: activity.revision })
    expect(life.retrievalQuery('pero', roomId)).toBe('')
  })

  it('回应向原发起者澄清后结算，新问题及传唤进入空闲等待', async () => {
    const opening = send('pero', '要听故事吗', 'question', ['nana'])
    const clarification = reply(opening, 'nana', '讲的是哪一段', 'question', ['pero'])
    expect(chat.getReplyIntent(clarification.id)?.intent).toMatchObject({ queue: ['pero'], responseContexts: {
      pero: { phase: 'settlement', openingMessageId: opening.id, initiatorId: 'pero' },
    } })
    const nextTopic = reply(clarification, 'pero', '是小猫找家的故事，你还想听另一个吗', 'question', ['nana'], true)
    expect(chat.getReplyIntent(nextTopic.id)?.intent).toMatchObject({ status: 'pending', queue: [], deferredAgentIds: ['nana'] })
    expect(chat.pendingReplyIds()).not.toContain(nextTopic.id)
    expect(await chat.requestRepliesTo(nextTopic.id, ['nana'], true)).toBe(true)
    expect(chat.getReplyIntent(nextTopic.id)?.intent.queue).toEqual([])
    settle(opening, 'nana')
    settle(clarification, 'pero')
    life.recover()
    expect(life.snapshot(roomId).exchanges).toMatchObject([{ status: 'quiet' }])
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    life = new StrongholdLifeService(db, chat, () => true, (id) => autonomous.has(id))
    bindLife()
    life.recover()
    expect(life.snapshot(roomId).exchanges).toEqual([])
    expect(chat.pendingReplyIds()).toEqual([])
    expect(chat.hasDeferredReply(roomId, 'nana')).toBe(true)
  })

  it('回应中的独立话题等待正常空闲机会，同一请求只领取一次', async () => {
    const opening = send('pero', '今天读到一个故事', 'share', ['nana'])
    const nextTopic = reply(opening, 'nana', '下次想和可洛米聊聊画画', 'share', ['keromi'])
    settle(opening, 'nana')
    const executed: number[] = []
    const rounds = new StrongholdRoundService(chat,
      { getRoomAgents: async () => ['pero', 'nana', 'keromi'] } as never,
      { decideNextTurn: async () => ({ agentIds: [], reason: '' }) } as never,
      { execute: async (_room: string, agentId: string, _pair: string, options: { sourceMessageId: number }) => {
        executed.push(options.sourceMessageId)
        const message = reply(chat.getMessageEvent(options.sourceMessageId)!, agentId, '我想画一只小猫', 'answer')
        return { summonedAgentIds: [], reply: message.content }
      } } as never,
      { listAgents: () => ['pero', 'nana', 'keromi'].map((id) => ({ id, isEnabled: true })) } as never,
      { getThread: (id: string) => threads.getThread(id) } as never,
      { broadcast: async () => {} } as never, () => true)
    await rounds.kick(nextTopic.id)
    await rounds.runIdle(roomId, 'keromi', new AbortController().signal)
    expect(executed).toEqual([])
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    life.recover()
    expect(await rounds.runIdle(roomId, 'keromi', new AbortController().signal)).toEqual({ reply: '我想画一只小猫' })
    expect(executed).toEqual([nextTopic.id])
    expect(chat.claimDeferredReply(roomId, 'keromi')).toBeUndefined()
    expect(chat.getReplyIntent(nextTopic.id)?.intent).toMatchObject({ status: 'completed', completed: ['keromi'], deferredAgentIds: [] })
  })

  it.each(['pero', 'keromi'])('待接话的来源或接收者 %s 重置后，恢复结算旧请求', async (agentId) => {
    const opening = send('nana', '看过这个故事吗', 'question', ['pero'])
    const nextTopic = reply(opening, 'pero', '可洛米想聊别的故事吗', 'question', ['keromi'])
    settle(opening, 'pero')
    expect(chat.hasDeferredReply(roomId, 'keromi')).toBe(true)
    await threads.resetMainThread(life.ref(agentId)!.threadId)
    life.recover()
    expect(chat.getReplyIntent(nextTopic.id)?.intent).toMatchObject({ status: 'completed', queue: [], deferredAgentIds: [] })
    expect(chat.hasDeferredReply(roomId, 'keromi')).toBe(false)
  })

  it('结算中另发活动邀请沿空闲机会接续，用户直接邀请仍立即受理', () => {
    const opening = send('pero', '要听故事吗', 'question', ['nana'])
    const clarification = reply(opening, 'nana', '是哪一段', 'question', ['pero'])
    const actor = { ...scope('pero', clarification.pairId!), sourceMessageId: clarification.id }
    const activity = life.activities.execute(actor, 'new-activity', { action: 'create', title: '一起画画' }) as StrongholdActivity
    const invitations = life.activities.execute(actor, 'invite-after-settlement', {
      action: 'invite', id: activity.id, revision: activity.revision, agentIds: ['nana'],
    }) as StrongholdInvitation[]
    const eventId = life.repo.get(invitations[0]!.id)!.sourceMessageId!
    expect(chat.getReplyIntent(eventId)?.intent).toMatchObject({ queue: [], deferredAgentIds: ['nana'] })
    const userActivity = createActivity('user', 'user-activity')
    const userInvite = life.activities.execute(scope('user'), 'user-direct-invite', {
      action: 'invite', id: userActivity.id, revision: userActivity.revision, agentIds: ['nana'],
    }) as StrongholdInvitation[]
    const userEventId = life.repo.get(userInvite[0]!.id)!.sourceMessageId!
    expect(chat.getReplyIntent(userEventId)?.intent).toMatchObject({ autonomous: false, queue: ['nana'], deferredAgentIds: [] })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000)
    life.recover()
    expect(chat.getReplyIntent(eventId)?.intent).toMatchObject({ status: 'completed', deferredAgentIds: [] })
    expect(chat.hasDeferredReply(roomId, 'nana')).toBe(false)
  })

  it('即时邀请排队到过期后直接结算，保留公开邀请并释放队列', async () => {
    const activity = createActivity('user')
    const invitations = life.activities.execute(scope('user'), 'expired-immediate-invite', {
      action: 'invite', id: activity.id, revision: activity.revision, agentIds: ['nana'],
    }) as StrongholdInvitation[]
    const eventId = life.repo.get(invitations[0]!.id)!.sourceMessageId!
    const model = vi.fn(async () => { throw new Error('过期邀请进入了模型执行') })
    const rounds = new StrongholdRoundService(chat,
      { getRoomAgents: async () => ['pero', 'nana', 'keromi'] } as never,
      { decideNextTurn: async () => ({ agentIds: [], reason: '' }) } as never,
      { execute: model } as never,
      { listAgents: () => ['pero', 'nana', 'keromi'].map((id) => ({ id, isEnabled: true })) } as never,
      { getThread: (id: string) => threads.getThread(id) } as never,
      { broadcast: async () => {} } as never, () => true)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000)
    await rounds.kick(eventId)
    expect(chat.getReplyIntent(eventId)?.intent).toMatchObject({ status: 'completed', queue: [], deferredAgentIds: [], completed: [] })
    expect(life.activities.invitations(roomId)).toEqual([])
    expect(chat.getMessageEvent(eventId)?.content).toContain('一起读书')
    expect(model).not.toHaveBeenCalled()
  })

  it('关注跳过本人操作，跨角色回声保留消费来源并允许新的外部事件', async () => {
    const source = send('user', '留意灯光和音乐的变化')
    const pero = { ...scope('pero'), sourceMessageId: source.id }
    const nana = { ...scope('nana'), sourceMessageId: source.id }
    life.watches.execute(pero, 'light-watch', { action: 'set', intent: '留意灯光', continuous: true, condition: { kind: 'environment', key: 'light' } })
    life.watches.execute(nana, 'music-watch', { action: 'set', intent: '留意音乐', continuous: true, condition: { kind: 'environment', key: 'music' } })
    const rooms = new StrongholdService(db, () => true)
    rooms.setLifeLifecycle((change) => life.onSceneChange(change))
    await rooms.updateEnvironment(roomId, 'light', '明亮', { ...pero, operationId: 'own-light' })
    expect(life.watches.list(pero, roomId)[0]!.pendingMessageIds).toEqual([])
    await rooms.updateEnvironment(roomId, 'light', '暖黄')
    const light = (await chat.getHistory(roomId)).at(-1)!
    life.recover()
    const handlingPero = { ...scope('pero', light.pairId!), sourceMessageId: light.id }
    await rooms.updateEnvironment(roomId, 'music', '轻音乐', { ...handlingPero, operationId: 'react-music' })
    const music = (await chat.getHistory(roomId)).at(-1)!
    life.finishSilent(handlingPero, 'pero-finish', { state: 'listening' }, light.id)
    settle(light, 'pero')
    life.watches.execute(handlingPero, 'another-light-watch', { action: 'set', intent: '继续留意灯光', continuous: true, condition: { kind: 'environment', key: 'light' } })
    life.recover()
    expect(chat.getReplyIntent(music.id)?.intent.queue).toEqual(['nana'])
    const handlingNana = { ...scope('nana', music.pairId!), sourceMessageId: music.id }
    await rooms.updateEnvironment(roomId, 'light', '柔和', { ...handlingNana, operationId: 'react-light' })
    const echo = (await chat.getHistory(roomId)).at(-1)!
    expect(JSON.parse(echo.metadataJson).lifeWatchAgentIds).toEqual(['pero', 'nana'])
    expect(life.watches.list(pero, roomId).map((watch) => watch.pendingMessageIds)).toEqual([[], []])
    await rooms.updateEnvironment(roomId, 'light', '清晨光线')
    const external = (await chat.getHistory(roomId)).at(-1)!
    expect(life.watches.list(pero, roomId).map((watch) => watch.pendingMessageIds)).toEqual([[external.id], [external.id]])
  })

  it('正常空闲机会建立新的关注因果关系，原参与者可以响应新进展', async () => {
    const source = send('user', '留意灯光')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    life.watches.execute(owner, 'watch-light', { action: 'set', intent: '留意灯光', continuous: true, condition: { kind: 'environment', key: 'light' } })
    const rooms = new StrongholdService(db, () => true)
    rooms.setLifeLifecycle((change) => life.onSceneChange(change))
    await rooms.updateEnvironment(roomId, 'light', '暖黄')
    const light = (await chat.getHistory(roomId)).at(-1)!
    life.recover()
    const nextTopic = reply(light, 'pero', 'Nana 下次想试试哪种灯光', 'question', ['nana'])
    settle(light, 'pero')
    expect(JSON.parse(nextTopic.metadataJson).lifeWatchAgentIds).toEqual(['pero'])
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    expect(chat.claimDeferredReply(roomId, 'nana')).toBe(nextTopic.id)
    const handling = { ...scope('nana', nextTopic.pairId!), sourceMessageId: nextTopic.id }
    await rooms.updateEnvironment(roomId, 'light', '柔和', { ...handling, operationId: 'new-initiative-light' })
    const changed = (await chat.getHistory(roomId)).at(-1)!
    expect(JSON.parse(changed.metadataJson).lifeWatchAgentIds).toEqual([])
    expect(life.watches.list(owner, roomId)[0]!.pendingMessageIds).toEqual([changed.id])
  })

  it('关注开始处理时合并排队期间的输入，保留执行中新到达的消息', () => {
    const source = send('user', '留意娜娜接下来要说的话')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    life.watches.execute(owner, 'watch-message-batch', {
      action: 'set', intent: '听娜娜说完', continuous: true, condition: { kind: 'message', actorId: 'nana' },
    })
    const first = send('nana', '我想起一件事')
    life.recover()
    const queued = send('nana', '还有一点补充')
    life.watches.beginProcessing({ ...owner, sourceMessageId: first.id })
    const during = send('nana', '刚收到的新消息')
    life.watches.consume(owner, first.id)
    expect(life.watches.list(owner, roomId)).toMatchObject([{ status: 'active', afterMessageId: queued.id, pendingMessageIds: [during.id] }])
    settle(first, 'pero')
    life.recover()
    expect(life.watches.list(owner, roomId)[0]!.requestMessageId).toBe(during.id)
  })

  it('执行期间取消关注后，迟到的消费保持取消状态', () => {
    const source = send('user', '留意娜娜')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    life.watches.execute(owner, 'cancel-during-execution', { action: 'set', intent: '听娜娜说话', continuous: true, condition: { kind: 'message', actorId: 'nana' } })
    const message = send('nana', '我回来了')
    life.recover()
    life.watches.beginProcessing({ ...owner, sourceMessageId: message.id })
    const queued = life.watches.list(owner, roomId)[0]!
    life.watches.execute(owner, 'cancel-watch', { action: 'cancel', id: queued.id, revision: queued.revision })
    life.watches.consume(owner, message.id)
    expect(life.repo.get<{ status: string }>(queued.id)?.data.status).toBe('cancelled')
    expect(life.watches.list(owner, roomId)).toEqual([])
  })

  it('相同活动状态保持原修订和事件，关注只响应实际变化', async () => {
    const activity = createActivity()
    life.watches.execute(scope('nana'), 'activity-watch', { action: 'set', intent: '留意读书进度', condition: { kind: 'activity', objectId: activity.id } })
    const before = await chat.countMessages(roomId)
    const same = life.activities.execute(scope('pero'), 'same-progress', {
      action: 'update', id: activity.id, revision: activity.revision, title: activity.title, description: '', progress: '',
    }) as StrongholdActivity
    expect(same).toEqual(activity)
    expect(await chat.countMessages(roomId)).toBe(before)
    const paused = life.activities.execute(scope('pero'), 'pause', { action: 'pause', id: activity.id, revision: same.revision }) as StrongholdActivity
    const repeated = life.activities.execute(scope('pero'), 'same-pause', { action: 'pause', id: activity.id, revision: paused.revision }) as StrongholdActivity
    expect(repeated).toEqual(paused)
    expect(await chat.countMessages(roomId)).toBe(before + 1)
    expect(life.watches.list(life.ref('nana')!, roomId)[0]!.pendingMessageIds).toEqual([life.repo.get(activity.id)!.sourceMessageId])
  })

  it('用户输入先于尚未执行的自然接话，接话意图继续沿原来源恢复', async () => {
    const autonomousMessage = send('pero', '刚读到有趣的故事', 'share', ['nana'])
    const userMessage = chat.commitMessage({ roomId, senderId: 'user', role: 'user', content: '先听我说', pairId: 'user-priority' })
    chat.commitReplyRequest(userMessage.id, ['pero'], false)
    const executed: number[] = []
    const rounds = new StrongholdRoundService(chat,
      { getRoomAgents: async () => ['pero', 'nana', 'keromi'] } as never,
      { decideNextTurn: async () => ({ agentIds: [], reason: '' }) } as never,
      { execute: async (_room: string, _agent: string, _pair: string, options: { sourceMessageId: number }) => {
        executed.push(options.sourceMessageId)
        return { summonedAgentIds: [] }
      } } as never,
      { listAgents: () => ['pero', 'nana', 'keromi'].map((id) => ({ id, isEnabled: true })) } as never,
      { getThread: (id: string) => threads.getThread(id) } as never,
      { broadcast: async () => {} } as never, () => true)
    await rounds.kick(autonomousMessage.id)
    expect(executed).toEqual([])
    await rounds.kick(userMessage.id)
    await rounds.kick(autonomousMessage.id)
    expect(executed).toEqual([userMessage.id, autonomousMessage.id])
  })
  it('用户离场调整本人活动，重放旧进入请求保持最新现场', () => {
    life.setPresence(roomId, true, 'enter')
    const activity = createActivity('user')
    life.setPresence(roomId, false, 'leave')
    life.setPresence(roomId, true, 'enter')
    expect(life.snapshot(roomId).userPresent).toBe(false)
    expect(life.activities.list(roomId)).toMatchObject([{ id: activity.id, status: 'paused', members: [{ agentId: 'user', status: 'away' }] }])
    expect(db.select().from(groupChatMessages).all().filter((row) => JSON.parse(row.metadataJson).lifeEvent?.kind === 'arrival')).toHaveLength(1)
  })
  it('跨房间移动固定离场和到达的见证者，旧代次环境修改整体回滚', async () => {
    db.insert(strongholdRooms).values({ id: 'study', name: '书房', facilityId: 1 }).run()
    db.insert(groupChatRooms).values({ id: 'study', name: '书房', creatorId: 'system' }).run()
    db.update(agentLocations).set({ roomId: 'study' }).where(eq(agentLocations.agentId, 'keromi')).run()
    const rooms = new StrongholdService(db, () => true)
    rooms.setLifeLifecycle((change) => life.onSceneChange(change))
    const initiator = scope('pero')
    await rooms.moveAgent('nana', 'study', { ...initiator, operationId: 'move-nana' })
    const events = db.select().from(groupChatMessages).all().map((message) => ({ message, event: JSON.parse(message.metadataJson).lifeEvent }))
    expect(events.map(({ message, event }) => [message.roomId, event.actorId, event.kind, event.details.before, event.details.after]))
      .toEqual([['living', 'nana', 'departure', 'living', 'study'], ['study', 'nana', 'arrival', 'living', 'study']])
    expect((await threads.queryExperiences(life.ref('pero')!.threadId)).map((entry) => entry.sourceMessageId)).toEqual([events[0]!.message.id])
    expect((await threads.queryExperiences(life.ref('keromi')!.threadId)).map((entry) => entry.sourceMessageId)).toEqual([events[1]!.message.id])
    await threads.resetMainThread(initiator.threadId)
    await expect(rooms.updateEnvironment(roomId, 'light', '暖黄', { ...initiator, operationId: 'stale-light' })).rejects.toThrow('THREAD_GENERATION_STALE')
    expect((await rooms.getRoom(roomId))?.environmentJson).toBe('{}')
    expect(await chat.countMessages(roomId)).toBe(1)
  })

  it('生活上下文只装配本人关注，私聊与据点共用当前主线的来源引用', async () => {
    const source = send('user', '今天一起读书')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    const ownWatch = life.watches.execute(owner, 'private-pero', { action: 'set', intent: '给主人准备惊喜', condition: { kind: 'message', actorId: 'user' } }) as StrongholdWatch
    life.watches.execute({ ...scope('nana'), sourceMessageId: source.id }, 'private-nana', { action: 'set', intent: '娜娜的私人心事', condition: { kind: 'message', actorId: 'user' } })
    const provider = new StrongholdLifeContextProvider(life)
    const request = { agentId: 'pero', threadId: owner.threadId, channel: 'desktop', tokenBudget: 16000, now: new Date().toISOString() }
    const regions = await provider.provide(request)
    expect(regions[0]!.content).toContain('给主人准备惊喜')
    expect(regions[0]!.content).not.toContain('娜娜的私人心事')
    expect(regions[0]!.sourceObjectRefs).toContainEqual({ objectType: 'stronghold-life', objectId: ownWatch.id, generation: ownWatch.revision, ownerPrincipalId: 'pero' })
    expect((await provider.provide({ ...request, channel: 'group' }))[0]!.content).toBe(regions[0]!.content)
    expect(await provider.provide({ ...request, threadId: 'side' })).toEqual([])
    expect(await provider.provide({ ...request, channel: 'social', realmExecution: true })).toEqual([])
    expect(await provider.provide({ ...request, background: true, taskId: 'background' })).toEqual([])
    expect(JSON.stringify(life.snapshot(roomId))).not.toContain('给主人准备惊喜')
  })

  it('新分享只选一位接话者，明确收尾进入安静并释放参与焦点', () => {
    const first = send('pero', '今天读到一段有趣的故事', 'share', ['nana', 'keromi'])
    expect(chat.getReplyIntent(first.id)?.intent.queue).toEqual(['nana'])
    const exchangeId = JSON.parse(first.metadataJson).lifeExchangeId
    const answer = chat.commitMessage({ roomId, senderId: 'nana', role: 'assistant', pairId: first.pairId!,
      content: '那我们下次接着读', metadata: { lifeResult: { state: 'conversing', purpose: 'close', exchangeId } } })
    expect(chat.getReplyIntent(answer.id)).toBeUndefined()
    expect(life.snapshot(roomId).exchanges).toMatchObject([{ id: exchangeId, status: 'quiet' }])
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    // 已响应的原始请求先完成，话题才能退出活动态。
    const intent = chat.getReplyIntent(first.id)!.intent
    chat.saveReplyIntent(first.id, { ...intent, status: 'completed', completed: ['nana'], queue: [] })
    life.recover()
    expect(life.snapshot(roomId).exchanges).toEqual([])
    expect(life.participation(scope('pero'))?.data).toMatchObject({ state: 'available' })
  })

  it('自然接话遵循角色自主设置，用户的直接邀请仍能投递', () => {
    autonomous.clear()
    const share = send('pero', '看看我画的画', 'share', ['nana'])
    expect(chat.getReplyIntent(share.id)).toBeUndefined()
    const activity = createActivity('user')
    const invitations = life.activities.execute(scope('user'), 'user-invite', {
      action: 'invite', id: activity.id, revision: activity.revision, agentIds: ['nana'],
    }) as StrongholdInvitation[]
    const event = db.select().from(groupChatMessages).all().find((row) =>
      JSON.parse(row.metadataJson).lifeEvent?.objectId === invitations[0]!.id)!
    expect(chat.getReplyIntent(event.id)?.intent).toMatchObject({ autonomous: false, queue: ['nana'] })
  })

  it('活动操作重试复用回执，过期修订冲突且不追加公共事件', async () => {
    const activity = createActivity()
    expect(createActivity()).toEqual(activity)
    const updated = life.activities.execute(scope('pero'), 'progress', {
      action: 'update', id: activity.id, revision: activity.revision, progress: '读到第三页',
    }) as StrongholdActivity
    const before = await chat.countMessages(roomId)
    expect(() => life.activities.execute(scope('pero'), 'stale', {
      action: 'end', id: activity.id, revision: activity.revision,
    })).toThrow('STRONGHOLD_LIFE_REVISION_CONFLICT')
    expect(await chat.countMessages(roomId)).toBe(before)
    expect(life.activities.list(roomId)).toMatchObject([{ id: activity.id, revision: updated.revision, progress: '读到第三页' }])
  })

  it('邀请由被邀请人接受，重置使旧邀请失效并保留公共活动', async () => {
    const activity = createActivity()
    const invitations = life.activities.execute(scope('pero'), 'invite', {
      action: 'invite', id: activity.id, revision: activity.revision, agentIds: ['nana', 'keromi'],
    }) as StrongholdInvitation[]
    expect(life.activities.execute(scope('pero'), 'invite-again', {
      action: 'invite', id: activity.id, revision: activity.revision, agentIds: ['nana', 'keromi'],
    })).toEqual(invitations)
    const nana = invitations.find((entry) => entry.recipient.agentId === 'nana')!
    expect(life.activities.list(roomId)[0]!.members.map((member) => member.agentId)).toEqual(['pero'])
    expect(() => life.activities.execute(scope('keromi'), 'wrong-recipient', {
      action: 'respond', id: nana.id, revision: nana.revision, response: 'accepted',
    })).toThrow('STRONGHOLD_INVITATION_RECIPIENT_INVALID')
    const accepted = life.activities.execute(scope('nana'), 'accept', {
      action: 'respond', id: nana.id, revision: nana.revision, response: 'accepted',
    }) as StrongholdInvitation
    expect(accepted.status).toBe('accepted')
    expect(life.activities.list(roomId)[0]!.members).toContainEqual({ ...life.ref('nana'), status: 'participating' })
    const oldScope = scope('keromi')
    await threads.resetMainThread(oldScope.threadId)
    life.recover()
    expect(life.activities.invitations(roomId)).toEqual([])
    expect(life.activities.list(roomId)[0]!.title).toBe('一起读书')
    expect(() => life.activities.execute(oldScope, 'late', { action: 'join', id: activity.id })).toThrow('THREAD_GENERATION_STALE')
  })

  it('重置后的新主线先本人加入，再取得公共活动的修改权限', async () => {
    const activity = createActivity()
    const previous = life.ref('pero')!
    await threads.resetMainThread(previous.threadId)
    const current = scope('pero')
    expect(() => life.activities.execute(current, 'before-join', {
      action: 'update', id: activity.id, revision: activity.revision, progress: '旧参与的迟到修改',
    })).toThrow('STRONGHOLD_ACTIVITY_MEMBERSHIP_REQUIRED')
    const joined = life.activities.execute(current, 'rejoin', { action: 'join', id: activity.id, revision: activity.revision }) as StrongholdActivity
    expect(joined.members).toEqual([{ ...life.ref('pero'), status: 'participating' }])
    const updated = life.activities.execute(current, 'after-join', { action: 'update', id: activity.id, revision: joined.revision, progress: '继续读书' }) as StrongholdActivity
    expect(updated.progress).toBe('继续读书')
  })

  it('同一角色多个关注命中时合并一次请求，连续关注保留执行期间的新事件', () => {
    const source = send('user', '留意娜娜和房间的变化')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    const first = life.watches.execute(owner, 'watch-message', {
      action: 'set', intent: '回应娜娜', continuous: true, condition: { kind: 'message', actorId: 'nana' },
    }) as StrongholdWatch
    life.watches.execute(owner, 'watch-environment', {
      action: 'set', intent: '看看灯光', condition: { kind: 'environment', key: 'light' },
    })
    send('nana', '我回来了')
    const environment = life.emit(scope('user'), 'light', { kind: 'environment', actorId: 'user', key: 'light', details: { after: '暖黄' } })
    life.recover()
    expect(chat.pendingReplyIds()).toEqual([environment.id])
    expect(life.watches.list(owner, roomId).map((watch) => watch.requestMessageId)).toEqual([environment.id, environment.id])
    const later = send('nana', '我又发现一件事')
    life.watches.consume(owner, environment.id)
    expect(life.watches.list(owner, roomId)).toMatchObject([{ id: first.id, status: 'active', pendingMessageIds: [later.id] }])
    life.recover()
    expect(life.watches.list(owner, roomId)[0]!.requestMessageId).toBe(later.id)
  })

  it('时间关注在服务重建后只发出一个真实到时事件，主线重置后不再接续', async () => {
    const source = send('user', '过会儿提醒我')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    const due = Date.now() - 1000
    const watch = life.watches.execute(owner, 'watch-time', { action: 'set', intent: '提醒主人休息', condition: { kind: 'time', at: due } }) as StrongholdWatch
    life = new StrongholdLifeService(db, chat, () => true, (id) => autonomous.has(id))
    bindLife()
    life.recover()
    life.recover()
    const events = db.select().from(groupChatMessages).all().filter((row) => JSON.parse(row.metadataJson).lifeEvent?.objectId === watch.id)
    expect(events).toHaveLength(1)
    expect(chat.getReplyIntent(events[0]!.id)?.intent.queue).toEqual(['pero'])
    await threads.resetMainThread(owner.threadId)
    life.recover()
    expect(life.watches.list(life.ref('pero')!, roomId)).toEqual([])
  })

  it('关闭自主活动时结算未执行请求，重新开启后继续尚未消费的关注', () => {
    const source = send('pero', '等娜娜说完')
    const owner = { ...scope('pero'), sourceMessageId: source.id }
    life.watches.execute(owner, 'watch', { action: 'set', intent: '回应娜娜', condition: { kind: 'message', actorId: 'nana' } })
    const next = send('nana', '有个新发现')
    life.recover()
    autonomous.delete('pero')
    const intent = chat.getReplyIntent(next.id)!.intent
    chat.saveReplyIntent(next.id, { ...intent, status: 'completed', completed: [], queue: [] })
    life.recover()
    life.recover()
    expect(life.watches.list(owner, roomId)).toMatchObject([{ status: 'active', pendingMessageIds: [next.id] }])
    autonomous.add('pero')
    life.recover()
    expect(chat.getReplyIntent(next.id)?.intent).toMatchObject({ status: 'pending', queue: ['pero'] })
  })

  it('邀请事件保存实际修订，事件撤回后恢复取消邀请', () => {
    const activity = createActivity()
    const invitations = life.activities.execute(scope('pero'), 'invite-with-source', {
      action: 'invite', id: activity.id, revision: activity.revision, agentIds: ['nana'],
    }) as StrongholdInvitation[]
    const invitation = invitations[0]!
    const persisted = life.repo.get(invitation.id)!
    const event = chat.getMessageEvent(persisted.sourceMessageId!)!
    expect(JSON.parse(event.metadataJson).lifeEvent.details.revision).toBe(invitation.revision)
    db.update(groupChatMessages).set({ status: 'deleted' }).where(eq(groupChatMessages.id, event.id)).run()
    life.recover()
    expect(life.activities.invitations(roomId)).toEqual([])
    expect(life.repo.get<{ status: string }>(invitation.id)?.data.status).toBe('cancelled')
  })

  it('静默开始的关注拥有真实来源，离开房间后失效', () => {
    const owner = scope('pero', 'silent-watch')
    life.watches.execute(owner, 'idle', { action: 'set', intent: '等娜娜回来', condition: { kind: 'arrival', actorId: 'nana' } })
    life.finishSilent(owner, 'silent-finish', { state: 'listening' })
    const watch = life.repo.list<{ armed: boolean; status: string }>('watch')[0]!
    expect(watch.data.armed).toBe(true)
    expect(chat.getMessageEvent(watch.sourceMessageId!)?.pairId).toBe('silent-watch')
    db.update(agentLocations).set({ roomId: 'study' }).where(eq(agentLocations.agentId, 'pero')).run()
    life.recover()
    expect(life.repo.get<{ status: string }>(watch.id)?.data.status).toBe('cancelled')
    expect(life.snapshot(roomId).participants).toEqual([])
  })

  it('来源撤回取消关注，已发布事件只进入真实在场主线的炼化来源', async () => {
    const source = send('user', '我们一起读书吧')
    const owner = { ...scope('pero', source.pairId!), sourceMessageId: source.id }
    const activity = life.activities.execute(owner, 'read', { action: 'create', title: '读绘本' }) as StrongholdActivity
    life.watches.execute(owner, 'listen', { action: 'set', intent: '留意娜娜', condition: { kind: 'message', actorId: 'nana' } })
    const experiences = await threads.queryMemoryExperiencesThrough(owner.threadId, Number.MAX_SAFE_INTEGER)
    expect(experiences.filter((row) => row.content.includes('读绘本'))).toHaveLength(1)
    expect(JSON.parse(experiences.find((row) => row.content.includes('读绘本'))!.content))
      .toMatchObject({ sourceMessageId: life.repo.get(activity.id)!.sourceMessageId, lifeEvent: { kind: 'activity', objectId: activity.id, details: { progress: '' } } })
    db.update(groupChatMessages).set({ status: 'deleted' }).where(eq(groupChatMessages.id, source.id)).run()
    life.invalidate(undefined, source.pairId!, roomId)
    life.recover()
    expect(life.watches.list(owner, roomId)).toEqual([])
    expect(life.activities.list(roomId)).toMatchObject([{ id: activity.id, sourceWithdrawn: true }])
    await threads.resetMainThread(owner.threadId)
    expect(await threads.queryMemoryExperiencesThrough(owner.threadId, Number.MAX_SAFE_INTEGER)).toEqual([])
  })

  it('全量清空记录移除生活状态，主线仍保留', async () => {
    const main = life.ref('pero')!
    createActivity()
    life.setPresence(roomId, true, 'presence')
    await new ResetService(db).clearLogs()
    expect(life.repo.list('activity')).toEqual([])
    expect(life.snapshot(roomId)).toEqual({ userPresent: false, participants: [], exchanges: [], activities: [], invitations: [] })
    expect(await threads.getThread(main.threadId)).toMatchObject({ threadKind: 'main', generation: 2 })
  })

  it('逻辑导入恢复活动资料并冻结旧执行，重写房间消息来源', () => {
    const activity = createActivity()
    life.watches.execute(scope('pero'), 'old-watch', { action: 'set', intent: '留意娜娜', condition: { kind: 'message', actorId: 'nana' } })
    const tableNames = ['stronghold_life_records', 'group_chat_messages']
    const tables = new Map<string, BackupRow[]>(tableNames.map((table) => [table, db.$client.prepare(`SELECT * FROM ${table}`).all() as BackupRow[]]))
    mergeBackupRecords(db.$client, tables, { conflict: 'duplicate', agentTargets: {} }, crypto.randomUUID())
    const all = life.repo.list<{ status: string; members: Array<{ status: string }> }>('activity')
    expect(all).toHaveLength(2)
    const imported = all.find((record) => record.id !== activity.id)!
    expect(imported.data).toMatchObject({ title: '一起读书', status: 'paused', members: [{ status: 'away' }] })
    expect(imported.sourceMessageId).not.toBe(tables.get('stronghold_life_records')!.find((row) => row.kind === 'activity')!.source_message_id)
    expect(chat.getMessageEvent(imported.sourceMessageId!)?.content).toContain('一起读书')
    const watches = life.repo.list<{ status: string; pendingMessageIds: number[] }>('watch')
    expect(watches.filter((watch) => watch.data.status === 'cancelled')).toHaveLength(1)
  })

  it('逻辑导入重写回应关系的角色和消息来源，并结算延后接话', () => {
    const opening = send('pero', '想听一个故事吗', 'question', ['nana'])
    const clarification = reply(opening, 'nana', '讲的是谁', 'question', ['pero'])
    settle(opening, 'nana')
    const nextTopic = reply(clarification, 'pero', '小猫的故事，下次再聊别的吧', 'question', ['nana'])
    settle(clarification, 'pero')
    const names = ['threads', 'group_chat_messages', 'agent_experiences', 'stronghold_life_records']
    const tables = new Map<string, BackupRow[]>(names.map((table) => [table, db.$client.prepare(`SELECT * FROM ${table}`).all() as BackupRow[]]))
    // 导入 Pero 与 Nana 两个来源角色，将 Nana 映射到目标库已有的 Keromi。
    tables.set('threads', tables.get('threads')!.filter((row) => row.agent_id !== 'keromi'))
    tables.set('agent_experiences', tables.get('agent_experiences')!.filter((row) => row.agent_id !== 'keromi'))
    mergeBackupRecords(db.$client, tables, { conflict: 'duplicate', agentTargets: { nana: 'keromi' } }, crypto.randomUUID())
    const importedOpening = db.select().from(groupChatMessages).all().find((message) => message.id !== opening.id && message.content === opening.content)!
    const importedTopic = db.select().from(groupChatMessages).all().find((message) => message.id !== nextTopic.id && message.content === nextTopic.content)!
    const metadata = JSON.parse(importedTopic.metadataJson)
    expect(metadata.lifeResponseContext).toEqual({ phase: 'settlement', openingMessageId: importedOpening.id, initiatorId: 'pero' })
    expect(metadata.replyIntent).toMatchObject({ status: 'completed', queue: [], deferredAgentIds: [],
      responseContexts: { keromi: { phase: 'response', openingMessageId: importedTopic.id, initiatorId: 'pero' } },
    })
    expect(metadata.replyIntent.responseContexts.nana).toBeUndefined()
    expect(metadata.replyIntent.deferredUntil).toBeUndefined()
    expect(chat.pendingReplyIds()).not.toContain(importedTopic.id)
  })
})
