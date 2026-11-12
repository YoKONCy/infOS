/**
 * Group Chat Service — 群聊消息服务
 *
 * 管理房间权威消息、逐条亲历引用与视角转换。
 * 消息、亲历和 Outbox 同事务提交，调用方负责唤醒需要回应的角色。
 *
 * @module packages/backend/src/services/stronghold/groupChatService
 */

import { eq, desc, asc, and, or, inArray, isNull, sql } from 'drizzle-orm'
import {
  groupChatRooms,
  groupChatMembers,
  groupChatMessages,
  strongholdAgentPairVisibility,
  agentLocations,
  agentExperiences,
  threads,
  kernelOutboxEvents,
} from '../../database/schema'
import type { DrizzleDb } from '../../database'
import { KernelOutboxRepository } from '../../kernel/kernelOutboxRepository'
import { stableHistoryWindow, invalidatePromptReplay } from '../llm/promptCache'
import { tokenCounter } from '../tokenizer/tokenCounter'
import { STRONGHOLD_QUIET_WINDOW_MS, type StrongholdReplyAdmission, type StrongholdReplyOptions, type StrongholdResponseContext } from './strongholdCausality'

// ── 类型 ──

type RoomRow = typeof groupChatRooms.$inferSelect
type MemberRow = typeof groupChatMembers.$inferSelect
type MessageRow = typeof groupChatMessages.$inferSelect

export interface StrongholdReplyIntent {
  status: 'pending' | 'completed'
  autonomous?: boolean
  targets: Array<{ agentId: string; threadId: string; generation: number }>
  queue?: string[]
  completed: string[]
  failedAgentIds?: string[]
  initialQueue?: string[]
  reason?: string
  allMention?: boolean
  allowAutoFollowUp?: boolean
  allowSummon?: boolean
  autoFollowUpChecked?: boolean
  summonedBy?: string
  summonReason?: string
  attempts: number
  retryAt?: number
  deferredAgentIds?: string[]
  deferredUntil?: number
  responseContexts?: Record<string, StrongholdResponseContext>
  watchIdsByAgent?: Record<string, string[]>
  freshInitiativeAgentIds?: string[]
}

/** 发送消息的输入 */
export interface SendMessageInput {
  roomId: string
  senderId: string
  content: string
  role: 'user' | 'assistant' | 'system'
  mentions?: string[]
  /** 本轮对话关联键：用户消息与其所有回复共用。 */
  pairId?: string
  metadata?: Record<string, unknown>
  requestReplies?: boolean
  deliveryKey?: string
  /** 领域事件固定发生时的实际可见范围。 */
  audienceAgentIds?: string[]
  audienceScope?: { agentId: string; threadId: string; generation: number; sourcePairId: string }
  execution?: { threadId: string; generation: number; executionId?: import('@infos/shared').KernelExecutionId; sourcePairId?: string; sourceMessageId?: number }
}

/** 据点消息级联删除结果。 */
export interface DeleteMessagePairResult {
  deletedCount: number
  deletedMessageIds: number[]
}

/** 视角转换后的消息 (给 LLM) */
export interface PerspectiveMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// ── Service ──

export class GroupChatService {
  private onMessageCommitted?: (message: MessageRow) => void
  private admitReply?: (message: MessageRow, agentId: string, options: StrongholdReplyOptions) => StrongholdReplyAdmission
  private canResumeReply?: (message: MessageRow) => boolean

  setLifeLifecycle(onMessage: (message: MessageRow) => void,
    admitReply?: (message: MessageRow, agentId: string, options: StrongholdReplyOptions) => StrongholdReplyAdmission,
    canResumeReply?: (message: MessageRow) => boolean): void {
    this.onMessageCommitted = onMessage
    this.admitReply = admitReply
    this.canResumeReply = canResumeReply
  }
  constructor(
    private db: DrizzleDb,
    private isEnabledAgent: (agentId: string) => boolean,
    private rollbackCharacterState?: (roomId: string, pairId: string) => Promise<void>,
  ) {}

  // ─── 房间 ───

  async listRooms(): Promise<RoomRow[]> {
    return this.db.select().from(groupChatRooms).all()
  }

  async getRoom(roomId: string): Promise<RoomRow | undefined> {
    return this.db.select().from(groupChatRooms).where(eq(groupChatRooms.id, roomId)).get()
  }

