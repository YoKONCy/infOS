import { t as __t } from '../lib/i18n'
/**
 * Maintenance Router — 记忆运行配置与新版后台任务 API
 *
 * - GET  /api/maintenance/memory-config
 * - PUT  /api/maintenance/memory-config
 * - POST /api/maintenance/trigger
 *
 * 遵循 .docs/S02_API_SPEC.md 信封规范。
 *
 * @module packages/backend/src/routers/maintenance.router
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { IndexMaintenanceService } from '../services/maintenance/indexMaintenanceService'
import { validate as zValidator } from '../lib/validation'
import { AppError } from '../lib/appError'
import type { AppContext } from '../container'
import {
  MEMORY_RUNTIME_CONFIG_KEY,
  loadMemoryRuntimeConfig,
  memoryRuntimeConfigSchema,
} from '../services/memory/memoryRuntimeConfig'

export function createMaintenanceRouter(ctx: AppContext) {
  const router = new Hono()
  const indexes = new IndexMaintenanceService(ctx)
  router.get('/indexes', (c) => c.json({ code: 'OK', data: indexes.status() }))
  router.post(
    '/reindex',
    zValidator(
      'json',
      z.object({
        scope: z.enum(['main', 'social', 'facts', 'knowledge', 'all']).default('main'),
        agentId: z
          .string()
          .regex(/^[\w-]+$/)
          .optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid('json')
      const data = await indexes.rebuild(input.scope, input.agentId)
      return c.json(
        { code: 'ACCEPTED', message: __t('server.routers', '索引重建已安排'), data },
        202,
      )
    },
  )

  // GET /api/maintenance/memory-config — 获取经过校验的主 Agent 记忆运行配置
  router.get('/memory-config', async (c) => {
    const config = await loadMemoryRuntimeConfig(ctx.configRepo)
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: config })
  })

  // PUT /api/maintenance/memory-config — 保存主 Agent 记忆运行配置
  router.put('/memory-config', zValidator('json', memoryRuntimeConfigSchema), async (c) => {
    const config = c.req.valid('json')
    await ctx.configRepo.setJson(MEMORY_RUNTIME_CONFIG_KEY, config)
    return c.json({
      code: 'OK',
      message: __t('server.routers', '记忆运行配置已更新'),
      data: config,
    })
  })

  // POST /api/maintenance/trigger — 手动触发维护任务
  router.post('/trigger', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const taskName = (body as Record<string, unknown>).task as string | undefined

    if (!taskName) {
      throw new AppError('MISSING_FIELD', {
        message: '请指定要触发的任务名称',
        data: { field: 'task', available: ctx.scheduler.getPeriodicScheduleNames() },
      })
    }

    // 通过 Scheduler 触发
    const success = await ctx.scheduler.triggerPeriodicNow(taskName)
    if (!success) {
      throw new AppError('NOT_FOUND', {
        message: `维护任务 "${taskName}" 不存在或正在运行中`,
        data: { taskName, available: ctx.scheduler.getPeriodicScheduleNames() },
      })
    }

    return c.json(
      {
        code: 'ACCEPTED',
        message: __t('server.routers', '维护任务 "{0}" 已触发', [taskName]),
        data: { taskName },
      },
      202,
    )
  })

  return router
}
