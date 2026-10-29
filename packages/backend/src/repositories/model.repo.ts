/**
 * 模型配置 Repository
 *
 * ai_model_configs 表的数据访问层。
 * 将 model.router 中的直接 DB 操作下沉至此。
 *
 * @module packages/backend/src/repositories/model.repo
 */

import { eq, sql } from 'drizzle-orm'
import { aiModelConfigs, configs } from '../database/schema'
import type { ReasoningEffort } from '../services/llm/types'
import type { DrizzleDb } from '../database'
import { ProviderConnectionRepository } from './providerConnection.repo'

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

/** 创建模型配置输入 */
export interface CreateModelInput {
  name: string
  provider: string
  modelId: string
  apiKey: string
  apiBase?: string
  providerConnectionId?: string | null
  connectionOverride?: boolean
  connectionProtocol?: 'openai' | 'anthropic' | 'gemini' | null
  connectionAuthMode?: 'api_key' | 'none'
  temperature?: number | null
  topP?: number | null
  maxTokens?: number | null
  contextWindowTokens?: number | null
  maxReActTurns?: number | null
  reasoningEffort?: ReasoningEffort | null
  returnNativeReasoning?: boolean
  wireApi?: import('../services/llm/types').LlmWireApi
  reasoningDialect?: import('../services/llm/types').ReasoningDialect
  stream?: boolean
  providerType?: string
  enableVision?: boolean
  enableAudioInput?: boolean
}

/** 更新模型配置输入 (所有字段可选) */
export interface UpdateModelInput {
  name?: string
  provider?: string
  modelId?: string
  apiKey?: string
  apiBase?: string
  providerConnectionId?: string | null
  connectionOverride?: boolean
  connectionProtocol?: 'openai' | 'anthropic' | 'gemini' | null
  connectionAuthMode?: 'api_key' | 'none'
  temperature?: number | null
  topP?: number | null
  maxTokens?: number | null
  contextWindowTokens?: number | null
  maxReActTurns?: number | null
  reasoningEffort?: ReasoningEffort | null
  returnNativeReasoning?: boolean
  wireApi?: import('../services/llm/types').LlmWireApi
  reasoningDialect?: import('../services/llm/types').ReasoningDialect
  stream?: boolean
  providerType?: string
  enableVision?: boolean
  enableAudioInput?: boolean
}

// Drizzle 推导行类型
type ModelConfigRow = typeof aiModelConfigs.$inferSelect

// ─────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────

export class ModelRepository {
  readonly connections: ProviderConnectionRepository

  constructor(private db: DrizzleDb) {
    this.connections = new ProviderConnectionRepository(db)
  }

  /** 列出所有模型配置 */
  async findAll(): Promise<ModelConfigRow[]> {
    return this.db.select().from(aiModelConfigs).all()
  }

  /** 根据 ID 查找 */
  async findById(id: number): Promise<ModelConfigRow | undefined> {
    return this.db.select().from(aiModelConfigs).where(eq(aiModelConfigs.id, id)).get()
  }

  /** 创建模型配置 */
  async create(
    data: CreateModelInput,
    options: { selectMainIfFirst?: boolean } = {},
  ): Promise<ModelConfigRow> {
    const now = new Date().toISOString()
    return this.db.transaction((transaction) => {
      const first =
        options.selectMainIfFirst &&
        !transaction.select({ id: aiModelConfigs.id }).from(aiModelConfigs).limit(1).get()
      const rows = transaction
        .insert(aiModelConfigs)
        .values({
          name: data.name,
          provider: data.provider,
          modelId: data.modelId,
          apiKey: data.apiKey,
          apiBase: data.apiBase,
          providerConnectionId: data.providerConnectionId,
          connectionOverride: data.connectionOverride ?? false,
          connectionProtocol: data.connectionProtocol,
          connectionAuthMode: data.connectionAuthMode ?? 'api_key',
          temperature: data.temperature ?? null,
          topP: data.topP ?? null,
          maxTokens: data.maxTokens ?? null,
          contextWindowTokens: data.contextWindowTokens ?? null,
          maxReActTurns: data.maxReActTurns ?? null,
          reasoningEffort: data.reasoningEffort ?? null,
          returnNativeReasoning: data.returnNativeReasoning ?? false,
          wireApi: data.wireApi ?? 'chat_completions',
          reasoningDialect: data.reasoningDialect ?? 'auto',
          stream: data.stream ?? true,
          providerType: data.providerType ?? 'global',
          enableVision: data.enableVision ?? false,
          enableAudioInput: data.enableAudioInput ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all()
      const model = rows[0]!
      if (first) {
        // 与模型创建共用事务，避免并发首次创建或保存失败留下半份配置。
        transaction
          .insert(configs)
          .values({ key: 'model.main', value: String(model.id) })
          .onConflictDoUpdate({
            target: configs.key,
            set: { value: String(model.id), updatedAt: now },
            setWhere: sql`trim(${configs.value}) = ''`,
          })
          .run()
      }
      return model
    })
  }

  /** 更新模型配置 */
  async update(id: number, data: UpdateModelInput): Promise<ModelConfigRow | undefined> {
    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    }
    if (data.name !== undefined) updates.name = data.name
    if (data.provider !== undefined) updates.provider = data.provider
    if (data.modelId !== undefined) updates.modelId = data.modelId
    if (data.apiKey !== undefined) updates.apiKey = data.apiKey
    if (data.apiBase !== undefined) updates.apiBase = data.apiBase
    if (data.temperature !== undefined) updates.temperature = data.temperature
    if (data.topP !== undefined) updates.topP = data.topP
    if (data.maxTokens !== undefined) updates.maxTokens = data.maxTokens
    if (data.maxReActTurns !== undefined) updates.maxReActTurns = data.maxReActTurns
    if (data.contextWindowTokens !== undefined)
      updates.contextWindowTokens = data.contextWindowTokens
    if (data.reasoningEffort !== undefined) updates.reasoningEffort = data.reasoningEffort
    if (data.returnNativeReasoning !== undefined)
      updates.returnNativeReasoning = data.returnNativeReasoning
    if (data.wireApi !== undefined) updates.wireApi = data.wireApi
    if (data.reasoningDialect !== undefined) updates.reasoningDialect = data.reasoningDialect
    if (data.stream !== undefined) updates.stream = data.stream
    if (data.providerType !== undefined) updates.providerType = data.providerType
    if (data.providerConnectionId !== undefined)
      updates.providerConnectionId = data.providerConnectionId
    if (data.connectionOverride !== undefined) updates.connectionOverride = data.connectionOverride
    if (data.connectionProtocol !== undefined) updates.connectionProtocol = data.connectionProtocol
    if (data.connectionAuthMode !== undefined) updates.connectionAuthMode = data.connectionAuthMode
    if (data.enableAudioInput !== undefined) updates.enableAudioInput = data.enableAudioInput
    if (data.enableVision !== undefined) updates.enableVision = data.enableVision

    await this.db.update(aiModelConfigs).set(updates).where(eq(aiModelConfigs.id, id))

    return this.findById(id)
  }

  /** 删除模型配置 */
  async deleteById(id: number): Promise<boolean> {
    const result = await this.db.delete(aiModelConfigs).where(eq(aiModelConfigs.id, id))
    return (result as unknown as { changes: number }).changes > 0
  }
}
