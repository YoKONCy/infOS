import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { HomeService } from '../services/home/homeService'
import type { ClientIdentity } from '../services/system/clientAccessService'
import { AppError } from '../lib/appError'
import { HomeError, homeMessage } from '../services/home/homeErrors'
import {
  homeCardSchema,
  homeDeclarationSchema,
  homeFileSchema,
  homeId,
  homeIntentSchema,
  homeMapSchema,
  homeScopeSchema,
  homeShelfSchema,
} from '../services/home/homeSchemas'
import {
  homeCardCommand,
  homeFileCommand,
  homeMapCommand,
  homeShelfCommand,
} from '../services/home/homeCommands'

/** 整个通道只向管理身份开放；卡片脚本必须经可信 Electron 主进程代理。 */
export function createHomeRouter(
  home: HomeService,
  authenticate: (request: Request) => ClientIdentity | undefined,
  validateScope: (scope: z.infer<typeof homeScopeSchema>) => Promise<void> = async () => {},
) {
  const router = new Hono()
  router.use('*', (c, next) => {
    const identity = authenticate(c.req.raw)
    if (!identity) throw new AppError('UNAUTHORIZED')
    if (!identity.admin) throw new AppError('FORBIDDEN')
    return next()
  })
  router.use('*', bodyLimit({ maxSize: 48 * 1024 * 1024 }))
  router.onError((error, c) => {
    if (error instanceof HomeError) {
      const code =
        error.code === 'HOME_NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'HOME_LIMIT'
            ? 'PAYLOAD_TOO_LARGE'
            : ['HOME_CONFLICT', 'HOME_CONFIRMATION_REQUIRED', 'HOME_EXPIRED'].includes(error.code)
              ? 'CONFLICT'
              : 'INVALID_PARAMETER'
      return c.json(
        {
          code,
          message: homeMessage(error.code),
          data: { homeCode: error.code, detail: error.data },
        },
        code === 'NOT_FOUND'
          ? 404
          : code === 'PAYLOAD_TOO_LARGE'
            ? 413
            : code === 'CONFLICT'
              ? 409
              : 400,
      )
    }
    if (error instanceof z.ZodError)
      return c.json({ code: 'INVALID_PARAMETER', message: homeMessage('HOME_INVALID') }, 400)
    throw error
  })
  const scoped = async (raw: unknown) => {
    const parsed = z
      .object({ scope: homeScopeSchema, input: z.unknown().optional() })
      .strict()
      .parse(raw)
    await validateScope(parsed.scope)
    return parsed
  }
  router.get('/settings', (c) => c.json({ code: 'OK', data: home.settings.describe() }))
  router.put('/settings', async (c) =>
    c.json({ code: 'OK', data: home.settings.update(await c.req.json()) }),
  )
  router.delete('/settings', (c) => c.json({ code: 'OK', data: home.settings.reset() }))
  // 她删除用户文件去哪（Windows 回收站 / infOS 回收区），设置页「桌面与家」用。
  router.get('/settings/delete-target', (c) =>
    c.json({ code: 'OK', data: { target: home.settings.deleteTarget() } }),
  )
  router.put('/settings/delete-target', async (c) => {
    const body = z
      .object({ target: z.enum(['system', 'infos']) })
      .strict()
      .parse(await c.req.json())
    return c.json({ code: 'OK', data: { target: home.settings.setDeleteTarget(body.target) } })
  })
  router.get('/limits', (c) => c.json({ code: 'OK', data: home.limits() }))
  router.put('/limits', async (c) => {
    const fields = z.number().int().positive()
    const input = z
      .object({
        massChangeThreshold: fields,
        massChangeWindowMs: fields,
        checkpointRetentionMs: fields,
        snapshotMaxBytes: fields,
        fileMaxBytes: fields,
        shelfMaxBytes: fields,
        shelfMaxItems: fields,
      })
      .partial()
      .strict()
      .parse(await c.req.json())
    return c.json({ code: 'OK', data: home.setLimits(input) })
  })
  router.post('/declarations', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    // mode:"merge" 只增不减（不冲掉已声明的路径）；默认整体替换。Agent 工具不接受 mode。
    const plan = homeDeclarationSchema
      .extend({ mode: z.enum(['replace', 'merge']).optional() })
      .strict()
      .parse(input)
    return c.json({
      code: 'OK',
      data:
        plan.mode === 'merge'
          ? home.authorization.mergeDeclaration(scope, plan.paths, plan.apps)
          : home.authorization.declare(scope, plan.paths, plan.apps),
    })
  })
  router.post('/files', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: homeFileCommand(home, scope, homeFileSchema.parse(input)) })
  })
  router.get('/confirmations', (c) =>
    c.json({ code: 'OK', data: home.authorization.pending(c.req.query('agentId')) }),
  )
  router.post('/confirmations/:id/answer', async (c) => {
    const input = z
      .object({ choice: z.enum(['once', 'session', 'permanent', 'deny']) })
      .strict()
      .parse(await c.req.json())
    return c.json({ code: 'OK', data: home.authorization.answer(c.req.param('id'), input.choice) })
  })
  router.get('/grants', (c) =>
    c.json({ code: 'OK', data: home.authorization.grants(homeId.parse(c.req.query('agentId'))) }),
  )
  router.get('/grants/:id', (c) => {
    const value = home.authorization
      .grants(homeId.parse(c.req.query('agentId')))
      .find((row) => row.id === c.req.param('id'))
    if (!value) throw new HomeError('HOME_NOT_FOUND')
    return c.json({ code: 'OK', data: value })
  })
  router.post('/grants', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    const grant = z
      .object({
        kind: z.enum(['folder', 'app']),
        target: z.string().min(1).max(4096),
        access: z.enum(['read', 'write']),
        duration: z.enum(['session', 'permanent']),
      })
      .strict()
      .parse(input)
    return c.json({
      code: 'OK',
      data: home.authorization.grant(scope, grant.kind, grant.target, grant.access, grant.duration),
    })
  })
  router.delete('/grants/:id', (c) => {
    home.authorization.revoke(homeId.parse(c.req.query('agentId')), c.req.param('id'))
    return c.json({ code: 'OK' })
  })
  router.post('/sessions/close', async (c) => {
    const { scope } = await scoped(await c.req.json())
    home.close(scope)
    return c.json({ code: 'OK' })
  })
  router.post('/checkpoints/list', async (c) => {
    const { scope } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: home.checkpoints.list(scope) })
  })
  router.post('/checkpoints/diff', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    const id = homeId.parse(input)
    return c.json({ code: 'OK', data: home.checkpoints.diff(scope, id) })
  })
  router.post('/checkpoints/undo', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    const id = homeId.optional().parse(input)
    return c.json({ code: 'OK', data: home.checkpoints.undo(scope, id) })
  })
  router.post('/checkpoints/reconcile', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: home.checkpoints.reconcile(scope, homeId.parse(input)) })
  })
  router.post('/recycle/list', async (c) => {
    const { scope } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: home.storage.listRecycle(scope) })
  })
  router.post('/native-trash/prepare', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({
      code: 'OK',
      data: home.files.prepareNativeTrash(scope, z.string().min(1).max(4096).parse(input)),
    })
  })
  router.post('/native-trash/complete', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    const completed = z
      .object({ checkpointId: homeId, result: z.enum(['success', 'failed']) })
      .strict()
      .parse(input)
    return c.json({
      code: 'OK',
      data: home.files.completeNativeTrash(scope, completed.checkpointId, completed.result),
    })
  })
  router.get('/recycle/summary', (c) =>
    c.json({
      code: 'OK',
      data: home.storage.recycleSummary(homeId.optional().parse(c.req.query('agentId'))),
    }),
  )
  // 用户手动清空回收区（永久删除）：仅管理身份、必须带固定确认词；Agent 工具没有对应入口。
  router.post('/recycle/purge', async (c) => {
    const input = z
      .object({ confirm: z.literal('PURGE_RECYCLE'), agentId: homeId.optional() })
      .strict()
      .parse(await c.req.json())
    return c.json({ code: 'OK', data: home.storage.purgeRecycle(input.agentId) })
  })
  router.post('/recycle/restore', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: home.storage.restoreRecycle(scope, homeId.parse(input)) })
  })
  router.get('/activities', (c) => {
    const query = z
      .object({
        agentId: homeId.optional(),
        sessionId: homeId.optional(),
        from: z.coerce.number().optional(),
        to: z.coerce.number().optional(),
        action: z.string().max(100).optional(),
        page: z.coerce.number().int().positive().optional(),
        pageSize: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .parse(c.req.query())
    return c.json({ code: 'OK', data: home.activity.query(query) })
  })
  router.post('/activities/summary', async (c) => {
    const { scope } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: home.activity.summary(scope) })
  })
  router.get('/activities/:id', (c) =>
    c.json({
      code: 'OK',
      data: home.activity.get(homeId.parse(c.req.query('agentId')), c.req.param('id')),
    }),
  )
  router.delete('/activities/:id', (c) =>
    c.json({
      code: 'OK',
      data: home.activity.remove(homeId.parse(c.req.query('agentId')), c.req.param('id')),
    }),
  )
  router.post('/desktop/authorize', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: home.authorizeDesktop(scope, homeIntentSchema.parse(input)) })
  })
  router.post('/desktop/complete', async (c) => {
    const input = z
      .object({
        permitId: homeId,
        result: z.enum(['success', 'failed']),
        detail: z.string().max(1000).optional(),
      })
      .strict()
      .parse(await c.req.json())
    return c.json({
      code: 'OK',
      data: home.completeDesktop(input.permitId, input.result, input.detail),
    })
  })
  router.post('/desktop/consume', async (c) => {
    const input = z
      .object({ permitId: homeId })
      .strict()
      .parse(await c.req.json())
    return c.json({ code: 'OK', data: home.consumeDesktop(input.permitId) })
  })
  router.post('/shelf', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({
      code: 'OK',
      data: homeShelfCommand(home, scope, homeShelfSchema.parse(input), 'user'),
    })
  })
  router.post('/map', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: homeMapCommand(home, scope, homeMapSchema.parse(input)) })
  })
  router.post('/cards/bind', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: home.cards.bind(scope, homeId.parse(input)) })
  })
  router.post('/cards/messages', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    const message = z
      .object({
        cardId: homeId,
        text: z.string().min(1).max(8000),
        messageId: z.string().uuid().optional(),
      })
      .strict()
      .parse(input)
    const saved = home.cards.send(scope, message.cardId, message.text, message.messageId)
    await home.cards.route(saved)
    return c.json({ code: 'OK', data: saved })
  })
  router.post('/cards', async (c) => {
    const { scope, input } = await scoped(await c.req.json())
    return c.json({ code: 'OK', data: homeCardCommand(home, scope, homeCardSchema.parse(input)) })
  })
  router.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      // 无待发送事件时也定期复核设备权限，避免撤权后保留长连接。
      let unsubscribe = () => {},
        timer: ReturnType<typeof setInterval> | undefined
      const queue: string[] = []
      let wake = () => {},
        overflow = false
      unsubscribe = home.activity.subscribe((event) => {
        if (queue.length >= 100) overflow = true
        else queue.push(JSON.stringify(event))
        wake()
      })
      const cleanup = () => {
        unsubscribe()
        clearInterval(timer)
        wake()
      }
      stream.onAbort(cleanup)
      timer = setInterval(() => wake(), 1000)
      try {
        await stream.writeSSE({ event: 'ready', data: '{}' })
        while (!stream.aborted && !overflow && authenticate(c.req.raw)?.admin) {
          while (queue.length) await stream.writeSSE({ event: 'home', data: queue.shift()! })
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      } finally {
        cleanup()
      }
    }),
  )
  return router
}
