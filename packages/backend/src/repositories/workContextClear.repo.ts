import { and, desc, eq } from 'drizzle-orm'
import type { DrizzleDb } from '../database'
import { threads, threadMessages, conversationExecutions, workContextClears } from '../database/schema'
import { AppError } from '../lib/appError'
import { t } from '../lib/i18n'

export interface WorkContextBoundary {
  id: number
  pairId: string
  toolCallId: string
  messageIds: number[]
  executionIds: string[]
}

export interface WorkContextClearReceipt extends WorkContextBoundary {
  applied: boolean
}

/** 清理只变更上下文选择，回执与当时已存在的来源集合在同一事务保存。 */
export class WorkContextClearRepository {
  constructor(private readonly db: DrizzleDb) {}

  latest(threadId: string, generation: number): WorkContextBoundary | undefined {
    const row = this.db.select().from(workContextClears).where(and(
      eq(workContextClears.threadId, threadId), eq(workContextClears.generation, generation),
    )).orderBy(desc(workContextClears.id)).get()
    return row && this.decode(row)
  }

  clear(input: {
    threadId: string
    agentId: string
    generation: number
    pairId: string
    toolCallId: string
  }): WorkContextClearReceipt {
    return this.db.transaction((tx) => {
      const thread = tx.select().from(threads).where(eq(threads.id, input.threadId)).get()
      if (!thread || thread.status !== 'active' || thread.channel !== 'desktop' ||
          !['conversation', 'companion'].includes(thread.purpose ?? 'conversation') ||
          thread.agentId !== input.agentId || thread.generation !== input.generation)
        throw new AppError('CONFLICT', { message: t('server.agent', '当前会话已变化，请重新发起上下文清理') })
      const saved = tx.select().from(workContextClears).where(and(
        eq(workContextClears.threadId, input.threadId), eq(workContextClears.generation, input.generation),
        eq(workContextClears.pairId, input.pairId), eq(workContextClears.toolCallId, input.toolCallId),
      )).get()
      if (saved) return { ...this.decode(saved), applied: false }
      const messageIds = tx.select({ id: threadMessages.id }).from(threadMessages)
        .where(eq(threadMessages.threadId, input.threadId)).all().map((row) => row.id)
      const executionIds = tx.select({ id: conversationExecutions.id }).from(conversationExecutions)
        .where(and(eq(conversationExecutions.threadId, input.threadId), eq(conversationExecutions.generation, input.generation)))
        .all().map((row) => row.id)
      // 最新边界覆盖此前来源，旧行保留幂等回执，避免重复保存增长中的完整身份集合。
      tx.update(workContextClears).set({ messageIdsJson: '[]', executionIdsJson: '[]' }).where(and(
        eq(workContextClears.threadId, input.threadId), eq(workContextClears.generation, input.generation),
      )).run()
      const row = tx.insert(workContextClears).values({
        ...input,
        messageIdsJson: JSON.stringify(messageIds),
        executionIdsJson: JSON.stringify(executionIds),
        createdAt: new Date().toISOString(),
      }).returning().get()!
      return { ...this.decode(row), applied: true }
    })
  }

  private decode(row: typeof workContextClears.$inferSelect): WorkContextBoundary {
    return {
      id: row.id,
      pairId: row.pairId,
      toolCallId: row.toolCallId,
      messageIds: JSON.parse(row.messageIdsJson),
      executionIds: JSON.parse(row.executionIdsJson),
    }
  }
}
