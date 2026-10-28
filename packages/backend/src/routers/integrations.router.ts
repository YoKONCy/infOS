import { t as __t } from '../lib/i18n'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../container'
import { validate as zValidator } from '../lib/validation'
import { sourceInputSchema } from '../services/integrations/integrationService'
import { readExtensionInventory } from '../services/integrations/extensionInventory'

export function createIntegrationsRouter(ctx: AppContext) {
  const router = new Hono()
  const extensionId = z.enum(['deepwiki', 'sciverse'])
  const featureId = z.enum(['search', 'pdf'])
  router.get('/installed', async (c) =>
    c.json({
      code: 'OK',
      data: await readExtensionInventory(ctx),
    }),
  )
  router.get('/', (c) =>
    c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: ctx.integrationService.view(),
    }),
  )
  router.put(
    '/extensions/:id',
    zValidator('param', z.object({ id: extensionId })),
    zValidator(
      'json',
      z.object({
        enabled: z.boolean(),
        chatEnabled: z.boolean().optional(),
        endpoint: z.string().trim().max(2048),
        apiKey: z.string().trim().max(4096).optional(),
        clearApiKey: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(20).default(5),
      }),
    ),
    async (c) => {
      const data = await ctx.integrationService.updateExtension(
        c.req.valid('param').id,
        c.req.valid('json'),
      )
      return c.json({ code: 'OK', message: __t('server.routers', '扩展配置已保存'), data })
    },
  )
  router.put(
    '/features/:kind',
    zValidator('param', z.object({ kind: featureId })),
    zValidator(
      'json',
      z.object({ enabled: z.boolean(), selectedSourceId: z.string().uuid().nullable() }),
    ),
    async (c) => {
      const data = await ctx.integrationService.updateFeature(
        c.req.valid('param').kind,
        c.req.valid('json'),
      )
      return c.json({ code: 'OK', message: __t('server.routers', '功能配置已保存'), data })
    },
  )
  router.post(
    '/features/:kind/sources',
    zValidator('param', z.object({ kind: featureId })),
    zValidator('json', sourceInputSchema),
    async (c) => {
      const data = await ctx.integrationService.saveSource(
        c.req.valid('param').kind,
        c.req.valid('json'),
      )
      return c.json({ code: 'OK', message: __t('server.routers', '来源已保存'), data })
    },
  )
  router.delete(
    '/features/:kind/sources/:id',
    zValidator('param', z.object({ kind: featureId, id: z.string().uuid() })),
    async (c) => {
      const { kind, id } = c.req.valid('param')
      const data = await ctx.integrationService.removeSource(kind, id)
      return c.json({ code: 'OK', message: __t('server.routers', '来源已移除'), data })
    },
  )
  return router
}
