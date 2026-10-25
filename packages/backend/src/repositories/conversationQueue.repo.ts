import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type {
  ConversationQueueItem,
  ConversationQueueSnapshot,
  QueuedConversationInput,
} from '@infos/shared'
import type { DrizzleDb } from '../database'
import { durableQueueWrite } from '../database/connection'
import {
  conversationQueueItems as items,
  conversationQueueThreads as threads,
  threadMessages,
} from '../database/schema'
import { AppError } from '../lib/appError'
import { t as __t } from '../lib/i18n'

type Row = typeof items.$inferSelect
const visibleStates = ['queued', 'running']

/** 所有改变派发权的操作均同步落盘；HTTP 确认不早于事务提交。 */
export class ConversationQueueRepository {
  constructor(private readonly db: DrizzleDb) {}

  private dto(row: Row): ConversationQueueItem {
    return {
      id: row.id,
      revision: row.revision,
      position: row.position,
      state: row.state as ConversationQueueItem['state'],
      input: JSON.parse(row.inputJson),
      immediate: row.immediate,
      createdAt: row.createdAt,
      error: row.error ?? undefined,
    }
  }

  get(id: string): ConversationQueueItem | undefined {
    const row = this.db.select().from(items).where(eq(items.id, id)).get()
    return row ? this.dto(row) : undefined
  }

  snapshot(threadId: string): ConversationQueueSnapshot {
    const thread = this.db.select().from(threads).where(eq(threads.threadId, threadId)).get()
    const entries = this.db
      .select()
      .from(items)
      .where(and(eq(items.threadId, threadId), inArray(items.state, [...visibleStates, 'draft'])))
      .orderBy(asc(items.position), asc(items.createdAt))
      .all()
      .map((row) => this.dto(row))
    return {
      threadId,
      paused: thread?.paused ?? false,
      reason: thread?.reason ?? undefined,
      items: entries.filter((entry) => entry.state !== 'draft'),
      drafts: entries.filter((entry) => entry.state === 'draft'),
    }
  }

  enqueue(id: string, input: QueuedConversationInput): ConversationQueueItem {
    return durableQueueWrite(this.db, () => {
      const existing = this.get(id)
      if (existing) {
        if (existing.input.threadId !== input.threadId)
          throw new AppError('CONFLICT', { message: '提交标识已属于另一会话' })
        return existing
      }
      const snapshot = this.snapshot(input.threadId)
      if (snapshot.items.length >= 100)
        throw new AppError('CONFLICT', { message: '待发消息最多 100 条' })
      if (
        [...snapshot.items, ...(snapshot.drafts ?? [])].some((entry) =>
          entry.input.attachmentIds?.some((attachment) =>
            input.attachmentIds?.includes(attachment),
          ),
        )
      )
        throw new AppError('CONFLICT', { message: '附件已在其他待发消息中' })
      this.db.insert(threads).values({ threadId: input.threadId }).onConflictDoNothing().run()
      if (!snapshot.items.length)
        this.db
          .update(threads)
          .set({ paused: false, reason: null })
          .where(eq(threads.threadId, input.threadId))
          .run()
      const position = Math.max(0, ...snapshot.items.map((entry) => entry.position)) + 1
      const row = this.db
        .insert(items)
        .values({
          id,
          threadId: input.threadId,
          inputJson: JSON.stringify(input),
          position,
          createdAt: Date.now(),
        })
        .returning()
        .get()!
      return this.dto(row)
    })
  }

