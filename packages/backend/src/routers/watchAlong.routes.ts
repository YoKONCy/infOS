import { Hono } from 'hono'
import { AppError } from '../lib/appError'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import type { AppContext } from '../container'
import { perceptionSnapshots } from '../services/perception/perceptionSnapshotStore'

/**
 * 陪看 / 感知相关接口，挂在调度路由的 /proactive/watch-along 下。
 * 鉴权中间件必须先于这些路由注册，因此由 createSchedulerRouter 在创建路由后立即调用。
 */
export function registerWatchAlongRoutes(router: Hono, ctx: AppContext): void {
  // 陪看只接受持有管理凭据的原生宿主，不接受自动附带的 Cookie、URL token 或网页 Origin。
  router.use('/proactive/watch-along*', async (c, next) => {
    const identity = ctx.clientAccess?.authenticate(c.req.raw)
    if (
      !identity?.admin ||
      !/^Bearer\s+\S+$/i.test(c.req.header('authorization') ?? '') ||
      c.req.header('origin')
    )
      throw new AppError('FORBIDDEN')
    await next()
  })
  router.post(
    '/proactive/watch-along/image',
    zValidator('json', z.object({id: z.string().uuid(), generation: z.number().int(), image: z.object({mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string().max(4_000_000).regex(/^[A-Za-z0-9+/=]+$/)}).optional()}).strict()),
    c => { const body = c.req.valid('json'); perceptionSnapshots.resolveImage(body.id, body.generation, body.image); return c.json({code: 'OK'}) },
  )
  router.get('/proactive/watch-along/image', c => c.json({code: 'OK', data: perceptionSnapshots.pendingImages()}))
  router.post(
    '/proactive/watch-along/snapshot',
    zValidator('json', z.object({
      sequence: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
      snapshot: z.object({ source: z.literal('perception'), generation: z.number().int().nonnegative(), capturedAt: z.number(), text: z.string().max(2000),
        watching:z.boolean().optional(),current:z.string().max(2000).optional(),tail:z.string().max(6000).optional(),events:z.array(z.object({id:z.number().int(),at:z.number(),text:z.string().max(2000)})).max(60).optional(),
        images: z.array(z.object({ mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string().max(4_000_000).regex(/^[A-Za-z0-9+/=]+$/) })).max(2).optional(),
      }).strict().nullable(),
    }).strict()),
    c => { const body = c.req.valid('json'); perceptionSnapshots.update(body.sequence, body.generation, body.expiresAt, body.snapshot); return c.json({ code: 'OK' }) },
  )
  router.post(
    '/proactive/watch-along/permit',
    zValidator('json', z.object({
      sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      hardStopped: z.boolean(),
      companionAllowed: z.boolean(),
    }).strict()),
    async (c) => {
      await ctx.companionSchedulerService.updatePerceptionPermit(c.req.valid('json'))
      if (c.req.valid('json').hardStopped) perceptionSnapshots.clear()
      return c.json({ code: 'OK' })
    },
  )
  router.post(
    '/proactive/watch-along/input',
    zValidator(
      'json',
      z
        .object({
          agentId: z.string().min(1).max(200),
          threadId: z.string().min(1).max(200),
          active: z.boolean(),
        })
        .strict(),
    ),
    async (c) => {
      const input = c.req.valid('json')
      const thread = await ctx.threadService.getThread(input.threadId)
      if (
        !thread ||
        thread.agentId !== input.agentId ||
        thread.channel !== 'desktop' ||
        thread.status !== 'active'
      )
        throw new AppError('INVALID_PARAMETER')
      ctx.companionSchedulerService.inputActivity(input.agentId, input.active)
      return c.json({ code: 'OK' })
    },
  )
  router.get('/proactive/watch-along/counts', c => {
    const level = c.req.query('level')
    return c.json({code: 'OK', data: ctx.companionSchedulerService.budget.counts(level === 'low' || level === 'high' ? level : 'medium')})
  })
  router.get('/proactive/watch-along/target', async c => c.json({code: 'OK', data: await ctx.companionSchedulerService.watchTarget()}))
  router.post('/proactive/watch-along/wake', zValidator('json', z.object({
    id: z.string().uuid(), kind: z.enum(['returned', 'new-app', 'task-completed', 'long-window']), expiresAt: z.number().int(), level: z.enum(['low', 'medium', 'high']),
  }).strict()), async c => c.json({code: 'OK', data: await ctx.companionSchedulerService.wake(c.req.valid('json'), c.req.raw.signal)}))
  // 陪看模式的主动插话（由桌面客户端的陪看调度触发；回合结束后返回）。
  router.post(
    '/proactive/watch-along',
    zValidator(
      'json',
      z
        .object({
          agentId: z.string().min(1).max(200),
          threadId: z.string().min(1).max(200),
          content: z.string().min(1).max(20000),
          frames: z.object({mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string().max(4_000_000).regex(/^[A-Za-z0-9+/=]+$/)}).strict().optional(),
          pace: z
            .object({
              minIntervalSec: z.number().int().min(30).max(3600),
              maxPerHour: z.number().int().min(1).max(60),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    async (c) =>
      c.json({
        code: 'OK',
        data: await ctx.companionSchedulerService.watchAlong.run(
          c.req.valid('json'),
          c.req.raw.signal,
        ),
      }),
  )
}
