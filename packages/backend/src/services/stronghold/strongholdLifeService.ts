import { and, eq } from 'drizzle-orm'
import type { StrongholdActivity, StrongholdExchange, StrongholdInvitation, StrongholdLifeSnapshot, StrongholdMemberRef, StrongholdParticipation, StrongholdParticipationResult } from '@infos/shared'
import { parseStrongholdParticipation } from '@infos/shared'
import type { DrizzleDb } from '../../database'
import { agentLocations, groupChatMessages, strongholdRooms, threads } from '../../database/schema'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'
import { StrongholdLifeRepository, type LifeRecord } from '../../repositories/strongholdLife.repo'
import type { GroupChatService } from './groupChatService'
import { StrongholdActivityService } from './strongholdActivityService'
import { StrongholdWatchService, type WatchData } from './strongholdWatchService'
import type { StrongholdSceneChange } from './strongholdService'
import { STRONGHOLD_QUIET_WINDOW_MS, type StrongholdReplyAdmission, type StrongholdReplyOptions, type StrongholdResponseContext } from './strongholdCausality'

export interface LifeScope extends StrongholdMemberRef {
  roomId: string
  pairId?: string
  sourceMessageId?: number
  signal?: AbortSignal
  causeAgentId?: string
}
export interface LifeEvent {
  kind: string
  actorId: string
  objectId?: string
  key?: string
  details: Record<string, unknown>
}
type ParticipationData = Omit<StrongholdParticipation, 'id' | 'roomId' | 'revision'>
type ExchangeData = Omit<StrongholdExchange, 'id' | 'roomId' | 'revision'>
type Message = typeof groupChatMessages.$inferSelect

export const lifeView = <T>(record: LifeRecord<T>) => ({ ...record.data, id: record.id, roomId: record.roomId, revision: record.revision })

/** 主线持有个人参与，房间消息持有公共事件，领域事务串起状态、亲历和回复请求。 */
export class StrongholdLifeService {
  readonly repo: StrongholdLifeRepository
  readonly activities: StrongholdActivityService
  readonly watches: StrongholdWatchService

  constructor(readonly db: DrizzleDb, readonly chat: GroupChatService,
    readonly enabled: (agentId: string) => boolean, readonly allowsAutonomy: (agentId: string) => boolean,
    readonly displayName: (agentId: string) => string = (id) => id) {
    this.repo = new StrongholdLifeRepository(db)
    this.activities = new StrongholdActivityService(this)
    this.watches = new StrongholdWatchService(this)
  }

  ref(agentId: string): StrongholdMemberRef | undefined {
    if (agentId === 'user') return { agentId, threadId: 'user', generation: 0 }
    const main = this.db.select().from(threads).where(and(eq(threads.agentId, agentId), eq(threads.threadKind, 'main'), eq(threads.status, 'active'))).get()
    return main && this.enabled(agentId) ? { agentId, threadId: main.id, generation: main.generation } : undefined
  }

  present(roomId: string): string[] {
    return this.db.select({ agentId: agentLocations.agentId }).from(agentLocations)
      .where(eq(agentLocations.roomId, roomId)).all().map((row) => row.agentId)
  }

  current(ref: StrongholdMemberRef, roomId?: string): boolean {
    const actual = this.ref(ref.agentId)
    if (!actual || actual.threadId !== ref.threadId || actual.generation !== ref.generation) return false
    return roomId === undefined || ref.agentId === 'user' || this.present(roomId).includes(ref.agentId)
  }

  assertScope(scope: LifeScope): void {
    scope.signal?.throwIfAborted()
    if (!this.current(scope, scope.roomId)) throw new AppError('CONFLICT', { message: 'THREAD_GENERATION_STALE' })
    if (!this.db.select({ id: strongholdRooms.id }).from(strongholdRooms).where(eq(strongholdRooms.id, scope.roomId)).get())
      throw new AppError('NOT_FOUND', { message: 'STRONGHOLD_ROOM_NOT_FOUND' })
    if (scope.sourceMessageId !== undefined && this.chat.getMessageEvent(scope.sourceMessageId)?.roomId !== scope.roomId)
      throw new AppError('CONFLICT', { message: 'STRONGHOLD_SOURCE_WITHDRAWN' })
  }

