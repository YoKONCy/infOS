import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import type { ConversationSource, ConversationWait, KernelExecutionDescriptor } from '@infos/shared'
import type { DrizzleDb } from '../database'
import {
  conversationExecutions,
  conversationExpectations,
  kernelOutboxEvents,
  threadMessages,
  threads,
} from '../database/schema'
import { AppError } from '../lib/appError'
import type { KernelOutboxRepository } from '../kernel/kernelOutboxRepository'
import { t } from '../lib/i18n'

/** 连续交流的执行与等待现场，每次提交重新核验代次和来源修订。 */
export class ConversationRepository {
  constructor(private readonly db: DrizzleDb, private readonly outbox?: KernelOutboxRepository) {}

  begin(input: {
    id: string
    threadId: string
    agentId: string
    generation: number
    sources: ConversationSource[]
    metadata?: Record<string, unknown>
  }) {
    return this.db.transaction((tx) => {
      const thread = tx.select().from(threads).where(eq(threads.id, input.threadId)).get()
      if (!thread || thread.status !== 'active' || thread.threadKind !== 'main' ||
          thread.agentId !== input.agentId || thread.generation !== input.generation)
        throw new AppError('CONFLICT', { message: t('server.conversation', '会话已重置，本次执行已过期') })
      tx.insert(conversationExecutions).values({
        id: input.id, threadId: input.threadId, agentId: input.agentId,
        generation: input.generation, inputSourcesJson: JSON.stringify(input.sources),
        metadataJson: JSON.stringify(input.metadata ?? {}),
        startedAt: new Date().toISOString(),
      }).onConflictDoNothing().run()
      const execution = this.assertCurrent(input.id)
      if (execution.threadId !== input.threadId || execution.agentId !== input.agentId || execution.generation !== input.generation)
        throw new AppError('CONFLICT', { message: t('server.conversation', '交流执行已结束或来源已变化') })
      return execution
    })
  }

  assertCurrent(id: string) {
    const record = this.db.select().from(conversationExecutions).where(eq(conversationExecutions.id, id)).get()
    if (!record) throw new AppError('NOT_FOUND', { message: t('server.conversation', '交流执行不存在') })
    const thread = this.db.select().from(threads).where(eq(threads.id, record.threadId)).get()
    if (!thread || thread.status !== 'active' || thread.generation !== record.generation || record.status !== 'running')
      throw new AppError('CONFLICT', { message: t('server.conversation', '交流执行已结束或来源已变化') })
    const sources = JSON.parse(record.inputSourcesJson) as ConversationSource[]
    for (const source of sources) {
      const message = this.db.select().from(threadMessages).where(eq(threadMessages.id, source.messageId)).get()
      if (!message || message.threadId !== record.threadId || message.status !== 'active' ||
          (message.revision ?? 1) !== source.revision)
        throw new AppError('CONFLICT', { message: t('server.conversation', '交流执行已结束或来源已变化') })
    }
    return { ...record, sources }
  }

  open(threadId: string, generation: number) {
    this.db.update(conversationExpectations).set({ status: 'expired' }).where(and(
      eq(conversationExpectations.threadId, threadId), eq(conversationExpectations.generation, generation),
      eq(conversationExpectations.status, 'open'), sql`${conversationExpectations.expiresAt} <= ${new Date().toISOString()}`,
    )).run()
    return this.db.select().from(conversationExpectations).where(and(
      eq(conversationExpectations.threadId, threadId), eq(conversationExpectations.generation, generation),
      eq(conversationExpectations.status, 'open'),
    )).orderBy(asc(conversationExpectations.createdAt), asc(conversationExpectations.id)).all()
  }

