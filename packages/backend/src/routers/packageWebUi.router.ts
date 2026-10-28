import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { AppError } from '../lib/appError'
import { t } from '../lib/i18n'
import type { PackageWebUi, PackageWebUiOwner } from '../packages/packageWebUi'

/** 仅资源票据的只读路径免于宿主鉴权，生命周期和所属身份仍由服务验证。 */
export function isPackageWebUiFileRequest(method: string, pathname: string): boolean {
  return (
    ['GET', 'HEAD'].includes(method) &&
    /^\/api\/packages\/web-ui\/files\/[a-f0-9]{64}\/.+/.test(pathname)
  )
}

export function createPackageWebUiRouter(
  ui: PackageWebUi,
  identify: (request: Request) => PackageWebUiOwner | undefined,
): Hono {
  const router = new Hono()
  const owner = (request: Request) => {
    const identity = identify(request)
    if (!identity) throw new AppError('UNAUTHORIZED')
    return identity
  }
  router.use(
    '*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE')
      },
    }),
  )
  router.get('/files/:ticket/*', async (c) => {
    const prefix = `/api/packages/web-ui/files/${c.req.param('ticket')}/`
    const relative = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length))
    const file = await ui.read(c.req.param('ticket'), relative, new URL(c.req.url).origin)
    // 覆盖全局携带凭据的 CORS 策略；模块与字体来自 opaque origin，只读取票据资源。
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Credentials', undefined)
    return new Response(new Uint8Array(file.content).buffer, {
      headers: {
        'Content-Type': file.type,
        'Content-Security-Policy': file.csp,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        // 静态 JSON 不是 REST 信封，不经过业务码补写。
        'X-InfOS-Package-Asset': '1',
      },
    })
  })
  router.post('/open', async (c) => {
    const identity = owner(c.req.raw)
    const body = z
      .object({ packageId: z.string().max(160), contributionId: z.string().max(160) })
      .parse(await c.req.json())
    return c.json({ code: 'OK', data: ui.open(body.packageId, body.contributionId, identity) })
  })
  router.get('/sessions/:id', (c) => {
    ui.touch(c.req.param('id'), owner(c.req.raw))
    return c.json({ code: 'OK' })
  })
  router.delete('/sessions/:id', (c) => {
    ui.close(c.req.param('id'), owner(c.req.raw))
    return c.json({ code: 'OK' })
  })
  router.post('/sessions/:id/call', async (c) => {
    const identity = owner(c.req.raw)
    const body = z
      .object({ action: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/i), input: z.unknown() })
      .parse(await c.req.json())
    const id = c.req.param('id')
    ui.touch(id, identity)
    return streamSSE(c, async (stream) => {
      const controller = new AbortController()
      stream.onAbort(() => controller.abort())
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal])
      try {
        const result = await ui.invoke(
          id,
          identity,
          body.action,
          body.input,
          async (value) => {
            await stream.writeSSE({ event: 'progress', data: JSON.stringify(value) })
          },
          signal,
        )
        if (!signal.aborted)
          await stream.writeSSE({ event: 'result', data: JSON.stringify(result) })
      } catch {
        if (!signal.aborted)
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              message: t('server.packages', '插件操作未完成，请重试或查看插件诊断。'),
            }),
          })
      } finally {
        controller.abort()
      }
    })
  })
  return router
}
