import { t as __t } from '../../lib/i18n'
/**
 * 模型注册表
 *
 * 从 SQLite aiModelConfigs 表读取模型配置，按用途查询。
 * 供 LlmService、AgentService 和后台模型任务获取活跃模型。
 *
 * @module packages/backend/src/services/llm/modelRegistry
 */

import { eq, and } from 'drizzle-orm'
import { aiModelConfigs, configs } from '../../database/schema'
import { modelFallbackIds, modelFallbackKey } from './modelFallbacks'
import type { DrizzleDb } from '../../database'
import type { ModelConfig } from './llmService'
import { createLogger } from '../../lib/logger'
import { AppError } from '../../lib/appError'
import { ProviderConnectionRepository } from '../../repositories/providerConnection.repo'
import { resolveModelConnection } from './modelConnection'

const logger = createLogger('ModelRegistry')

// ─────────────────────────────────────────────
// 模型用途枚举
// ─────────────────────────────────────────────

/**
 * 模型用途
 *
 * 每种用途可独立配置不同的模型：
 * - chat: 日常对话 (前台)
 * - scorer: 记忆分析 (后台)
 * - embedding: 向量化 (EmbeddingService 独立管理)
 * - reflection: 记忆维护 (后台)
 * - task: 工作模式 (可选高性能模型)
 */
export type ModelPurpose = 'chat' | 'scorer' | 'reflection' | 'task'

/** 数据库行类型 */
type ModelRow = typeof aiModelConfigs.$inferSelect

// ─────────────────────────────────────────────
// ModelRegistry
// ─────────────────────────────────────────────

export class ModelRegistry {
  /** 模型缓存 (避免频繁查 DB) */
  private cache = new Map<string, { config: ModelConfig; expiresAt: number }>()

  /** 缓存有效期 (5 分钟) */
  private readonly cacheTtl = 5 * 60 * 1000

  constructor(private db: DrizzleDb) {}

  /**
   * 按用途获取模型配置
   *
   * 查找优先级：
   * 1. 该用途下的活跃模型 (providerType = 用途)
   * 2. 全局默认模型 (providerType = 'global')
   * 3. 抛出 CONFIG_ERROR
   */
  async getByPurpose(purpose: ModelPurpose): Promise<ModelConfig> {
    // 检查缓存
    const cacheKey = `purpose:${purpose}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.config
    }

    // 1. 查找指定用途的模型
    let row = await this.db
      .select()
      .from(aiModelConfigs)
      .where(and(eq(aiModelConfigs.providerType, purpose)))
      .get()

    // 2. 回退到全局默认
    if (!row) {
      row = await this.db
        .select()
        .from(aiModelConfigs)
        .where(eq(aiModelConfigs.providerType, 'global'))
        .get()
    }

    if (!row) {
      throw new AppError('CONFIG_ERROR', {
        message: `未找到 "${purpose}" 用途的模型配置，请先在设置中添加模型`,
        data: { purpose },
      })
    }

    const config = await this.rowToConfig(row)

    // 写入缓存
    this.cache.set(cacheKey, { config, expiresAt: Date.now() + this.cacheTtl })

    logger.debug(__t('logs.llm', '获取模型配置'), {
      purpose,
      model: config.modelId,
      provider: config.provider,
    })
    return config
  }

  /**
   * 按 ID 获取模型配置
   */
  async getById(id: number): Promise<ModelConfig | null> {
    const row = await this.db.select().from(aiModelConfigs).where(eq(aiModelConfigs.id, id)).get()

    if (!row) return null
    return this.rowToConfig(row)
  }

  /**
   * 列出所有模型配置
   *
   * 返回脱敏后的列表 (API Key 遮蔽)。
   */
  async listAll(): Promise<Array<ModelRow & { apiKey: string }>> {
    const rows = await this.db.select().from(aiModelConfigs).all()
    return rows.map((r) => ({
      ...r,
      apiKey: r.apiKey ? this.maskKey(r.apiKey) : '',
    }))
  }

  /**
   * 使缓存失效
   *
   * 在模型配置 CRUD 后调用，确保下次使用最新配置。
   */
  invalidateCache(): void {
    this.cache.clear()
    logger.debug(__t('logs.llm', '模型缓存已清空'))
  }

  /**
   * 使指定用途的缓存失效
   */
  invalidatePurpose(purpose: ModelPurpose): void {
    this.cache.delete(`purpose:${purpose}`)
  }

  // ── 内部方法 ──

  /** 数据库行 → ModelConfig */
  private async rowToConfig(row: ModelRow, withFallbacks = true): Promise<ModelConfig> {
    const connection = await resolveModelConnection(
      row,
      (id) => new ProviderConnectionRepository(this.db).findById(id),
      async (key) =>
        (await this.db.select().from(configs).where(eq(configs.key, key)).get())?.value,
    )
    const fallbackModels: ModelConfig[] = []
    if (withFallbacks) {
      const raw = await this.db
        .select()
        .from(configs)
        .where(eq(configs.key, modelFallbackKey(row.id)))
        .get()
      for (const id of modelFallbackIds(raw?.value, row.id)) {
        const candidate = await this.db
          .select()
          .from(aiModelConfigs)
          .where(eq(aiModelConfigs.id, id))
          .get()
        if (candidate) fallbackModels.push(await this.rowToConfig(candidate, false))
      }
    }
    return {
      configId: row.id,
      fallbackModels,
      ...connection,
      modelId: row.modelId,
      temperature: row.temperature ?? undefined,
      topP: row.topP ?? undefined,
      maxTokens: row.maxTokens ?? undefined,
      contextWindowTokens: row.contextWindowTokens ?? undefined,
      maxReActTurns: row.maxReActTurns ?? undefined,
      reasoningEffort: (row.reasoningEffort as ModelConfig['reasoningEffort']) ?? undefined,
      returnNativeReasoning: row.returnNativeReasoning ?? false,
      wireApi: (row.wireApi as ModelConfig['wireApi']) ?? 'chat_completions',
      reasoningDialect: (row.reasoningDialect as ModelConfig['reasoningDialect']) ?? 'auto',
      assistantPrefill: (row.assistantPrefill as ModelConfig['assistantPrefill']) ?? 'auto',
      stream: row.stream ?? true,
      enableVision: row.enableVision ?? false,
      enableAudioInput: row.enableAudioInput ?? false,
    }
  }

  /** 遮蔽 API Key (保留前 4 后 4) */
  private maskKey(key: string): string {
    if (key.length <= 8) return '****'
    return key.slice(0, 4) + '****' + key.slice(-4)
  }
}
