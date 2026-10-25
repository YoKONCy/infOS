import { t as __t } from '../lib/i18n'
/**
 * surface.router — HTTP 路由适配层
 *
 * 负责定义该模块的稳定入口、数据边界与错误语义。
 * 调用方通过这里访问领域能力，避免绕过校验直接耦合内部状态。
 */
import { Hono } from 'hono'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'
import { formatAgentInputAnswers } from '@infos/shared'
import { createLogger } from '../lib/logger'

const logger = createLogger('SurfaceInput')

const inputSchema = z.object({
  surfaceId: z.string().min(1),
  nodeId: z.string().min(1),
  generation: z.string().min(1),
  seat: z
    .object({
      seatId: z.string().min(1),
      sessionId: z.string().min(1),
      windowId: z.string().min(1),
      epoch: z.number().int().positive(),
    })
    .optional(),
  action: z.enum(['approval.resolve', 'agent-input.resolve', 'background-task.submit-input']),
  payload: z.record(z.string(), z.unknown()),
})

/** Internal Surface 的统一用户输入入口。 */
export function createSurfaceRouter(ctx: AppContext) {
  const router = new Hono()

  router.post('/input', zValidator('json', inputSchema), async (c) => {
    const input = c.req.valid('json')
    const validateSeat = (principalId: string) => {
      if (!ctx.nodeRegistry.listSessions().some((session) => session.carrier === 'websocket'))
        return
      if (!input.seat) {
        throw new AppError('CONFLICT', {
          message: '交互连接尚未就绪，请稍后重试',
          data: { reason: 'INPUT_SEAT_REQUIRED' },
        })
      }
      if (input.payload.principalId !== undefined && input.payload.principalId !== principalId)
        throw new AppError('VALIDATION_ERROR', { message: '操作角色与请求身份不匹配' })
      try {
        ctx.nodeRegistry.validateInputSeat({
          seatId: input.seat.seatId as import('@infos/shared').KernelInputSeatId,
          sessionId: input.seat.sessionId as import('@infos/shared').KernelNodeSessionId,
          principalId,
          windowId: input.seat.windowId,
          epoch: input.seat.epoch,
          capability: input.action === 'approval.resolve' ? 'approval' : 'input',
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : ''
        if (['INPUT_SEAT_EXPIRED', 'INPUT_SEAT_IDENTITY_MISMATCH'].includes(reason))
          throw new AppError('CONFLICT', {
            message: '交互连接已更新，请重试；你的选择已保留',
            data: { reason },
          })
        if (reason === 'INPUT_SEAT_CAPABILITY_DENIED')
          throw new AppError('FORBIDDEN', { message: '当前窗口没有处理此请求的权限' })
        throw error
      }
    }
    if (input.action === 'approval.resolve') {
      const approvalId = String(input.payload.approvalId ?? '')
      const request = ctx.approvalService.get(approvalId)
      if (!request) throw new AppError('NOT_FOUND', { message: '审批请求不存在' })
      validateSeat(request.agentId)
      const expectedSurfaceId = request.taskId
        ? `background-task:${request.taskId}`
        : `conversation:${request.threadId}:${request.sessionId}`
      if (
        input.surfaceId !== expectedSurfaceId &&
        input.surfaceId !== `conversation-approval:${approvalId}` &&
        !input.surfaceId.startsWith('conversation-message:')
      ) {
        throw new AppError('VALIDATION_ERROR', { message: '审批 Surface 身份不匹配' })
      }
      const expectedGeneration = request.taskId
        ? (await ctx.backgroundTaskProjection.getSnapshot(request.taskId)).surfaces[0]?.generation
        : `conversation-approval:${approvalId}`
      if (input.generation !== expectedGeneration) {
        throw new AppError('VALIDATION_ERROR', { message: '审批 Surface 已过期，请刷新后重试' })
      }
      const decision = input.payload.decision
      if (!['allow_once', 'allow_session', 'deny_once'].includes(String(decision))) {
        throw new AppError('VALIDATION_ERROR', { message: '审批决定无效' })
      }
      const resolved = ctx.approvalService.resolve(
        approvalId,
        decision as 'allow_once' | 'allow_session' | 'deny_once',
        typeof input.payload.message === 'string' ? input.payload.message : undefined,
      )
      if (!resolved.taskId) ctx.conversationProjection.invalidate(resolved.threadId)
      const projection = resolved.taskId
        ? await ctx.backgroundTaskProjection.getSnapshot(resolved.taskId)
        : await ctx.conversationProjection.getSnapshot(resolved.threadId)
      return c.json({ code: 'OK', data: { projection } })
    }

    if (input.action === 'agent-input.resolve') {
      const inputId = String(input.payload.inputId ?? '')
      const request = ctx.agentInputService.get(inputId)
      if (!request) throw new AppError('NOT_FOUND', { message: '求助请求不存在' })
      validateSeat(request.agentId)
      const expectedSurfaceId = request.taskId
        ? `background-task:${request.taskId}`
        : `conversation-input:${inputId}`
      const expectedGeneration = request.taskId
        ? (await ctx.backgroundTaskProjection.getSnapshot(request.taskId)).surfaces[0]?.generation
        : `conversation-input:${inputId}`
      if (input.surfaceId !== expectedSurfaceId || input.generation !== expectedGeneration) {
        throw new AppError('VALIDATION_ERROR', { message: '求助 Surface 版本已失效，请刷新后重试' })
      }
      const resumeConversation =
        !request.taskId && request.required && !ctx.agentInputService.hasActiveWaiter(inputId)
      if (
        resumeConversation &&
        ctx.runtimeStateService.listActiveTasks().some((task) => task.threadId === request.threadId)
      ) {
        throw new AppError('CONFLICT', { message: '当前会话仍在执行，请稍后再提交回答' })
      }
      const submittedAnswers = input.payload.answers
      if (submittedAnswers !== undefined && !Array.isArray(submittedAnswers))
        throw new AppError('VALIDATION_ERROR', { message: '回答列表格式无效' })
      const resolved = ctx.agentInputService.resolve(inputId, {
        answers: submittedAnswers as import('@infos/shared').AgentInputAnswer[] | undefined,
        skipped: input.payload.skipped === true,
        selectedOptionIds: Array.isArray(input.payload.selectedOptionIds)
          ? input.payload.selectedOptionIds.map(String)
          : [],
        message: typeof input.payload.message === 'string' ? input.payload.message : undefined,
      })
      if (resumeConversation && resolved.status === 'answered') {
        // 原等待已在超时或重启时释放，沿原 Thread 和当前权限继续，不派生后台任务。
        const answer = formatAgentInputAnswers(resolved)
        ctx.runtimeStateService.registerTask(resolved.threadId, resolved.agentId)
        void ctx.conversationTurnService
          .executeTurn({
            threadId: resolved.threadId,
            agentId: resolved.agentId,
            content: `针对刚才的问题，我的回答是：\n${answer}\n请结合原会话继续。`,
            signal: ctx.runtimeStateService.getAbortSignal(resolved.threadId),
          })
          .catch((error) => {
            logger.error(__t('logs.routers', '收到迟到回答后继续会话失败'), {
              threadId: resolved.threadId,
              error,
            })
          })
          .finally(() => {
            ctx.runtimeStateService.unregisterTask(resolved.threadId)
            ctx.conversationProjection.invalidate(resolved.threadId)
          })
      }
      ctx.conversationProjection.invalidate(resolved.threadId)
      const projection = resolved.taskId
        ? await ctx.backgroundTaskProjection.getSnapshot(resolved.taskId)
        : await ctx.conversationProjection.getSnapshot(resolved.threadId)
      return c.json({ code: 'OK', data: { projection } })
    }

    const taskId = String(input.payload.taskId ?? '')
    const current = await ctx.backgroundTaskProjection.getSnapshot(taskId)
    validateSeat(current.principalId)
    if (
      input.surfaceId !== `background-task:${taskId}` ||
      input.generation !== current.surfaces[0]?.generation
    ) {
      throw new AppError('VALIDATION_ERROR', { message: '任务 Surface 已过期，请刷新后重试' })
    }
    const decision = input.payload.decision
    if (!['allow_once', 'allow_session', 'deny_once'].includes(String(decision))) {
      throw new AppError('VALIDATION_ERROR', { message: '任务输入决定无效' })
    }
    await ctx.backgroundTaskService.submitInput(taskId, {
      decision: decision as 'allow_once' | 'allow_session' | 'deny_once',
      message: typeof input.payload.message === 'string' ? input.payload.message : undefined,
    })
    const projection = await ctx.backgroundTaskProjection.getSnapshot(taskId)
    return c.json({ code: 'OK', data: { projection } })
  })

  return router
}
