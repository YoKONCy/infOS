import { t as __t } from '../lib/i18n'
/**
 * 配置 API 路由
 *
 * KV 配置的完整 CRUD 端点 (B6-3)：
 * - GET    /api/configs          列出所有配置 (分页)
 * - GET    /api/configs/:key     获取单个配置
 * - PUT    /api/configs          设置配置
 * - DELETE /api/configs/:key     删除配置
 * - POST   /api/configs/batch    批量获取
 * - PUT    /api/configs/batch    批量设置
 * - POST   /api/configs/export   导出全部配置
 * - POST   /api/configs/import   导入配置
 *
 * @module packages/backend/src/routers/config.router
 */

import { Hono } from 'hono'
import { validate as zValidator } from '../lib/validation'
import {
  setConfigSchema,
  batchGetConfigSchema,
  validAssistantPrefillSetting,
} from '../schemas/config.schema'
import { z } from 'zod'
import type { AppContext } from '../container'
import { createLogger, setLogLevel, parseLogLevel } from '../lib/logger'
import { AppError } from '../lib/appError'
import { EmbeddingService } from '../services/embedding/embeddingService'
import { LANGUAGE_CONFIG_KEY, normalizeLocale, SUPPORTED_LOCALES } from '@infos/shared/i18n'
import { getLocale, setLocale } from '../lib/i18n'
import {
  EMBEDDING_ENABLED_KEY,
  MEMORY_BACKGROUND_ENABLED_KEY,
  WHOLESOME_MODE_KEY,
  ASSISTANT_PREFILL_KEY,
} from '@infos/shared'
import {
  MEMORY_RUNTIME_CONFIG_KEY,
  loadMemoryRuntimeConfig,
} from '../services/memory/memoryRuntimeConfig'

const logger = createLogger('ConfigRouter')

/**
 * 日志级别热更新：检测 system.logLevel 配置变更，动态调整所有 logger 实例
 *
 * Dashboard 设置面板保存日志级别后，无需重启服务即可生效。
 * 非法值不改变当前级别（仅告警）。
 *
 * @param key   配置 key
 * @param value 配置值（日志级别标签，如 "debug"）
 */
function applyLogLevelHotReload(key: string, value: string): void {
  if (key === LANGUAGE_CONFIG_KEY) {
    setLocale(normalizeLocale(value))
    return
  }
  if (key !== 'system.logLevel') return
  const num = parseLogLevel(value)
  if (num != null) {
    setLogLevel(num)
    logger.info(__t('logs.routers', '日志级别已热更新: {0} (level={1})', [value, num]))
  } else {
    logger.warn(__t('logs.routers', '无效的日志级别: "{0}"，忽略变更（保持当前级别）', [value]))
  }
}

/** 配置 key 前缀到热更新方法的映射 */
const HOT_RELOAD_MAP: Array<{
  prefix: string
  method: keyof Pick<
    AppContext,
    'reloadEmbeddingConfig' | 'reloadTtsConfig' | 'reloadAsrConfig' | 'reloadMemoryBackgroundConfig'
  >
}> = [
  { prefix: 'embedding.', method: 'reloadEmbeddingConfig' },
  { prefix: 'memory.background.', method: 'reloadMemoryBackgroundConfig' },
  { prefix: 'reranker.', method: 'reloadEmbeddingConfig' },
  { prefix: 'tts.', method: 'reloadTtsConfig' },
  { prefix: 'asr.', method: 'reloadAsrConfig' },
]

// ── 额外 Schema (B6-3) ──

const batchSetConfigSchema = z.object({
  items: z.array(setConfigSchema).min(1).max(100),
})

const activateEmbeddingSchema = z.object({
  provider: z.literal('api'),
  model: z.string().trim().min(1),
  dimension: z.number().int().min(1).max(4096),
  apiBase: z.string().trim().optional(),
  apiKey: z.string().trim().optional(),
  reranker: z.object({
    enabled: z.boolean(),
    model: z.string().trim().optional(),
    apiBase: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
  }),
})

