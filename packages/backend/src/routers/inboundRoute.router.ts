import { t as __t } from '../lib/i18n'
/**
 * InboundRoute Router — 入站路由表管理 API
 *
 * 第七阶段 #7：提供外部消息路由规则的 CRUD 端点。
 * 管理员通过此 API 配置"消息来源 → Agent/Channel"的映射，
 * 替代旧的全局活跃 Agent 对外部消息的决定作用。
 *
 * 端点：
 * - GET    /api/inbound-routes           列出所有路由
 * - GET    /api/inbound-routes/resolve   按 (source, identifier) 查询路由
 * - POST   /api/inbound-routes           创建路由
 * - PUT    /api/inbound-routes/:id       更新路由
 * - DELETE /api/inbound-routes/:id       删除路由
 *
 * @module packages/backend/src/routers/inboundRoute.router
 */

import { Hono } from 'hono'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import { AppError } from '../lib/appError'
import type { AppContext } from '../container'

// ─────────────────────────────────────────────
// Zod Schema
// ─────────────────────────────────────────────

/** 合法的来源类型 */
const SOURCE_VALUES = ['qq_private', 'qq_group', 'discord', 'webhook', 'monitor'] as const

/** 合法的通道类型 */
const CHANNEL_VALUES = ['desktop', 'social', 'group'] as const

/** 创建路由的请求体 Schema */
const createRouteSchema = z.object({
  source: z.enum(SOURCE_VALUES),
  identifier: z.string().min(1).max(200),
  agentId: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_-]+$/, 'agentId 只允许小写字母、数字、下划线和短横线'),
  channel: z.enum(CHANNEL_VALUES).optional().default('social'),
  threadId: z.string().max(64).optional().nullable(),
  config: z.record(z.string(), z.unknown()).optional(),
})

/** 更新路由的请求体 Schema（所有字段可选） */
const updateRouteSchema = z.object({
  agentId: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
  channel: z.enum(CHANNEL_VALUES).optional(),
  threadId: z.string().max(64).optional().nullable(),
  config: z.record(z.string(), z.unknown()).optional(),
})

// ─────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────

export function createInboundRouteRouter(ctx: AppContext) {
  const router = new Hono()

  // GET /api/inbound-routes — 列出所有路由
  router.get('/', async (c) => {
    const routes = await ctx.inboundRouteService.list()
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: routes })
  })

  // GET /api/inbound-routes/resolve — 按 (source, identifier) 查询路由
  // 便捷接口：外部消息入口可直接调用此端点测试路由命中情况
  router.get('/resolve', async (c) => {
    const source = c.req.query('source')
    const identifier = c.req.query('identifier')
    if (!source || !identifier) {
      throw new AppError('VALIDATION_ERROR', {
        message: '缺少参数 source 或 identifier',
      })
    }
    const resolved = await ctx.inboundRouteService.resolve(source, identifier)
    return c.json({ code: 'OK', message: __t('server.routers', '路由命中'), data: resolved })
  })

  // POST /api/inbound-routes — 创建路由
  router.post('/', zValidator('json', createRouteSchema), async (c) => {
    const body = c.req.valid('json')
    const route = await ctx.inboundRouteService.create({
      source: body.source,
      identifier: body.identifier,
      agentId: body.agentId,
      channel: body.channel,
      threadId: body.threadId ?? null,
      config: body.config,
    })
    return c.json(
      { code: 'CREATED', message: __t('server.routers', '路由创建成功'), data: route },
      201,
    )
  })

  // PUT /api/inbound-routes/:id — 更新路由
  router.put('/:id', zValidator('json', updateRouteSchema), async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const updated = await ctx.inboundRouteService.update(id, body)
    return c.json({ code: 'OK', message: __t('server.routers', '路由更新成功'), data: updated })
  })

  // DELETE /api/inbound-routes/:id — 删除路由
  router.delete('/:id', async (c) => {
    const id = c.req.param('id')
    await ctx.inboundRouteService.delete(id)
    return c.json({ code: 'OK', message: __t('server.routers', '路由 "{0}" 已删除', [id]) })
  })

  return router
}