  perform<T>(scope: LifeScope, operationId: string, action: () => T): T {
    return this.db.transaction(() => {
      this.assertScope(scope)
      const id = `life-receipt:${scope.threadId}:${scope.generation}:${operationId}`
      const receipt = this.repo.get<{ result: T }>(id)
      if (receipt) {
        if (receipt.roomId !== scope.roomId) throw new AppError('CONFLICT', { message: 'STRONGHOLD_LIFE_REVISION_CONFLICT' })
        return receipt.data.result
      }
      const result = action()
      this.create(id, 'receipt', scope, { result })
      return result
    })
  }

  create<T>(id: string, kind: LifeRecord['kind'], scope: LifeScope, data: T, personal = true): LifeRecord<T> {
    return this.repo.save({ id, kind, roomId: scope.roomId,
      agentId: scope.agentId, threadId: personal ? scope.threadId : null, generation: personal ? scope.generation : null,
      sourceMessageId: scope.sourceMessageId ?? null, sourcePairId: scope.pairId ?? null, data }, 0)
  }

  emit(scope: LifeScope, operationId: string, event: LifeEvent, audience?: string[]): Message {
    return this.chat.commitMessage({ roomId: scope.roomId, senderId: 'system', role: 'system',
      pairId: scope.pairId ?? `life:${operationId}`, deliveryKey: `life-event:${operationId}`,
      content: t('server.stronghold', '{0} · {1}', [this.displayName(event.actorId), String(event.details.text ?? event.kind)]),
      audienceAgentIds: audience,
      metadata: { lifeEvent: event, causedByMessageId: scope.sourceMessageId, causedByAgentId: scope.causeAgentId ?? scope.agentId },
    })
  }

  onSceneChange(change: StrongholdSceneChange): void {
    const actorId = change.kind === 'environment' ? change.source?.agentId ?? change.actorId : change.actorId
    const actor = this.ref(actorId)
    if (!actor) return
    change.source?.signal?.throwIfAborted()
    if (change.source) {
      const initiator = this.ref(change.source.agentId ?? actorId)
      if (!initiator || change.source.threadId !== initiator.threadId || change.source.generation !== initiator.generation)
        throw new Error('THREAD_GENERATION_STALE')
      if (change.source.sourceMessageId !== undefined && !this.chat.getMessageEvent(change.source.sourceMessageId))
        throw new Error('STRONGHOLD_SOURCE_WITHDRAWN')
    }
    const scope = { ...actor, roomId: change.roomId, pairId: change.source?.pairId,
      sourceMessageId: change.source?.sourceMessageId, causeAgentId: change.source?.agentId }
    const operationId = `${actor.threadId}:${actor.generation}:${change.source?.operationId ?? crypto.randomUUID()}:${change.roomId}:${change.kind}:${change.key ?? ''}:${JSON.stringify(change.after ?? null)}`
    this.emit(scope, operationId, { kind: change.kind, actorId, key: change.key,
      details: { before: change.before, after: change.after,
        text: t('server.stronghold', change.kind === 'arrival' ? '进入了房间' : change.kind === 'departure' ? '离开了房间' : '调整了房间环境'),
      } }, change.audience)
    if (change.kind === 'departure') this.invalidate(actor.threadId, undefined, change.roomId, scope)
    if (change.kind === 'arrival') this.commitParticipation(scope, { state: 'available' })
  }

  participation(ref: StrongholdMemberRef): LifeRecord<ParticipationData> | undefined {
    return this.repo.get(`life-participation:${ref.threadId}:${ref.generation}`)
  }

  snapshot(roomId: string): StrongholdLifeSnapshot {
    return {
      userPresent: this.repo.get<{ present: boolean }>(`life-presence:user:${roomId}`)?.data.present ?? false,
      participants: this.repo.list<ParticipationData>('participation', roomId)
        .filter((row) => row.agentId !== 'user' && this.current(row.data, roomId)).map(lifeView),
      exchanges: this.repo.list<ExchangeData>('exchange', roomId).filter((row) => row.data.status !== 'closed').map(lifeView),
      activities: this.activities.list(roomId), invitations: this.activities.invitations(roomId),
    }
  }