const importConfigSchema = z.object({
  data: z
    .record(z.string(), z.string())
    .refine(
      (data) =>
        [EMBEDDING_ENABLED_KEY, MEMORY_BACKGROUND_ENABLED_KEY, WHOLESOME_MODE_KEY].every(
          (key) => data[key] === undefined || data[key] === 'true' || data[key] === 'false',
        ),
      { message: '开关配置必须为 true 或 false' },
    )
    .refine(
      (data) =>
        data[LANGUAGE_CONFIG_KEY] === undefined ||
        (SUPPORTED_LOCALES as readonly string[]).includes(data[LANGUAGE_CONFIG_KEY]!),
      { message: '仅支持简体中文、繁體中文和 English' },
    )
    .refine(
      (data) =>
        data[ASSISTANT_PREFILL_KEY] === undefined ||
        validAssistantPrefillSetting(data[ASSISTANT_PREFILL_KEY]!),
      { message: '预填充配置无效，正文最多 8000 个字符' },
    ),
  /** 是否覆盖已有 key (默认 true) */
  overwrite: z.boolean().default(true),
})

/**
 * 架构说明: ConfigRepo 是一个纯 KV CRUD，业务逻辑极简 (get/set/delete/listAll)，
 * 中间插入 Service 层只会增加无意义的透传。因此这里 Router 直接调用 Repo 是
 * 三层架构的**允许例外**。
 *
 * ⚠️ 请勿将此模式复制到复杂资源 (如 Model/Memory/Agent) 的 Router 中。
 */
