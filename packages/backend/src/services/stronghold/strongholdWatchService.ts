import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { StrongholdMemberRef, StrongholdWatch } from '@infos/shared'
import { groupChatMessages } from '../../database/schema'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'
import type { LifeRecord } from '../../repositories/strongholdLife.repo'
import { lifeView, type LifeEvent, type LifeScope, type StrongholdLifeService } from './strongholdLifeService'

export type WatchData = Omit<StrongholdWatch, 'id' | 'roomId' | 'revision'> & {
  armed: boolean
  explicit: boolean
  processingMessageIds?: number[]
}
const inputSchema = z.object({
  action: z.enum(['list', 'set', 'cancel']), id: z.string().optional(), revision: z.number().int().nonnegative().optional(),
  intent: z.string().trim().min(1).max(1000).optional(), continuous: z.boolean().default(false),
  expiresAt: z.number().int().positive().optional(),
  condition: z.object({ kind: z.enum(['message', 'mentioned', 'arrival', 'departure', 'environment', 'invitation', 'activity', 'time']),
    actorId: z.string().optional(), objectId: z.string().optional(), key: z.string().max(100).optional(), at: z.number().int().positive().optional(),
  }).optional(),
})

/** 私有关注只在确定性匹配后产生一次合并请求，处理回执沿实际来源消费。 */
export class StrongholdWatchService {
  constructor(private readonly life: StrongholdLifeService) {}

  list(ref: StrongholdMemberRef, roomId: string): StrongholdWatch[] {
    return this.life.repo.list<WatchData>('watch', roomId)
      .filter((record) => record.threadId === ref.threadId && record.generation === ref.generation &&
        ['active', 'queued'].includes(record.data.status)).map(lifeView)
  }

  execute(scope: LifeScope, operationId: string, args: unknown) {
    const input = inputSchema.parse(args)
    this.life.assertScope(scope)
    if (input.action === 'list') return this.list(scope, scope.roomId)
    return this.life.perform(scope, operationId, () => {
      if (input.action === 'cancel') {
        const record = this.life.repo.get<WatchData>(input.id ?? '')
        if (!record || record.kind !== 'watch' || record.roomId !== scope.roomId || record.threadId !== scope.threadId || record.generation !== scope.generation)
          throw new AppError('NOT_FOUND', { message: 'STRONGHOLD_WATCH_NOT_FOUND' })
        if (input.revision !== record.revision) throw new AppError('CONFLICT', { message: 'STRONGHOLD_LIFE_REVISION_CONFLICT' })
        return lifeView(this.life.repo.update(record, { ...record.data, status: 'cancelled', pendingMessageIds: [] }))
      }
      if (!input.condition || !input.intent ||
        (input.condition.kind === 'message' && input.condition.actorId === scope.agentId) ||
        (input.expiresAt !== undefined && input.expiresAt <= Date.now()) ||
        (input.condition.kind === 'time' && !input.condition.at) ||
        (['arrival', 'departure', 'message'].includes(input.condition.kind) && !input.condition.actorId) ||
        (['activity', 'invitation'].includes(input.condition.kind) && !input.condition.objectId) ||
        (input.condition.kind === 'environment' && !input.condition.key))
        throw new AppError('INVALID_PARAMETER', { message: 'STRONGHOLD_WATCH_INVALID' })
      const source = scope.sourceMessageId === undefined
        ? this.life.db.select().from(groupChatMessages).where(and(eq(groupChatMessages.roomId, scope.roomId),
            eq(groupChatMessages.pairId, scope.pairId ?? ''), eq(groupChatMessages.status, 'active'))).orderBy(desc(groupChatMessages.id)).get()
        : this.life.chat.getMessageEvent(scope.sourceMessageId)
      const last = this.life.db.select({ id: groupChatMessages.id }).from(groupChatMessages)
        .where(eq(groupChatMessages.roomId, scope.roomId)).orderBy(desc(groupChatMessages.id)).get()
      const existing = this.life.repo.list<WatchData>('watch', scope.roomId).find((record) =>
        record.threadId === scope.threadId && record.generation === scope.generation &&
        record.sourceMessageId === (source?.id ?? null) && record.sourcePairId === (scope.pairId ?? null) &&
        ['active', 'queued'].includes(record.data.status) && record.data.intent === input.intent &&
        JSON.stringify(record.data.condition) === JSON.stringify(input.condition))
      if (existing) return lifeView(existing)
      const record = this.life.create(`life-watch:${scope.threadId}:${scope.generation}:${operationId}`, 'watch',
        { ...scope, sourceMessageId: source?.id }, {
          intent: input.intent, condition: input.condition, status: 'active', continuous: input.condition.kind === 'time' ? false : input.continuous,
          expiresAt: input.expiresAt ?? Math.max(Date.now() + 24 * 60 * 60_000, (input.condition.at ?? 0) + 60_000),
          afterMessageId: last?.id ?? 0, pendingMessageIds: [], armed: Boolean(source), explicit: source?.role === 'user',
        } satisfies WatchData)
      return lifeView(record)
    })
  }

