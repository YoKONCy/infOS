import { Hono } from 'hono'
import { z } from 'zod'
import { validate as zValidator } from '../lib/validation'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'

/** 画布与 Agent 共用业务操作，素材与创作交付由宿主兼容层代理。 */
export function createPictoriaRouter(ctx: AppContext) {
  const router = new Hono()
  router.get('/canvas/bootstrap', (c) =>
    c.json({
      code: 'OK',
      data: {
        agents: ctx.agentManager.listAgents().map(({ id, name }) => ({ id, name })),
        status: ctx.pictoria.controller.status(),
      },
    }),
  )
  router.post(
    '/canvas/run',
    zValidator(
      'json',
      z
        .object({
          agentId: z.string().min(1).max(128),
          input: z.record(z.string(), z.unknown()),
          key: z.string().uuid(),
        })
        .strict(),
    ),
    async (c) => {
      const value = c.req.valid('json')
      if (!ctx.agentManager.getAgent(value.agentId))
        throw new AppError('NOT_FOUND', { message: '角色不存在' })
      return c.json({
        code: 'OK',
        data: await ctx.pictoria.runCanvas(value.agentId, value.input, value.key),
      })
    },
  )
  router.post(
    '/canvas/assets',
    zValidator(
      'json',
      z
        .object({
          agentId: z.string().min(1).max(128),
          name: z.string().min(1).max(180),
          mimeType: z.string().max(100),
          base64: z.string().min(1).max(28_000_000),
        })
        .strict(),
    ),
    async (c) => {
      const value = c.req.valid('json')
      if (!ctx.agentManager.getAgent(value.agentId))
        throw new AppError('NOT_FOUND', { message: '角色不存在' })
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64))
        throw new AppError('VALIDATION_ERROR', { message: '素材编码无效' })
      return c.json({
        code: 'OK',
        data: await ctx.pictoria.importCanvasAsset(
          value.agentId,
          value.name,
          value.mimeType,
          Buffer.from(value.base64, 'base64'),
        ),
      })
    },
  )
  router.get(
    '/canvas/assets/:id',
    zValidator('query', z.object({ agentId: z.string().min(1).max(128) })),
    async (c) =>
      c.json({
        code: 'OK',
        data: await ctx.pictoria.canvasAsset(c.req.valid('query').agentId, c.req.param('id')),
      }),
  )
  router.get('/status', (c) => c.json({ code: 'OK', data: ctx.pictoria.controller.status() }))
  router.post('/start', async (c) => {
    try {
      const body = await c.req.text()
      if (body.length > 1024) throw new Error('桌面启动请求过大')
      const value = z
        .object({ desktopGuard: z.unknown().optional() })
        .strict()
        .parse(body.trim() ? JSON.parse(body) : {})
      return c.json({ code: 'OK', data: await ctx.pictoria.start(value.desktopGuard) })
    } catch (error) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message: error instanceof Error ? error.message : 'Pictoria 后台启动失败',
      })
    }
  })
  router.post('/stop', async (c) => {
    try {
      return c.json({ code: 'OK', data: await ctx.pictoria.stop() })
    } catch (failure) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message: failure instanceof Error ? failure.message : 'Pictoria 后台停止失败',
      })
    }
  })
  router.post('/shutdown-managed', async (c) => {
    try {
      return c.json({ code: 'OK', data: await ctx.pictoria.controller.shutdownManaged() })
    } catch (failure) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message: failure instanceof Error ? failure.message : '托管 Pictoria 停止失败',
      })
    }
  })
  router.post('/reconnect', async (c) =>
    c.json({ code: 'OK', data: await ctx.pictoria.controller.reconnect() }),
  )
  router.get('/settings', async (c) => c.json({ code: 'OK', data: await ctx.pictoria.settings() }))
  router.put(
    '/settings',
    zValidator('json', z.object({ enabled: z.boolean(), chatEnabled: z.boolean() }).strict()),
    async (c) => c.json({ code: 'OK', data: await ctx.pictoria.settings(c.req.valid('json')) }),
  )
  router.get('/tasks', zValidator('query', z.object({ agentId: z.string().min(1) })), (c) =>
    c.json({
      code: 'OK',
      data: ctx.pictoria.calls.list('infos.pictoria', c.req.valid('query').agentId),
    }),
  )
  router.post(
    '/deliveries/:callId/resolve',
    zValidator('json', z.object({ decision: z.enum(['sent', 'retry']) }).strict()),
    (c) => {
      ctx.pictoria.resolveDelivery(c.req.param('callId'), c.req.valid('json').decision)
      return c.json({ code: 'OK' })
    },
  )
  router.post(
    '/operations/:operation',
    zValidator(
      'json',
      z
        .object({
          agentId: z.string().min(1).max(128),
          threadId: z.string().optional(),
          input: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
    ),
    async (c) => {
      const value = c.req.valid('json')
      if (!ctx.agentManager.getAgent(value.agentId))
        throw new AppError('NOT_FOUND', { message: '角色不存在' })
      try {
        const data = await ctx.pictoria.operation(
          c.req.param('operation'),
          value.input,
          value.agentId,
          value.threadId,
          c.req.header('idempotency-key'),
        )
        return c.json({ code: 'OK', data })
      } catch (error) {
        throw new AppError('VALIDATION_ERROR', {
          message: error instanceof Error ? error.message : '绘图操作失败',
        })
      }
    },
  )
  return router
}
