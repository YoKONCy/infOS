/**
 * BackgroundTask Repository（M05 §4.1）
 *
 * background_tasks 表的数据访问层。
 * 职责：
 * - 创建和更新任务
 * - 分页查询（按 Agent / 状态 / 时间 / 关键字筛选）
 * - 原子状态迁移（带来源状态守卫，防止乱序覆盖）
 * - 获取指定 Agent 的执行队列
 * - 服务重启后的未完成任务恢复查询
 *
 * @module packages/backend/src/repositories/backgroundTask.repo
 */

import { eq, desc, and, inArray, notInArray, like, gte, lte, sql } from 'drizzle-orm'
import { backgroundTasks, kernelOutboxEvents } from '../database/schema'
import { KernelOutboxRepository } from '../kernel/kernelOutboxRepository'
import { AppError } from '../lib/appError'
import type { DrizzleDb } from '../database'

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

/** 任务状态机（M05 §4） */
export type BackgroundTaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_input'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 任务来源 */
export type BackgroundTaskSource = 'user' | 'agent' | 'scheduler' | 'runtime'

/** 完成后行为 */
export type CompletionAction = 'notify' | 'open_result' | 'send_to_chat'

/** 任务类别；常驻任务不会进入普通执行队列。 */
export type BackgroundTaskCategory = 'agent_task' | 'resident'

/** 创建任务输入 */
export interface CreateBackgroundTaskInput {
  id: string
  agentId: string
  threadId: string
  targetThreadId?: string | null
  title: string
  instruction: string
  priority?: number
  parentTaskId?: string | null
  requestedBy?: BackgroundTaskSource
  completionAction?: CompletionAction
  category?: BackgroundTaskCategory
  status?: BackgroundTaskStatus
  metadataJson?: string
  lifecycleJson?: string
}

/** 分页查询参数 */
export interface BackgroundTaskQuery {
  parentTaskId?: string
  appId?: string
  category?: BackgroundTaskCategory
  agentId?: string
  status?: BackgroundTaskStatus | BackgroundTaskStatus[]
  keyword?: string
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface BackgroundTaskPage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

// Drizzle 推导行类型
export type BackgroundTaskRow = typeof backgroundTasks.$inferSelect

// ─────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────

export class BackgroundTaskRepository {
  constructor(private db: DrizzleDb) {}

  /** 当前本地时间（与 schema 默认一致格式） */
  private now(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19)
  }

  /** 创建任务（初始状态 queued） */
  async create(data: CreateBackgroundTaskInput): Promise<BackgroundTaskRow> {
    const rows = await this.db
      .insert(backgroundTasks)
      .values({
        id: data.id,
        agentId: data.agentId,
        threadId: data.threadId,
        targetThreadId: data.targetThreadId ?? null,
        title: data.title,
        instruction: data.instruction,
        priority: data.priority ?? 5,
        parentTaskId: data.parentTaskId ?? null,
        requestedBy: data.requestedBy ?? 'user',
        completionAction: data.completionAction ?? 'notify',
        category: data.category ?? 'agent_task',
        status: data.status ?? 'queued',
        metadataJson: data.metadataJson ?? '{}',
        lifecycleJson: data.lifecycleJson ?? null,
      })
      .returning()
    return rows[0]!
  }

  /** 按 ID 查询 */
  async findById(id: string): Promise<BackgroundTaskRow | null> {
    const rows = await this.db
      .select()
      .from(backgroundTasks)
      .where(eq(backgroundTasks.id, id))
      .limit(1)
    return rows[0] ?? null
  }

