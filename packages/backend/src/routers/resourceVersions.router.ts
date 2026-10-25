import { Hono } from 'hono'
import { z } from 'zod'
import { ResourceVersions } from '@infos/shared/resource-versions'
import { AppError } from '../lib/appError'
import { t } from '../lib/i18n'
import { errorHandler } from '../middleware/errorHandler'

/** 应用和回退只登记下次启动操作，不在 HTTP 请求中执行用户代码。 */
export function createResourceVersionsRouter(resources: ResourceVersions) {
  const router = new Hono()
  router.onError((error, c) => {
    const reason = String(error).match(/RESOURCE_[A-Z_]+/)?.[0] ?? 'RESOURCE_OPERATION_FAILED'
    const message =
      reason === 'RESOURCE_SOURCE_CHANGED'
        ? '原资源或候选已变更，请刷新并重新创建候选版本。'
        : reason === 'RESOURCE_PENDING_EXISTS'
          ? '同类资源已有待执行操作，请先取消或重启。'
          : reason === 'RESOURCE_ROLLBACK_ORDER'
            ? '请先回退同类资源最近应用的版本。'
            : '资源版本操作失败，请刷新并检查候选版本。'
    return errorHandler(
      new AppError('INVALID_PARAMETER', {
        message: t('server.resource-versions', message),
        data: { reason },
      }),
      c,
    )
  })
  router.get('/', async (c) => c.json({ code: 'OK', data: await resources.view() }))
  router.post('/checkout', async (c) => {
    const { kind } = z
      .object({ kind: z.enum(['skills', 'custom', 'agents', 'packages']) })
      .parse(await c.req.json())
    return c.json({ code: 'OK', data: await resources.checkout(kind) })
  })
  router.get('/:id/changes', async (c) =>
    c.json({ code: 'OK', data: await resources.changes(c.req.param('id')) }),
  )
  router.get('/:id/preview', async (c) =>
    c.json({
      code: 'OK',
      data: await resources.preview(
        c.req.param('id'),
        z.string().min(1).max(2000).parse(c.req.query('file')),
      ),
    }),
  )
  router.post('/:id/apply', async (c) => {
    await resources.schedule(c.req.param('id'), 'apply')
    return c.json({ code: 'OK' })
  })
  router.post('/:id/rollback', async (c) => {
    await resources.schedule(c.req.param('id'), 'rollback')
    return c.json({ code: 'OK' })
  })
  router.delete('/:id/pending', async (c) => {
    await resources.cancel(c.req.param('id'))
    return c.json({ code: 'OK' })
  })
  router.delete('/:id', async (c) => {
    await resources.discard(c.req.param('id'))
    return c.json({ code: 'OK' })
  })
  router.put('/safe-mode', async (c) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json())
    await resources.setSafeMode(enabled)
    return c.json({ code: 'OK' })
  })
  return router
}