  observe(message: typeof groupChatMessages.$inferSelect): void {
    const metadata = JSON.parse(message.metadataJson)
    const event = metadata.lifeEvent as LifeEvent | undefined
    for (const record of this.life.repo.list<WatchData>('watch', message.roomId)) {
      const watch = record.data
      if (!['active', 'queued'].includes(watch.status)) continue
      if (!watch.armed && record.sourcePairId === message.pairId && message.senderId === record.agentId) {
        this.life.repo.save({ ...record, sourceMessageId: message.id, data: { ...watch, armed: true } }, record.revision)
        continue
      }
      if (!watch.armed || message.id <= watch.afterMessageId || !this.matches(record, message, event)) continue
      if (message.senderId === record.agentId || (event?.actorId === record.agentId && event.kind !== 'time') ||
        metadata.lifeWatchIds?.includes(record.id) || metadata.lifeWatchAgentIds?.includes(record.agentId)) continue
      const ref = record.threadId && record.agentId && record.generation !== null
        ? { agentId: record.agentId, threadId: record.threadId, generation: record.generation } : undefined
      if (!ref || !this.life.current(ref, record.roomId)) continue
      if (!this.life.db.$client.prepare('SELECT 1 FROM agent_experiences WHERE source_message_id=? AND thread_id=? AND generation=? AND withdrawn=0')
        .get(message.id, ref.threadId, ref.generation)) continue
      this.life.repo.update(record, { ...watch, pendingMessageIds: [...new Set([...watch.pendingMessageIds, message.id])] })
    }
  }

  private matches(record: LifeRecord<WatchData>, message: typeof groupChatMessages.$inferSelect, event?: LifeEvent): boolean {
    const condition = record.data.condition
    if (condition.kind === 'message') return message.role !== 'system' && message.senderId === condition.actorId
    if (condition.kind === 'mentioned') return JSON.parse(message.mentionsJson ?? '[]').some((id: string) => id === record.agentId || id === '@all')
    if (!event || event.kind !== condition.kind) return false
    return (!condition.actorId || condition.actorId === event.actorId) &&
      (!condition.objectId || condition.objectId === event.objectId) &&
      (!condition.key || condition.key === event.key) &&
      (condition.kind !== 'time' || event.objectId === record.id)
  }

  consume(ref: StrongholdMemberRef, sourceMessageId?: number): void {
    if (sourceMessageId === undefined) return
    for (const record of this.life.repo.list<WatchData>('watch')) {
      if (record.threadId !== ref.threadId || record.generation !== ref.generation || record.data.status !== 'queued' ||
        record.data.requestMessageId !== sourceMessageId) continue
      const consumed = record.data.processingMessageIds
      const pending = record.data.pendingMessageIds.filter((id) => consumed ? !consumed.includes(id) : id > sourceMessageId)
      this.life.repo.update(record, { ...record.data, status: record.data.continuous ? 'active' : 'completed',
        afterMessageId: (consumed ?? []).reduce((latest, id) => Math.max(latest, id), sourceMessageId), requestMessageId: undefined,
        processingMessageIds: undefined, pendingMessageIds: record.data.continuous ? pending : [] })
    }
  }

  /** 领取时固定已到达的输入，排队期间追加的变化随本次处理，执行中新到达的变化继续保留。 */
  beginProcessing(scope: LifeScope): void {
    if (scope.sourceMessageId === undefined) return
    this.life.db.transaction(() => {
      this.life.assertScope(scope)
      for (const record of this.life.repo.list<WatchData>('watch', scope.roomId)) {
        if (record.threadId !== scope.threadId || record.generation !== scope.generation || record.data.status !== 'queued' ||
          record.data.requestMessageId !== scope.sourceMessageId || record.data.processingMessageIds) continue
        this.life.repo.update(record, { ...record.data, processingMessageIds: [...record.data.pendingMessageIds] })
      }
    })
  }