  mutate(
    threadId: string,
    id: string,
    revision: number,
    change: { content?: string; cancel?: boolean; immediate?: boolean; draft?: boolean },
  ): void {
    durableQueueWrite(this.db, () => {
      const entry = this.get(id)
      if (!entry || entry.input.threadId !== threadId)
        throw new AppError('NOT_FOUND', { message: '队列消息不存在' })
      if (entry.revision !== revision)
        throw new AppError('CONFLICT', { message: '队列已在另一客户端更新，请刷新后重试' })
      if (entry.input.taskResultEvent && !change.cancel)
        throw new AppError('CONFLICT', {
          message: __t('server.task', '任务交付事件不能改写为用户消息，只能取消本次唤醒'),
        })
      if (entry.state === 'running' || entry.immediate)
        throw new AppError('CONFLICT', { message: '消息已开始执行' })
      if (!visibleStates.includes(entry.state) && !(entry.state === 'draft' && change.cancel))
        throw new AppError('CONFLICT', { message: '该消息已处理' })
      if (change.content !== undefined && entry.state !== 'queued')
        throw new AppError('CONFLICT', { message: '只能编辑尚未执行的消息' })
      if (change.immediate && entry.state !== 'queued')
        throw new AppError('CONFLICT', { message: '只能立即提交尚未执行的消息' })
      if (change.draft && entry.state !== 'queued')
        throw new AppError('CONFLICT', { message: '消息已发送，无法退回编辑' })
      const snapshot = this.snapshot(threadId)
      if (
        change.immediate &&
        snapshot.items.some((item) => item.immediate && item.state === 'queued')
      )
        throw new AppError('CONFLICT', { message: '已有一条消息正在交接，请稍候' })
      this.db
        .update(items)
        .set({
          inputJson: JSON.stringify({
            ...entry.input,
            ...(change.content !== undefined ? { content: change.content } : {}),
          }),
          state: change.cancel ? 'cancelled' : change.draft ? 'draft' : entry.state,
          immediate: change.immediate ?? false,
          position: change.immediate
            ? Math.min(0, ...snapshot.items.map((item) => item.position)) - 1
            : entry.position,
          revision: entry.revision + 1,
        })
        .where(eq(items.id, id))
        .run()
    })
  }

  reorder(threadId: string, order: Array<{ id: string; revision: number }>): void {
    durableQueueWrite(this.db, () => {
      const queued = this.snapshot(threadId).items.filter(
        (entry) => entry.state === 'queued' && !entry.immediate,
      )
      if (
        order.length !== queued.length ||
        new Set(order.map((entry) => entry.id)).size !== order.length ||
        order.some(
          (entry) =>
            !queued.some((item) => item.id === entry.id && item.revision === entry.revision),
        )
      )
        throw new AppError('CONFLICT', { message: '队列顺序已变化，请刷新后重试' })
      order.forEach((entry, position) =>
        this.db
          .update(items)
          .set({ position: position + 1, revision: entry.revision + 1 })
          .where(eq(items.id, entry.id))
          .run(),
      )
    })
  }

  pause(threadId: string, paused: boolean, reason?: string): void {
    durableQueueWrite(this.db, () => {
      this.db
        .insert(threads)
        .values({ threadId, paused, reason: reason ?? null })
        .onConflictDoUpdate({ target: threads.threadId, set: { paused, reason: reason ?? null } })
        .run()
      if (paused)
        this.db
          .update(items)
          .set({ immediate: false, revision: sql`${items.revision} + 1` })
          .where(
            and(eq(items.threadId, threadId), eq(items.state, 'queued'), eq(items.immediate, true)),
          )
          .run()
    })
  }

  historyChanged(threadId: string, deleted = false, discardPending = false): void {
    durableQueueWrite(this.db, () => {
      this.db
        .update(items)
        .set({
          checkpointJson: null,
          revision: sql`${items.revision} + 1`,
          ...(deleted
            ? {
                state: 'cancelled',
                inputJson: JSON.stringify({ threadId, content: '' }),
                immediate: false,
              }
            : {}),
        })
        .where(eq(items.threadId, threadId))
        .run()
      if (discardPending && !deleted)
        this.db
          .update(items)
          .set({ state: 'cancelled', immediate: false })
          .where(
            and(eq(items.threadId, threadId), inArray(items.state, ['queued', 'running', 'draft'])),
          )
          .run()
      this.db
        .insert(threads)
        .values({ threadId, paused: true, reason: '会话历史已变更，请核对待发送消息' })
        .onConflictDoUpdate({
          target: threads.threadId,
          set: { paused: true, reason: '会话历史已变更，请核对待发送消息' },
        })
        .run()
    })
  }

