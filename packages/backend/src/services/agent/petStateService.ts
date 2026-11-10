import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { DEFAULT_CHARACTER_STATE, normalizeCharacterState } from '@infos/shared'
import {
  agentCharacterStateEvents as events,
  threads,
  threadMessages,
  groupChatMessages,
  agentExperiences,
  kernelOutboxEvents,
} from '../../database/schema'
import type { DrizzleDb } from '../../database'
import { AppError } from '../../lib/appError'
import { ConversationRepository } from '../../repositories/conversation.repo'

const TEMP_TEXT_TTL_MS = 6 * 60 * 60 * 1000
const MAX_TEMP_LINES_PER_POOL = 12
const mergeLines = (before: string[], after: string[]) =>
  [...new Set([...before, ...after].map((line) => line.trim()).filter(Boolean))].slice(
    -MAX_TEMP_LINES_PER_POOL,
  )

export interface PetStateUpdateData {
  mood?: string
  vibe?: string
  mind?: string
  ongoingGoals?: string
  commitments?: string
  relationships?: string
  clickMessages?: Record<string, string[]>
  idleMessages?: string[]
  backMessages?: string[]
}

export interface PetStateScope {
  threadId: string
  pairId?: string
  toolCallId?: string
  signal?: AbortSignal
  generation?: number
  executionId?: string
  channel?: string
  characterStateVersion?: { revision: number }
}

export interface PetStateData {
  agentId: string
  threadId: string
  revision: number
  mood: string
  vibe: string
  mind: string
  ongoingGoals: string
  commitments: string
  relationships: string
  clickMessagesJson: string
  idleMessagesJson: string
  backMessagesJson: string
  textExpiresAt: string | null
  updatedAt: string | null
}

/** 角色共享状态按来源贡献重放，撤回一轮保留其他场景随后产生的有效字段。 */
export class PetStateService {
  private publish?: (payload: Record<string, unknown>) => Promise<void>
  constructor(private db: DrizzleDb) {}

  setPublisher(publish: NonNullable<PetStateService['publish']>): void {
    this.publish = publish
  }

  async get(agentId: string, threadId?: string): Promise<PetStateData | null> {
    if (!threadId) threadId = this.db.select({ id: threads.id }).from(threads)
      .where(and(eq(threads.agentId, agentId), eq(threads.threadKind, 'main'))).get()?.id
    if (!threadId) return null
    const thread = this.db
      .select({ agentId: threads.agentId, channel: threads.channel, status: threads.status })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get()
    if (!thread || (thread.channel !== 'group' && thread.agentId !== agentId)) return null
    const rows = this.db
      .select()
      .from(events)
      .where(
        eq(events.agentId, agentId),
      )
      .orderBy(asc(events.id))
      .all()
    const state: PetStateData = {
      agentId,
      threadId,
      revision: rows.at(-1)?.id ?? 0,
      ...DEFAULT_CHARACTER_STATE,
      clickMessagesJson: '{}',
      idleMessagesJson: '[]',
      backMessagesJson: '[]',
      textExpiresAt: null,
      updatedAt: null,
    }
    const sourceKey = (row: typeof rows[number]) => `${row.threadId}:${row.generation}:${row.pairId}`
    const retracted = new Set(rows.filter((row) => row.kind === 'retract').map(sourceKey))
    let click: Record<string, string[]> = {},
      idle: string[] = [],
      back: string[] = []
    for (const row of rows) {
      if (
        row.kind !== 'update' ||
        retracted.has(sourceKey(row))
      )
        continue
      const patch = JSON.parse(row.patchJson) as PetStateUpdateData
      Object.assign(state, normalizeCharacterState(patch))
      if (patch.clickMessages || patch.idleMessages || patch.backMessages) {
        if (!state.textExpiresAt || Date.parse(state.textExpiresAt) <= Date.parse(row.createdAt)) {
          click = {}
          idle = []
          back = []
        }
        for (const [part, lines] of Object.entries(patch.clickMessages ?? {}))
          click[part] = mergeLines(click[part] ?? [], lines)
        idle = mergeLines(idle, patch.idleMessages ?? [])
        back = mergeLines(back, patch.backMessages ?? [])
        state.textExpiresAt = new Date(Date.parse(row.createdAt) + TEMP_TEXT_TTL_MS).toISOString()
      }
      state.updatedAt = row.createdAt
    }
    if (this.hasActiveTemporaryTexts(state)) {
      state.clickMessagesJson = JSON.stringify(click)
      state.idleMessagesJson = JSON.stringify(idle)
      state.backMessagesJson = JSON.stringify(back)
    } else state.textExpiresAt = null
    return state
  }