export function createConfigRouter(ctx: AppContext) {
  const router = new Hono()

  // POST /api/configs/embedding/activate — 真实验证候选Embedding配置，成功后才持久化。
  router.post('/embedding/activate', zValidator('json', activateEmbeddingSchema), async (c) => {
    if (ctx.embeddingService.isEnabled === false)
      throw new AppError('CONFIG_ERROR', { message: '向量功能已关闭，请先开启后再验证模型' })
    const input = c.req.valid('json')
    const current = ctx.embeddingService.getConfig()
    const apiBase = input.apiBase || current.apiBase
    const apiKey = input.apiKey || current.apiKey
    if (!apiBase) throw new AppError('CONFIG_ERROR', { message: 'Embedding API Base 不能为空' })
    if (!apiKey) throw new AppError('CONFIG_ERROR', { message: 'Embedding API Key 不能为空' })

    const candidate = new EmbeddingService({
      enabled: true,
      apiBase,
      apiKey,
      model: input.model,
      dimension: input.dimension,
      reranker: current.reranker,
    })
    const startedAt = performance.now()
    const vector = await candidate.embedOne(
      'infOS Embedding 模型激活与维度校验',
      ctx.embeddingService.cancellationSignal,
    )
    if (ctx.embeddingService.getConfig().enabled === false)
      throw new AppError('CONFIG_ERROR', { message: '向量功能已关闭，已停止模型验证' })
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt))
    if (!vector.length) {
      throw new AppError('EMBEDDING_ERROR', { message: 'Embedding 模型返回了空向量' })
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new AppError('EMBEDDING_ERROR', { message: 'Embedding 模型返回了非法数值' })
    }
    if (vector.length !== input.dimension) {
      throw new AppError('EMBEDDING_ERROR', {
        message: `Embedding 维度不匹配：配置 ${input.dimension} 维，实际返回 ${vector.length} 维`,
        data: { expectedDimension: input.dimension, actualDimension: vector.length, durationMs },
      })
    }

    const items = [
      ['embedding.provider', input.provider],
      ['embedding.model', input.model],
      ['embedding.dimension', String(input.dimension)],
      ['reranker.enabled', String(input.reranker.enabled)],
    ] as const
    for (const [key, value] of items) await ctx.configRepo.set(key, value)
    if (input.apiBase) await ctx.configRepo.set('embedding.apiBase', input.apiBase)
    if (input.apiKey) await ctx.configRepo.set('embedding.apiKey', input.apiKey)
    if (input.reranker.model) await ctx.configRepo.set('reranker.model', input.reranker.model)
    if (input.reranker.apiBase) await ctx.configRepo.set('reranker.apiBase', input.reranker.apiBase)
    if (input.reranker.apiKey) await ctx.configRepo.set('reranker.apiKey', input.reranker.apiKey)
    await ctx.reloadEmbeddingConfig()

    return c.json({
      code: 'OK',
      message: __t('server.routers', 'Embedding 模型已激活并保存'),
      data: {
        model: input.model,
        dimension: vector.length,
        durationMs,
      },
    })
  })

  // GET /api/configs — 列出所有配置 (B6-3)
  router.get('/', async (c) => {
    const prefix = c.req.query('prefix') ?? ''
    const entries = await ctx.configRepo.listAll(prefix)
    return c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: { items: entries, total: entries.length },
    })
  })

  // GET /api/configs/:key — 获取单个配置
  router.get('/:key', async (c) => {
    const key = c.req.param('key')
    const value = await ctx.configRepo.get(key)
    if (value == null) {
      // 找不到配置时返回 200 OK + null，避免触发后端 Hono logger 的 404 WARN
      return c.json({
        code: 'NOT_CONFIGURED',
        message: __t('server.routers', '配置 "{0}" 未设置', [key]),
        data: { key, value: null },
      })
    }
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: { key, value } })
  })

  // PUT /api/configs — 设置配置
  router.put('/', zValidator('json', setConfigSchema), async (c) => {
    const { key, value } = c.req.valid('json')
    await ctx.configRepo.set(key, value)
    if (key === MEMORY_RUNTIME_CONFIG_KEY)
      ctx.eventMemoryService.syncAdvancedRetrievalConfig(
        await loadMemoryRuntimeConfig(ctx.configRepo),
      )

    // 日志级别热更新（system.logLevel 配置变更时立即生效）
    applyLogLevelHotReload(key, value)

    // 检测是否需要触发服务热更新
    for (const { prefix, method } of HOT_RELOAD_MAP) {
      if (key.startsWith(prefix)) {
        logger.info(__t('logs.routers', '检测到配置变更: {0}，触发 {1}', [key, method]))
        await ctx[method]()
        break
      }
    }

    await ctx.appManager?.notifyConfigChanged?.([key])
    if (key === LANGUAGE_CONFIG_KEY) await ctx.gatewayHub.pushStateUpdate({ language: getLocale() })
    return c.json({
      code: 'OK',
      message: __t('server.routers', '配置已更新'),
      data: { key, value },
    })
  })

  // DELETE /api/configs/:key — 删除配置 (B6-3)
  router.delete('/:key', async (c) => {
    const key = c.req.param('key')
    const existing = await ctx.configRepo.get(key)
    if (existing == null) {
      return c.json(
        { code: 'NOT_FOUND', message: __t('server.routers', '配置 "{0}" 不存在', [key]) },
        404,
      )
    }
    await ctx.configRepo.delete(key)
    if (key === LANGUAGE_CONFIG_KEY) setLocale('zh-CN')
    for (const { prefix, method } of HOT_RELOAD_MAP) if (key.startsWith(prefix)) await ctx[method]()
    if (key === MEMORY_RUNTIME_CONFIG_KEY)
      ctx.eventMemoryService.syncAdvancedRetrievalConfig(
        await loadMemoryRuntimeConfig(ctx.configRepo),
      )
    await ctx.appManager?.notifyConfigChanged?.([key])
    if (key === LANGUAGE_CONFIG_KEY) await ctx.gatewayHub.pushStateUpdate({ language: getLocale() })
    return c.json({ code: 'OK', message: __t('server.routers', '配置 "{0}" 已删除', [key]) })
  })

  // POST /api/configs/batch — 批量获取
  router.post('/batch', zValidator('json', batchGetConfigSchema), async (c) => {
    const { keys } = c.req.valid('json')
    const results: Record<string, string | null> = {}
    for (const key of keys) {
      results[key] = (await ctx.configRepo.get(key)) ?? null
    }
    return c.json({ code: 'OK', message: __t('server.routers', '批量获取成功'), data: results })
  })

  // PUT /api/configs/batch — 批量设置 (B6-3)
  router.put('/batch', zValidator('json', batchSetConfigSchema), async (c) => {
    const { items } = c.req.valid('json')
    const pendingReloads = new Set<string>()
    for (const item of items) {
      await ctx.configRepo.set(item.key, item.value)
      // 日志级别热更新（批量保存时同样生效）
      applyLogLevelHotReload(item.key, item.value)
      for (const { prefix, method } of HOT_RELOAD_MAP) {
        if (item.key.startsWith(prefix)) {
          pendingReloads.add(method)
        }
      }
    }

    // 批量完成后统一触发热更新 (每个 service 最多一次)
    if (items.some((item) => item.key === MEMORY_RUNTIME_CONFIG_KEY)) {
      ctx.eventMemoryService.syncAdvancedRetrievalConfig(
        await loadMemoryRuntimeConfig(ctx.configRepo),
      )
    }
    for (const method of pendingReloads) {
      logger.info(__t('logs.routers', '批量配置变更，触发 {0}', [method]))
      await ctx[
        method as keyof Pick<
          AppContext,
          | 'reloadEmbeddingConfig'
          | 'reloadTtsConfig'
          | 'reloadAsrConfig'
          | 'reloadMemoryBackgroundConfig'
        >
      ]()
    }

    await ctx.appManager?.notifyConfigChanged?.(items.map((item) => item.key))
    if (items.some((item) => item.key === LANGUAGE_CONFIG_KEY))
      await ctx.gatewayHub.pushStateUpdate({ language: getLocale() })
    return c.json({
      code: 'OK',
      message: __t('server.routers', '已更新 {0} 项配置', [items.length]),
      data: { count: items.length },
    })
  })

  // POST /api/configs/export — 导出全部配置 (B6-3)
  router.post('/export', async (c) => {
    const entries = await ctx.configRepo.listAll('')
    const data: Record<string, string> = {}
    for (const entry of entries) {
      data[entry.key] = entry.value
    }
    return c.json({
      code: 'OK',
      message: __t('server.routers', '已导出 {0} 项配置', [entries.length]),
      data,
    })
  })

  // POST /api/configs/import — 导入配置 (B6-3)
  router.post('/import', zValidator('json', importConfigSchema), async (c) => {
    const { data, overwrite } = c.req.valid('json')
    let imported = 0
    let skipped = 0
    const changedKeys: string[] = []

    for (const [key, value] of Object.entries(data)) {
      if (!overwrite) {
        const existing = await ctx.configRepo.get(key)
        if (existing != null) {
          skipped++
          continue
        }
      }
      await ctx.configRepo.set(key, value)
      // 日志级别热更新（导入配置时同样生效）
      changedKeys.push(key)
      applyLogLevelHotReload(key, value)
      imported++
    }

    if (Object.prototype.hasOwnProperty.call(data, MEMORY_RUNTIME_CONFIG_KEY)) {
      ctx.eventMemoryService.syncAdvancedRetrievalConfig(
        await loadMemoryRuntimeConfig(ctx.configRepo),
      )
    }
    const reloads = new Set(
      HOT_RELOAD_MAP.filter(({ prefix }) => changedKeys.some((key) => key.startsWith(prefix))).map(
        ({ method }) => method,
      ),
    )
    for (const method of reloads) await ctx[method]()
    await ctx.appManager?.notifyConfigChanged?.(changedKeys)
    if (changedKeys.includes(LANGUAGE_CONFIG_KEY))
      await ctx.gatewayHub.pushStateUpdate({ language: getLocale() })
    return c.json({
      code: 'OK',
      message: __t('server.routers', '导入完成: {0} 项写入, {1} 项跳过', [imported, skipped]),
      data: { imported, skipped },
    })
  })

  return router
}
