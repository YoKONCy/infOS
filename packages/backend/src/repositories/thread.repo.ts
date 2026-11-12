/**
 * Thread Repository
 *
 * threads + thread_messages + thread_summaries 表的数据访问层。
 * 消息是不可变事件流，只追加，不修改。删除通过软删除实现。
 *
 * @module packages/backend/src/repositories/thread.repo
 */

import type {
  InteractionMode,
  AchievementId,
  KernelExecutionDescriptor,
  KernelObjectId,
  ThreadChannel,
} from '@infos/shared'
import { eq, ne, desc, asc, sql, and, or, inArray, notInArray, isNull } from 'drizzle-orm'
import {
  threads,
  threadMessages,
  threadSummaries,
  kernelOutboxEvents,
  achievements,
  flowStates,
  flowStateRevisions,
  taskPlans,
  taskPlanMutations,
  configs,
  agentExperiences,
  groupChatMessages,
  groupChatRooms,
  agentCharacterStateEvents,
  conversationExecutions,
  conversationExpectations,
  conversationMessageSources,
  workContextClears,
  messageAttachments,
} from '../database/schema'
import { editedMessageMetadata } from './messageEdit'
import type { DrizzleDb } from '../database'
import type { KernelOutboxRepository } from '../kernel/kernelOutboxRepository'
import type { ExecutionMode } from '@infos/shared'
import { AppError } from '../lib/appError'
import { ConversationRepository } from './conversation.repo'
import { WorkContextClearRepository } from './workContextClear.repo'
import type { ConversationSource } from '@infos/shared'
import { conversationSourceKey } from '@infos/shared'
import { t } from '../lib/i18n'

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export type { ThreadChannel } from '@infos/shared'

/** Thread 用途 — 普通对话 / 后台任务 / 应用内部状态 */
export type ThreadPurpose = 'conversation' | 'background_task' | 'app_internal'

/** Thread 创建输入 */
export interface CreateThreadInput {
  id: string
  agentId: string
  channel: ThreadChannel
  platform?: string
  platformIdentifier?: string
  title?: string
  /**
   * ContextPolicy（JSON 序列化的 ChannelPolicy 字符串）
   * null/undefined 表示使用 DEFAULT_POLICIES 中该 channel 的默认策略
   * 传入时覆盖默认策略，允许 Thread 级别自定义上下文窗口/记忆检索等行为
   */
  contextPolicy?: string | null
  /** M05: Thread 用途，默认 conversation；后台任务传 background_task 与聊天历史隔离 */
  purpose?: ThreadPurpose
  interactionMode?: InteractionMode
  /** 以下会话设置用于新会话继承；未传时使用列默认值。 */
  executionMode?: ExecutionMode
  modelConfigId?: number | null
  reasoningEffort?: import('@infos/shared').ReasoningEffort | null
}

/** Thread 消息创建输入 */
export interface CreateThreadMessageInput {
  /** 仅业务规则可提供；与有效回复在同一事务中记录，失败则一起回滚。 */
  achievement?: { subjectId: string; id: AchievementId }
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  rawContent?: string
  pairId?: string
  publicationId?: string
  executionId?: string
  sourceMessages?: ConversationSource[]
  respondsTo?: string[]
  senderId?: string
  agentId?: string
  metadataJson?: string
  scorerStatus?: 'pending' | 'analyzed' | 'failed' | 'skipped'
  status?: 'active' | 'failed' | 'interrupted'
  /** 当前消息提交所属的 Kernel Execution；存在时在同一事务写入 Outbox。 */
  execution?: KernelExecutionDescriptor
  expectedGeneration?: number
}

/** 查询活跃消息参数 */
export interface QueryActiveMessagesParams {
  threadId: string
  beforeMessageId?: number
  orderById?: boolean
  roles?: Array<'user' | 'assistant'>
  /** 返回最近 N 条（默认 20） */
  limit?: number
}

/** Thread 摘要创建输入 */
export interface CreateSummaryInput {
  threadId: string
  content: string
  coversMessageIds: string[]
}

// Drizzle 推导行类型
type ThreadRow = typeof threads.$inferSelect
type ThreadMessageRow = typeof threadMessages.$inferSelect
type ThreadSummaryRow = typeof threadSummaries.$inferSelect
interface MemorySourceInfo {
  available: boolean
  withdrawn: boolean
  revised: boolean
  messages: Array<{ id: number; role: string; content: string; timestamp: string | null; pairId: string | null; roomId?: string }>
}
export type ContinuityMessageRow = ThreadMessageRow & {
  threadAgentId: string
  threadChannel: string
  threadPlatform: string | null
  threadTitle: string | null
}

// ─────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────

export class ThreadRepository {
  readonly conversations: ConversationRepository
  constructor(
    private db: DrizzleDb,
    private outbox?: KernelOutboxRepository,
  ) {
    this.conversations = new ConversationRepository(db, outbox)
  }

  // ── Thread 操作 ──

  /** 唯一索引处理并发创建，迁移只补建空主线。 */
  ensureMainThread(agentId: string): ThreadRow {
    this.db.insert(threads).values({
      id: `main_${crypto.randomUUID()}`,
      agentId,
      channel: 'desktop',
      purpose: 'conversation',
      threadKind: 'main',
      interactionMode: 'chat',
    }).onConflictDoNothing().run()
    const row = this.db.select().from(threads)
      .where(and(eq(threads.agentId, agentId), eq(threads.threadKind, 'main'))).get()
    if (!row || row.status !== 'active') throw new Error('MAIN_THREAD_UNAVAILABLE')
    return row
  }

  workContextBoundary(threadId: string, generation: number) {
    return new WorkContextClearRepository(this.db).latest(threadId, generation)
  }

  assertMainMemoryWrite(threadId: string, agentId: string, generation?: number): void {
    const thread = this.db.select().from(threads).where(eq(threads.id, threadId)).get()
    if (!thread || thread.status !== 'active' || thread.threadKind !== 'main' ||
        thread.agentId !== agentId || generation === undefined || thread.generation !== generation)
      throw new AppError('FORBIDDEN', { message: t('server.agent', '此记忆操作仅限有效的主会话执行') })
  }

  async assertGeneration(threadId: string, generation: number): Promise<void> {
    const thread = await this.getThread(threadId)
    if (!thread || thread.status !== 'active' || thread.generation !== generation)
      throw new AppError('CONFLICT', { message: '会话已重置，本次执行已过期' })
  }

  async latestExperienceId(): Promise<number> {
    return this.db.select({ id: sql<number>`coalesce(max(id), 0)` }).from(agentExperiences).get()!.id
  }

  async memoryDraftMessage(messageId: number, scene: boolean) {
    if (scene) {
      const row = this.db.select().from(groupChatMessages).where(eq(groupChatMessages.id, messageId)).get()
      if (!row || row.status !== 'active' || row.role !== 'assistant' || !row.pairId) return undefined
      const metadata = JSON.parse(row.metadataJson ?? '{}') as Record<string, unknown>
      return { revision: 1, threadId: String(metadata.threadId ?? ''), agentId: row.senderId, pairId: row.pairId,
        timestamp: row.timestamp, metadata, sceneRoomId: row.roomId }
    }
    const row = this.db.select().from(threadMessages).where(eq(threadMessages.id, messageId)).get()
    if (!row || row.status !== 'active' || row.role !== 'assistant' || !row.pairId || !row.agentId) return undefined
    const metadata = JSON.parse(row.metadataJson ?? '{}') as Record<string, unknown>
    return { revision: row.revision ?? 1, threadId: row.threadId, agentId: row.agentId, pairId: row.pairId, timestamp: row.timestamp,
      metadata, sceneRoomId: undefined }
  }