  wait(executionId: string, input: ConversationWait) {
    return this.db.transaction((tx) => {
      const record = this.assertCurrent(executionId)
      const sources = input.messageIds.map((id) => {
        const message = tx.select().from(threadMessages).where(eq(threadMessages.id, id)).get()
        if (!message || message.threadId !== record.threadId || message.status !== 'active' ||
            message.executionId !== executionId || message.role !== 'assistant')
          throw new AppError('INVALID_PARAMETER', { message: t('server.conversation', '待回应事项必须引用本次已发布的消息') })
        return { messageId: id, revision: message.revision ?? 1 }
      })
      const id = `${executionId}:wait:${input.id}`
      tx.insert(conversationExpectations).values({
        id, threadId: record.threadId, agentId: record.agentId, generation: record.generation,
        executionId, question: input.question, continuation: input.continuation,
        sourceMessagesJson: JSON.stringify(sources), createdAt: new Date().toISOString(), expiresAt: input.expiresAt,
      }).onConflictDoNothing().run()
      const saved = tx.select().from(conversationExpectations).where(eq(conversationExpectations.id, id)).get()!
      if (saved.question !== input.question || saved.continuation !== input.continuation ||
          saved.sourceMessagesJson !== JSON.stringify(sources) || (saved.expiresAt ?? undefined) !== input.expiresAt)
        throw new AppError('CONFLICT', { message: t('server.conversation', '等待事项标识已使用，请核对内容') })
      return { id }
    })
  }

  waitMany(executionId: string, items: ConversationWait[]) {
    return this.db.transaction(() => items.map((input) => this.wait(executionId, input)))
  }

  resolve(executionId: string, ids: string[]): void {
    if (!ids.length) return
    this.db.transaction((tx) => {
      const execution = this.assertCurrent(executionId)
      const responses = execution.sources.filter((source) =>
        tx.select().from(threadMessages).where(eq(threadMessages.id, source.messageId)).get()?.role === 'user')
      if (!responses.length) throw new AppError('INVALID_PARAMETER', { message: t('server.conversation', '回应事项需要有效的用户消息来源') })
      const pending = tx.select().from(conversationExpectations).where(and(
        eq(conversationExpectations.threadId, execution.threadId), eq(conversationExpectations.generation, execution.generation),
      )).all()
      this.open(execution.threadId, execution.generation)
      const now = new Date().toISOString()
      const responseSourcesJson = JSON.stringify(responses)
      const eligible = new Set(pending.filter((item) =>
        (item.status === 'open' && (!item.expiresAt || item.expiresAt > now)) ||
        (item.status === 'resolved' && item.responseSourcesJson === responseSourcesJson),
      ).map((item) => item.id))
      if (ids.some((id) => !eligible.has(id)))
        throw new AppError('CONFLICT', { message: t('server.conversation', '待回应事项已结束或不属于当前会话') })
      const questionSources = pending.filter((item) => ids.includes(item.id))
        .flatMap((item) => JSON.parse(item.sourceMessagesJson) as ConversationSource[])
      const sources = [...new Map([...execution.sources, ...questionSources].map((source) => [source.messageId, source])).values()]
      tx.update(conversationExecutions).set({ inputSourcesJson: JSON.stringify(sources) })
        .where(eq(conversationExecutions.id, executionId)).run()
      this.assertCurrent(executionId)
      tx.update(conversationExpectations).set({
        status: 'resolved', responseSourcesJson,
      }).where(inArray(conversationExpectations.id, ids)).run()
    })
  }

  settle(id: string, status: string, metadata: Record<string, unknown>, execution?: KernelExecutionDescriptor): void {
    this.db.transaction((tx) => {
      const current = tx.select().from(conversationExecutions).where(eq(conversationExecutions.id, id)).get()
      if (!current || current.status !== 'running') return
      const waiting = tx.select({ id: conversationExpectations.id }).from(conversationExpectations).where(and(
        eq(conversationExpectations.executionId, id), eq(conversationExpectations.status, 'open'),
      )).get()
      tx.update(conversationExecutions).set({
        status: status === 'completed' && waiting ? 'waiting' : status,
        metadataJson: JSON.stringify(metadata), kernelExecutionId: execution?.executionId, completedAt: new Date().toISOString(),
      }).where(eq(conversationExecutions.id, id)).run()
      if (execution && this.outbox) {
        const event = this.outbox.createEvent({
          protocolVersion: 1, type: 'conversation.execution.settled', durability: 'durable',
          principalId: execution.principalId, processId: execution.processId,
          executionId: execution.executionId, correlationId: execution.executionId,
          payload: { threadId: current.threadId, executionId: id, generation: current.generation },
        })
        tx.insert(kernelOutboxEvents).values(this.outbox.toRow(event)).run()
      }
    })
  }

