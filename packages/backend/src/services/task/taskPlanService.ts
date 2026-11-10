import { t as __t } from '../../lib/i18n'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PlanStep, TaskPlan, UpdatePlanInput } from '@infos/shared'
import { TaskPlanRepository, type PlanRow } from '../../repositories/taskPlan.repo'
import { AppError } from '../../lib/appError'
import { createLogger } from '../../lib/logger'

const logger = createLogger('TaskPlanService')
const stepSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(300),
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
  })
  .strict()
export const updatePlanSchema = z
  .object({
    action: z.enum(['create', 'update', 'get', 'clear']),
    expectedRevision: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(120).optional(),
    steps: z.array(stepSchema).min(1).max(20).optional(),
  })
  .strict()

export interface PlanScope {
  agentId: string
  threadId: string
  taskId?: string
  pairId?: string
  toolCallId?: string
  generation?: number
}

/** 清单保存公开步骤，任务与定时计划的执行状态只作实时投影。 */
export class TaskPlanService {
  private dispatches = new Map<string, Promise<void>>()
  constructor(
    private repo: TaskPlanRepository,
    private notify: (agentId: string, threadId: string) => Promise<void>,
  ) {}

  private scope(scope: PlanScope) {
    const thread = this.repo.thread(scope.threadId)
    if (!thread || thread.agentId !== scope.agentId)
      throw new AppError('NOT_FOUND', { message: '会话不存在或不属于当前角色' })
    if (scope.taskId) {
      const task = this.repo.task(scope.taskId)
      if (!task || task.threadId !== scope.threadId || task.agentId !== scope.agentId)
        throw new AppError('FORBIDDEN', { message: '计划与任务归属不匹配' })
      return task
    }
    if (thread.purpose !== 'conversation')
      throw new AppError('FORBIDDEN', { message: '此会话需要有效任务身份才能修改计划' })
    return undefined
  }

  get(threadId: string, agentId: string): TaskPlan | null {
    const thread = this.repo.thread(threadId)
    if (!thread || thread.agentId !== agentId)
      throw new AppError('NOT_FOUND', { message: '会话不存在或不属于当前角色' })
    const row = this.repo.current(threadId)
    return row ? this.project(row) : null
  }

  private project(row: PlanRow): TaskPlan {
    let value: unknown
    try {
      value = JSON.parse(row.stepsJson)
    } catch {
      value = null
    }
    const parsed = z.array(stepSchema).min(1).max(20).safeParse(value)
    if (!parsed.success) throw new AppError('CONFLICT', { message: '计划记录损坏，请检查后恢复' })
    const related = this.repo.related(row.id, row.agentId)
    const steps: PlanStep[] = parsed.data.map((step) => {
      const task = related.tasks.find((item) => {
        try {
          return JSON.parse(item.metadataJson).planStepId === step.id
        } catch {
          return false
        }
      })
      if (task) {
        const status =
          task.status === 'completed'
            ? 'completed'
            : task.status === 'running'
              ? 'in_progress'
              : task.status === 'queued'
                ? 'pending'
                : 'blocked'
        return { ...step, status, task: { id: task.id, status: task.status } }
      }
      const schedule = related.schedules.find((item) => item.planStepId === step.id)
      if (schedule)
        return {
          ...step,
          status: ['failed', 'cancelled'].includes(schedule.status)
            ? 'blocked'
            : schedule.status === 'completed'
              ? 'completed'
              : schedule.status === 'dispatched'
                ? step.status
                : 'pending',
          schedule: { id: schedule.id, status: schedule.status, time: schedule.time },
        }
      return step
    })
    return {
      id: row.id,
      agentId: row.agentId,
      threadId: row.threadId,
      taskId: row.taskId,
      revision: row.revision,
      title: row.title,
      status:
        row.status === 'archived'
          ? 'archived'
          : steps.length && steps.every((step) => step.status === 'completed')
            ? 'completed'
            : 'active',
      steps,
      createdAt: row.createdAt,
      updatedAt: [row.updatedAt, ...related.tasks.map((task) => task.updatedAt)]
        .map((time) => (time.includes('T') ? time : time.replace(' ', 'T') + 'Z'))
        .sort()
        .at(-1)!,
    }
  }

