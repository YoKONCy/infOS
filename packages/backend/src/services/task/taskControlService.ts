import { z } from 'zod'
import { t as __t } from '../../lib/i18n'
import type { TaskControlContext, TaskControlInput, TaskOrigin } from '@infos/shared'
import type { BackgroundScheduler } from './backgroundTaskService'
import type { AgentInputService } from '../execution/agentInputService'
import type { ApprovalService } from '../execution/approvalService'
import { AppError } from '../../lib/appError'
import type { BackgroundTaskInfo } from './backgroundTaskService'
import type { TaskDeliveryService } from './taskDeliveryService'
import type { TaskPlanService } from './taskPlanService'

export const taskControlSchema = z
  .object({
    action: z.enum([
      'create',
      'list',
      'get',
      'update',
      'pause',
      'resume',
      'cancel',
      'answer',
      'approve',
      'resolve_delivery',
    ]),
    taskId: z.string().min(1).max(160).optional(),
    resultOffset: z.number().int().min(0).optional(),
    resultLimit: z.number().int().min(1).max(32000).optional(),
    planId: z.string().min(1).max(160).optional(),
    planStepId: z.string().min(1).max(80).optional(),
    expectedRevision: z.number().int().positive().optional(),
    instruction: z.string().trim().min(1).max(4000).optional(),
    title: z.string().trim().min(1).max(100).optional(),
    successCriteria: z.string().trim().max(2000).optional(),
    message: z.string().trim().max(4000).optional(),
    inputId: z.string().min(1).optional(),
    answers: z
      .array(
        z
          .object({
            questionId: z.string().trim().min(1).max(80),
            selectedOptionIds: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
            message: z.string().trim().max(4000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .optional(),
    selectedOptionIds: z.array(z.string()).max(20).optional(),
    decision: z.enum(['allow_once', 'deny_once']).optional(),
    recovery: z.enum(['read_only', 'confirm']).optional(),
    confirmUncertain: z.boolean().optional(),
    deadline: z.string().datetime({ offset: true }).optional(),
    maxSegments: z.number().int().min(1).max(1000).optional(),
    maxLlmCalls: z.number().int().min(1).max(10000).optional(),
    maxToolCalls: z.number().int().min(1).max(50000).optional(),
    deliveryId: z.string().min(1).max(250).optional(),
    deliveryDecision: z.enum(['sent', 'retry']).optional(),
  })
  .strict()

/** 桌面和社交共用业务操作；身份由入口提供，执行参数由模型或界面提供。 */
export class TaskControlService {
  constructor(
    private readonly tasks: BackgroundScheduler,
    private readonly inputs: AgentInputService,
    private readonly approvals: ApprovalService,
    private readonly authorizeOrigin: (origin: TaskOrigin) => Promise<string | undefined>,
    private readonly deliveries?: Pick<TaskDeliveryService, 'list' | 'resolve'>,
    private readonly beforeDesktopResume?: (task: BackgroundTaskInfo) => Promise<void>,
    private readonly plans?: TaskPlanService,
  ) {}

  async remote(origin: TaskOrigin, input: TaskControlInput, callId?: string): Promise<unknown> {
    const valid = z
      .object({
        platform: z.string().min(1).max(40),
        accountId: z.string().min(1).max(100),
        senderId: z.string().min(1).max(100),
        channelId: z.string().min(1).max(100),
        channelType: z.literal('private'),
        messageId: z.string().min(1).max(160),
      })
      .strict()
      .safeParse(origin)
    if (!valid.success) throw new AppError('FORBIDDEN', { message: '任务入口缺少有效消息来源' })
    const agentId = await this.authorizeOrigin(origin)
    if (!agentId) throw new AppError('FORBIDDEN', { message: '当前账号或会话未获任务控制授权' })
    // 当前内置社交应用仅支持已绑定主人的私聊，角色身份由绑定配置解析。
    return this.execute(agentId, input, origin, false, undefined, { callId })
  }

  async execute(
    agentId: string,
    raw: TaskControlInput,
    origin?: TaskOrigin,
    userInitiated = false,
    threadId?: string,
    context: TaskControlContext = {},
  ): Promise<unknown> {
    const parsed = taskControlSchema.safeParse(raw)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', { message: '任务操作参数无效' })
    const input = parsed.data
    if (!agentId) throw new AppError('FORBIDDEN', { message: '任务入口缺少可信角色绑定' })
    if (input.action === 'create') {
      if (context.taskId)
        throw new AppError('FORBIDDEN', {
          message: __t('server.task', '后台任务不能派发通用子任务'),
        })
      if (!input.instruction)
        throw new AppError('VALIDATION_ERROR', { message: '创建任务需要指令' })
      const instruction = input.instruction
      const dispatch = async (link?: {
        planId: string
        planStepId: string
        originThreadId: string
      }) => {
        const task = await this.tasks.dispatch({
          agentId,
          instruction,
          title: input.title,
          requestedBy: context.requestedBy ?? 'user',
          targetThreadId: link?.originThreadId ?? threadId,
          completionAction: (link?.originThreadId ?? threadId) ? 'send_to_chat' : 'notify',
          metadata: { ...link, ...(threadId ? { originThreadId: threadId } : {}) },
          idempotencyKey: link
            ? `plan:${link.planId}:${link.planStepId}`
            : origin
              ? `social:${origin.platform}:${origin.accountId}:${origin.senderId}:${origin.messageId}:${context.callId ?? 'create'}`
              : context.callId
                ? `tool:${agentId}:${threadId}:${context.callId}`
                : undefined,
          lifecycle: {
            origin,
            successCriteria: input.successCriteria ?? '',
            recovery: input.recovery ?? 'confirm',
            ...(input.deadline ? { deadline: input.deadline } : {}),
            ...(input.maxSegments ? { maxSegments: input.maxSegments } : {}),
            ...(input.maxLlmCalls ? { maxLlmCalls: input.maxLlmCalls } : {}),
            ...(input.maxToolCalls ? { maxToolCalls: input.maxToolCalls } : {}),
          },
        })
        return this.describe(task, input)
      }
      return this.plans
        ? this.plans.withLink(agentId, input.planId, input.planStepId, threadId, dispatch)
        : dispatch()
    }
    if (input.action === 'list') {
      const page = await this.tasks.query({ agentId, parentTaskId: context.taskId, pageSize: 20 })
      return {
        ...page,
        items: page.items
          .filter(
            (task) =>
              task.category !== 'resident' &&
              (!context.taskId || task.parentTaskId === context.taskId),
          )
          .map((task) => ({
            id: task.id,
            revision: task.revision,
            title: task.title,
            status: task.status,
            currentStage: task.currentStage,
            updatedAt: task.updatedAt,
          })),
      }
    }
    if (!input.taskId) throw new AppError('VALIDATION_ERROR', { message: '请明确指定任务' })
    const task = await this.tasks.getTask(input.taskId)
    if (!task || task.agentId !== agentId)
      throw new AppError('NOT_FOUND', { message: '任务不存在或无权访问' })
    if (
      context.taskId &&
      (task.id === context.taskId ? input.action !== 'get' : task.parentTaskId !== context.taskId)
    )
      throw new AppError('FORBIDDEN', {
        message: __t('server.task', '后台任务只能读取自身或管理直接关联的任务'),
      })
    if (task.category === 'resident')
      throw new AppError('CONFLICT', {
        message: '这是随服务运行的只读常驻状态，不能作为普通任务操作',
      })
    if (input.action === 'get') return this.describe(task, input)
    if (input.expectedRevision === undefined || input.expectedRevision !== task.revision)
      throw new AppError('CONFLICT', { message: '请先读取任务当前修订，再提交操作' })
    if (input.action === 'resolve_delivery') {
      if (!input.deliveryId || !input.deliveryDecision || !this.deliveries)
        throw new AppError('VALIDATION_ERROR', { message: '请明确指定待核验的投递记录及处理决定' })
      this.deliveries.resolve(task.id, input.deliveryId, input.deliveryDecision)
      return this.describe(task)
    }
    if (input.action === 'answer' || input.action === 'approve') {
      const wait = task.lifecycle.wait
      if (task.status !== 'waiting_input' || !wait || wait.key !== input.inputId)
        throw new AppError('CONFLICT', { message: '请求已过期或不属于当前任务' })
      if (input.action === 'answer' && wait.kind === 'input') {
        const request = this.inputs.get(wait.key)
        if (request?.taskId !== task.id)
          throw new AppError('CONFLICT', { message: '问题归属不匹配' })
        this.inputs.resolve(wait.key, {
          answers: input.answers,
          selectedOptionIds: input.selectedOptionIds,
          message: input.message,
        })
      } else if (input.action === 'approve' && wait.kind === 'approval' && input.decision) {
        const request = this.approvals.get(wait.key)
        if (request?.taskId !== task.id)
          throw new AppError('CONFLICT', { message: '审批归属不匹配' })
        this.approvals.resolve(wait.key, input.decision, input.message)
      } else throw new AppError('VALIDATION_ERROR', { message: '回答类型与等待请求不匹配' })
      await this.tasks.wakeWaitingTasks()
      return this.describe((await this.tasks.getTask(task.id))!)
    }
    if (input.action === 'resume' && /DESKTOP_/.test(task.errorMessage ?? '')) {
      if (!origin && !userInitiated)
        throw new AppError('CONFLICT', {
          message: '桌面已由用户接管，请由用户在面板或已授权社交会话中恢复任务',
        })
      if (task.lifecycle.pendingEffect && !input.confirmUncertain)
        throw new AppError('CONFLICT', { message: '上一次动作结果尚未确认，请核验后再恢复' })
      if (!['paused', 'blocked', 'failed', 'waiting'].includes(task.status))
        throw new AppError('CONFLICT', { message: '任务当前不能恢复' })
      await this.beforeDesktopResume?.(task)
    }
    return this.tasks.changeTask(task.id, task.revision, input)
  }

  private describe(
    task: BackgroundTaskInfo,
    input: Pick<TaskControlInput, 'resultOffset' | 'resultLimit'> = {},
  ) {
    const offset = input.resultOffset ?? 0
    const limit = input.resultLimit ?? 12000
    const result = task.result?.slice(offset, offset + limit) ?? null
    const wait = task.lifecycle.wait
    const request =
      wait?.kind === 'input'
        ? this.inputs.get(wait.key)
        : wait?.kind === 'approval'
          ? this.approvals.get(wait.key)
          : undefined
    return {
      id: task.id,
      agentId: task.agentId,
      revision: task.revision,
      parentTaskId: task.parentTaskId,
      title: task.title,
      instruction: task.instruction,
      status: task.status,
      currentStage: task.currentStage,
      result,
      resultTotalChars: task.result?.length ?? 0,
      nextResultOffset: task.result && offset + limit < task.result.length ? offset + limit : null,
      errorMessage: task.errorMessage,
      lifecycle: task.lifecycle,
      plan: task.plan,
      request,
      deliveries: this.deliveries?.list(task.id) ?? [],
    }
  }
}