  // ─── 成员 ───

  async getRoomMembers(roomId: string): Promise<MemberRow[]> {
    return this.db.select().from(groupChatMembers).where(eq(groupChatMembers.roomId, roomId)).all()
  }

  async addMember(roomId: string, agentId: string, role = 'member'): Promise<void> {
    if (!this.isEnabledAgent(agentId)) {
      throw new Error(`Agent ${agentId} 不存在或未启用，禁止加入据点房间`)
    }
    const room = await this.getRoom(roomId)
    if (!room) throw new Error(`房间 ${roomId} 不存在`)
    const existing = await this.db
      .select()
      .from(groupChatMembers)
      .where(eq(groupChatMembers.roomId, roomId))
      .all()

    if (existing.some((m) => m.agentId === agentId)) return

    await this.db.insert(groupChatMembers).values({ roomId, agentId, role })
  }

  async removeMember(roomId: string, agentId: string): Promise<void> {
    // 不能移除 system/user
    if (['system', 'user'].includes(agentId)) return

    const members = await this.getRoomMembers(roomId)
    const target = members.find((m) => m.agentId === agentId)
    if (target) {
      await this.db.delete(groupChatMembers).where(eq(groupChatMembers.id, target.id))
    }
  }

  // ─── 消息 ───

  /**
   * 发送消息到群聊
   *
   * 1. 保存消息
   * 2. 返回保存的消息 (调用方负责触发调度)
   */
  async sendMessage(input: SendMessageInput): Promise<MessageRow> {
    return this.commitMessage(input)
  }

  /** 领域状态、公共事件、亲历与 Outbox 可在调用方的同一事务提交。 */
  commitMessage(input: SendMessageInput): MessageRow {
    return this.db.transaction((tx) => {
      if (input.audienceScope) {
        const scope = input.audienceScope
        const main = tx.select().from(threads).where(eq(threads.id, scope.threadId)).get()
        const source = tx.select({ id: groupChatMessages.id }).from(groupChatMessages)
          .where(and(eq(groupChatMessages.roomId, input.roomId), eq(groupChatMessages.pairId, scope.sourcePairId), eq(groupChatMessages.status, 'active'))).get()
        if (!main || main.agentId !== scope.agentId || main.generation !== scope.generation || main.status !== 'active' || !source)
          throw new Error('THREAD_GENERATION_STALE')
      }
      if (input.deliveryKey) {
        const delivered = tx.select().from(groupChatMessages).where(and(eq(groupChatMessages.roomId, input.roomId),
          sql`json_extract(${groupChatMessages.metadataJson}, '$.deliveryKey') = ${input.deliveryKey}`)).get()
        if (delivered) return delivered
      }
      if (input.execution) {
        const main = tx.select().from(threads).where(eq(threads.id, input.execution.threadId)).get()
        if (!main || main.threadKind !== 'main' || main.agentId !== input.senderId ||
          main.generation !== input.execution.generation || main.status !== 'active') {
          throw new Error('THREAD_GENERATION_STALE')
        }
        if (input.execution.sourcePairId || input.execution.sourceMessageId !== undefined) {
          const source = tx.select({ id: groupChatMessages.id }).from(groupChatMessages)
            .where(and(
              eq(groupChatMessages.roomId, input.roomId),
              input.execution.sourcePairId ? eq(groupChatMessages.pairId, input.execution.sourcePairId) : undefined,
              input.execution.sourceMessageId === undefined ? undefined : eq(groupChatMessages.id, input.execution.sourceMessageId),
              eq(groupChatMessages.status, 'active'),
            )).get()
          if (!source) throw new Error('STRONGHOLD_SOURCE_WITHDRAWN')
        }
        if (input.pairId) {
          const existing = this.getSceneReply(input.roomId, input.senderId, input.pairId, input.execution)
          if (existing) return existing
        }
      }
      const message = tx.insert(groupChatMessages).values({
          roomId: input.roomId,
          senderId: input.senderId,
          content: input.content,
          role: input.role,
          mentionsJson: JSON.stringify(input.mentions ?? []),
          pairId: input.pairId,
          metadataJson: JSON.stringify({
            ...input.metadata,
            threadId: input.execution?.threadId,
            threadGeneration: input.execution?.generation,
            sourceMessageId: input.execution?.sourceMessageId,
            deliveryKey: input.deliveryKey,
          }),
        }).returning().get()!
      const present = input.audienceAgentIds ?? tx.select({ agentId: agentLocations.agentId }).from(agentLocations)
        .where(eq(agentLocations.roomId, input.roomId)).all().map((row) => row.agentId)
      const targets: StrongholdReplyIntent['targets'] = []
      for (const agentId of new Set([...present, input.senderId])) {
        if (['user', 'system', 'Butler', 'butler'].includes(agentId) || !this.isEnabledAgent(agentId)) continue
        tx.insert(threads).values({
          id: `main_${crypto.randomUUID()}`,
          agentId,
          channel: 'desktop',
          purpose: 'conversation',
          threadKind: 'main',
          interactionMode: 'chat',
        }).onConflictDoNothing().run()
        const main = tx.select().from(threads)
          .where(and(eq(threads.agentId, agentId), eq(threads.threadKind, 'main'))).get()!
        targets.push({ agentId, threadId: main.id, generation: main.generation })
        tx.insert(agentExperiences).values({
          agentId,
          threadId: main.id,
          generation: main.generation,
          sourceMessageId: message.id,
          roomId: input.roomId,
          occurredAt: message.timestamp ?? new Date().toISOString(),
        }).onConflictDoNothing().run()
      }
      if (input.requestReplies && input.role !== 'system' && input.pairId) {
        const replyIntent: StrongholdReplyIntent = { status: 'pending', targets, completed: [], attempts: 0,
          autonomous: input.role === 'assistant' }
        message.metadataJson = JSON.stringify({ ...JSON.parse(message.metadataJson), replyIntent })
        tx.update(groupChatMessages).set({ metadataJson: message.metadataJson })
          .where(eq(groupChatMessages.id, message.id)).run()
      }
      const outbox = new KernelOutboxRepository(this.db)
      const event = outbox.createEvent({
        protocolVersion: 1,
        type: 'stronghold.message.committed',
        durability: 'durable',
        principalId: input.senderId,
        correlationId: input.pairId,
        executionId: input.execution?.executionId,
        payload: { roomId: input.roomId, messageId: message.id, pairId: input.pairId },
      })
      tx.insert(kernelOutboxEvents).values(outbox.toRow(event)).run()
      this.onMessageCommitted?.(message)
      return message
    })
  }