  async update(scope: PlanScope, raw: UpdatePlanInput): Promise<TaskPlan | null> {
    const input = updatePlanSchema.parse(raw)
    const task = this.scope(scope)
    const current = this.repo.current(scope.threadId)
    if (input.action === 'get') return current ? this.project(current) : null
    if (input.action !== 'create' && (!current || input.expectedRevision !== current.revision))
      throw new AppError('CONFLICT', { message: '请读取最新计划，并携带 expectedRevision 更新' })
    if (input.action === 'create' && current && this.project(current).status === 'active')
      throw new AppError('CONFLICT', { message: '已有未结束的计划，请更新或明确清除后再创建' })
    if (input.action !== 'clear' && !input.steps)
      throw new AppError('VALIDATION_ERROR', { message: '请提供完整步骤列表' })
    const steps = input.steps ?? (JSON.parse(current!.stepsJson) as PlanStep[])
    if (new Set(steps.map((step) => step.id)).size !== steps.length)
      throw new AppError('VALIDATION_ERROR', { message: '步骤 ID 不能重复' })
    if (steps.filter((step) => step.status === 'in_progress').length > 1)
      throw new AppError('VALIDATION_ERROR', { message: '同一份清单只标记一个当前处理步骤' })
    if (input.action === 'create' && !input.title)
      throw new AppError('VALIDATION_ERROR', { message: '创建计划需要简短标题' })
    const now = new Date().toISOString()
    const create = input.action === 'create'
    const row: PlanRow = {
      id: create ? randomUUID() : current!.id,
      agentId: scope.agentId,
      threadId: scope.threadId,
      taskId: scope.taskId ?? null,
      taskRevision: task?.revision ?? null,
      revision: create ? 1 : current!.revision + 1,
      title: input.title ?? current!.title,
      status: input.action === 'clear' ? 'archived' : 'active',
      stepsJson: JSON.stringify(steps),
      createdAt: create ? now : current!.createdAt,
      updatedAt: now,
    }
    const result = row.status === 'archived' ? null : this.project(row)
    this.repo.write(row, current, create, scope)
    await this.changed(scope.agentId, scope.threadId)
    return result
  }

  async rollbackPairs(threadId: string, pairIds: string[]): Promise<void> {
    const agentId = this.repo.thread(threadId)?.agentId ?? this.repo.current(threadId)?.agentId
    if (this.repo.rollbackPairs(threadId, pairIds) && agentId) await this.changed(agentId, threadId)
  }

  async recoverInterruptedTurns(): Promise<void> {
    for (const [threadId, pairs] of this.repo.interruptedTurns())
      await this.rollbackPairs(threadId, pairs)
  }

  async clearThread(threadId: string): Promise<void> {
    const agentId = this.repo.current(threadId)?.agentId
    this.repo.archiveThread(threadId)
    if (agentId) await this.changed(agentId, threadId)
  }

  /** 关联由派发入口确认，模型不能通过勾选覆盖后台执行状态。 */
  link(agentId: string, planId?: string, stepId?: string, threadId?: string) {
    if (!planId && !stepId) return undefined
    const row = planId ? this.repo.find(planId) : undefined
    if (
      !row ||
      row.agentId !== agentId ||
      row.taskId ||
      (threadId && row.threadId !== threadId) ||
      !this.repo.thread(row.threadId) ||
      row.status === 'archived' ||
      !stepId
    )
      throw new AppError('NOT_FOUND', { message: '找不到可关联的会话计划' })
    const step = this.project(row).steps.find((item) => item.id === stepId)
    if (!step || step.status === 'completed')
      throw new AppError('CONFLICT', { message: '计划步骤不存在或已经完成' })
    if (step.task || step.schedule)
      throw new AppError('CONFLICT', { message: '此步骤已关联任务或定时计划，请查看原任务' })
    return { planId: row.id, planStepId: step.id, originThreadId: row.threadId }
  }

  archiveTask(taskId: string) {
    this.repo.archiveTask(taskId)
  }

  forTask(taskId: string): TaskPlan | null {
    const task = this.repo.task(taskId)
    const row = task ? this.repo.current(task.threadId) : undefined
    return row && row.taskId === taskId ? this.project(row) : null
  }

  async retainDeletedTask(
    task: import('../../repositories/backgroundTask.repo').BackgroundTaskRow,
  ) {
    const threadId = this.repo.retainTaskOutcome(task)
    if (threadId) await this.changed(task.agentId, threadId)
  }

  /** 同一步的后台派发与定时安排串行确认，避免并行工具调用重复安排。 */
  async withLink<T>(
    agentId: string,
    planId: string | undefined,
    stepId: string | undefined,
    threadId: string | undefined,
    dispatch: (link: ReturnType<TaskPlanService['link']>) => Promise<T>,
  ): Promise<T> {
    if (!planId && !stepId) return dispatch(undefined)
    const key = `${planId}:${stepId}`
    const previous = this.dispatches.get(key)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    this.dispatches.set(key, pending)
    await previous
    try {
      return await dispatch(this.link(agentId, planId, stepId, threadId))
    } finally {
      release()
      if (this.dispatches.get(key) === pending) this.dispatches.delete(key)
    }
  }

  /** 仅兼容旧检查点的段末计划，新工具更新后不再接受旧快照覆盖。 */
  async importLegacy(
    scope: PlanScope,
    title: string,
    steps: Array<{ title: string; done: boolean }>,
  ) {
    if (!steps.length || this.repo.current(scope.threadId)) return
    await this.update(scope, {
      action: 'create',
      title: title.slice(0, 120),
      steps: steps.map((step, i) => ({
        id: `step-${i + 1}`,
        title: step.title,
        status: step.done ? 'completed' : 'pending',
      })),
    })
  }

  private async changed(agentId: string, threadId: string) {
    try {
      await this.notify(agentId, threadId)
    } catch (error) {
      logger.warn(__t('logs.task', '计划已保存，刷新通知失败: {0}', [error]))
    }
  }
}
