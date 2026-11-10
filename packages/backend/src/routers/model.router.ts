import { t as __t } from '../lib/i18n'
/**
 * 模型配置 API 路由
 *
 * AI 模型配置的 CRUD：
 * - GET    /api/models           列出所有模型配置
 * - GET    /api/models/:id       获取单个模型配置
 * - POST   /api/models           创建模型配置
 * - PUT    /api/models/:id       更新模型配置
 * - DELETE /api/models/:id       删除模型配置
 * - POST   /api/models/:id/test  测试模型连通性
 *
 * 所有 DB 操作通过 ModelService → ModelRepository 完成，
 * Router 层不直接操作数据库。
 *
 * @module packages/backend/src/routers/model.router
 */

import { Hono } from 'hono'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import type { AppContext } from '../container'

// ─────────────────────────────────────────────
// Zod Schema
// ─────────────────────────────────────────────

const createModelSchema = z.object({
  /** 配置名称 (用户可读，如 "GPT-4o 日常") */
  name: z.string().min(1).max(100),
  /** Provider 类型 (openai/gemini/anthropic 等) */
  provider: z.string().min(1),
  /** 模型 ID (如 gpt-4o, claude-sonnet-4-20250514) */
  modelId: z.string().min(1),
  /** API Key (可选，留空使用全局配置) */
  apiKey: z.string().default(''),
  /** API 基址 (可选，留空使用默认) */
  apiBase: z.string().optional(),
  providerConnectionId: z.string().min(1).nullable().optional(),
  connectionOverride: z.boolean().optional(),
  connectionProtocol: z.enum(['openai', 'anthropic', 'gemini']).nullable().optional(),
  connectionAuthMode: z.enum(['api_key', 'none']).optional(),
  /** 温度 0-2 */
  temperature: z.number().min(0).max(2).nullable().optional(),
  /** Top P 0-1 */
  topP: z.number().min(0).max(1).nullable().optional(),
  /** 最大输出 Token 数 */
  maxTokens: z.number().int().min(1).nullable().optional(),
  /** 模型完整上下文窗口 */
  contextWindowTokens: z.number().int().min(1).nullable().optional(),
  /** 桌面 ReAct 最大轮次；null 使用通道默认值。 */
  maxReActTurns: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  /** 模型推理强度；null 表示不传 */
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  /** 是否请求并展示Provider原生思考摘要。 */
  returnNativeReasoning: z.boolean().optional(),
  wireApi: z.enum(['chat_completions', 'responses']).optional(),
  reasoningDialect: z.enum(['auto', 'openai', 'deepseek', 'openrouter', 'generic']).optional(),
  /** 回答预填充能力声明；auto 按协议、接口、模型与思考状态判断。 */
  assistantPrefill: z.enum(['auto', 'supported', 'unsupported']).optional(),
  /** 是否使用Provider流式接口 */
  stream: z.boolean().optional(),
  /** Provider 类型 / 用途 (global/chat/scorer/reflection/task) */
  providerType: z.string().default('global'),
  /** 启用视觉能力 (多模态) */
  enableVision: z.boolean().optional(),
  /** 声明模型支持原生音频输入（非 ASR） */
  enableAudioInput: z.boolean().optional(),
})

const updateModelSchema = createModelSchema.partial().extend({
  name: z.string().min(1).max(100).optional(),
})

// ─────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────

