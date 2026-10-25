import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'
import { t } from '../lib/i18n'
import { USER_AVATAR_MAX_BYTES } from '../services/system/userAvatarService'

export function createUserAvatarRouter(ctx: Pick<AppContext, 'userAvatarService' | 'gatewayHub'>) {
  const router = new Hono()
  router.get('/', async (c) => c.json({ code: 'OK', data: await ctx.userAvatarService.profile() }))
  router.get('/content', async () => {
    const bytes = await ctx.userAvatarService.read()
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    })
  })
  router.put(
    '/',
    bodyLimit({
      maxSize: USER_AVATAR_MAX_BYTES + 64 * 1024,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: '头像文件应大于 0 且不超过 5MB' })
      },
    }),
    async (c) => {
      const body = await c.req.parseBody()
      if (!(body.avatar instanceof File))
        throw new AppError('MISSING_FIELD', { message: '请上传裁切后的头像文件' })
      const data = await ctx.userAvatarService.save(body.avatar)
      await ctx.gatewayHub.pushStateUpdate({ ownerAvatarChanged: true }).catch(() => undefined)
      return c.json({ code: 'OK', message: t('server.user-avatar', '头像已更新'), data })
    },
  )
  router.delete('/', async (c) => {
    const data = await ctx.userAvatarService.remove()
    await ctx.gatewayHub.pushStateUpdate({ ownerAvatarChanged: true }).catch(() => undefined)
    return c.json({ code: 'OK', message: t('server.user-avatar', '已恢复默认头像'), data })
  })
  return router
}