  context(agentId: string, roomId?: string): string {
    const ref = this.ref(agentId)
    if (!ref) return ''
    const location = roomId ?? this.db.select().from(agentLocations).where(eq(agentLocations.agentId, agentId)).get()?.roomId
    if (!location) return ''
    const watches = this.watches.list(ref, location)
    const events = [...new Set(watches.flatMap((watch) => watch.pendingMessageIds))]
      .map((id) => this.chat.getMessageEvent(id))
      .filter((message): message is Message => Boolean(message))
      .map((message) => ({ id: message.id, senderId: message.senderId, content: message.content,
        timestamp: message.timestamp, lifeEvent: JSON.parse(message.metadataJson).lifeEvent }))
    return JSON.stringify({ ...this.snapshot(location), watches, events })
  }

  /** 检索只使用本次来源、命中关注和直接关联活动，模型场景指令由执行器单独装配。 */
  retrievalQuery(agentId: string, roomId: string, sourceMessageId?: number, currentGoal = ''): string {
    const ref = this.ref(agentId)
    if (!ref || !this.current(ref, roomId)) return ''
    const hints = new Set<string>()
    const messages = new Set<string>()
    const append = (target: Set<string>, ...values: unknown[]) => {
      for (const value of values) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) continue
        const text = String(value).trim()
        if (text) target.add(text)
      }
    }
    const addActivity = (id: unknown) => {
      if (typeof id !== 'string') return
      const activity = this.repo.get<Omit<StrongholdActivity, 'id' | 'roomId' | 'revision'>>(id)
      if (activity?.kind === 'activity' && activity.roomId === roomId) append(hints, activity.data.title)
    }
    const addObject = (kind: string, id: unknown) => {
      if (kind === 'activity') addActivity(id)
      if (kind !== 'invitation' || typeof id !== 'string') return
      const invitation = this.repo.get<StrongholdInvitation>(id)
      if (invitation?.kind === 'invitation' && invitation.roomId === roomId) addActivity(invitation.data.activityId)
    }
    const focus = this.participation(ref)
    if (sourceMessageId === undefined) {
      append(hints, currentGoal)
      const activities = this.activities.list(roomId).filter((activity) => activity.status === 'active' &&
        activity.members.some((member) => member.agentId === agentId && member.threadId === ref.threadId &&
          member.generation === ref.generation && ['participating', 'observing'].includes(member.status)))
      const focused = focus?.roomId === roomId ? activities.find((activity) => activity.id === focus.data.activityId) : undefined
      const activity = focused ?? (activities.length === 1 ? activities[0] : undefined)
      append(hints, activity?.title)
      return [...hints].join('\n')
    }
    const source = this.chat.getMessageEvent(sourceMessageId)
    if (!source || source.roomId !== roomId) return ''
    const selectedIds = new Set([sourceMessageId])
    const watches = this.repo.list<WatchData>('watch', roomId).filter((record) => record.threadId === ref.threadId &&
      record.generation === ref.generation && record.data.status === 'queued' && record.data.requestMessageId === sourceMessageId)
    for (const { data } of watches) {
      append(hints, data.intent)
      addObject(data.condition.kind, data.condition.objectId)
      for (const id of data.processingMessageIds ?? data.pendingMessageIds) selectedIds.add(id)
    }
    for (const id of selectedIds) {
      const message = id === sourceMessageId ? source : this.chat.getMessageEvent(id)
      if (!message || message.roomId !== roomId) continue
      const metadata = JSON.parse(message.metadataJson)
      addActivity(metadata.lifeResult?.activityId)
      if (focus?.roomId === roomId && focus.data.exchangeId && metadata.lifeExchangeId === focus.data.exchangeId)
        addActivity(focus.data.activityId)
      const event = metadata.lifeEvent as LifeEvent | undefined
      if (!event) {
        if (message.content.trim()) append(messages, this.displayName(message.senderId), message.content)
        continue
      }
      addActivity(event.details.activityId)
      addObject(event.kind, event.objectId)
      if (event.kind === 'time' || event.kind === 'attention') continue
      append(messages, this.displayName(event.actorId))
      if (event.kind === 'activity') append(messages, event.details.title, event.details.progress)
      else if (event.kind === 'environment') append(messages, event.key, event.details.before, event.details.after)
      else append(messages, message.content)
    }
    return [...new Set([...hints, ...messages])].join('\n')
  }

  /** 回调在消息事务内运行，恢复时直接读取已提交状态。 */
  onMessage(message: Message): void {
    const metadata = JSON.parse(message.metadataJson) as Record<string, unknown>
    const sourceId = typeof metadata.sourceMessageId === 'number' ? metadata.sourceMessageId :
      typeof metadata.causedByMessageId === 'number' ? metadata.causedByMessageId : undefined
    const actorId = typeof metadata.causedByAgentId === 'string' ? metadata.causedByAgentId : message.senderId
    const cause = this.chat.getExecutionCause(sourceId, actorId)
    metadata.lifeWatchIds = cause.watchIds
    metadata.lifeWatchAgentIds = cause.watchAgentIds
    metadata.lifeResponseContext = cause.response
    this.db.update(groupChatMessages).set({ metadataJson: JSON.stringify(metadata) }).where(eq(groupChatMessages.id, message.id)).run()
    message.metadataJson = JSON.stringify(metadata)
    this.watches.observe(message)
    if (message.role === 'system') return
    if (message.senderId === 'user') this.setPresence(message.roomId, true, `message:${message.id}`)
    const ref = this.ref(message.senderId)
    if (!ref) return
    const scope: LifeScope = { ...ref, roomId: message.roomId, pairId: message.pairId ?? undefined, sourceMessageId: message.id }
    const result = metadata.lifeResult ? parseStrongholdParticipation(metadata.lifeResult) : undefined
    const source = sourceId === undefined ? undefined : this.chat.getMessageEvent(sourceId)
    const sourceMetadata = source ? JSON.parse(source.metadataJson) : {}
    const focus = this.participation(ref)
    let exchange = this.repo.get<ExchangeData>(result?.exchangeId ?? sourceMetadata.lifeExchangeId ?? focus?.data.exchangeId ?? '')
    if (!exchange || exchange.roomId !== message.roomId || exchange.data.status === 'closed') {
      exchange = message.role === 'user'
        ? this.repo.list<ExchangeData>('exchange', message.roomId).filter((row) => row.data.status === 'active').at(-1)
        : undefined
    }
    if (!exchange) exchange = this.create(`life-exchange:${message.id}`, 'exchange', scope, {
      status: 'active', participantIds: [], lastSpeakerId: message.senderId, lastMessageId: message.id,
      quietAt: 0, closesAt: 0,
    } satisfies ExchangeData, false)
    const addresses: string[] = result?.addressedTo ?? JSON.parse(message.mentionsJson ?? '[]')
    const participants = [...new Set([...exchange.data.participantIds, message.senderId,
      ...addresses.filter((id) => this.present(message.roomId).includes(id))])]
    const quiet = Boolean(cause.response) || result?.purpose === 'close' || result?.purpose === 'acknowledge'
    exchange = this.repo.update(exchange, { ...exchange.data, participantIds: participants,
      lastSpeakerId: message.senderId, lastMessageId: message.id,
      status: quiet ? 'quiet' : 'active', quietAt: quiet ? Date.now() : 0, closesAt: quiet ? Date.now() + STRONGHOLD_QUIET_WINDOW_MS : 0 })
    metadata.lifeExchangeId = exchange.id
    this.db.update(groupChatMessages).set({ metadataJson: JSON.stringify(metadata) }).where(eq(groupChatMessages.id, message.id)).run()
    message.metadataJson = JSON.stringify(metadata)
    if (this.current(ref, message.roomId)) this.commitParticipation(scope, result ?? { state: 'conversing' }, exchange.id)
    this.watches.consume(ref, sourceId)
    const declared = message.role === 'assistant' && metadata.replyIntent ? JSON.parse(message.mentionsJson ?? '[]') as string[] : []
    let naturalCandidate: string | undefined
    if (message.role === 'assistant' && result && ['share', 'question'].includes(result.purpose ?? '')) {
      const explicit = result.addressedTo?.length ? result.addressedTo : undefined
      const speakerIndex = participants.indexOf(message.senderId)
      const rotated = [...participants.slice(speakerIndex + 1), ...participants.slice(0, speakerIndex)]
      const candidates = (explicit ?? rotated).filter((id) => id !== message.senderId && id !== 'user' &&
        this.present(message.roomId).includes(id) && this.allowsAutonomy(id))
      naturalCandidate = candidates.find((id) => {
        const target = this.ref(id)
        const state = target && this.participation(target)
        if (!explicit && state && ['occupied', 'resting'].includes(state.data.state)) return false
        return !this.chat.pendingReplyIds().some((pendingId) => {
          const pending = this.chat.getReplyIntent(pendingId)
          return pending?.intent.queue?.includes(id) && JSON.parse(pending.message.metadataJson).lifeExchangeId === exchange!.id
        })
      })
    }
    const requested = [...new Set([...declared, ...(naturalCandidate ? [naturalCandidate] : [])])]
    if (requested.length) this.chat.commitReplyRequest(message.id, requested, true, undefined, { kind: declared.length ? 'summon' : 'natural' })
    const intent = this.chat.getReplyIntent(message.id)?.intent
    if (message.role === 'assistant' && intent && !intent.queue && !requested.length)
      this.chat.saveReplyIntent(message.id, { ...intent, queue: [], status: 'completed' })
    if (intent?.queue?.length && exchange.data.status === 'quiet')
      this.repo.update(exchange, { ...exchange.data, status: 'active', quietAt: 0, closesAt: 0 })
  }

  /** 当前回应可澄清原发起内容；独立话题和结算后的新请求等待下一次自主机会。 */
  admitReply(message: Message, agentId: string, options: StrongholdReplyOptions): StrongholdReplyAdmission {
    if (message.role === 'user') return { mode: 'immediate' }
    const metadata = JSON.parse(message.metadataJson)
    const response = metadata.lifeResponseContext as StrongholdResponseContext | undefined
    const initiatorId = metadata.lifeEvent?.actorId ?? message.senderId
    const next: StrongholdResponseContext = { phase: 'response', openingMessageId: message.id, initiatorId }
    if (options.kind === 'watch') return { mode: 'immediate', response: { ...next, phase: 'settlement' } }
    if (!response) return { mode: 'immediate', response: next }
    const closesRequest = metadata.lifeResult?.purpose === 'question' || options.kind === 'wait' ||
      (metadata.lifeEvent?.kind === 'invitation' && metadata.lifeEvent.details.status !== 'pending')
    if (response.phase === 'response' && response.initiatorId === agentId && closesRequest)
      return { mode: 'immediate', response: { ...response, phase: 'settlement' } }
    return { mode: 'idle', response: next }
  }

  canResumeReply(message: Message): boolean {
    const event = JSON.parse(message.metadataJson).lifeEvent as LifeEvent | undefined
    if (event?.kind !== 'invitation' || event.details.status !== 'pending') return true
    const invitation = this.repo.get<StrongholdInvitation>(event.objectId ?? '')
    if (!invitation || invitation.kind !== 'invitation' || !['pending', 'later'].includes(invitation.data.status) ||
      invitation.data.expiresAt <= Date.now() || !this.current(invitation.data.recipient, message.roomId)) return false
    const inviter = { agentId: invitation.agentId!, threadId: invitation.threadId!, generation: invitation.generation! }
    const activity = this.repo.get<{ status: string }>(invitation.data.activityId)
    return this.current(inviter, message.roomId) && Boolean(activity && activity.data.status !== 'ended')
  }

  commitParticipation(scope: LifeScope, result: StrongholdParticipationResult, exchangeId?: string): void {
    const previous = this.participation(scope)
    if (result.expectedRevision !== undefined && result.expectedRevision !== (previous?.revision ?? 0))
      throw new AppError('CONFLICT', { message: 'STRONGHOLD_LIFE_REVISION_CONFLICT' })
    if (result.activityId && !this.activities.isMember(result.activityId, scope, scope.roomId))
      throw new AppError('FORBIDDEN', { message: 'STRONGHOLD_ACTIVITY_MEMBERSHIP_REQUIRED' })
    const exchange = exchangeId ?? result.exchangeId
    if (exchange) {
      const current = this.repo.get<ExchangeData>(exchange)
      if (!current || current.kind !== 'exchange' || current.roomId !== scope.roomId || current.data.status === 'closed')
        throw new AppError('CONFLICT', { message: 'STRONGHOLD_LIFE_REVISION_CONFLICT' })
    }
    const data: ParticipationData = { agentId: scope.agentId, threadId: scope.threadId, generation: scope.generation,
      state: result.state, exchangeId: result.purpose === 'close' ? undefined : exchange,
      activityId: result.activityId }
    this.repo.save({ id: `life-participation:${scope.threadId}:${scope.generation}`, kind: 'participation',
      roomId: scope.roomId, agentId: scope.agentId, threadId: scope.threadId, generation: scope.generation,
      sourceMessageId: scope.sourceMessageId ?? null, sourcePairId: scope.pairId ?? null, data }, previous?.revision ?? 0)
  }

  finishSilent(scope: LifeScope, operationId: string, result: StrongholdParticipationResult | undefined, sourceId?: number): void {
    if (!this.current(scope, scope.roomId)) return
    this.perform(scope, operationId, () => {
      if (result) this.commitParticipation(scope, result)
      this.watches.armSilent(scope)
      this.watches.consume(scope, sourceId)
      return true
    })
  }

  setPresence(roomId: string, present: boolean, operationId: string): void {
    const id = `life-presence:user:${roomId}`
    const scope: LifeScope = { agentId: 'user', threadId: 'user', generation: 0, roomId }
    this.perform(scope, `presence:${operationId}`, () => {
      const previous = this.repo.get<{ present: boolean }>(id)
      if ((previous?.data.present ?? false) === present) return true
      this.repo.save({ id, kind: 'presence', roomId, agentId: 'user', threadId: null, generation: null,
        sourceMessageId: null, sourcePairId: null, data: { present } }, previous?.revision ?? 0)
      this.emit(scope, `presence:${operationId}`, { kind: present ? 'arrival' : 'departure', actorId: 'user', details: {
        text: t('server.stronghold', present ? '进入了房间' : '离开了房间'),
      } })
      this.activities.recover()
      return true
    })
  }

  recover(): void {
    this.db.transaction(() => {
      this.chat.pruneDeferredReplies()
      this.activities.recover()
      this.watches.recover()
      for (const exchange of this.repo.list<ExchangeData>('exchange')) {
        if (exchange.data.status === 'closed') continue
        const pending = this.chat.pendingReplyIds().some((id) => {
          const message = this.chat.getReplyIntent(id)?.message
          return message && JSON.parse(message.metadataJson).lifeExchangeId === exchange.id
        })
        if (pending) continue
        if (exchange.data.status === 'active') {
          this.repo.update(exchange, { ...exchange.data, status: 'quiet', quietAt: Date.now(), closesAt: Date.now() + STRONGHOLD_QUIET_WINDOW_MS })
        } else if (exchange.data.closesAt <= Date.now()) {
          this.repo.update(exchange, { ...exchange.data, status: 'closed' })
          for (const participant of this.repo.list<ParticipationData>('participation', exchange.roomId)) {
            if (participant.data.exchangeId === exchange.id && participant.data.state === 'conversing')
              this.repo.update(participant, { ...participant.data, state: 'available', exchangeId: undefined })
          }
        }
      }
    })
  }

  invalidate(threadId?: string, sourcePairId?: string, roomId?: string, origin?: LifeScope): void {
    this.db.transaction(() => {
      this.chat.pruneDeferredReplies(threadId, sourcePairId, roomId)
      this.watches.invalidate(threadId, sourcePairId, roomId)
      this.activities.invalidate(threadId, sourcePairId, roomId, origin)
      for (const record of this.repo.list<ParticipationData>('participation', roomId)) {
        if ((threadId && record.threadId !== threadId) || (sourcePairId && record.sourcePairId !== sourcePairId)) continue
        this.repo.update(record, { ...record.data, state: 'available', exchangeId: undefined, activityId: undefined })
      }
    })
  }
}