  hasActiveTemporaryTexts(state: PetStateData | null): boolean {
    return !!state?.textExpiresAt && Date.parse(state.textExpiresAt) > Date.now()
  }

  async update(
    agentId: string,
    data: PetStateUpdateData,
    scope?: PetStateScope,
  ): Promise<string | null> {
    if (!scope?.threadId || !scope.pairId)
      throw new AppError('INVALID_PARAMETER', {
        message: '角色状态更新缺少会话或消息轮次标识，无法建立可撤回记录',
      })
    scope.signal?.throwIfAborted()
    // 全部检查与写入同步完成，不在检查后让出执行权，避免撤回与旧工具竞态。
    this.db.transaction((tx) => {
      const continuousExecution = scope.pairId ? new ConversationRepository(this.db).get(scope.pairId) : undefined
      if (continuousExecution) new ConversationRepository(this.db).assertCurrent(continuousExecution.id)
      const thread = tx
        .select({
          agentId: threads.agentId,
          channel: threads.channel,
          status: threads.status,
          platform: threads.platform,
          platformIdentifier: threads.platformIdentifier,
          generation: threads.generation,
        })
        .from(threads)
        .where(eq(threads.id, scope.threadId))
        .get()
      if (
        !thread ||
        thread.status === 'deleted' ||
        (scope.generation !== undefined && thread.generation !== scope.generation) ||
        (thread.channel !== 'group' && thread.agentId !== agentId)
      )
        throw new AppError('FORBIDDEN', { message: '该会话不存在、已删除或不属于当前角色' })
      if (
        scope.pairId &&
        tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.threadId, scope.threadId),
              eq(events.kind, 'retract'),
              eq(events.pairId, scope.pairId),
            ),
          )
          .get()
      )
        throw new AppError('CONFLICT', { message: '对应消息已撤回，不能重新写入角色状态' })
      const activePair =
        thread.platform === 'stronghold'
          ? tx
              .select({ id: groupChatMessages.id })
              .from(groupChatMessages)
              .where(
                and(
                  eq(
                    groupChatMessages.roomId,
                    (thread.platformIdentifier ?? '').slice(0, -(thread.agentId.length + 1)),
                  ),
                  eq(groupChatMessages.pairId, scope.pairId!),
                  eq(groupChatMessages.status, 'active'),
                ),
              )
              .get()
          : tx
              .select({ id: threadMessages.id })
              .from(threadMessages)
              .where(
                and(
                  eq(threadMessages.threadId, scope.threadId),
                  eq(threadMessages.pairId, scope.pairId!),
                  eq(threadMessages.status, 'active'),
                ),
              )
              .get()
      const scenePair = !activePair && tx.select({ id: agentExperiences.id }).from(agentExperiences)
        .innerJoin(groupChatMessages, eq(groupChatMessages.id, agentExperiences.sourceMessageId))
        .where(and(eq(agentExperiences.agentId, agentId), eq(agentExperiences.threadId, scope.threadId),
          eq(agentExperiences.generation, thread.generation), eq(agentExperiences.withdrawn, false),
          eq(groupChatMessages.pairId, scope.pairId!), eq(groupChatMessages.status, 'active'))).get()
      const withdrawnPair = tx.select({ id: threadMessages.id }).from(threadMessages)
        .where(and(eq(threadMessages.threadId, scope.threadId), eq(threadMessages.pairId, scope.pairId!), eq(threadMessages.status, 'deleted'))).get()
      const withdrawnScene = tx.select({ id: groupChatMessages.id }).from(groupChatMessages)
        .where(and(eq(groupChatMessages.pairId, scope.pairId!), eq(groupChatMessages.status, 'deleted'))).get()
      const execution = scope.channel !== 'group' && !activePair && !scenePair && !withdrawnPair && !withdrawnScene && scope.executionId && scope.generation !== undefined
        ? tx.select({ payload: kernelOutboxEvents.payloadJson }).from(kernelOutboxEvents)
          .where(and(eq(kernelOutboxEvents.executionId, scope.executionId), eq(kernelOutboxEvents.eventType, 'kernel.execution.created'), eq(kernelOutboxEvents.principalId, agentId))).get()
        : undefined
      const executionThread = execution ? (JSON.parse(execution.payload) as { descriptor?: { threadId?: string } }).descriptor?.threadId : undefined
      if (!activePair && !scenePair &&
          !(continuousExecution?.threadId === scope.threadId && continuousExecution.agentId === agentId) &&
          executionThread !== scope.threadId) throw new AppError('CONFLICT', { message: '状态来源消息不存在或已撤回' })
      const latest = tx.select({ id: events.id }).from(events)
        .where(eq(events.agentId, agentId)).orderBy(desc(events.id)).get()?.id ?? 0
      const duplicate = scope.toolCallId && tx.select({ id: events.id }).from(events)
        .where(and(eq(events.agentId, agentId), eq(events.threadId, scope.threadId),
          eq(events.generation, thread.generation), eq(events.pairId, scope.pairId!), eq(events.toolCallId, scope.toolCallId))).get()
      if (duplicate) {
        if (scope.characterStateVersion) scope.characterStateVersion.revision = latest
        return
      }
      if (scope.characterStateVersion && scope.characterStateVersion.revision !== latest) {
        scope.characterStateVersion.revision = latest
        throw new AppError('CONFLICT', { message: '角色状态已由其他场景更新，请重试' })
      }
      const patch: PetStateUpdateData = {
        ...normalizeCharacterState(data),
        clickMessages: data.clickMessages,
        idleMessages: data.idleMessages,
        backMessages: data.backMessages,
      }
      const saved = tx.insert(events)
        .values({
          threadId: scope.threadId,
          agentId,
          generation: thread.generation,
          kind: 'update',
          pairId: scope.pairId!,
          toolCallId: scope.toolCallId ?? null,
          patchJson: JSON.stringify(patch),
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: events.id }).get()
      if (saved && scope.characterStateVersion) scope.characterStateVersion.revision = saved.id
    })
    return (await this.get(agentId, scope.threadId))?.textExpiresAt ?? null
  }

  async rollbackPairs(threadId: string, pairIds: string[]): Promise<void> {
    if (!pairIds.length) return
    const agents = this.db
      .selectDistinct({ agentId: events.agentId, generation: events.generation })
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
          eq(events.kind, 'update'),
          inArray(events.pairId, pairIds),
        ),
      )
      .all()
    if (!agents.length) {
      const thread = this.db.select({ agentId: threads.agentId, generation: threads.generation })
        .from(threads).where(eq(threads.id, threadId)).get()
      if (thread) agents.push(thread)
    }
    this.db.transaction((tx) => {
      for (const { agentId, generation } of agents) {
        for (const pairId of new Set(pairIds)) {
          tx.insert(events).values({
              threadId,
              agentId,
              generation,
              kind: 'retract',
              pairId,
              createdAt: new Date().toISOString(),
            }).run()
        }
      }
    })
    for (const { agentId } of agents) await this.broadcast(agentId, threadId)
  }

  async clearThread(threadId: string): Promise<void> {
    const pairs = this.db.selectDistinct({ pairId: events.pairId }).from(events)
      .where(and(eq(events.threadId, threadId), eq(events.kind, 'update'))).all()
    await this.rollbackPairs(threadId, pairs.map((row) => row.pairId))
  }

  async rollbackRoomPair(roomId: string, pairId: string): Promise<void> {
    const mainThreads = this.db.selectDistinct({ threadId: agentExperiences.threadId }).from(agentExperiences)
      .innerJoin(groupChatMessages, eq(groupChatMessages.id, agentExperiences.sourceMessageId))
      .where(and(eq(agentExperiences.roomId, roomId), eq(groupChatMessages.pairId, pairId))).all()
    for (const row of mainThreads) await this.rollbackPairs(row.threadId, [pairId])
    const roomThreads = this.db
      .select({ id: threads.id, identity: threads.platformIdentifier })
      .from(threads)
      .where(eq(threads.platform, 'stronghold'))
      .all()
      .filter((thread) => thread.identity?.startsWith(roomId + ':'))
    for (const thread of roomThreads) await this.rollbackPairs(thread.id, [pairId])
  }

  async clearChannel(channel: string): Promise<void> {
    const channelThreads = this.db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.channel, channel))
      .all()
    for (const thread of channelThreads) await this.clearThread(thread.id)
  }

  async broadcast(agentId: string, threadId: string): Promise<void> {
    const state = await this.get(agentId, threadId)
    if (!state) return
    await this.publish?.({
      agentId,
      threadId,
      scope: 'agent',
      revision: state.revision,
      replace: true,
      mood: state.mood,
      vibe: state.vibe,
      mind: state.mind,
      ongoingGoals: state.ongoingGoals,
      commitments: state.commitments,
      relationships: state.relationships,
      click_messages: JSON.parse(state.clickMessagesJson),
      idle_messages: JSON.parse(state.idleMessagesJson),
      back_messages: JSON.parse(state.backMessagesJson),
      text_expires_at: state.textExpiresAt,
    })
  }
}
