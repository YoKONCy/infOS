import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validation'
import { AppError } from '../lib/appError'
import { t } from '../lib/i18n'
import type { RuntimeDebugService } from '../services/debug/runtimeDebugService'

export function createRuntimeDebugRouter(service: RuntimeDebugService) {
  const router = new Hono()
  router.get('/:threadId', async (c) => {
    try {
      const status = await service.getStatus(c.req.param('threadId'))
      return c.json({ code: 'OK', data: status })
    } catch (error) {
      throw new AppError('INVALID_PARAMETER', {
        message: t('server.runtime-debug', '当前会话不支持调试'),
        cause: error,
      })
    }
  })
  router.put('/:threadId', validate('json', z.object({ enabled: z.boolean() })), async (c) => {
    try {
      const data = await service.setEnabled(c.req.param('threadId'), c.req.valid('json').enabled)
      return c.json({ code: 'OK', data })
    } catch (error) {
      throw new AppError('INVALID_PARAMETER', {
        message: t('server.runtime-debug', '调试模式切换失败，请确认当前为普通桌面工作会话。'),
        cause: error,
      })
    }
  })
  return router
}