  /** 分页查询（默认按创建时间倒序） */
  async query(params: BackgroundTaskQuery): Promise<BackgroundTaskPage<BackgroundTaskRow>> {
    const conditions = []
    if (params.parentTaskId) conditions.push(eq(backgroundTasks.parentTaskId, params.parentTaskId))
    if (params.appId)
      conditions.push(
        sql`json_extract(${backgroundTasks.metadataJson}, '$.appId') = ${params.appId}`,
      )
    if (params.category) conditions.push(eq(backgroundTasks.category, params.category))
    if (params.agentId) conditions.push(eq(backgroundTasks.agentId, params.agentId))
    if (params.status) {
      const statuses = Array.isArray(params.status) ? params.status : [params.status]
      conditions.push(
        statuses.length === 1
          ? eq(backgroundTasks.status, statuses[0]!)
          : inArray(backgroundTasks.status, statuses),
      )
    }
    if (params.keyword) {
      // 标题或指令包含关键字
      conditions.push(
        sql`(${backgroundTasks.title} LIKE ${'%' + params.keyword + '%'} OR ${backgroundTasks.instruction} LIKE ${'%' + params.keyword + '%'})`,
      )
    }
    if (params.from) conditions.push(gte(backgroundTasks.createdAt, params.from))
    if (params.to) conditions.push(lte(backgroundTasks.createdAt, params.to))

    const where = conditions.length > 0 ? and(...conditions) : undefined
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20))

    const totalRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(backgroundTasks)
      .where(where)
    const total = totalRows[0]?.count ?? 0

    const items = await this.db
      .select()
      .from(backgroundTasks)
      .where(where)
      .orderBy(desc(backgroundTasks.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    return { items, total, page, pageSize }
  }

  /**
   * 原子状态迁移（带来源状态守卫）
   *
   * @param id 任务 ID
   * @param from 期望的当前状态（不匹配则不更新，返回 false）
   * @param to 目标状态
   * @param patch 随迁移一并写入的字段（如 startedAt / completedAt / errorMessage）
   */
  async transition(
    id: string,
    from: BackgroundTaskStatus | BackgroundTaskStatus[],
    to: BackgroundTaskStatus,
    patch: Partial<
      Pick<
        BackgroundTaskRow,
        | 'startedAt'
        | 'completedAt'
        | 'errorMessage'
        | 'result'
        | 'progress'
        | 'currentStage'
        | 'checkpointJson'
        | 'updatedAt'
        | 'lifecycleJson'
        | 'inputQuestion'
        | 'inputContextJson'
      >
    > = {},
    expectedRevision?: number,
  ): Promise<boolean> {
    const fromStatuses = Array.isArray(from) ? from : [from]
    return this.db.transaction((tx) => {
      const row = tx
        .update(backgroundTasks)
        .set({ status: to, updatedAt: this.now(), ...patch })
        .where(
          and(
            eq(backgroundTasks.id, id),
            inArray(backgroundTasks.status, fromStatuses),
            expectedRevision === undefined
              ? undefined
              : eq(backgroundTasks.revision, expectedRevision),
          ),
        )
        .returning()
        .get()
      if (!row) return false
      if (to === 'waiting' && row.lifecycleJson) {
        let wait = JSON.parse(row.lifecycleJson).wait as { kind: string; key: string } | undefined
        const visited = new Set([id])
        while (wait?.kind === 'task') {
          if (visited.has(wait.key) || visited.size > 100)
            throw new AppError('CONFLICT', { message: '任务等待形成循环' })
          visited.add(wait.key)
          const target = tx
            .select()
            .from(backgroundTasks)
            .where(eq(backgroundTasks.id, wait.key))
            .get()
          if (!target || target.agentId !== row.agentId)
            throw new AppError('CONFLICT', { message: '等待任务已失效' })
          wait = target.lifecycleJson ? JSON.parse(target.lifecycleJson).wait : undefined
        }
      }
      if (
        ['completed', 'failed', 'blocked', 'cancelled'].includes(to) ||
        (to === 'waiting_input' && row.lifecycleJson && JSON.parse(row.lifecycleJson).wait)
      ) {
        const outbox = new KernelOutboxRepository(this.db)
        const event = outbox.createEvent({
          protocolVersion: 1,
          type: 'task.notification',
          durability: 'durable',
          principalId: row.agentId,
          payload: { ...row, checkpointJson: null },
        })
        tx.insert(kernelOutboxEvents).values(outbox.toRow(event)).run()
      }
      return true
    })
  }

  /** 通用字段更新（进度/阶段/工具计数/检查点/错误信息等，不改状态） */
  async update(
    id: string,
    patch: Partial<
      Pick<
        BackgroundTaskRow,
        | 'title'
        | 'progress'
        | 'currentStage'
        | 'toolCallCount'
        | 'checkpointJson'
        | 'metadataJson'
        | 'inputQuestion'
        | 'inputContextJson'
        | 'errorMessage'
        | 'result'
        | 'updatedAt'
        | 'lifecycleJson'
      >
    >,
    expectedRevision?: number,
  ): Promise<void> {
    await this.db
      .update(backgroundTasks)
      .set({ ...patch, updatedAt: this.now() })
      .where(
        and(
          eq(backgroundTasks.id, id),
          expectedRevision === undefined
            ? undefined
            : eq(backgroundTasks.revision, expectedRevision),
        ),
      )
  }

  /** 用户意图变更与修订号在同一次写入中提交。 */
  async revise(
    id: string,
    revision: number,
    patch: Partial<
      Pick<
        BackgroundTaskRow,
        | 'instruction'
        | 'metadataJson'
        | 'title'
        | 'lifecycleJson'
        | 'checkpointJson'
        | 'inputQuestion'
        | 'inputContextJson'
        | 'status'
        | 'completedAt'
        | 'errorMessage'
      >
    >,
  ): Promise<boolean> {
    return (
      this.db
        .update(backgroundTasks)
        .set({ ...patch, revision: revision + 1, updatedAt: this.now() })
        .where(and(eq(backgroundTasks.id, id), eq(backgroundTasks.revision, revision)))
        .returning({ id: backgroundTasks.id })
        .all().length > 0
    )
  }

  async listWaiting(): Promise<BackgroundTaskRow[]> {
    return this.db
      .select()
      .from(backgroundTasks)
      .where(
        and(
          eq(backgroundTasks.category, 'agent_task'),
          inArray(backgroundTasks.status, ['waiting', 'waiting_input']),
        ),
      )
      .all()
  }

  /** 取消意图与任务修订一同持久化；进程中断或应用离线后继续收口委派。 */
  async listPendingCancellations(): Promise<BackgroundTaskRow[]> {
    return this.db
      .select()
      .from(backgroundTasks)
      .where(sql`json_extract(${backgroundTasks.metadataJson}, '$.cancellationPending') = 1`)
      .limit(100)
      .all()
  }

  /** 用 SQL 累计消耗，避免高频回调互相覆盖。 */
  consumeUsage(
    id: string,
    revision: number,
    usage: { llmCalls?: number; toolCalls?: number },
  ): void {
    this.db
      .update(backgroundTasks)
      .set({
        lifecycleJson: sql`json_set(${backgroundTasks.lifecycleJson},
      '$.usage.llmCalls', coalesce(json_extract(${backgroundTasks.lifecycleJson}, '$.usage.llmCalls'), 0) + ${usage.llmCalls ?? 0},
      '$.usage.toolCalls', coalesce(json_extract(${backgroundTasks.lifecycleJson}, '$.usage.toolCalls'), 0) + ${usage.toolCalls ?? 0})`,
      })
      .where(and(eq(backgroundTasks.id, id), eq(backgroundTasks.revision, revision)))
      .run()
  }

  recordEffect(
    id: string,
    revision: number,
    effect: { executionId: string; toolName: string; callId: string } | null,
    callId?: string,
  ): boolean {
    return (
      this.db
        .update(backgroundTasks)
        .set({
          lifecycleJson: effect
            ? sql`json_set(${backgroundTasks.lifecycleJson}, '$.pendingEffect', json(${JSON.stringify(effect)}))`
            : sql`json_remove(${backgroundTasks.lifecycleJson}, '$.pendingEffect')`,
        })
        .where(
          and(
            eq(backgroundTasks.id, id),
            eq(backgroundTasks.revision, revision),
            effect
              ? and(
                  eq(backgroundTasks.status, 'running'),
                  sql`json_extract(${backgroundTasks.lifecycleJson}, '$.pendingEffect') IS NULL`,
                )
              : !callId
                ? undefined
                : sql`json_extract(${backgroundTasks.lifecycleJson}, '$.pendingEffect.callId') = ${callId}`,
          ),
        )
        .returning({ id: backgroundTasks.id })
        .all().length > 0
    )
  }

  /** 获取指定 Agent 的执行队列（排队 + 运行中，按优先级 + 创建时间排序） */
  async listQueueByAgent(agentId: string): Promise<BackgroundTaskRow[]> {
    return await this.db
      .select()
      .from(backgroundTasks)
      .where(
        and(
          eq(backgroundTasks.agentId, agentId),
          eq(backgroundTasks.category, 'agent_task'),
          inArray(backgroundTasks.status, [
            'queued',
            'running',
            'paused',
            'waiting_input',
            'waiting',
            'blocked',
          ]),
        ),
      )
      .orderBy(backgroundTasks.priority, backgroundTasks.createdAt)
  }

  /** 统计各 Agent 活跃任务数（用于任务中心概览/聊天徽章） */
  async countActiveByAgent(): Promise<Array<{ agentId: string; count: number }>> {
    return await this.db
      .select({
        agentId: backgroundTasks.agentId,
        count: sql<number>`count(*)`,
      })
      .from(backgroundTasks)
      .where(
        and(
          eq(backgroundTasks.category, 'agent_task'),
          inArray(backgroundTasks.status, [
            'queued',
            'running',
            'paused',
            'waiting_input',
            'waiting',
            'blocked',
          ]),
        ),
      )
      .groupBy(backgroundTasks.agentId)
  }

  /** 判断 Thread 或 Agent 是否存在会阻止危险操作的任务。 */
  async hasActiveWork(input: { threadId?: string; agentId?: string }): Promise<boolean> {
    const identity = input.threadId
      ? eq(backgroundTasks.threadId, input.threadId)
      : eq(backgroundTasks.agentId, input.agentId!)
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(backgroundTasks)
      .where(
        and(
          identity,
          eq(backgroundTasks.category, 'agent_task'),
          inArray(backgroundTasks.status, [
            'queued',
            'running',
            'paused',
            'waiting_input',
            'waiting',
            'blocked',
          ]),
        ),
      )
    return (rows[0]?.count ?? 0) > 0
  }

  /** 按固定 ID 幂等注册常驻任务。 */
  async ensureResident(data: CreateBackgroundTaskInput): Promise<BackgroundTaskRow> {
    const existing = await this.findById(data.id)
    if (existing) {
      if (existing.category !== 'resident')
        throw new AppError('CONFLICT', { message: '常驻状态 ID 与普通任务冲突' })
      // 常驻记录随当前进程恢复；修复旧版本误套普通任务恢复逻辑留下的阻塞状态。
      await this.db
        .update(backgroundTasks)
        .set({
          status: 'running',
          currentStage: '系统常驻 · 随服务运行',
          errorMessage: null,
          completedAt: null,
          inputQuestion: null,
          inputContextJson: null,
          updatedAt: this.now(),
        })
        .where(and(eq(backgroundTasks.id, data.id), eq(backgroundTasks.category, 'resident')))
      return (await this.findById(data.id))!
    }
    const created = await this.create({
      ...data,
      category: 'resident',
      status: 'running',
      requestedBy: 'runtime',
    })
    await this.update(created.id, { currentStage: '系统常驻 · 随服务运行' })
    return (await this.findById(created.id))!
  }

  /** 角色删除时仅回收常驻投影，普通任务及其交付历史保留。 */
  async deleteResidentsForAgent(agentId: string): Promise<void> {
    await this.db
      .delete(backgroundTasks)
      .where(and(eq(backgroundTasks.category, 'resident'), eq(backgroundTasks.agentId, agentId)))
  }

  /** 启动时清理旧版本遗留的孤立常驻记录；空角色列表也必须清理。 */
  async pruneOrphanResidents(agentIds: string[]): Promise<void> {
    await this.db
      .delete(backgroundTasks)
      .where(
        and(
          eq(backgroundTasks.category, 'resident'),
          agentIds.length ? notInArray(backgroundTasks.agentId, agentIds) : undefined,
        ),
      )
  }

  /** 服务重启后的未完成任务恢复查询
   *
   * 返回普通任务中 running / waiting_input 状态的记录（重启后这些任务的
   * 执行现场已丢失，需要由 Service 决定标记 crashed 还是续跑）。
   */
  async listInterrupted(): Promise<BackgroundTaskRow[]> {
    return await this.db
      .select()
      .from(backgroundTasks)
      .where(
        and(
          eq(backgroundTasks.category, 'agent_task'),
          inArray(backgroundTasks.status, ['running', 'waiting_input']),
        ),
      )
  }

  /** 重启后补交尚未启动的任务，避免分页过程中状态变化漏掉任务。 */
  async listQueued(): Promise<BackgroundTaskRow[]> {
    return this.db
      .select()
      .from(backgroundTasks)
      .where(and(eq(backgroundTasks.status, 'queued'), eq(backgroundTasks.category, 'agent_task')))
      .all()
  }

  /** 标记历史记录已读，重复调用保持幂等。 */
  async markRead(id: string): Promise<boolean> {
    const rows = await this.db
      .update(backgroundTasks)
      .set({ readAt: this.now(), updatedAt: this.now() })
      .where(eq(backgroundTasks.id, id))
      .returning({ id: backgroundTasks.id })
    return rows.length > 0
  }

  /** 批量标记历史记录已读。 */
  async markAllRead(): Promise<number> {
    const rows = await this.db
      .update(backgroundTasks)
      .set({ readAt: this.now(), updatedAt: this.now() })
      .where(
        and(
          inArray(backgroundTasks.status, ['completed', 'failed', 'cancelled']),
          sql`${backgroundTasks.readAt} IS NULL`,
        ),
      )
      .returning({ id: backgroundTasks.id })
    return rows.length
  }

  /** 删除一条任务记录。 */
  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(backgroundTasks)
      .where(eq(backgroundTasks.id, id))
      .returning({ id: backgroundTasks.id })
    return rows.length > 0
  }

  /** LIKE 筛选辅助（保留给未来按 title 精确过滤扩展） */
  protected likeTitle(keyword: string) {
    return like(backgroundTasks.title, `%${keyword}%`)
  }
}
