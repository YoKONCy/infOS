import { t as __t } from '../lib/i18n'
/**
 * Scheduler Router — 定时任务管理 API
 *
 * 提供后台定时任务的查看、列表和手动触发：
 * - GET  /api/scheduler/status        获取调度器全局状态
 * - GET  /api/scheduler/tasks         获取全部已注册任务列表
 * - POST /api/scheduler/trigger/:name 手动触发一个定时任务
 *
 * 遵循 .docs/S02_API_SPEC.md 信封规范。
 *
 * @module packages/backend/src/routers/scheduler.router
 */

import { Hono } from 'hono'
import { AppError } from '../lib/appError'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import type { AppContext } from '../container'
import { registerWatchAlongRoutes } from './watchAlong.routes'

export function createSchedulerRouter(ctx: AppContext) {
  const router = new Hono()
  registerWatchAlongRoutes(router, ctx)

  router.get('/proactive', (c) =>
    c.json({ code: 'OK', data: ctx.companionSchedulerService.getState() }),
  )
  router.put(
    '/proactive',
    zValidator(
      'json',
      z
        .object({
          mode: z.enum(['off', 'companion', 'autonomous']).optional(),
          strongholdActivity: z.boolean().optional(),
          companionIntervalMinutes: z.number().min(1).max(1440).optional(),
          autonomousIntervalMinutes: z.number().min(1).max(1440).optional(),
          goal: z.string().max(8000).optional(),
          maxDailyRuns: z.number().int().min(1).max(1440).optional(),
          timeZone: z.string().min(1).max(100).optional(),
        })
        .strict(),
    ),
    async (c) =>
      c.json({
        code: 'OK',
        data: await ctx.companionSchedulerService.configure(c.req.valid('json')),
      }),
  )
  router.put(
    '/proactive/agents/:agentId',
    zValidator('json', z.object({
      mode: z.enum(['off', 'companion', 'autonomous']).nullable().optional(),
      strongholdActivity: z.boolean().nullable().optional(),
    }).strict()),
    async (c) => {
      const agentId = c.req.param('agentId')
      if (!ctx.agentManager.getAgent(agentId)) throw new AppError('NOT_FOUND', { message: '角色不存在' })
      return c.json({ code: 'OK', data: await ctx.companionSchedulerService.configureAgent(agentId, c.req.valid('json')) })
    },
  )
  router.post('/proactive/check', async (c) =>
    c.json({ code: 'OK', data: await ctx.companionSchedulerService.checkNow() }),
  )

  // GET /api/scheduler/status — 获取调度器全局状态
  router.get('/status', (c) => {
    const tasks = ctx.scheduler.getPeriodicScheduleStatus()
    return c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: {
        schedulerRunning: ctx.scheduler.isPeriodicStarted,
        serverNow: Date.now(),
        taskCount: tasks.length,
        activeTasks: tasks.filter((t) => t.running).length,
      },
    })
  })

  // GET /api/scheduler/tasks — 获取全部已注册任务列表
  router.get('/tasks', (c) => {
    const tasks = ctx.scheduler.getPeriodicScheduleStatus()
    return c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: {
        schedulerRunning: ctx.scheduler.isPeriodicStarted,
        serverNow: Date.now(),
        items: tasks.map((t) => ({
          ...t,
          intervalDesc: formatInterval(t.intervalMs),
        })),
        total: tasks.length,
      },
    })
  })

  // GET /api/scheduler/reminders — 获取待触发的用户提醒列表
  router.get('/reminders', async (c) => {
    const agentId = c.req.query('agentId') ?? undefined
    const reminders = await ctx.schedulerService.listPending(agentId)
    return c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: {
        items: reminders,
        total: reminders.length,
      },
    })
  })

  // 活动投影直接读取已有任务和计划，不维护另一份桌宠工作状态。
  router.get('/activity', async (c) => {
    const agentId = c.req.query('agentId')
    if (!agentId || !ctx.agentManager.getAgent(agentId))
      throw new AppError('NOT_FOUND', { message: '角色不存在' })
    const [scheduled, suggestions, tasks, recent] = await Promise.all([
      ctx.schedulerService.listPending(agentId),
      ctx.schedulerService.listSuggestions(agentId),
      ctx.backgroundTaskService.query({
        agentId,
        status: ['queued', 'running', 'paused', 'waiting_input', 'waiting', 'blocked'],
        pageSize: 100,
      }),
      ctx.backgroundTaskService.query({
        agentId,
        status: ['completed', 'failed', 'cancelled'],
        pageSize: 5,
      }),
    ])
    const activeTasks = tasks.items.filter((task) => task.category !== 'resident')
    return c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: {
        agentId,
        scheduled,
        suggestions,
        tasks: activeTasks,
        recent: recent.items.filter((task) => task.category !== 'resident'),
      },
    })
  })

  router.post(
    '/reminders/:id/:action',
    zValidator('json', z.object({ agentId: z.string().min(1) })),
    async (c) => {
      const id = Number(c.req.param('id'))
      const action = c.req.param('action')
      const { agentId } = c.req.valid('json')
      if (!Number.isSafeInteger(id) || !['cancel', 'retry', 'pause', 'resume'].includes(action))
        throw new AppError('INVALID_PARAMETER', { message: '计划操作无效' })
      const ok =
        action === 'cancel'
          ? await ctx.schedulerService.cancel(id, agentId)
          : action === 'retry'
            ? await ctx.schedulerService.retry(id, agentId)
            : await ctx.schedulerService.pause(id, agentId, action === 'pause')
      if (!ok)
        throw new AppError('INVALID_PARAMETER', {
          message: '计划不存在、角色不匹配或当前状态无法操作',
        })
      return c.json({
        code: 'OK',
        message:
          action === 'cancel'
            ? __t('server.routers', '已取消')
            : action === 'retry'
              ? __t('server.routers', '已安排重试')
              : action === 'pause'
                ? __t('server.routers', '周期计划已暂停')
                : __t('server.routers', '周期计划已恢复'),
        data: { id },
      })
    },
  )

  router.post(
    '/suggestions/:id/:action',
    zValidator('json', z.object({ agentId: z.string().min(1) })),
    async (c) => {
      const action = c.req.param('action')
      const { agentId } = c.req.valid('json')
      if (!['accept', 'dismiss'].includes(action))
        throw new AppError('INVALID_PARAMETER', { message: '建议操作无效' })
      const item =
        action === 'accept'
          ? await ctx.schedulerService.acceptSuggestion(c.req.param('id'), agentId)
          : await ctx.schedulerService.dismissSuggestion(c.req.param('id'), agentId)
      return c.json({
        code: 'OK',
        message:
          action === 'accept'
            ? __t('server.routers', '建议已采纳')
            : __t('server.routers', '建议已忽略'),
        data: item,
      })
    },
  )

  router.post(
    '/agent-tasks',
    zValidator(
      'json',
      z.object({
        agentId: z.string().min(1).max(64),
        time: z.string().min(1),
        instruction: z.string().min(1).max(4000),
        threadId: z.string().min(1).optional(),
        repeatIntervalMinutes: z.number().int().min(1).max(525600).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json')
      if (!ctx.agentManager.getAgent(body.agentId)) {
        throw new AppError('NOT_FOUND', { message: `角色不存在: ${body.agentId}` })
      }
      const target = body.threadId
        ? await ctx.threadService.getThread(body.threadId)
        : await ctx.threadService.getOrCreateLatest(body.agentId, 'desktop', 'conversation')
      if (
        !target ||
        target.agentId !== body.agentId ||
        target.channel !== 'desktop' ||
        target.purpose !== 'conversation'
      )
        throw new AppError('INVALID_PARAMETER', { message: '定时任务须绑定该角色有效的主应用会话' })
      const item = await ctx.schedulerService.create({
        type: 'agent_task',
        agentId: body.agentId,
        time: body.time,
        content: body.instruction,
        threadId: target.id,
        repeatIntervalMinutes: body.repeatIntervalMinutes,
      })
      return c.json(
        { code: 'CREATED', message: __t('server.routers', '提醒已创建'), data: item },
        201,
      )
    },
  )

  // POST /api/scheduler/trigger/:name — 手动触发
  router.post('/trigger/:name', async (c) => {
    const taskName = c.req.param('name')
    const success = await ctx.scheduler.triggerPeriodicNow(taskName)
    if (!success) {
      throw new AppError('NOT_FOUND', {
        message: `定时任务 "${taskName}" 不存在或正在运行中`,
        data: { taskName },
      })
    }
    return c.json(
      {
        code: 'ACCEPTED',
        message: __t('server.routers', '任务 "{0}" 已触发', [taskName]),
        data: { taskName },
      },
      202,
    )
  })

  return router
}

// ── 辅助函数 ──

/** 将毫秒间隔转为可读描述 */
function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}分钟`
  return `${(ms / 3600_000).toFixed(1)}小时`
}
