import { t as __t } from '../lib/i18n'
/**
 * Theme Router — 自定义主题
 *
 * - GET    /api/themes                    主题列表与主题文件夹位置
 * - GET    /api/themes/:id/files/<path>   读取主题文件（theme.css、图片、字体）
 * - POST   /api/themes/import             导入主题 ZIP（字段 theme；?replace=1 覆盖同名主题）
 * - DELETE /api/themes/:id                删除主题
 *
 * @module packages/backend/src/routers/theme.router
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { CUSTOM_THEME_LIMITS } from '@infos/shared'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'

export function createThemeRouter(ctx: AppContext) {
  const router = new Hono()
  const service = ctx.themeService

  router.get('/', async (c) =>
    c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: { folder: service.folder, themes: await service.list() },
    }),
  )

  router.get('/:id/files/*', async (c) => {
    const id = c.req.param('id')
    const prefix = `/files/`
    const raw = c.req.path.slice(c.req.path.indexOf(prefix) + prefix.length)
    let relative: string
    try {
      relative = decodeURIComponent(raw)
    } catch {
      relative = ''
    }
    const { bytes, mime } = await service.readFile(id, relative)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
      },
    })
  })

  router.post(
    '/import',
    bodyLimit({
      // 多出的 1MB 留给 multipart 边界与字段头。
      maxSize: CUSTOM_THEME_LIMITS.archive + 1024 * 1024,
      onError: (c) =>
        c.json(
          { code: 'PAYLOAD_TOO_LARGE', message: __t('server.theme', '主题包为空或超过 20MB') },
          413,
        ),
    }),
    async (c) => {
      const body = await c.req.parseBody()
      const file = body.theme
      if (!(file instanceof File))
        throw new AppError('MISSING_FIELD', { message: __t('server.theme', '请上传主题 ZIP') })
      const theme = await service.import(
        new Uint8Array(await file.arrayBuffer()),
        file.name,
        c.req.query('replace') === '1',
      )
      return c.json(
        { code: 'CREATED', message: __t('server.theme', '主题已导入'), data: theme },
        201,
      )
    },
  )

  router.delete('/:id', async (c) => {
    await service.remove(c.req.param('id'))
    return c.json({ code: 'OK', message: __t('server.theme', '主题已删除'), data: null })
  })

  return router
}