  /** 已落盘场景回复按角色、轮次和主线代次复用，重复投递共享同一条权威消息。 */
  getSceneReply(
    roomId: string,
    agentId: string,
    pairId: string,
    scope: { threadId: string; generation: number; sourceMessageId?: number },
  ): MessageRow | undefined {
    const source = scope.sourceMessageId === undefined ? undefined : this.db.select({ role: groupChatMessages.role })
      .from(groupChatMessages).where(and(eq(groupChatMessages.id, scope.sourceMessageId), eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.pairId, pairId))).get()
    return this.db.select().from(groupChatMessages).where(and(
      eq(groupChatMessages.roomId, roomId),
      eq(groupChatMessages.senderId, agentId),
      eq(groupChatMessages.pairId, pairId),
      eq(groupChatMessages.role, 'assistant'),
      eq(groupChatMessages.status, 'active'),
      sql`json_extract(${groupChatMessages.metadataJson}, '$.threadId') = ${scope.threadId}`,
      sql`json_extract(${groupChatMessages.metadataJson}, '$.threadGeneration') = ${scope.generation}`,
      scope.sourceMessageId === undefined ? undefined :
        or(sql`json_extract(${groupChatMessages.metadataJson}, '$.sourceMessageId') = ${scope.sourceMessageId}`,
          source?.role === 'user' ? sql`json_extract(${groupChatMessages.metadataJson}, '$.sourceMessageId') IS NULL` : undefined),
    )).get()
  }

  getReplyIntent(messageId: number): { message: MessageRow; intent: StrongholdReplyIntent } | undefined {
    const message = this.db.select().from(groupChatMessages).where(and(
      eq(groupChatMessages.id, messageId), eq(groupChatMessages.status, 'active'),
    )).get()
    if (!message) return undefined
    const intent = JSON.parse(message.metadataJson).replyIntent as StrongholdReplyIntent | undefined
    return intent ? { message, intent } : undefined
  }

  saveReplyIntent(messageId: number, intent: StrongholdReplyIntent): void {
    this.db.transaction((tx) => {
      const source = tx.select().from(groupChatMessages).where(and(
        eq(groupChatMessages.id, messageId), eq(groupChatMessages.status, 'active'),
      )).get()
      if (!source) return
      tx.update(groupChatMessages).set({
        metadataJson: JSON.stringify({ ...JSON.parse(source.metadataJson), replyIntent: intent }),
      }).where(eq(groupChatMessages.id, messageId)).run()
    })
  }

  pendingReplyIds(): number[] {
    return this.db.select({ id: groupChatMessages.id }).from(groupChatMessages).where(and(
      eq(groupChatMessages.status, 'active'),
      sql`json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.status') = 'pending'`,
      sql`coalesce(json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.retryAt'), 0) <= ${Date.now()}`,
      sql`(coalesce(json_array_length(json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.deferredAgentIds')), 0) = 0
        OR coalesce(json_array_length(json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.queue')), 0) > 0)`,
    )).orderBy(asc(groupChatMessages.id)).limit(50).all().map((row) => row.id)
  }

  getMessageEvent(messageId: number) {
    return this.db.select().from(groupChatMessages).where(and(eq(groupChatMessages.id, messageId), eq(groupChatMessages.status, 'active'))).get()
  }

  async getMessageEvents(roomId: string, afterMessageId: number, senderId?: string, sourcePairId?: string) {
    return this.db.select({ id: groupChatMessages.id, senderId: groupChatMessages.senderId }).from(groupChatMessages)
      .where(and(eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.status, 'active'),
        afterMessageId < 0 ? undefined : sql`${groupChatMessages.id} > ${afterMessageId}`,
        senderId ? eq(groupChatMessages.senderId, senderId) : undefined,
        sourcePairId ? eq(groupChatMessages.pairId, sourcePairId) : undefined))
      .orderBy(afterMessageId < 0 ? desc(groupChatMessages.id) : asc(groupChatMessages.id))
      .limit(afterMessageId < 0 || senderId ? 1 : 100).all()
  }

  /** 等待条件匹配后把回应请求附到真实来源；先持久化，再由轮次服务恢复。 */
  async requestRepliesTo(messageId: number, agentIds: string[], autonomous = true, scope?: { threadId: string; generation: number }): Promise<boolean> {
    return this.commitReplyRequest(messageId, agentIds, autonomous, scope, { kind: 'wait' })
  }

  commitReplyRequest(messageId: number, agentIds: string[], autonomous = true,
    scope?: { threadId: string; generation: number }, options: StrongholdReplyOptions = {}): boolean {
    return this.db.transaction((tx) => {
      const message = tx.select().from(groupChatMessages).where(and(eq(groupChatMessages.id, messageId), eq(groupChatMessages.status, 'active'))).get()
      if (!message || !message.pairId) return false
      const metadata = JSON.parse(message.metadataJson)
      const intent = metadata.replyIntent as StrongholdReplyIntent | undefined
      const targets = tx.select({ agentId: agentExperiences.agentId, threadId: threads.id, generation: threads.generation })
        .from(agentExperiences).innerJoin(threads, and(eq(threads.id, agentExperiences.threadId), eq(threads.generation, agentExperiences.generation)))
        .where(and(eq(agentExperiences.sourceMessageId, messageId), eq(agentExperiences.withdrawn, false),
          eq(threads.threadKind, 'main'), eq(threads.status, 'active'))).all()
      const rawMentions: unknown = JSON.parse(message.mentionsJson ?? '[]')
      const mentions = Array.isArray(rawMentions) ? rawMentions.filter((value): value is string => typeof value === 'string') : []
      const requested = [...new Set(agentIds)].filter((id) => targets.some((target) => target.agentId === id &&
        (!scope || (target.threadId === scope.threadId && target.generation === scope.generation))) && this.isEnabledAgent(id) &&
        (message.role !== 'user' || !mentions.length || mentions.includes('@all') || mentions.includes(id)))
      if (!requested.length) return false
      const completed = intent?.completed ?? []
      const declared = mentions.includes('@all') ? targets.map((target) => target.agentId) : mentions
      const candidates = [...new Set([...(intent?.queue ?? declared), ...requested])]
        .filter((id) => !completed.includes(id) && targets.some((target) => target.agentId === id))
      if (!candidates.length) return requested.every((id) => completed.includes(id))
      const queue: string[] = []
      const deferred = new Set(intent?.deferredAgentIds ?? [])
      const responseContexts: Record<string, StrongholdResponseContext> = Object.assign(Object.create(null), intent?.responseContexts)
      const watchIdsByAgent: Record<string, string[]> = Object.assign(Object.create(null), intent?.watchIdsByAgent)
      for (const agentId of candidates) {
        const admission = this.admitReply?.(message, agentId, options)
        if (intent?.queue?.includes(agentId) || !admission || admission.mode === 'immediate') {
          queue.push(agentId)
          deferred.delete(agentId)
        } else deferred.add(agentId)
        if (admission?.response && !intent?.queue?.includes(agentId)) responseContexts[agentId] = admission.response
        if (options.watchIds?.length && requested.includes(agentId))
          watchIdsByAgent[agentId] = [...new Set([...(watchIdsByAgent[agentId] ?? []), ...options.watchIds])]
      }
      const replyIntent: StrongholdReplyIntent = { ...intent, targets,
        status: 'pending', autonomous: intent?.autonomous ?? autonomous, queue,
        initialQueue: intent?.initialQueue ?? queue, completed, attempts: intent?.attempts ?? 0,
        deferredAgentIds: [...deferred], deferredUntil: deferred.size ? intent?.deferredUntil ?? Date.now() + STRONGHOLD_QUIET_WINDOW_MS : undefined,
        responseContexts, watchIdsByAgent,
        reason: '等待的真实事件已到达', allowSummon: true, allowAutoFollowUp: false }
      tx.update(groupChatMessages).set({ metadataJson: JSON.stringify({ ...metadata, replyIntent }) })
        .where(eq(groupChatMessages.id, messageId)).run()
      return true
    })
  }

  /** 回应阶段和关注消费身份随实际执行来源传播，旧消息沿角色身份推导回应阶段。 */
  getExecutionCause(messageId: number | undefined, agentId: string): {
    response?: StrongholdResponseContext; watchIds: string[]; watchAgentIds: string[]
  } {
    const message = messageId === undefined ? undefined : this.getMessageEvent(messageId)
    if (!message) return { watchIds: [], watchAgentIds: [] }
    const metadata = JSON.parse(message.metadataJson)
    const intent = metadata.replyIntent as StrongholdReplyIntent | undefined
    const initiatorId = message.role === 'system' ? metadata.lifeEvent?.actorId : message.senderId
    const response = (intent?.responseContexts && Object.hasOwn(intent.responseContexts, agentId) ? intent.responseContexts[agentId] : undefined) ??
      (message.role !== 'user' && typeof initiatorId === 'string' && initiatorId !== 'system'
        ? { phase: 'response' as const, openingMessageId: message.id, initiatorId } : undefined)
    const ownWatches = intent?.watchIdsByAgent && Object.hasOwn(intent.watchIdsByAgent, agentId) ? intent.watchIdsByAgent[agentId]! : []
    const fresh = intent?.freshInitiativeAgentIds?.includes(agentId)
    return { response,
      watchIds: [...new Set<string>([...(fresh ? [] : metadata.lifeWatchIds ?? []), ...ownWatches])],
      watchAgentIds: [...new Set<string>([...(fresh ? [] : metadata.lifeWatchAgentIds ?? []), ...(ownWatches.length ? [agentId] : [])])],
    }
  }

  /** 延后请求仅由正常空闲机会领取，周期恢复保持其等待状态。 */
  claimDeferredReply(roomId: string, agentId: string): number | undefined {
    return this.db.transaction((tx) => {
      const rows = tx.select().from(groupChatMessages).where(and(eq(groupChatMessages.roomId, roomId),
        eq(groupChatMessages.status, 'active'), sql`json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.status') = 'pending'`,
        sql`coalesce(json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.deferredUntil'), 0) <= ${Date.now()}`,
        sql`EXISTS (SELECT 1 FROM json_each(json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.deferredAgentIds')) WHERE value = ${agentId})`,
      )).orderBy(asc(groupChatMessages.id)).all()
      for (const message of rows) {
        const metadata = JSON.parse(message.metadataJson)
        const intent = metadata.replyIntent as StrongholdReplyIntent
        const valid = this.deferredTargetIsCurrent(message, intent, agentId)
        const deferredAgentIds = intent.deferredAgentIds!.filter((id) => id !== agentId)
        const queue = valid ? [...new Set([...(intent.queue ?? []), agentId])] : intent.queue ?? []
        this.saveReplyIntent(message.id, { ...intent, queue, deferredAgentIds,
          freshInitiativeAgentIds: valid ? [...new Set([...(intent.freshInitiativeAgentIds ?? []), agentId])] : intent.freshInitiativeAgentIds,
          status: queue.length || deferredAgentIds.length ? 'pending' : 'completed' })
        if (valid) return message.id
      }
      return undefined
    })
  }

  hasDeferredReply(roomId: string, agentId: string): boolean {
    return Boolean(this.db.select({ id: groupChatMessages.id }).from(groupChatMessages).where(and(
      eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.status, 'active'),
      sql`json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.status') = 'pending'`,
      sql`EXISTS (SELECT 1 FROM json_each(json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.deferredAgentIds')) WHERE value = ${agentId})`,
    )).get())
  }

  isReplySourceCurrent(message: MessageRow): boolean {
    return this.canResumeReply?.(message) ?? true
  }

  pruneDeferredReplies(threadId?: string, pairId?: string, roomId?: string): void {
    this.db.transaction(() => {
      const rows = this.db.select().from(groupChatMessages).where(and(eq(groupChatMessages.status, 'active'),
        roomId ? eq(groupChatMessages.roomId, roomId) : undefined,
        sql`json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.status') = 'pending'`,
        sql`coalesce(json_array_length(json_extract(${groupChatMessages.metadataJson}, '$.replyIntent.deferredAgentIds')), 0) > 0`,
      )).all()
      for (const message of rows) {
        const metadata = JSON.parse(message.metadataJson)
        const intent = metadata.replyIntent as StrongholdReplyIntent
        const invalidateSource = (threadId && metadata.threadId === threadId) || (pairId && message.pairId === pairId)
        const deferredAgentIds = intent.deferredAgentIds!.filter((id) => !invalidateSource &&
          (!threadId || intent.targets.find((target) => target.agentId === id)?.threadId !== threadId) &&
          this.deferredTargetIsCurrent(message, intent, id))
        if (deferredAgentIds.length === intent.deferredAgentIds!.length) continue
        this.saveReplyIntent(message.id, { ...intent, deferredAgentIds,
          status: intent.queue?.length || deferredAgentIds.length ? 'pending' : 'completed' })
      }
    })
  }

  private deferredTargetIsCurrent(message: MessageRow, intent: StrongholdReplyIntent, agentId: string): boolean {
    if (!this.isReplySourceCurrent(message)) return false
    const metadata = JSON.parse(message.metadataJson)
    const target = intent.targets.find((entry) => entry.agentId === agentId)
    if (!target || !this.isEnabledAgent(agentId)) return false
    const witness = this.db.select({ id: agentExperiences.id }).from(agentExperiences)
      .innerJoin(threads, and(eq(threads.id, agentExperiences.threadId), eq(threads.generation, agentExperiences.generation)))
      .innerJoin(agentLocations, and(eq(agentLocations.agentId, agentId), eq(agentLocations.roomId, message.roomId)))
      .where(and(eq(agentExperiences.sourceMessageId, message.id), eq(agentExperiences.agentId, agentId),
        eq(agentExperiences.threadId, target.threadId), eq(agentExperiences.generation, target.generation),
        eq(agentExperiences.withdrawn, false), eq(threads.threadKind, 'main'), eq(threads.status, 'active'))).get()
    if (!witness) return false
    if (!metadata.threadId) return true
    const author = this.db.select().from(threads).where(eq(threads.id, metadata.threadId)).get()
    return author?.threadKind === 'main' && author.status === 'active' && author.generation === metadata.threadGeneration
  }

  /** 获取房间消息总数（对话日志列表展示用，避免拉取全量）。 */
  async countMessages(roomId: string): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(groupChatMessages)
      .where(and(eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.status, 'active')))
      .get()
    return row?.count ?? 0
  }

  /** 获取房间历史消息 (最新 N 条，按时间正序) */
  async getHistory(roomId: string, limit = 50, throughMessageId?: number): Promise<MessageRow[]> {
    const msgs = await this.db
      .select()
      .from(groupChatMessages)
      .where(and(eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.status, 'active'),
        throughMessageId === undefined ? undefined : sql`${groupChatMessages.id} <= ${throughMessageId}`))
      .orderBy(desc(groupChatMessages.id))
      .limit(limit)
      .all()

    // 反转为时间正序
    return msgs.reverse()
  }

  /** 兼容旧亲历表的导入入口；新消息由 sendMessage 固定实际在场关系。 */
  async recordPairVisibility(roomId: string, pairId: string, agentIds: string[]): Promise<void> {
    const uniqueAgentIds = [...new Set(agentIds)]
    if (uniqueAgentIds.length === 0) return
    await this.db
      .insert(strongholdAgentPairVisibility)
      .values(
        uniqueAgentIds.map((agentId) => ({
          agentId,
          roomId,
          pairId,
        })),
      )
      .onConflictDoNothing()
  }

  /** 按预算读取角色在指定房间亲历的历史。 */
  async getVisibleHistoryByBudget(agentId: string, tokenBudget: number, roomId: string): Promise<MessageRow[]> {
    const messages = await this.getVisibleHistoryPairs(agentId, 10000, false, roomId)
    const selected: MessageRow[] = []
    let used = 0
    for (const message of messages.reverse()) {
      const tokens = tokenCounter.countTokens(message.content) + 8
      if (selected.length && used + tokens > tokenBudget) break
      selected.push(message)
      used += tokens
    }
    return selected.reverse()
  }

  async getVisibleHistoryPairs(
    agentId: string,
    pairLimit = 20,
    stable = false,
    roomId?: string,
  ): Promise<MessageRow[]> {
    const normalizedLimit = Math.max(1, pairLimit)
    const perceived = this.db.select({ message: groupChatMessages }).from(agentExperiences)
      .innerJoin(groupChatMessages, eq(groupChatMessages.id, agentExperiences.sourceMessageId))
      .innerJoin(threads, and(eq(threads.id, agentExperiences.threadId), eq(threads.generation, agentExperiences.generation)))
      .where(and(eq(agentExperiences.agentId, agentId), eq(agentExperiences.withdrawn, false),
        eq(threads.threadKind, 'main'), eq(threads.status, 'active'), eq(groupChatMessages.status, 'active'),
        roomId === undefined ? undefined : eq(groupChatMessages.roomId, roomId)))
      .orderBy(desc(agentExperiences.id)).all().map((row) => row.message)
    const recentPairs = [...new Set(perceived.map((row) => row.pairId ?? `message:${row.id}`))]
      .slice(0, normalizedLimit + (stable ? 1 : 0)).reverse()
    const pairs = stable
      ? stableHistoryWindow(roomId === undefined ? `stronghold:${agentId}` : `stronghold:${roomId}:${agentId}`,
          recentPairs, normalizedLimit, (pair) => pair)
      : recentPairs
    const selectedPairs = new Set(pairs)
    return perceived.filter((row) => selectedPairs.has(row.pairId ?? `message:${row.id}`)).reverse()
  }

  /** 获取最近 N 个完整群聊回合；一个 pair 包含用户发言及本轮全部回复。 */
  async getHistoryPairs(roomId: string, pairLimit = 20): Promise<MessageRow[]> {
    const normalizedLimit = Math.max(1, pairLimit)
    const pairKey = sql<string>`coalesce(${groupChatMessages.pairId}, '__message__:' || ${groupChatMessages.id})`
    const latestId = sql<number>`max(${groupChatMessages.id})`
    const recentPairs = await this.db
      .select({ pairKey, latestId })
      .from(groupChatMessages)
      .where(and(eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.status, 'active')))
      .groupBy(pairKey)
      .orderBy(desc(latestId))
      .limit(normalizedLimit)
      .all()

    if (recentPairs.length === 0) return []
    const pairIds = recentPairs
      .map((row) => row.pairKey)
      .filter((key) => !key.startsWith('__message__:'))
    const legacyMessageIds = recentPairs
      .map((row) => row.pairKey)
      .filter((key) => key.startsWith('__message__:'))
      .map((key) => Number(key.slice('__message__:'.length)))
      .filter(Number.isInteger)
    const selectors = []
    if (pairIds.length > 0) selectors.push(inArray(groupChatMessages.pairId, pairIds))
    if (legacyMessageIds.length > 0) {
      selectors.push(
        and(isNull(groupChatMessages.pairId), inArray(groupChatMessages.id, legacyMessageIds))!,
      )
    }

    return this.db
      .select()
      .from(groupChatMessages)
      .where(
        and(
          eq(groupChatMessages.roomId, roomId),
          eq(groupChatMessages.status, 'active'),
          selectors.length === 1 ? selectors[0] : or(...selectors),
        ),
      )
      .orderBy(asc(groupChatMessages.id))
      .all()
  }

  /**
   * 级联删除一轮据点对话。
   *
   * 新消息通过 pairId 精确删除用户发言和本轮全部 Agent/system 回复；
   * 旧消息没有 pairId 时保守地只删除目标消息，避免群聊中按相邻记录误删。
   */
  async deleteMessagePair(roomId: string, messageId: number): Promise<DeleteMessagePairResult> {
    invalidatePromptReplay()
    const target = await this.db
      .select()
      .from(groupChatMessages)
      .where(and(eq(groupChatMessages.id, messageId), eq(groupChatMessages.roomId, roomId)))
      .get()

    if (!target) {
      throw new Error(`消息 ${messageId} 不存在或不属于房间 ${roomId}`)
    }

    const condition = target.pairId
      ? and(eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.pairId, target.pairId))
      : and(eq(groupChatMessages.id, messageId), eq(groupChatMessages.roomId, roomId))
    const rows = this.db.transaction((tx) => {
      const removed = tx.update(groupChatMessages).set({ status: 'deleted' })
        .where(and(condition, eq(groupChatMessages.status, 'active'))).returning().all()
      if (removed.length) tx.update(agentExperiences).set({ withdrawn: true })
        .where(inArray(agentExperiences.sourceMessageId, removed.map((row) => row.id))).run()
      return removed
    })
    if (target.pairId) await this.rollbackCharacterState?.(roomId, target.pairId)

    return {
      deletedCount: rows.length,
      deletedMessageIds: rows.map((row) => row.id),
    }
  }

  /** 判断本轮用户消息仍存在，防止删除后异步 Agent 回复迟到写回。 */
  async isPairActive(roomId: string, pairId: string): Promise<boolean> {
    const message = await this.db
      .select({ id: groupChatMessages.id })
      .from(groupChatMessages)
      .where(and(eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.pairId, pairId), eq(groupChatMessages.status, 'active')))
      .get()
    return Boolean(message)
  }

  // ─── 视角转换 ───

  /**
   * 将群聊历史转换为特定 Agent 的 LLM 消息视角。
   *
   * 每条消息都保留显式sender标签，避免多个来源共用user角色后让模型误判说话者。
   * 当前Agent自己的历史仍使用assistant角色，其他参与者使用user角色。
   */
  convertPerspective(
    messages: MessageRow[],
    agentId: string,
    ownerName = '用户',
  ): PerspectiveMessage[] {
    return messages.map((msg) => {
      const senderId = msg.senderId || 'unknown'
      const tag = this.normalizeMessageTag(senderId === 'user' ? ownerName : senderId)
      const time =
        senderId !== 'user' && msg.timestamp ? `, time=${this.escapeAttribute(msg.timestamp)}` : ''
      const taggedContent = `<${tag}${time}>${this.escapeContent(msg.content)}</${tag}>`
      if (senderId === agentId) {
        return { role: 'assistant' as const, content: taggedContent }
      }
      if (
        msg.role === 'system' ||
        senderId === 'Butler' ||
        senderId === 'butler' ||
        senderId === 'system'
      ) {
        return { role: 'system' as const, content: taggedContent }
      }
      return { role: 'user' as const, content: taggedContent }
    })
  }

  private normalizeMessageTag(value: string): string {
    const normalized = value.trim().replace(/[^\p{L}\p{N}_-]/gu, '_')
    return normalized || 'unknown'
  }

  private escapeContent(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }

  private escapeAttribute(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;')
  }

  /**
   * 获取 Agent 候选列表 (排除 user/system/Butler)
   */
  async getCandidateAgents(roomId: string): Promise<string[]> {
    const members = await this.getRoomMembers(roomId)
    return members.map((m) => m.agentId).filter((id) => !['user', 'system', 'Butler'].includes(id))
  }
}
