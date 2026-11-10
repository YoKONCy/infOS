import { and, asc, eq, inArray } from 'drizzle-orm'
import type { DrizzleDb } from '../database'
import { flowStateRevisions, flowStates, threads, threadMessages, groupChatMessages, agentExperiences } from '../database/schema'
import { AppError } from '../lib/appError'
import { t as __t } from '../lib/i18n'
import { ConversationRepository } from './conversation.repo'

export type FlowStateRow = typeof flowStates.$inferSelect

/** 心流持久化：当前状态与修订历史保持独立，避免污染 Thread 消息。 */
export class FlowStateRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(threadId: string, agentId: string): Promise<FlowStateRow | null> {
    const rows = await this.db
      .select()
      .from(flowStates)
      .where(and(eq(flowStates.threadId, threadId), eq(flowStates.agentId, agentId)))
      .limit(1)
    return rows[0] ?? null
  }

  async listByThread(threadId: string): Promise<FlowStateRow[]> {
    return this.db.select().from(flowStates).where(eq(flowStates.threadId, threadId))
  }

  async save(input: {
    threadId: string
    agentId: string
    currentGoal?: string
    privateFacts?: string
    pairId?: string | null
    generation?: number
  }): Promise<FlowStateRow> {
    return this.db.transaction((tx) => {
      if (input.generation !== undefined) {
        const thread = tx.select().from(threads).where(eq(threads.id, input.threadId)).get()
        if (!thread || thread.status !== 'active' || thread.generation !== input.generation) {
          throw new AppError('CONFLICT', { message: __t('errors.backend', '会话已重置，本次执行已过期') })
        }
      }
      if (input.pairId) {
        if (new ConversationRepository(this.db).get(input.pairId)) new ConversationRepository(this.db).assertCurrent(input.pairId)
        const withdrawn = tx.select({ id: threadMessages.id }).from(threadMessages).where(and(
          eq(threadMessages.threadId, input.threadId),
          eq(threadMessages.pairId, input.pairId),
          eq(threadMessages.status, 'deleted'),
        )).get()
        if (withdrawn) {
          throw new AppError('CONFLICT', { message: __t('errors.backend', '状态来源消息不存在或已撤回') })
        }
        const sceneMessages = tx.select({ status: groupChatMessages.status }).from(groupChatMessages)
          .where(eq(groupChatMessages.pairId, input.pairId)).all()
        if (sceneMessages.length && sceneMessages.every((message) => message.status !== 'active'))
          throw new AppError('CONFLICT', { message: __t('errors.backend', '状态来源消息不存在或已撤回') })
      }
      const before = tx.select().from(flowStates).where(and(
        eq(flowStates.threadId, input.threadId),
        eq(flowStates.agentId, input.agentId),
      )).get()
      const currentGoal = input.currentGoal ?? before?.currentGoal ?? ''
      const privateFacts = input.privateFacts ?? before?.privateFacts ?? ''
      tx.insert(flowStateRevisions).values({
        threadId: input.threadId,
        agentId: input.agentId,
        pairId: input.pairId ?? null,
        beforeCurrentGoal: before?.currentGoal ?? '',
        beforePrivateFacts: before?.privateFacts ?? '',
        afterCurrentGoal: currentGoal,
        afterPrivateFacts: privateFacts,
        patchFieldsJson: JSON.stringify([
          ...(input.currentGoal !== undefined ? ['currentGoal'] : []),
          ...(input.privateFacts !== undefined ? ['privateFacts'] : []),
        ]),
      }).run()
      const row = tx
        .insert(flowStates)
        .values({
          threadId: input.threadId,
          agentId: input.agentId,
          currentGoal,
          privateFacts,
          revision: (before?.revision ?? 0) + 1,
          updatedByPairId: input.pairId ?? null,
        })
        .onConflictDoUpdate({
          target: [flowStates.threadId, flowStates.agentId],
          set: {
            currentGoal,
            privateFacts,
            revision: (before?.revision ?? 0) + 1,
            updatedByPairId: input.pairId ?? null,
            updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
          },
        })
        .returning()
        .get()
      return row!
    })
  }

  async clear(threadId: string, agentId: string, pairId?: string | null): Promise<FlowStateRow> {
    return this.save({ threadId, agentId, currentGoal: '', privateFacts: '', pairId })
  }

  async rollbackPairs(threadId: string, pairIds: string[]): Promise<void> {
    if (!pairIds.length) return
    this.db.transaction((tx) => {
      const revisions = tx.select().from(flowStateRevisions)
        .where(eq(flowStateRevisions.threadId, threadId)).orderBy(asc(flowStateRevisions.id)).all()
      const affected = new Set(revisions.filter((row) => row.pairId && pairIds.includes(row.pairId)).map((row) => row.agentId))
      for (const agentId of affected) {
        const history = revisions.filter((row) => row.agentId === agentId)
        let currentGoal = history[0]!.beforeCurrentGoal
        let privateFacts = history[0]!.beforePrivateFacts
        let updatedByPairId: string | null = null
        for (const revision of history) {
          if (revision.pairId && pairIds.includes(revision.pairId)) continue
          const fields: string[] = revision.patchFieldsJson ? JSON.parse(revision.patchFieldsJson) : [
            ...(revision.afterCurrentGoal !== revision.beforeCurrentGoal ? ['currentGoal'] : []),
            ...(revision.afterPrivateFacts !== revision.beforePrivateFacts ? ['privateFacts'] : []),
          ]
          const beforeCurrentGoal = currentGoal
          const beforePrivateFacts = privateFacts
          if (fields.includes('currentGoal')) currentGoal = revision.afterCurrentGoal
          if (fields.includes('privateFacts')) privateFacts = revision.afterPrivateFacts
          tx.update(flowStateRevisions).set({
            beforeCurrentGoal,
            beforePrivateFacts,
            afterCurrentGoal: currentGoal,
            afterPrivateFacts: privateFacts,
          }).where(eq(flowStateRevisions.id, revision.id)).run()
          updatedByPairId = revision.pairId
        }
        const before = tx.select().from(flowStates).where(and(
          eq(flowStates.threadId, threadId), eq(flowStates.agentId, agentId),
        )).get()
        const state = { currentGoal, privateFacts, revision: (before?.revision ?? 0) + 1, updatedByPairId }
        tx.insert(flowStates).values({ threadId, agentId, ...state })
          .onConflictDoUpdate({
            target: [flowStates.threadId, flowStates.agentId],
            set: { ...state, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) },
          }).run()
      }
      tx.delete(flowStateRevisions).where(and(eq(flowStateRevisions.threadId, threadId), inArray(flowStateRevisions.pairId, pairIds))).run()
    })
  }

  async rollbackScene(roomId: string, pairId: string): Promise<void> {
    const sources = this.db.select({ threadId: agentExperiences.threadId }).from(agentExperiences)
      .innerJoin(groupChatMessages, eq(groupChatMessages.id, agentExperiences.sourceMessageId))
      .where(and(eq(groupChatMessages.roomId, roomId), eq(groupChatMessages.pairId, pairId))).all()
    for (const threadId of new Set(sources.map((source) => source.threadId))) await this.rollbackPairs(threadId, [pairId])
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db.delete(flowStateRevisions).where(eq(flowStateRevisions.threadId, threadId))
    await this.db.delete(flowStates).where(eq(flowStates.threadId, threadId))
  }
}