  list(threadId: string, generation: number) {
    return this.db.select().from(conversationExecutions).where(and(
      eq(conversationExecutions.threadId, threadId), eq(conversationExecutions.generation, generation),
    )).all()
  }

  get(id: string) {
    return this.db.select().from(conversationExecutions).where(eq(conversationExecutions.id, id)).get()
  }

  consumeInputs(id: string, sources: ConversationSource[]): void {
    this.db.transaction((tx) => {
      const current = this.assertCurrent(id)
      const previous = tx.select({ inputSourcesJson: conversationExecutions.inputSourcesJson }).from(conversationExecutions)
        .where(and(eq(conversationExecutions.threadId, current.threadId), eq(conversationExecutions.generation, current.generation),
          inArray(conversationExecutions.status, ['completed', 'waiting']))).all()
      const consumed = new Set(previous.flatMap((run) => JSON.parse(run.inputSourcesJson) as ConversationSource[])
        .map((source) => `${source.messageId}@${source.revision}`))
      const additional = sources.filter((source) => {
        const message = tx.select().from(threadMessages).where(eq(threadMessages.id, source.messageId)).get()
        return message?.threadId === current.threadId && message.role === 'user' &&
          !consumed.has(`${source.messageId}@${source.revision}`)
      })
      const inputs = [...new Map([...current.sources, ...additional].map((source) => [source.messageId, source])).values()]
      tx.update(conversationExecutions).set({ inputSourcesJson: JSON.stringify(inputs) }).where(eq(conversationExecutions.id, id)).run()
      this.assertCurrent(id)
    })
  }

  forProjection(threadId: string, generation: number, executionIds: string[], after?: string, before?: string) {
    return this.db.select().from(conversationExecutions).where(and(
      eq(conversationExecutions.threadId, threadId), eq(conversationExecutions.generation, generation),
      or(inArray(conversationExecutions.id, executionIds), and(
        sql`${conversationExecutions.status} != 'running'`,
        after ? sql`${conversationExecutions.startedAt} >= ${after}` : undefined,
        before ? sql`${conversationExecutions.startedAt} <= ${before}` : undefined,
        sql`NOT EXISTS (SELECT 1 FROM thread_messages WHERE execution_id = ${conversationExecutions.id} AND role = 'assistant' AND status = 'active')`,
      )),
    )).orderBy(desc(conversationExecutions.startedAt)).limit(100).all()
  }

  recover(): void {
    this.db.update(conversationExecutions).set({ status: 'interrupted', completedAt: new Date().toISOString() })
      .where(eq(conversationExecutions.status, 'running')).run()
  }

  dependentPublications(messageId: number): number[] {
    const message = this.db.select().from(threadMessages).where(eq(threadMessages.id, messageId)).get()
    if (!message) return []
    const runIds = this.db.select({ id: conversationExecutions.id }).from(conversationExecutions).where(and(
      eq(conversationExecutions.threadId, message.threadId),
      sql`EXISTS (SELECT 1 FROM json_each(${conversationExecutions.inputSourcesJson}) WHERE json_extract(value, '$.messageId') = ${messageId})`,
    )).all().map((run) => run.id)
    if (!runIds.length) return []
    return this.db.select({ id: threadMessages.id }).from(threadMessages).where(and(
      inArray(threadMessages.executionId, runIds), eq(threadMessages.role, 'assistant'), eq(threadMessages.status, 'active'),
    )).all().map((row) => row.id)
  }

