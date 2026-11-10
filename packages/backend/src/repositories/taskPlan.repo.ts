import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../database'
import {
  backgroundTasks,
  scheduledTasks,
  taskPlans,
  taskPlanMutations,
  threadMessages,
  threads,
} from '../database/schema'
import { AppError } from '../lib/appError'
import type { PlanStep } from '@infos/shared'
import type { BackgroundTaskRow } from './backgroundTask.repo'

export type PlanRow = typeof taskPlans.$inferSelect

/** 版本检查与写入在同一同步事务中完成，不修改任务的执行修订。 */
export class TaskPlanRepository {
  constructor(private db: DrizzleDb) {}

  thread(id: string) {
    return this.db
      .select()
      .from(threads)
      .where(and(eq(threads.id, id), eq(threads.status, 'active')))
      .get()
  }

  task(id: string) {
    return this.db.select().from(backgroundTasks).where(eq(backgroundTasks.id, id)).get()
  }

  current(threadId: string) {
    return this.db
      .select()
      .from(taskPlans)
      .where(and(eq(taskPlans.threadId, threadId), ne(taskPlans.status, 'archived')))
      .orderBy(desc(taskPlans.createdAt))
      .get()
  }

  find(id: string) {
    return this.db.select().from(taskPlans).where(eq(taskPlans.id, id)).get()
  }