  armSilent(scope: LifeScope): void {
    const records = this.life.repo.list<WatchData>('watch', scope.roomId).filter((record) =>
      record.threadId === scope.threadId && record.generation === scope.generation &&
      record.sourcePairId === scope.pairId && record.data.status === 'active' && !record.data.armed)
    if (!records.length) return
    const source = this.life.emit(scope, `watch-start:${scope.threadId}:${scope.generation}:${scope.pairId}`, {
      kind: 'attention', actorId: scope.agentId, details: { text: t('server.stronghold', '开始留意房间里的变化') },
    })
    for (const record of records) {
      const latest = this.life.repo.get<WatchData>(record.id)!
      this.life.repo.save({ ...latest, sourceMessageId: source.id, data: { ...latest.data, armed: true } }, latest.revision)
    }
  }

  recover(): void {
    const ready = new Map<string, Array<LifeRecord<WatchData>>>()
    for (let record of this.life.repo.list<WatchData>('watch')) {
      if (!['active', 'queued'].includes(record.data.status)) continue
      const ref = { agentId: record.agentId!, threadId: record.threadId!, generation: record.generation! }
      const source = record.sourceMessageId === null ? undefined : this.life.chat.getMessageEvent(record.sourceMessageId)
      if (!this.life.current(ref, record.roomId) || (record.sourceMessageId !== null && !source)) {
        this.life.repo.update(record, { ...record.data, status: 'cancelled', pendingMessageIds: [] })
        continue
      }
      if (record.data.expiresAt <= Date.now()) {
        this.life.repo.update(record, { ...record.data, status: 'expired', pendingMessageIds: [] })
        continue
      }
      if (!record.data.armed) continue
      if (record.data.status === 'queued') {
        const request = this.life.chat.getReplyIntent(record.data.requestMessageId ?? -1)
        if (!request || request.intent.failedAgentIds?.includes(ref.agentId))
          this.life.repo.update(record, { ...record.data, status: 'failed', pendingMessageIds: [], requestMessageId: undefined })
        else if (request.intent.completed.includes(ref.agentId)) this.consume(ref, record.data.requestMessageId)
        else if (request.intent.status === 'completed')
          this.life.repo.update(record, { ...record.data, status: 'active', requestMessageId: undefined })
        continue
      }
      if (!record.data.explicit && !this.life.allowsAutonomy(ref.agentId)) continue
      if (record.data.condition.kind === 'time' && record.data.condition.at! <= Date.now() && !record.data.pendingMessageIds.length) {
        this.life.emit({ ...ref, roomId: record.roomId }, `watch-time:${record.id}`, {
          kind: 'time', actorId: ref.agentId, objectId: record.id, details: { text: t('server.stronghold', '到了约定时间') },
        }, [ref.agentId])
        record = this.life.repo.get<WatchData>(record.id)!
      }
      const valid = record.data.pendingMessageIds.filter((id) => Boolean(this.life.chat.getMessageEvent(id)))
      if (!valid.length) continue
      const key = `${record.roomId}:${ref.threadId}:${ref.generation}`
      const group = ready.get(key) ?? []
      group.push({ ...record, data: { ...record.data, pendingMessageIds: valid } })
      ready.set(key, group)
    }
    for (const records of ready.values()) {
      const first = records[0]!
      const ref = { agentId: first.agentId!, threadId: first.threadId!, generation: first.generation! }
      const pending = records.flatMap((record) => record.data.pendingMessageIds)
      const requestId = pending.reduce((latest, id) => Math.max(latest, id), 0)
      if (!this.life.chat.commitReplyRequest(requestId, [ref.agentId], !records.some((record) => record.data.explicit), ref,
        { kind: 'watch', watchIds: records.map((record) => record.id) })) continue
      for (const record of records)
        this.life.repo.update(record, { ...record.data, status: 'queued', requestMessageId: requestId })
    }
  }

  invalidate(threadId?: string, sourcePairId?: string, roomId?: string): void {
    for (const record of this.life.repo.list<WatchData>('watch', roomId)) {
      if ((threadId && record.threadId !== threadId) || (sourcePairId && record.sourcePairId !== sourcePairId) ||
        !['active', 'queued'].includes(record.data.status)) continue
      this.life.repo.update(record, { ...record.data, status: 'cancelled', pendingMessageIds: [] })
    }
  }
}