  /** 来源变化仅撤销关联执行贡献，其他正式消息独立保留。 */
  invalidate(messageId: number): string[] {
    return this.db.transaction((tx) => {
      const message = tx.select().from(threadMessages).where(eq(threadMessages.id, messageId)).get()
      if (!message) return []
      const thread = tx.select().from(threads).where(eq(threads.id, message.threadId)).get()
      if (!thread) return []
      const affected = tx.select({ id: conversationExecutions.id, inputSourcesJson: conversationExecutions.inputSourcesJson })
        .from(conversationExecutions).where(and(
          eq(conversationExecutions.threadId, message.threadId), eq(conversationExecutions.generation, thread.generation),
          or(message.executionId ? and(eq(conversationExecutions.id, message.executionId), eq(conversationExecutions.status, 'running')) : undefined,
            sql`EXISTS (SELECT 1 FROM json_each(${conversationExecutions.inputSourcesJson}) WHERE json_extract(value,'$.messageId') = ${messageId})`),
        )).all()
      const ids = affected.map((run) => run.id)
      const consumingRuns = new Set(affected.filter((run) =>
        (JSON.parse(run.inputSourcesJson) as ConversationSource[]).some((source) => source.messageId === messageId),
      ).map((run) => run.id))
      if (ids.length) {
        tx.update(conversationExecutions).set({ status: 'revoked' }).where(inArray(conversationExecutions.id, ids)).run()
      }
      const expectations = tx.select().from(conversationExpectations).where(and(
        eq(conversationExpectations.threadId, message.threadId), eq(conversationExpectations.generation, thread.generation),
      )).all()
      for (const expectation of expectations) {
        const questionSources = JSON.parse(expectation.sourceMessagesJson) as ConversationSource[]
        const responses = JSON.parse(expectation.responseSourcesJson) as ConversationSource[]
        if (questionSources.some((source) => source.messageId === messageId) || consumingRuns.has(expectation.executionId)) {
          tx.update(conversationExpectations).set({ status: 'cancelled' }).where(eq(conversationExpectations.id, expectation.id)).run()
        } else if (expectation.status === 'resolved' && responses.some((source) => source.messageId === messageId)) {
          tx.update(conversationExpectations).set({ status: 'open', responseSourcesJson: '[]' }).where(eq(conversationExpectations.id, expectation.id)).run()
        }
      }
      return ids
    })
  }

  publications(executionId: string) {
    return this.db.select().from(threadMessages).where(and(
      eq(threadMessages.executionId, executionId), eq(threadMessages.role, 'assistant'), eq(threadMessages.status, 'active'),
    )).orderBy(asc(threadMessages.id)).all()
  }

  /** 首条替代发言与旧消息撤回共用外层发布事务，失败时保留原消息。 */
  applyRegeneration(executionId: string): number[] {
    const execution = this.assertCurrent(executionId)
    const metadata = JSON.parse(execution.metadataJson)
    const regeneration = metadata.regeneration
    if (!regeneration || regeneration.applied) return []
    const target = this.db.select().from(threadMessages).where(eq(threadMessages.id, regeneration.messageId)).get()
    if (!target || target.threadId !== execution.threadId || target.status !== 'active' || target.revision !== regeneration.revision)
      throw new AppError('CONFLICT', { message: t('server.conversation', '消息已变化，请重新选择后再生成') })
    const replacements = this.db.select({ id: threadMessages.id }).from(threadMessages).where(and(
      eq(threadMessages.threadId, execution.threadId), eq(threadMessages.status, 'active'),
      eq(threadMessages.role, 'assistant'), inArray(threadMessages.id, regeneration.replacementMessageIds as number[]),
    )).all().map((message) => message.id)
    if (replacements.length) this.db.update(threadMessages).set({
      status: 'deleted', deletedBy: 'regeneration', deletedAt: new Date().toISOString(),
    }).where(inArray(threadMessages.id, replacements)).run()
    for (const id of replacements) this.invalidate(id)
    regeneration.applied = true
    this.db.update(conversationExecutions).set({ metadataJson: JSON.stringify(metadata) })
      .where(eq(conversationExecutions.id, executionId)).run()
    this.assertCurrent(executionId)
    return replacements
  }

  taskResultSource(threadId: string, taskId: string) {
    return this.db.select({ id: threadMessages.id }).from(threadMessages).where(and(
      eq(threadMessages.threadId, threadId), eq(threadMessages.status, 'active'),
      sql`json_extract(${threadMessages.metadataJson}, '$.taskId') = ${taskId}`,
      sql`json_extract(${threadMessages.metadataJson}, '$.kind') IN ('background_task_result', 'application_result')`,
    )).orderBy(desc(threadMessages.id)).get()
  }
}