  related(planId: string, agentId: string) {
    const tasks = this.db
      .select()
      .from(backgroundTasks)
      .where(
        and(
          eq(backgroundTasks.agentId, agentId),
          sql`json_extract(CASE WHEN json_valid(${backgroundTasks.metadataJson}) THEN ${backgroundTasks.metadataJson} ELSE '{}' END, '$.planId') = ${planId}`,
        ),
      )
      .all()
    const schedules = this.db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.agentId, agentId), eq(scheduledTasks.planId, planId)))
      .all()
    return { tasks, schedules }
  }

  write(
    row: PlanRow,
    previous?: PlanRow,
    replace = false,
    origin?: { pairId?: string; toolCallId?: string; generation?: number },
  ) {
    return this.db.transaction((tx) => {
      if (origin?.pairId && new ConversationRepository(this.db).get(origin.pairId)) new ConversationRepository(this.db).assertCurrent(origin.pairId)
      const thread = tx
        .select({ id: threads.id, generation: threads.generation })
        .from(threads)
        .where(and(eq(threads.id, row.threadId), eq(threads.status, 'active')))
        .get()
      const deletedPair = origin?.pairId
        ? tx
            .select({ id: threadMessages.id })
            .from(threadMessages)
            .where(
              and(
                eq(threadMessages.threadId, row.threadId),
                eq(threadMessages.pairId, origin.pairId),
                eq(threadMessages.status, 'deleted'),
              ),
            )
            .get()
        : undefined
      if (!thread || deletedPair || (origin?.generation !== undefined && thread.generation !== origin.generation))
        throw new AppError('CONFLICT', { message: '原对话已删除或撤回，不能再更新清单' })
      const current = tx
        .select()
        .from(taskPlans)
        .where(and(eq(taskPlans.threadId, row.threadId), ne(taskPlans.status, 'archived')))
        .get()
      if (current?.id !== previous?.id || current?.revision !== previous?.revision)
        throw new AppError('CONFLICT', { message: '计划已改变，请读取最新计划后重试' })
      if (row.taskId) {
        const task = tx
          .select()
          .from(backgroundTasks)
          .where(eq(backgroundTasks.id, row.taskId))
          .get()
        if (!task || task.revision !== row.taskRevision || task.status !== 'running')
          throw new AppError('CONFLICT', { message: '任务已停止或修改，不能更新旧计划' })
      }
      if (replace && current)
        tx.update(taskPlans).set({ status: 'archived' }).where(eq(taskPlans.id, current.id)).run()
      if (!previous || replace) tx.insert(taskPlans).values(row).run()
      else tx.update(taskPlans).set(row).where(eq(taskPlans.id, row.id)).run()
      if (origin?.pairId) {
        const ids = [...new Set([row.id, ...(current ? [current.id] : [])])]
        const after = tx.select().from(taskPlans).where(inArray(taskPlans.id, ids)).all()
        tx.insert(taskPlanMutations)
          .values({
            threadId: row.threadId,
            agentId: row.agentId,
            pairId: origin.pairId,
            callId: origin.toolCallId,
            beforeJson: JSON.stringify(current ? [current] : []),
            afterJson: JSON.stringify(after),
            createdAt: new Date().toISOString(),
          })
          .run()
      }
      return row
    })
  }

  /** 逆序恢复选中轮次；较新的其他轮次或外部修改优先保留。 */
  rollbackPairs(threadId: string, pairIds: string[]): boolean {
    if (!pairIds.length) return false
    return this.db.transaction((tx) => {
      const selected = new Set(pairIds)
      const protectedIds = new Set<string>()
      const mutations = tx
        .select()
        .from(taskPlanMutations)
        .where(
          and(
            eq(taskPlanMutations.threadId, threadId),
            inArray(taskPlanMutations.status, ['active', 'superseded']),
          ),
        )
        .orderBy(desc(taskPlanMutations.id))
        .all()
      let changed = false
      for (const mutation of mutations) {
        const after = JSON.parse(mutation.afterJson) as PlanRow[]
        if (!selected.has(mutation.pairId) && mutation.status !== 'superseded') {
          after.forEach((row) => protectedIds.add(row.id))
          continue
        }
        const before = JSON.parse(mutation.beforeJson) as PlanRow[]
        const current = tx
          .select()
          .from(taskPlans)
          .where(
            inArray(
              taskPlans.id,
              after.map((row) => row.id),
            ),
          )
          .all()
        const safe = after.every(
          (row) =>
            !protectedIds.has(row.id) &&
            current.some((value) => planContent(value) === planContent(row)),
        )
        if (safe) {
          for (const row of after) {
            const prior = before.find((value) => value.id === row.id)
            if (prior)
              tx.update(taskPlans)
                .set({
                  ...prior,
                  revision: current.find((value) => value.id === row.id)!.revision + 1,
                  updatedAt: new Date().toISOString(),
                })
                .where(eq(taskPlans.id, row.id))
                .run()
            else tx.delete(taskPlans).where(eq(taskPlans.id, row.id)).run()
          }
          changed = true
        } else after.forEach((row) => protectedIds.add(row.id))
        tx.update(taskPlanMutations)
          .set({ status: safe ? 'reverted' : 'superseded' })
          .where(eq(taskPlanMutations.id, mutation.id))
          .run()
      }
      // 旧清单没有变更日志时，只归档明确由已撤回轮次新建的清单，不猜测旧步骤。
      const first = tx
        .select({ timestamp: threadMessages.timestamp })
        .from(threadMessages)
        .where(and(eq(threadMessages.threadId, threadId), inArray(threadMessages.pairId, pairIds)))
        .orderBy(asc(threadMessages.id))
        .get()
      if (first?.timestamp) {
        const threshold = new Date(first.timestamp.replace(' ', 'T')).getTime()
        for (const row of tx
          .select()
          .from(taskPlans)
          .where(and(eq(taskPlans.threadId, threadId), ne(taskPlans.status, 'archived')))
          .all()) {
          if (
            !mutations.some((mutation) =>
              (JSON.parse(mutation.afterJson) as PlanRow[]).some((value) => value.id === row.id),
            ) &&
            Date.parse(row.createdAt) >= threshold
          ) {
            tx.update(taskPlans)
              .set({
                status: 'archived',
                revision: row.revision + 1,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(taskPlans.id, row.id))
              .run()
            changed = true
          }
        }
      }
      return changed
    })
  }

  archiveThread(threadId: string): void {
    this.db
      .update(taskPlans)
      .set({ status: 'archived', updatedAt: new Date().toISOString() })
      .where(eq(taskPlans.threadId, threadId))
      .run()
    this.db
      .update(taskPlanMutations)
      .set({ status: 'discarded' })
      .where(
        and(
          eq(taskPlanMutations.threadId, threadId),
          inArray(taskPlanMutations.status, ['active', 'superseded']),
        ),
      )
      .run()
  }

  /** 启动时仅核对普通对话；后台任务继续由任务恢复流程负责。 */
  interruptedTurns(): Map<string, string[]> {
    const pending = new Map<string, Set<string>>()
    const checked = new Set<string>()
    const mutations = this.db
      .select()
      .from(taskPlanMutations)
      .innerJoin(threads, eq(taskPlanMutations.threadId, threads.id))
      .where(and(eq(taskPlanMutations.status, 'active'), eq(threads.status, 'active')))
      .all()
    for (const { task_plan_mutations: mutation } of mutations) {
      const key = JSON.stringify([mutation.threadId, mutation.pairId])
      if (checked.has(key)) continue
      checked.add(key)
      if ((JSON.parse(mutation.afterJson) as PlanRow[]).some((row) => row.taskId)) continue
      const execution = new ConversationRepository(this.db).get(mutation.pairId)
      if (execution) {
        if (!['completed', 'waiting', 'paused'].includes(execution.status)) {
          const executionIds = pending.get(mutation.threadId) ?? new Set<string>()
          executionIds.add(execution.id)
          pending.set(mutation.threadId, executionIds)
        }
        continue
      }
      const messages = this.db
        .select({ role: threadMessages.role, status: threadMessages.status })
        .from(threadMessages)
        .where(
          and(
            eq(threadMessages.threadId, mutation.threadId),
            eq(threadMessages.pairId, mutation.pairId),
          ),
        )
        .all()
      if (
        !messages.length ||
        messages.some((message) => message.role === 'assistant' && message.status === 'active')
      )
        continue
      const pairs = pending.get(mutation.threadId) ?? new Set<string>()
      pairs.add(mutation.pairId)
      pending.set(mutation.threadId, pairs)
    }
    return new Map([...pending].map(([threadId, pairs]) => [threadId, [...pairs]]))
  }

  /** 用户调整任务要求时归档旧步骤，迟到的执行无法恢复它。 */
  archiveTask(taskId: string) {
    this.db
      .update(taskPlans)
      .set({ status: 'archived', updatedAt: new Date().toISOString() })
      .where(and(eq(taskPlans.taskId, taskId), ne(taskPlans.status, 'archived')))
      .run()
  }

  /** 删除已结束的执行记录时留下最终步骤状态，避免完成度倒退。 */
  retainTaskOutcome(task: BackgroundTaskRow): string | undefined {
    let link: { planId?: string; planStepId?: string }
    try {
      link = JSON.parse(task.metadataJson)
    } catch {
      return
    }
    if (!link.planId || !link.planStepId) return
    const row = this.find(link.planId)
    if (!row || row.agentId !== task.agentId) return
    const steps = JSON.parse(row.stepsJson) as PlanStep[]
    const step = steps.find((item) => item.id === link.planStepId)
    if (!step) return
    step.status = task.status === 'completed' ? 'completed' : 'blocked'
    this.db
      .update(taskPlans)
      .set({
        stepsJson: JSON.stringify(steps),
        revision: row.revision + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(taskPlans.id, row.id), eq(taskPlans.revision, row.revision)))
      .run()
    return row.threadId
  }
}

function planContent(row: PlanRow): string {
  const { revision: _revision, updatedAt: _updatedAt, ...content } = row
  return JSON.stringify(content)
}
import { ConversationRepository } from './conversation.repo'