export function createModelRouter(ctx: AppContext) {
  const router = new Hono()

  const connectionSchema = z.object({
    name: z.string().min(1).max(100),
    brand: z.string().min(1).max(100),
    protocol: z.enum(['openai', 'anthropic', 'gemini']),
    apiBase: z.string().max(2000),
    authMode: z.enum(['api_key', 'none']),
    apiKey: z.string().max(10000),
  })
  router.get('/providers', async (c) =>
    c.json({ code: 'OK', data: await ctx.modelService.providers.list() }),
  )
  router.post('/providers', zValidator('json', connectionSchema), async (c) =>
    c.json(
      { code: 'CREATED', data: await ctx.modelService.providers.create(c.req.valid('json')) },
      201,
    ),
  )
  router.get('/providers/:connectionId', async (c) =>
    c.json({ code: 'OK', data: await ctx.modelService.providers.get(c.req.param('connectionId')) }),
  )
  router.put(
    '/providers/:connectionId',
    zValidator('json', connectionSchema.partial()),
    async (c) =>
      c.json({
        code: 'OK',
        data: await ctx.modelService.providers.update(
          c.req.param('connectionId'),
          c.req.valid('json'),
        ),
      }),
  )
  router.delete('/providers/:connectionId', async (c) => {
    await ctx.modelService.providers.remove(
      c.req.param('connectionId'),
      c.req.query('replacementId'),
    )
    return c.json({ code: 'OK', message: __t('server.routers', '服务商连接已删除') })
  })
  router.post('/providers/:connectionId/probe', async (c) =>
    c.json({
      code: 'OK',
      data: await ctx.modelService.providers.probe(c.req.param('connectionId')),
    }),
  )
  router.post('/providers/:connectionId/models', async (c) =>
    c.json({
      code: 'OK',
      data: await ctx.modelService.providers.listModels(c.req.param('connectionId')),
    }),
  )

  // GET /api/models — 列出所有模型配置 (API Key 遮蔽)
  router.get('/', async (c) => {
    const models = await ctx.modelService.list()
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: models })
  })

  // 有序回退只引用已有卡片，不复制模型密钥。
  router.get('/:id/fallbacks', async (c) =>
    c.json({
      code: 'OK',
      data: await ctx.modelService.getFallbacks(Number(c.req.param('id'))),
    }),
  )
  router.put(
    '/:id/fallbacks',
    zValidator('json', z.object({ modelIds: z.array(z.number().int().positive()).max(32) })),
    async (c) =>
      c.json({
        code: 'OK',
        data: await ctx.modelService.setFallbacks(
          Number(c.req.param('id')),
          c.req.valid('json').modelIds,
        ),
      }),
  )

  // GET /api/models/:id — 获取单个模型配置
  router.get('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const model = await ctx.modelService.getById(id)
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: model })
  })

  // POST /api/models — 创建模型配置
  router.post('/', zValidator('json', createModelSchema), async (c) => {
    const body = c.req.valid('json')
    const model = await ctx.modelService.create(body)
    return c.json(
      { code: 'CREATED', message: __t('server.routers', '模型配置已创建'), data: model },
      201,
    )
  })

  // PUT /api/models/:id — 更新模型配置
  router.put('/:id', zValidator('json', updateModelSchema), async (c) => {
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const model = await ctx.modelService.update(id, body)
    return c.json({ code: 'OK', message: __t('server.routers', '模型配置已更新'), data: model })
  })

  // DELETE /api/models/:id — 删除模型配置
  router.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    await ctx.modelService.delete(id)
    return c.json({ code: 'OK', message: __t('server.routers', '模型配置已删除') })
  })

  // POST /api/models/list-remote — 获取远程模型列表
  router.post(
    '/list-remote',
    zValidator(
      'json',
      z.object({
        provider: z.string().min(1),
        apiKey: z.string().default(''),
        apiBase: z.string().optional(),
        protocol: z.enum(['openai', 'anthropic', 'gemini']).optional(),
        providerConnectionId: z.string().min(1).optional(),
        connectionOverride: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json')
      const models = await ctx.modelService.listRemoteModels(body)
      return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: models })
    },
  )

  // POST /api/models/:id/test — 测试模型连通性
  router.post('/:id/test', async (c) => {
    const id = Number(c.req.param('id'))
    const result = await ctx.modelService.test(id)
    return c.json({
      code: 'OK',
      message: __t('server.routers', '模型连通性测试成功'),
      data: result,
    })
  })

  return router
}