  async memorySource(origin: import('@infos/shared').EventNoteOrigin): Promise<MemorySourceInfo> {
    const sourceIds = [...new Set([
      ...(origin.messageIds ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
      ...origin.pairIds.flatMap((key) => {
        const match = /^message:(\d+)@\d+$/.exec(key)
        return match ? [Number(match[1])] : []
      }),
    ])]
    const messages = origin.pairIds.length || sourceIds.length ? this.db.select().from(threadMessages)
      .where(and(eq(threadMessages.threadId, origin.threadId), or(
        inArray(threadMessages.pairId, origin.pairIds), inArray(threadMessages.id, sourceIds),
      )))
      .orderBy(asc(threadMessages.id)).all() : []
    const experiences = origin.experienceIds?.length ? this.db.select({
      id: agentExperiences.id, sourceId: groupChatMessages.id, role: groupChatMessages.role,
      content: groupChatMessages.content, timestamp: agentExperiences.occurredAt,
      roomId: groupChatMessages.roomId, senderId: groupChatMessages.senderId,
      pairId: groupChatMessages.pairId, withdrawn: agentExperiences.withdrawn, status: groupChatMessages.status,
    }).from(agentExperiences).innerJoin(groupChatMessages, eq(groupChatMessages.id, agentExperiences.sourceMessageId))
      .where(and(eq(agentExperiences.threadId, origin.threadId), inArray(agentExperiences.id, origin.experienceIds.map(Number))))
      .orderBy(asc(agentExperiences.id)).all() : []
    const additional = await Promise.all((origin.sources ?? []).map((source) => this.memorySource(source)))
    return {
      available: messages.length > 0 || experiences.length > 0 || additional.some((source) => source.available),
      withdrawn: sourceIds.some((id) => !messages.some((message) => message.id === id)) ||
        messages.some((message) => message.status === 'deleted') || experiences.some((item) => item.withdrawn || item.status !== 'active') || additional.some((source) => source.withdrawn),
      revised: messages.some((message) => origin.messageRevisions?.[String(message.id)] !== undefined && origin.messageRevisions[String(message.id)] !== message.revision) || additional.some((source) => source.revised),
      messages: [
        ...messages.map((message) => ({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp, pairId: message.pairId })),
        ...experiences.map((item) => ({ id: -item.id, role: item.senderId, content: item.content, timestamp: item.timestamp, pairId: item.pairId, roomId: item.roomId })),
        ...additional.flatMap((source) => source.messages),
      ],
    }
  }

  /** 亲历读取始终联结当前代次与来源有效性，正文由房间消息持有。 */
  async queryExperiences(threadId: string, limit = 30, throughId?: number,
    scene: { roomId?: string; pairId?: string; throughMessageId?: number; conversationOnly?: boolean } = {}) {
    return this.db.select({
      id: agentExperiences.id, roomId: agentExperiences.roomId,
      roomName: groupChatRooms.name,
      sourceMessageId: groupChatMessages.id, senderId: groupChatMessages.senderId,
      content: groupChatMessages.content, role: groupChatMessages.role,
      lifeEventJson: sql<string | null>`json_extract(${groupChatMessages.metadataJson}, '$.lifeEvent')`,
      timestamp: agentExperiences.occurredAt, generation: agentExperiences.generation,
      pairId: groupChatMessages.pairId,
    }).from(agentExperiences)
      .innerJoin(threads, and(eq(threads.id, agentExperiences.threadId), eq(threads.generation, agentExperiences.generation)))
      .innerJoin(groupChatMessages, eq(groupChatMessages.id, agentExperiences.sourceMessageId))
      .leftJoin(groupChatRooms, eq(groupChatRooms.id, agentExperiences.roomId))
      .where(and(eq(agentExperiences.threadId, threadId), eq(agentExperiences.withdrawn, false),
        eq(groupChatMessages.status, 'active'), throughId === undefined ? undefined : sql`${agentExperiences.id} <= ${throughId}`,
        scene.conversationOnly ? inArray(groupChatMessages.role, ['user', 'assistant']) : undefined,
        scene.roomId ? eq(groupChatMessages.roomId, scene.roomId) : undefined,
        scene.pairId ? eq(groupChatMessages.pairId, scene.pairId) : undefined,
        scene.throughMessageId === undefined ? undefined : sql`${groupChatMessages.id} <= ${scene.throughMessageId}`))
      .orderBy(desc(agentExperiences.id)).limit(limit > 0 ? limit : -1).all().reverse()
  }

  async queryMemoryExperiencesThrough(threadId: string, throughId: number): Promise<ThreadMessageRow[]> {
    const rows = await this.queryExperiences(threadId, 0, throughId)
    return rows.map((row) => ({
      id: -row.id, threadId, role: 'system',
      content: JSON.stringify({ source: 'stronghold', sourceMessageId: row.sourceMessageId, roomId: row.roomId,
        senderId: row.senderId, content: row.content, lifeEvent: row.lifeEventJson ? JSON.parse(row.lifeEventJson) : undefined }),
      rawContent: null, status: 'active', pairId: `experience:${row.id}`, senderId: row.senderId,
      publicationId: null, executionId: null,
      revision: 1, agentId: null, metadataJson: '{}', scorerStatus: 'pending',
      timestamp: row.timestamp, deletedAt: null, deletedBy: null,
    }))
  }

  /** 消息、局部现场和代次一起提交，来源记录继续用于追溯。 */
  async resetMainThread(threadId: string, variables?: { key: string; value: string }): Promise<number> {
    return this.db.transaction((tx) => {
      const thread = tx.select().from(threads).where(eq(threads.id, threadId)).get()
      if (!thread || thread.status !== 'active') throw new Error('THREAD_NOT_FOUND')
      if (thread.threadKind !== 'main')
        throw new AppError('FORBIDDEN', { message: '仅主会话支持清空重置' })
      tx.update(threadMessages).set({
        status: 'deleted', deletedBy: 'reset', deletedAt: new Date().toISOString(),
      }).where(and(eq(threadMessages.threadId, threadId), ne(threadMessages.status, 'deleted'))).run()
      tx.update(threads).set({
        generation: thread.generation + 1,
        messageCount: 0, pairCount: 0, lastMessageAt: null,
        updatedAt: sql`datetime('now', 'localtime')`,
      }).where(eq(threads.id, threadId)).run()
      tx.delete(workContextClears).where(eq(workContextClears.threadId, threadId)).run()
      tx.delete(flowStates).where(eq(flowStates.threadId, threadId)).run()
      tx.delete(flowStateRevisions).where(eq(flowStateRevisions.threadId, threadId)).run()
      tx.update(threadSummaries).set({ isStale: true }).where(eq(threadSummaries.threadId, threadId)).run()
      tx.delete(taskPlans).where(eq(taskPlans.threadId, threadId)).run()
      tx.delete(taskPlanMutations).where(eq(taskPlanMutations.threadId, threadId)).run()
      tx.update(conversationExecutions).set({ status: 'reset' }).where(eq(conversationExecutions.threadId, threadId)).run()
      tx.update(conversationExpectations).set({ status: 'cancelled' }).where(eq(conversationExpectations.threadId, threadId)).run()
      if (variables) tx.insert(configs).values(variables)
        .onConflictDoUpdate({ target: configs.key, set: { value: variables.value } }).run()
      return thread.generation + 1
    })
  }

  async updateModelSettings(
    threadId: string,
    settings: {
      modelConfigId: number | null
      reasoningEffort: import('@infos/shared').ReasoningEffort | null
    },
  ): Promise<boolean> {
    const result = await this.db
      .update(threads)
      .set({ ...settings, updatedAt: sql`datetime('now', 'localtime')` })
      .where(and(eq(threads.id, threadId), eq(threads.status, 'active')))
    return result.changes > 0
  }

  /** 创建 Thread */
  async createThread(data: CreateThreadInput): Promise<ThreadRow> {
    const rows = await this.db
      .insert(threads)
      .values({
        id: data.id,
        agentId: data.agentId,
        channel: data.channel,
        platform: data.platform,
        platformIdentifier: data.platformIdentifier,
        title: data.title ?? '',
        contextPolicy: data.contextPolicy ?? null,
        purpose: data.purpose ?? 'conversation',
        interactionMode:
          data.interactionMode ??
          (data.channel === 'desktop' && (!data.purpose || data.purpose === 'conversation')
            ? 'chat'
            : 'work'),
        ...(data.executionMode
          ? { executionMode: data.executionMode, autoExecuteTools: data.executionMode !== 'manual' }
          : {}),
        ...(data.modelConfigId !== undefined ? { modelConfigId: data.modelConfigId } : {}),
        ...(data.reasoningEffort !== undefined ? { reasoningEffort: data.reasoningEffort } : {}),
      })
      .returning()
    return rows[0]!
  }

  /**
   * 查询角色最近活跃的普通桌面对话，用于新会话继承会话设置。
   *
   * 数据库触发器为创建、设置、消息计数和标题等写入分配单调活动序号，
   * 同一秒内的操作也按真实写入顺序排序，不依赖墙上时间。
   */
  async findLatestConversation(agentId: string): Promise<ThreadRow | undefined> {
    const rows = await this.db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.agentId, agentId),
          eq(threads.channel, 'desktop'),
          eq(threads.purpose, 'conversation'),
          eq(threads.status, 'active'),
        ),
      )
      .orderBy(desc(threads.activitySeq))
      .limit(1)
    return rows[0]
  }

  /** 根据 ID 查询 Thread */
  async getThread(id: string): Promise<ThreadRow | undefined> {
    const rows = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.id, id), eq(threads.status, 'active')))
      .limit(1)
    return rows[0]
  }

  /** 查询 Thread 列表；未传 agentId 时不按单一角色过滤。 */
  async listThreads(params: {
    agentId?: string
    agentIds?: string[]
    channel?: string
    /** 排除指定 Channel；用于主应用列表隔离独立应用的内部 Thread。 */
    excludeChannels?: string[]
    /** M05: 按用途过滤；不传时保持向后兼容（返回全部用途） */
    purpose?: ThreadPurpose
    threadKind?: 'main' | 'side'
    page?: number
    pageSize?: number
  }): Promise<{ items: ThreadRow[]; total: number }> {
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20))
    const offset = (page - 1) * pageSize

    const conditions = [eq(threads.status, 'active')]
    if (params.threadKind) conditions.push(eq(threads.threadKind, params.threadKind))
    if (params.agentId) {
      conditions.push(eq(threads.agentId, params.agentId))
    } else if (params.agentIds) {
      if (params.agentIds.length === 0) return { items: [], total: 0 }
      conditions.push(inArray(threads.agentId, params.agentIds))
    }
    if (params.channel) {
      conditions.push(eq(threads.channel, params.channel))
    }
    if (params.excludeChannels?.length) {
      conditions.push(notInArray(threads.channel, params.excludeChannels))
    }
    if (params.purpose) {
      conditions.push(eq(threads.purpose, params.purpose))
    }
    const whereClause = and(...conditions)

    const items = await this.db
      .select()
      .from(threads)
      .where(whereClause)
      .orderBy(asc(threads.threadKind), desc(threads.lastMessageAt), desc(threads.createdAt))
      .limit(pageSize)
      .offset(offset)

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(threads)
      .where(whereClause)
    const total = countResult[0]?.count ?? 0

    return { items, total }
  }

  /** 查询或创建 Agent 的最新 Thread */
  async getOrCreateLatestThread(
    agentId: string,
    channel: ThreadChannel,
    purpose: ThreadPurpose = 'conversation',
  ): Promise<ThreadRow> {
    if (channel === 'desktop' && purpose === 'conversation') return this.ensureMainThread(agentId)
    // 查找最新的活跃 Thread
    const existing = await this.db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.agentId, agentId),
          eq(threads.channel, channel),
          eq(threads.purpose, purpose),
          eq(threads.status, 'active'),
        ),
      )
      .orderBy(desc(threads.lastMessageAt), desc(threads.createdAt))
      .limit(1)

    if (existing.length > 0) {
      return existing[0]!
    }

    // 没有则创建
    return this.createThread({
      id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      channel,
      purpose,
    })
  }

  /** 标记指定 Channel 的全部旧 Thread 与消息为已删除，用于移除持久通道时清理历史数据。 */
  async softDeleteByChannel(channel: string): Promise<number> {
    await this.db
      .update(threadMessages)
      .set({
        status: 'deleted',
        deletedAt: sql`(datetime('now', 'localtime'))`,
        deletedBy: 'migration',
      })
      .where(
        and(
          eq(threadMessages.status, 'active'),
          inArray(
            threadMessages.threadId,
            this.db.select({ id: threads.id }).from(threads).where(and(eq(threads.channel, channel), eq(threads.threadKind, 'side'))),
          ),
        ),
      )
    const result = await this.db
      .update(threads)
      .set({
        status: 'deleted',
        updatedAt: sql`(datetime('now', 'localtime'))`,
      })
      .where(and(eq(threads.channel, channel), eq(threads.status, 'active'), eq(threads.threadKind, 'side')))
    return result.changes
  }

  /** 只读取活跃轮次标识，用于会话删除统计，不访问文件检查点。 */
  async activePairIds(threadId: string): Promise<string[]> {
    const rows = this.db
      .select({ pairId: threadMessages.pairId })
      .from(threadMessages)
      .where(and(eq(threadMessages.threadId, threadId), ne(threadMessages.status, 'deleted')))
      .orderBy(asc(threadMessages.id))
      .all()
    return [...new Set(rows.flatMap((row) => (row.pairId ? [row.pairId] : [])))]
  }

  /** 软删除整条 Thread 及其活跃消息，保留记录供审计恢复。 */
  async softDeleteThread(threadId: string): Promise<{ deleted: boolean; messageIds: number[] }> {
    return this.db.transaction((tx) => {
      const activeThread = tx
        .select({ id: threads.id, threadKind: threads.threadKind })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.status, 'active')))
        .get()
      if (!activeThread) return { deleted: false, messageIds: [] }
      if (activeThread.threadKind === 'main')
        throw new AppError('FORBIDDEN', { message: '主会话只能清空重置' })
      const messageIds = tx
        .select({ id: threadMessages.id })
        .from(threadMessages)
        .where(and(eq(threadMessages.threadId, threadId), ne(threadMessages.status, 'deleted')))
        .all()
        .map((row) => row.id)
      if (messageIds.length > 0)
        tx.update(threadMessages)
          .set({
            status: 'deleted',
            deletedAt: sql`(datetime('now', 'localtime'))`,
            deletedBy: 'user',
          })
          .where(inArray(threadMessages.id, messageIds))
          .run()
      tx.update(threads)
        .set({ status: 'deleted', updatedAt: sql`(datetime('now', 'localtime'))` })
        .where(eq(threads.id, threadId))
        .run()
      return { deleted: true, messageIds }
    })
  }

  /**
   * 更新 Thread 的消息计数。
   *
   * @param pairCount      本轮新增的对话对数（assistant 消息数）
   * @param messageCountDelta 本轮新增的消息条数（默认 1）
   *
   * messageCount 统一统计「所有消息」（user + assistant + system），
   * 与 syncThreadStats 的重算口径保持一致。
   */
  async updateMessageCount(
    threadId: string,
    pairCount: number,
    messageCountDelta = 1,
  ): Promise<void> {
    await this.db
      .update(threads)
      .set({
        messageCount: sql`message_count + ${messageCountDelta}`,
        pairCount: sql`pair_count + ${pairCount}`,
        lastMessageAt: sql`(datetime('now', 'localtime'))`,
        updatedAt: sql`(datetime('now', 'localtime'))`,
      })
      .where(eq(threads.id, threadId))
  }

  /**
   * 更新 Thread 标题
   *
   * 用于首次用户消息时自动设置标题（取消息内容前 N 字截断）。
   */
  async updateTitle(threadId: string, title: string): Promise<void> {
    await this.db
      .update(threads)
      .set({
        title,
        updatedAt: sql`(datetime('now', 'localtime'))`,
      })
      .where(eq(threads.id, threadId))
  }

  /**
   * 查询 Thread 的消息总数（仅活跃消息）
   *
   * 用于总览页统计真实对话条数，而非 Thread 记录数。
   */
  async countActiveMessages(threadId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(threadMessages)
      .where(and(eq(threadMessages.threadId, threadId), eq(threadMessages.status, 'active')))
    return result[0]?.count ?? 0
  }

  async updateDisabledTools(threadId: string, disabledToolsJson: string): Promise<boolean> {
    const result = await this.db
      .update(threads)
      .set({ disabledToolsJson, updatedAt: sql`(datetime('now', 'localtime'))` })
      .where(and(eq(threads.id, threadId), eq(threads.status, 'active')))
    return result.changes > 0
  }

  async updateEnabledSkills(threadId: string, enabledSkillsJson: string): Promise<boolean> {
    const result = await this.db
      .update(threads)
      .set({ enabledSkillsJson, updatedAt: sql`(datetime('now', 'localtime'))` })
      .where(and(eq(threads.id, threadId), eq(threads.status, 'active')))
    return result.changes > 0
  }

  async updateAutoExecuteTools(threadId: string, autoExecuteTools: boolean): Promise<boolean> {
    return this.updateExecutionMode(threadId, autoExecuteTools ? 'auto' : 'manual')
  }

  async updateExecutionMode(threadId: string, executionMode: ExecutionMode): Promise<boolean> {
    const result = await this.db
      .update(threads)
      .set({
        executionMode,
        autoExecuteTools: executionMode !== 'manual',
        updatedAt: sql`(datetime('now', 'localtime'))`,
      })
      .where(and(eq(threads.id, threadId), eq(threads.status, 'active')))
    return result.changes > 0
  }

  async updateInteractionMode(
    threadId: string,
    interactionMode: InteractionMode,
  ): Promise<boolean> {
    const result = await this.db
      .update(threads)
      .set({ interactionMode, updatedAt: sql`(datetime('now', 'localtime'))` })
      .where(and(eq(threads.id, threadId), eq(threads.status, 'active')))
    return result.changes > 0
  }

  /**
   * 更新 Thread 的 ContextPolicy
   *
   * @param threadId       Thread ID
   * @param contextPolicy  JSON 序列化的 ChannelPolicy 字符串；null 表示恢复使用默认策略
   */
  async updateContextPolicy(threadId: string, contextPolicy: string | null): Promise<boolean> {
    const result = await this.db
      .update(threads)
      .set({
        contextPolicy,
        updatedAt: sql`(datetime('now', 'localtime'))`,
      })
      .where(eq(threads.id, threadId))
    return result.changes > 0
  }

  // ── 消息操作 ──

  /** 追加一条消息，并在 Execution 存在时同事务追加 Durable Event。 */
  async appendMessage(data: CreateThreadMessageInput): Promise<ThreadMessageRow> {
    return this.db.transaction((tx) => {
      const thread = tx.select().from(threads).where(eq(threads.id, data.threadId)).get()
      if (!thread || thread.status !== 'active' ||
          (data.expectedGeneration !== undefined && thread.generation !== data.expectedGeneration))
        throw new AppError('CONFLICT', { message: '会话已重置，本次执行已过期' })
      if (data.publicationId) {
        const existing = tx.select().from(threadMessages).where(eq(threadMessages.publicationId, data.publicationId)).get()
        if (existing) {
          if (existing.threadId !== data.threadId || existing.content !== data.content || existing.status !== 'active' ||
              existing.role !== data.role || existing.executionId !== (data.executionId ?? null) ||
              existing.agentId !== (data.agentId ?? null))
            throw new AppError('CONFLICT', { message: t('server.conversation', '消息发布标识已使用，请核对已发布内容') })
          return existing
        }
      }
      if (data.executionId && data.role === 'assistant') this.conversations.assertCurrent(data.executionId)
      if (data.role === 'assistant' && data.pairId && data.expectedGeneration !== undefined) {
        const retracted = tx.select({ id: agentCharacterStateEvents.id }).from(agentCharacterStateEvents)
          .where(and(eq(agentCharacterStateEvents.threadId, data.threadId), eq(agentCharacterStateEvents.pairId, data.pairId), eq(agentCharacterStateEvents.kind, 'retract'))).get()
        if (retracted) throw new AppError('CONFLICT', { message: '状态来源消息不存在或已撤回' })
        const source = tx.select({ id: threadMessages.id }).from(threadMessages)
          .where(and(eq(threadMessages.threadId, data.threadId), eq(threadMessages.pairId, data.pairId),
            eq(threadMessages.role, 'user'), eq(threadMessages.status, 'deleted'))).get()
        if (source) throw new AppError('CONFLICT', { message: '状态来源消息不存在或已撤回' })
      }
      let metadataJson = data.metadataJson ?? '{}'
      if (data.role === 'assistant' && data.pairId) {
        const metadata = JSON.parse(metadataJson)
        if (Array.isArray(metadata?.toolCalls)) {
          const sources = tx.select({ id: threadMessages.id, revision: threadMessages.revision })
            .from(threadMessages).where(and(
              eq(threadMessages.threadId, data.threadId), eq(threadMessages.pairId, data.pairId),
              eq(threadMessages.status, 'active'),
            )).all()
          metadata.memorySourceRevisions = {
            ...Object.fromEntries(sources.map((source) => [String(source.id), source.revision ?? 1])),
            ...metadata.memorySourceRevisions,
          }
          metadataJson = JSON.stringify(metadata)
        }
      }
      const rows = tx
        .insert(threadMessages)
        .values({
          threadId: data.threadId,
          role: data.role,
          content: data.content,
          rawContent: data.rawContent,
          pairId: data.pairId,
          publicationId: data.publicationId,
          executionId: data.executionId,
          senderId: data.senderId,
          agentId: data.agentId,
          metadataJson,
          scorerStatus: thread.threadKind === 'main' ? (data.scorerStatus ?? 'pending') : 'skipped',
          status: data.status ?? 'active',
        })
        .returning()
        .all()
      const row = rows[0]!
      for (const source of data.sourceMessages ?? []) {
        const current = tx.select().from(threadMessages).where(eq(threadMessages.id, source.messageId)).get()
        if (!current || current.threadId !== data.threadId || current.status !== 'active' ||
            (current.revision ?? 1) !== source.revision)
          throw new AppError('CONFLICT', { message: t('server.conversation', '交流执行已结束或来源已变化') })
        tx.insert(conversationMessageSources).values({
          threadId: data.threadId,
          messageId: row.id, sourceMessageId: source.messageId, sourceRevision: source.revision,
        }).run()
      }
      if (data.executionId && data.respondsTo?.length) this.conversations.resolve(data.executionId, data.respondsTo)
      const replaced = data.executionId && data.role === 'assistant'
        ? this.conversations.applyRegeneration(data.executionId) : []
      if (replaced.length) {
        const metadata = JSON.parse(row.metadataJson ?? '{}')
        metadata.replacedMessageIds = replaced
        row.metadataJson = JSON.stringify(metadata)
        tx.update(threadMessages).set({ metadataJson: row.metadataJson }).where(eq(threadMessages.id, row.id)).run()
        tx.update(messageAttachments).set({ status: 'deleted', deletedAt: new Date().toISOString() })
          .where(inArray(messageAttachments.messageId, replaced)).run()
      }
      tx.update(threads).set({
        messageCount: sql`coalesce(${threads.messageCount}, 0) + 1 - ${replaced.length}`,
        pairCount: sql`coalesce(${threads.pairCount}, 0) + ${data.role === 'assistant' ? 1 : 0} - ${replaced.length}`,
        lastMessageAt: row.timestamp, updatedAt: sql`datetime('now', 'localtime')`,
      }).where(eq(threads.id, data.threadId)).run()
      if (
        data.achievement &&
        data.role === 'assistant' &&
        (data.status ?? 'active') === 'active' &&
        data.content.trim()
      ) {
        tx.insert(achievements)
          .values({
            subjectId: data.achievement.subjectId,
            achievementId: data.achievement.id,
            unlockedAt: new Date().toISOString(),
            sourceMessageId: row.id,
          })
          .onConflictDoNothing({ target: [achievements.subjectId, achievements.achievementId] })
          .run()
      }
      if (data.execution && this.outbox) {
        const event = this.outbox.createEvent({
          protocolVersion: 1,
          type: 'conversation.message.committed',
          durability: 'durable',
          principalId: data.execution.principalId,
          processId: data.execution.processId,
          executionId: data.execution.executionId,
          correlationId: data.execution.executionId,
          object: {
            objectType: 'thread-message',
            objectId: String(row.id) as KernelObjectId,
            generation: row.revision ?? 1,
            ownerPrincipalId: data.execution.principalId,
          },
          payload: {
            threadId: data.threadId,
            messageId: row.id,
            pairId: data.pairId,
            role: data.role,
            status: data.status ?? 'active',
          },
        })
        tx.insert(kernelOutboxEvents).values(this.outbox.toRow(event)).run()
      }
      return row
    })
  }

  /** 保存对话对（user + assistant） */
  async saveMessagePair(params: {
    threadId: string
    agentId: string
    userContent: string
    assistantContent: string
    assistantRawContent?: string
    pairId: string
  }): Promise<{ userMessage: ThreadMessageRow; assistantMessage: ThreadMessageRow }> {
    const userMessage = await this.appendMessage({
      threadId: params.threadId,
      role: 'user',
      content: params.userContent,
      pairId: params.pairId,
    })

    const assistantMessage = await this.appendMessage({
      threadId: params.threadId,
      role: 'assistant',
      content: params.assistantContent,
      rawContent: params.assistantRawContent,
      pairId: params.pairId,
      agentId: params.agentId,
    })

    // 更新 Thread 计数：本对写入 2 条消息（user + assistant），对话对增加 1

    return { userMessage, assistantMessage }
  }

  /**
   * 查询 Thread 的活跃消息（时间正序）
   *
   * 默认返回最近 N 条 active 消息，供 Context Compiler 使用。
   */
  async queryActiveMessages(params: QueryActiveMessagesParams): Promise<ThreadMessageRow[]> {
    const limit = params.limit ?? 20

    // 先按时间倒序取最近 N 条 active 消息
    const recent = await this.db
      .select()
      .from(threadMessages)
      .where(and(eq(threadMessages.threadId, params.threadId), eq(threadMessages.status, 'active'),
        params.roles ? inArray(threadMessages.role, params.roles) : undefined,
        params.beforeMessageId === undefined ? undefined : sql`${threadMessages.id} < ${params.beforeMessageId}`))
      .orderBy(...(params.orderById ? [desc(threadMessages.id)] : [desc(threadMessages.timestamp), desc(threadMessages.id)]))
      .limit(limit)

    // 反转为时间正序（供 LLM 消费）
    return recent.reverse()
  }

  /** 从会话起点读取用户时间索引，不加载正文；追加边界之外的消息不参与本次计算。 */
  async queryConversationUserTimes(
    threadId: string,
    throughMessageId: number,
  ): Promise<Array<{ id: number; timestamp: string | null }>> {
    return this.db
      .select({ id: threadMessages.id, timestamp: threadMessages.timestamp })
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, threadId),
          eq(threadMessages.role, 'user'),
          inArray(threadMessages.status, ['active', 'failed', 'interrupted']),
          sql`${threadMessages.id} <= ${throughMessageId}`,
        ),
      )
      .orderBy(asc(threadMessages.id))
  }

  async findMessagesByPairIds(threadId: string, pairIds: string[]): Promise<ThreadMessageRow[]> {
    if (pairIds.length === 0) return []
    const sources = pairIds.flatMap((key) => {
      const match = /^message:(\d+)@(\d+)$/.exec(key)
      return match ? [{ id: Number(match[1]), revision: Number(match[2]) }] : []
    })
    const rows = await this.db
      .select()
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, threadId),
          or(inArray(threadMessages.pairId, pairIds),
            ...sources.map((source) => and(eq(threadMessages.id, source.id), eq(threadMessages.revision, source.revision)))),
          eq(threadMessages.status, 'active'),
        ),
      )
      .orderBy(asc(threadMessages.timestamp), asc(threadMessages.id))
    return rows.map((row) => pairIds.includes(conversationSourceKey(row))
      ? { ...row, pairId: conversationSourceKey(row) } : row)
  }

  async findPair(threadId: string, pairId: string): Promise<ThreadMessageRow[]> {
    return this.findMessagesByPairIds(threadId, [pairId])
  }

  /** 补记周期固定追加边界，关机恢复后仍使用同一批来源。 */
  async latestMemoryMessageId(): Promise<number> {
    const [row] = await this.db
      .select({ id: sql<number>`coalesce(max(${threadMessages.id}), 0)` })
      .from(threadMessages)
    return row?.id ?? 0
  }

  /** 后台审阅全部尚存来源，不受聊天窗口和最近一万轮的读取上限影响。 */
  async queryMemoryMessagesThrough(
    threadId: string,
    throughMessageId: number,
  ): Promise<ThreadMessageRow[]> {
    const rows = await this.db
      .select()
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, threadId),
          eq(threadMessages.status, 'active'),
          sql`${threadMessages.id} <= ${throughMessageId}`,
          // 分支历史沿用同一角色的记忆，新增轮次继续正常提炼。
          sql`json_extract(CASE WHEN json_valid(${threadMessages.metadataJson})
            THEN ${threadMessages.metadataJson} ELSE '{}' END, '$.forkOrigin') IS NULL`,
        ),
      )
      .orderBy(asc(threadMessages.timestamp), asc(threadMessages.id))
    const thread = await this.getThread(threadId)
    return thread?.threadKind === 'main'
      ? rows.map((row) => ({ ...row, pairId: conversationSourceKey(row) }))
      : rows
  }

  /** 查询最近 N 个完整对话轮次，旧消息缺少 pairId 时按单条独立轮次处理。 */
  async queryActiveMessagePairs(
    threadId: string,
    pairLimit = 20,
    options?: {
      beforeMessageId?: number
      recoverable?: boolean
    },
  ): Promise<ThreadMessageRow[]> {
    const normalizedLimit = Math.max(1, pairLimit)
    const visible = options?.recoverable
      ? inArray(threadMessages.status, ['active', 'failed', 'interrupted'])
      : eq(threadMessages.status, 'active')
    const pairKey = sql<string>`coalesce(${threadMessages.pairId}, '__message__:' || ${threadMessages.id})`
    const latestId = sql<number>`max(${threadMessages.id})`
    const recentPairs = await this.db
      .select({ pairKey, latestId })
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, threadId),
          visible,
          options?.beforeMessageId
            ? sql`${threadMessages.id} < ${options.beforeMessageId}`
            : undefined,
        ),
      )
      .groupBy(pairKey)
      .orderBy(desc(latestId))
      .limit(normalizedLimit)

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
    if (pairIds.length > 0) selectors.push(inArray(threadMessages.pairId, pairIds))
    if (legacyMessageIds.length > 0) {
      selectors.push(
        and(isNull(threadMessages.pairId), inArray(threadMessages.id, legacyMessageIds))!,
      )
    }

    return this.db
      .select()
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, threadId),
          visible,
          selectors.length === 1 ? selectors[0] : or(...selectors),
        ),
      )
      .orderBy(asc(threadMessages.timestamp), asc(threadMessages.id))
  }

  /** 查询同一 Agent 最近活跃的指定 Channel Thread，并读取最近N个完整回合。 */
  async queryLatestChannelContinuityPairs(input: {
    agentId: string
    sourceChannel: string
    pairLimit: number
  }): Promise<ContinuityMessageRow[]> {
    const sourceThread = (
      await this.db
        .select()
        .from(threads)
        .where(
          and(
            eq(threads.agentId, input.agentId),
            eq(threads.channel, input.sourceChannel),
            eq(threads.purpose, 'conversation'),
            eq(threads.status, 'active'),
          ),
        )
        .orderBy(desc(threads.lastMessageAt), desc(threads.createdAt))
        .limit(1)
    )[0]
    if (!sourceThread) return []
    const messages = await this.queryActiveMessagePairs(sourceThread.id, input.pairLimit)
    return messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        ...message,
        threadAgentId: sourceThread.agentId,
        threadChannel: sourceThread.channel,
        threadPlatform: sourceThread.platform,
        threadTitle: sourceThread.title,
      }))
  }

  /** 查询同一 Agent 指定来源 Channel 的近期权威消息，供跨模式 Continuity 只读消费。 */
  async queryContinuityMessages(input: {
    agentId: string
    excludeThreadId: string
    sourceChannel: string
    limit: number
    since?: string
  }): Promise<ContinuityMessageRow[]> {
    const conditions = [
      eq(threads.agentId, input.agentId),
      eq(threads.channel, input.sourceChannel),
      eq(threads.status, 'active'),
      eq(threads.purpose, 'conversation'),
      sql`${threads.id} <> ${input.excludeThreadId}`,
      eq(threadMessages.status, 'active'),
      inArray(threadMessages.role, ['user', 'assistant']),
    ]
    if (input.since) conditions.push(sql`${threadMessages.timestamp} >= ${input.since}`)
    const rows = await this.db
      .select({
        message: threadMessages,
        threadAgentId: threads.agentId,
        threadChannel: threads.channel,
        threadPlatform: threads.platform,
        threadTitle: threads.title,
      })
      .from(threadMessages)
      .innerJoin(threads, eq(threadMessages.threadId, threads.id))
      .where(and(...conditions))
      .orderBy(desc(threadMessages.timestamp), desc(threadMessages.id))
      .limit(Math.max(0, input.limit))
    return rows.reverse().map(({ message, ...thread }) => ({ ...message, ...thread }))
  }

  /** 按稳定消息游标查询 Thread 的活跃消息（最新在前）。 */
  async listActiveMessages(params: {
    threadId: string
    beforeMessageId?: number
    page?: number
    pageSize?: number
  }): Promise<{ items: ThreadMessageRow[]; total: number; hasMoreBefore: boolean }> {
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 60))
    const offset = params.beforeMessageId ? 0 : (Math.max(1, params.page ?? 1) - 1) * pageSize
    const conditions = [
      eq(threadMessages.threadId, params.threadId),
      inArray(threadMessages.status, ['active', 'failed', 'interrupted']),
    ]

    if (params.beforeMessageId) {
      const [cursor] = await this.db
        .select({ id: threadMessages.id, timestamp: threadMessages.timestamp })
        .from(threadMessages)
        .where(
          and(
            eq(threadMessages.threadId, params.threadId),
            eq(threadMessages.id, params.beforeMessageId),
          ),
        )
        .limit(1)
      if (cursor) {
        const cursorTimestamp = cursor.timestamp
        conditions.push(
          cursorTimestamp === null
            ? sql`${threadMessages.timestamp} is null and ${threadMessages.id} < ${cursor.id}`
            : or(
                sql`${threadMessages.timestamp} < ${cursorTimestamp}`,
                and(
                  eq(threadMessages.timestamp, cursorTimestamp),
                  sql`${threadMessages.id} < ${cursor.id}`,
                ),
              )!,
        )
      }
    }

    const rows = await this.db
      .select()
      .from(threadMessages)
      .where(and(...conditions))
      .orderBy(desc(threadMessages.timestamp), desc(threadMessages.id))
      .limit(pageSize + 1)
      .offset(offset)

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, params.threadId),
          inArray(threadMessages.status, ['active', 'failed', 'interrupted']),
        ),
      )
    const total = countResult[0]?.count ?? 0

    return {
      items: rows.slice(0, pageSize),
      total,
      hasMoreBefore: rows.length > pageSize,
    }
  }

  deletedMessageIds(threadId: string): number[] {
    return this.db.select({ id: threadMessages.id }).from(threadMessages).where(and(
      eq(threadMessages.threadId, threadId), eq(threadMessages.status, 'deleted'),
      or(isNull(threadMessages.deletedBy), ne(threadMessages.deletedBy, 'reset')),
    )).all().map((message) => message.id)
  }

  getMessage(messageId: number) {
    return this.db.select().from(threadMessages).where(eq(threadMessages.id, messageId)).get()
  }

  async getMessageCoverageContext(messageId: number): Promise<
    | {
        threadId: string
        pairId: string | null
        executionId: string | null
        revision: number | null
        status: string | null
        role: string
      }
    | undefined
  > {
    const [message] = await this.db
      .select({
        threadId: threadMessages.threadId,
        pairId: threadMessages.pairId,
        executionId: threadMessages.executionId,
        revision: threadMessages.revision,
        status: threadMessages.status,
        role: threadMessages.role,
      })
      .from(threadMessages)
      .where(eq(threadMessages.id, messageId))
      .limit(1)
    return message
  }

  async getPairMessageIds(messageId: number): Promise<number[]> {
    const current = (
      await this.db.select().from(threadMessages).where(eq(threadMessages.id, messageId)).limit(1)
    )[0]
    if (!current) return []
    if (current.pairId) {
      return (
        await this.db
          .select({ id: threadMessages.id })
          .from(threadMessages)
          .where(eq(threadMessages.pairId, current.pairId))
      ).map((row) => row.id)
    }
    return [messageId]
  }

  /** 软删除单条消息 */
  async softDeleteMessage(messageId: number, deletedBy: string): Promise<boolean> {
    // 先查消息所属 threadId，用于后续同步计数
    const msg = await this.db
      .select({ threadId: threadMessages.threadId })
      .from(threadMessages)
      .where(eq(threadMessages.id, messageId))
      .limit(1)
    if (!msg[0]) return false

    const result = await this.db
      .update(threadMessages)
      .set({
        status: 'deleted',
        deletedAt: sql`(datetime('now', 'localtime'))`,
        deletedBy,
      })
      .where(eq(threadMessages.id, messageId))

    // 删除成功后同步 Thread 的消息计数和最后消息时间
    if (result.changes > 0) {
      await this.syncThreadStats(msg[0].threadId)
    }

    return result.changes > 0
  }

  /**
   * 同步 Thread 的 messageCount / pairCount / lastMessageAt
   *
   * 软删除消息后调用，根据活跃消息重新统计并更新 Thread 记录。
   * 保证总览页「最近对话」的数量和排序正确。
   */
  async syncThreadStats(threadId: string): Promise<void> {
    // 统计活跃消息数
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(threadMessages)
      .where(and(eq(threadMessages.threadId, threadId), eq(threadMessages.status, 'active')))
    const activeCount = countResult[0]?.count ?? 0

    // 统计活跃对话对数（assistant 消息数即 pair 数）
    const pairResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, threadId),
          eq(threadMessages.status, 'active'),
          eq(threadMessages.role, 'assistant'),
        ),
      )
    const activePairCount = pairResult[0]?.count ?? 0

    // 查最后一条活跃消息时间
    const lastMsg = await this.db
      .select({ timestamp: threadMessages.timestamp })
      .from(threadMessages)
      .where(and(eq(threadMessages.threadId, threadId), eq(threadMessages.status, 'active')))
      .orderBy(desc(threadMessages.timestamp))
      .limit(1)
    const lastMessageAt = lastMsg[0]?.timestamp ?? null

    await this.db
      .update(threads)
      .set({
        messageCount: activeCount,
        pairCount: activePairCount,
        lastMessageAt,
        updatedAt: sql`(datetime('now', 'localtime'))`,
      })
      .where(eq(threads.id, threadId))
  }

  /**
   * 软删除整对消息
   *
   * 优先按 pairId 级联删除（新数据）。
   * 旧数据兼容：pairId 为 null 时，按 threadId + 时间顺序找相邻配对消息。
   * - user 消息 → 找同 thread 中时间最近的下一条 assistant 消息
   * - assistant 消息 → 找同 thread 中时间最近的上一条 user 消息
   */
  async softDeletePair(messageId: number, deletedBy: string): Promise<number> {
    // 先找到消息
    const msg = await this.db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.id, messageId))
      .limit(1)

    if (!msg[0]) return 0

    const current = msg[0]

    // 有 pairId → 按 pairId 级联删除
    if (current.pairId) {
      const result = await this.db
        .update(threadMessages)
        .set({
          status: 'deleted',
          deletedAt: sql`(datetime('now', 'localtime'))`,
          deletedBy,
        })
        .where(eq(threadMessages.pairId, current.pairId))

      // 删除成功后同步 Thread 统计
      if (result.changes > 0) {
        await this.syncThreadStats(current.threadId)
      }

      return result.changes
    }

    // 旧数据兼容：pairId 为 null，按 threadId + 时间顺序找相邻配对消息
    const isUser = current.role === 'user'
    const neighbor = await this.db
      .select({ id: threadMessages.id })
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, current.threadId),
          eq(threadMessages.role, isUser ? 'assistant' : 'user'),
          eq(threadMessages.status, 'active'),
          isUser
            ? sql`${threadMessages.timestamp} >= ${current.timestamp}`
            : sql`${threadMessages.timestamp} <= ${current.timestamp}`,
        ),
      )
      .orderBy(
        isUser ? sql`${threadMessages.timestamp} asc` : sql`${threadMessages.timestamp} desc`,
      )
      .limit(1)

    // 收集要删除的消息 ID（当前消息 + 配对消息）
    const idsToDelete = neighbor[0] ? [messageId, neighbor[0].id] : [messageId]

    const result = await this.db
      .update(threadMessages)
      .set({
        status: 'deleted',
        deletedAt: sql`(datetime('now', 'localtime'))`,
        deletedBy,
      })
      .where(inArray(threadMessages.id, idsToDelete))

    // 删除成功后同步 Thread 统计
    if (result.changes > 0) {
      await this.syncThreadStats(current.threadId)
    }

    return result.changes
  }

  /** 编辑消息内容（创建新 revision） */
  async editMessage(
    messageId: number,
    newContent: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    const [current] = await this.db
      .select()
      .from(threadMessages)
      .where(and(eq(threadMessages.id, messageId), ne(threadMessages.status, 'deleted')))
      .limit(1)
    if (!current) return false
    // 更新当前消息的内容和 revision
    const result = await this.db
      .update(threadMessages)
      .set({
        content: newContent,
        metadataJson: editedMessageMetadata(current.metadataJson, newContent),
        revision: sql`coalesce(${threadMessages.revision}, 1) + 1`,
      })
      .where(
        and(
          eq(threadMessages.id, messageId),
          ne(threadMessages.status, 'deleted'),
          eq(
            sql`coalesce(${threadMessages.revision}, 1)`,
            expectedRevision ?? current.revision ?? 1,
          ),
        ),
      )

    return result.changes > 0
  }

  // ── 摘要操作（已废弃，见 .docs/archived/03-context-runtime.md 第 0 节决策） ──
  // 超出上下文窗口的早期消息由长记忆系统兜底，不再生成滚动摘要。
  // 以下方法保留仅为兼容已有数据，运行时不应再调用。

  /** @deprecated 已废弃，超窗口消息由长记忆系统兜底 */
  async upsertSummary(data: CreateSummaryInput): Promise<ThreadSummaryRow> {
    const existing = await this.db
      .select()
      .from(threadSummaries)
      .where(eq(threadSummaries.threadId, data.threadId))
      .limit(1)

    if (existing.length > 0) {
      const rows = await this.db
        .update(threadSummaries)
        .set({
          content: data.content,
          coversMessageIds: JSON.stringify(data.coversMessageIds),
          revision: sql`revision + 1`,
          isStale: false,
        })
        .where(eq(threadSummaries.id, existing[0]!.id))
        .returning()
      return rows[0]!
    }

    const rows = await this.db
      .insert(threadSummaries)
      .values({
        threadId: data.threadId,
        content: data.content,
        coversMessageIds: JSON.stringify(data.coversMessageIds),
      })
      .returning()
    return rows[0]!
  }

  /** @deprecated 已废弃，超窗口消息由长记忆系统兜底 */
  async getLatestSummary(threadId: string): Promise<ThreadSummaryRow | undefined> {
    const rows = await this.db
      .select()
      .from(threadSummaries)
      .where(and(eq(threadSummaries.threadId, threadId), eq(threadSummaries.isStale, false)))
      .orderBy(desc(threadSummaries.revision))
      .limit(1)
    return rows[0]
  }

  /** @deprecated 已废弃，超窗口消息由长记忆系统兜底 */
  async markSummaryStale(threadId: string): Promise<void> {
    await this.db
      .update(threadSummaries)
      .set({ isStale: true })
      .where(and(eq(threadSummaries.threadId, threadId), eq(threadSummaries.isStale, false)))
  }

  // ── Scorer 操作（AIOS: 替代 conversation_logs 的 scorer 相关查询） ──

  /**
   * 获取待 Scorer 处理的对话对
   *
   * 返回 pairId 配对的消息（user + assistant），按时间正序。
   * 仅返回 scorer_status='pending' 且 role='assistant' 的消息及其配对的 user 消息。
   *
   * AIOS(Phase5): 新增 threadId + channel 参数，支持按 Thread 分批提炼，
   * 避免不同 Thread 的对话混合在一起导致记忆污染。
   * - threadId 提供：只查该 Thread 的消息
   * - channel 提供：只查该 channel 的消息（通过 threads 表 JOIN）
   *
   * @param agentId   Agent ID
   * @param batchSize 最多返回多少对
   * @param threadId  限定 Thread（可选，不传则查所有 Thread）
   * @param channel   限定 channel（可选，需要 JOIN threads 表）
   */
  async getPendingForScorer(
    agentId: string,
    batchSize: number,
    threadId?: string,
    channel?: ThreadChannel,
  ): Promise<
    Array<{ userMessage: ThreadMessageRow; assistantMessage: ThreadMessageRow; pairId: string }>
  > {
    // AIOS(Phase5): 按 threadId 过滤，避免跨 Thread 混批
    const assistantConditions = [
      inArray(threadMessages.threadId, this.db.select({ id: threads.id }).from(threads)
        .where(and(eq(threads.threadKind, 'main'), eq(threads.status, 'active')))),
      eq(threadMessages.agentId, agentId),
      eq(threadMessages.role, 'assistant'),
      eq(threadMessages.scorerStatus, 'pending'),
      eq(threadMessages.status, 'active'),
    ]
    if (threadId) {
      assistantConditions.push(eq(threadMessages.threadId, threadId))
    }

    // AIOS(Phase5): 按 channel 过滤；与 threadId 同时提供时取两者交集——先查该 channel 的所有 threadId，再用 inArray 过滤
    // 不用 JOIN 是因为 JOIN 会让返回类型变成合并行，破坏 ThreadMessageRow 类型
    if (channel) {
      const threadRows = await this.db
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.channel, channel))
      const threadIds = threadRows.map((r) => r.id)
      if (threadIds.length === 0) return []
      assistantConditions.push(inArray(threadMessages.threadId, threadIds))
    }

    // 先查 pending 的 assistant 消息（带 pairId）
    const pendingAssistant = await this.db
      .select()
      .from(threadMessages)
      .where(and(...assistantConditions))
      .orderBy(threadMessages.timestamp)
      .limit(batchSize)

    if (pendingAssistant.length === 0) return []

    // 按 pairId 查对应的 user 消息
    const pairIds = [...new Set(pendingAssistant.map((m) => m.pairId).filter(Boolean))] as string[]
    if (pairIds.length === 0) return []

    const pendingThreadIds = [...new Set(pendingAssistant.map((message) => message.threadId))]
    const userMessages = await this.db
      .select()
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.role, 'user'),
          eq(threadMessages.status, 'active'),
          inArray(threadMessages.pairId, pairIds),
          inArray(threadMessages.threadId, pendingThreadIds),
        ),
      )
      .orderBy(threadMessages.timestamp)

    // 使用Thread与pairId复合键，防止异常导入数据中的重复pairId跨Thread配对。
    const userMap = new Map<string, ThreadMessageRow>()
    for (const user of userMessages) {
      if (user.pairId) userMap.set(`${user.threadId}:${user.pairId}`, user)
    }

    // 配对返回
    const result: Array<{
      userMessage: ThreadMessageRow
      assistantMessage: ThreadMessageRow
      pairId: string
    }> = []
    for (const a of pendingAssistant) {
      if (!a.pairId) continue
      const user = userMap.get(`${a.threadId}:${a.pairId}`)
      if (user) {
        result.push({ userMessage: user, assistantMessage: a, pairId: a.pairId })
      }
    }
    return result
  }

  /**
   * 标记对话对的 Scorer 状态
   *
   * 通过 pairId 更新 assistant 消息的 scorer_status。
   * 同时将 scorer 元数据写入 metadataJson（合并已有 metadata）。
   *
   * @param pairId         对话对 ID
   * @param status         新状态（analyzed/failed/skipped）
   * @param metadataPatch  要合并的元数据（如 importance、tags、memoryId 等）
   */
  async updateScorerStatus(
    threadId: string,
    pairId: string,
    status: 'analyzed' | 'failed' | 'skipped',
    metadataPatch?: Record<string, unknown>,
  ): Promise<void> {
    // 查询当前 assistant 消息
    const msgs = await this.db
      .select()
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, threadId),
          eq(threadMessages.pairId, pairId),
          eq(threadMessages.role, 'assistant'),
        ),
      )
      .limit(1)

    if (msgs.length === 0) return
    const msg = msgs[0]!

    // 合并 metadata
    let metadata: Record<string, unknown> = {}
    try {
      metadata = JSON.parse(msg.metadataJson ?? '{}')
    } catch {
      metadata = {}
    }
    if (metadataPatch) {
      metadata = { ...metadata, ...metadataPatch }
    }

    await this.db
      .update(threadMessages)
      .set({
        scorerStatus: status,
        metadataJson: JSON.stringify(metadata),
      })
      .where(eq(threadMessages.id, msg.id))
  }

  /**
   * 统计 Agent 的待处理对话对数量
   */
  async countPendingForScorer(agentId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.agentId, agentId),
          eq(threadMessages.role, 'assistant'),
          eq(threadMessages.scorerStatus, 'pending'),
          eq(threadMessages.status, 'active'),
        ),
      )
    return result[0]?.count ?? 0
  }
}