  claim(threadId: string): ConversationQueueItem | undefined {
    return durableQueueWrite(this.db, () => {
      const snapshot = this.snapshot(threadId)
      if (snapshot.paused || snapshot.items.some((entry) => entry.state === 'running')) return
      const entry = snapshot.items.find((item) => item.state === 'queued')
      if (!entry) return
      this.db
        .update(items)
        .set({ state: 'running', revision: entry.revision + 1 })
        .where(eq(items.id, entry.id))
        .run()
      return this.get(entry.id)
    })
  }

  settle(id: string, state: ConversationQueueItem['state'], error?: string): void {
    durableQueueWrite(this.db, () =>
      this.db
        .update(items)
        .set({
          state,
          error: error ?? null,
          immediate: false,
          revision: (this.get(id)?.revision ?? 0) + 1,
        })
        .where(eq(items.id, id))
        .run(),
    )
  }

  /** 崩溃后不猜测工具是否成功；只有已保存完整回复的条目能直接结算。 */
  recover(): void {
    durableQueueWrite(this.db, () => {
      // 停用旧版本尚未发送的合成续接项；已有聊天消息不在此修改。
      this.db
        .update(items)
        .set({
          state: 'cancelled',
          immediate: false,
          revision: sql`${items.revision} + 1`,
        })
        .where(and(eq(items.state, 'queued'), sql`${items.id} LIKE '%:continue'`))
        .run()
      this.db
        .update(items)
        .set({ checkpointJson: null })
        .where(sql`${items.checkpointJson} IS NOT NULL`)
        .run()
      const unfinished = this.db
        .select()
        .from(items)
        .where(inArray(items.state, ['queued', 'running']))
        .all()
      for (const row of unfinished) {
        if (row.state === 'running') {
          const reply = this.db
            .select()
            .from(threadMessages)
            .where(
              and(
                eq(threadMessages.threadId, row.threadId),
                eq(threadMessages.pairId, `queue_${row.id}`),
                eq(threadMessages.role, 'assistant'),
                eq(threadMessages.status, 'active'),
              ),
            )
            .get()
          this.db
            .update(items)
            .set({
              state: reply ? 'completed' : 'interrupted',
              immediate: false,
              error: reply ? null : '应用曾异常退出，本次执行已中断，请在聊天栏自行发送后续指令。',
              revision: row.revision + 1,
            })
            .where(eq(items.id, row.id))
            .run()
        } else if (row.immediate) {
          this.db
            .update(items)
            .set({ immediate: false, revision: row.revision + 1 })
            .where(eq(items.id, row.id))
            .run()
        }
        this.db
          .insert(threads)
          .values({
            threadId: row.threadId,
            paused: true,
            reason: '重启后未发送消息已保留，请确认是否发送',
          })
          .onConflictDoUpdate({
            target: threads.threadId,
            set: { paused: true, reason: '重启后未发送消息已保留，请确认是否发送' },
          })
          .run()
      }
    })
  }

  readyThreads(): string[] {
    return this.db
      .selectDistinct({ id: threads.threadId })
      .from(threads)
      .innerJoin(items, eq(items.threadId, threads.threadId))
      .where(and(eq(threads.paused, false), eq(items.state, 'queued')))
      .all()
      .map((row) => row.id)
  }

  referencesAttachment(id: string): boolean {
    return this.db
      .select()
      .from(items)
      .where(inArray(items.state, [...visibleStates, 'draft']))
      .all()
      .some((row) =>
        (JSON.parse(row.inputJson) as QueuedConversationInput).attachmentIds?.includes(id),
      )
  }
}
