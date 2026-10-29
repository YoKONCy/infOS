import { t as __t } from '../../lib/i18n'
/**
 * 模型配置 Service
 *
 * AI 模型配置的业务编排层。
 * 封装 CRUD + API Key 遮蔽 + 连通性测试 + 缓存失效。
 *
 * @module packages/backend/src/services/model/modelService
 */

import type {
  ModelRepository,
  CreateModelInput,
  UpdateModelInput,
} from '../../repositories/model.repo'
import type { LlmService } from '../llm/llmService'
import type { ModelRegistry } from '../llm/modelRegistry'
import { AppError } from '../../lib/appError'
import { createLogger } from '../../lib/logger'
import type { ConfigRepository } from '../../repositories/config.repo'
import { modelFallbackIds, modelFallbackKey } from '../llm/modelFallbacks'
import { ProviderConnectionService } from './providerConnectionService'

const logger = createLogger('ModelService')

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

/** 模型配置 DTO (API Key 已遮蔽) */
export interface ModelConfigDto {
  id: number
  name: string
  modelId: string
  provider: string | null
  providerType: string | null
  apiKey: string
  apiBase: string | null
  temperature: number | null
  topP: number | null
  maxTokens: number | null
  maxReActTurns: number | null
  reasoningEffort: string | null
  returnNativeReasoning: boolean
  wireApi: string
  reasoningDialect: string
  stream: boolean
  createdAt: string | null
  updatedAt: string | null
  [key: string]: unknown
}

/** 连通性测试结果 */
export interface TestResult {
  success: boolean
  durationMs: number
  response?: string
  error?: string
}

// ─────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────

/** 遮蔽 API Key (保留前4后4) */
function maskKey(key: string | null): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

export class ModelService {
  readonly providers: ProviderConnectionService

  constructor(
    private modelRepo: ModelRepository,
    private llmService: LlmService,
    private modelRegistry: ModelRegistry,
    private configRepo?: ConfigRepository,
  ) {
    this.providers = new ProviderConnectionService(modelRepo, llmService, modelRegistry)
  }

  private async validateConnection(data: {
    providerConnectionId?: string | null
    connectionOverride?: boolean
    apiBase?: string | null
  }): Promise<void> {
    if (!data.providerConnectionId) return
    await this.providers.get(data.providerConnectionId)
    if (!data.connectionOverride) return
    try {
      const url = new URL(data.apiBase ?? '')
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('无效地址')
    } catch {
      throw new AppError('VALIDATION_ERROR', {
        message: '独立覆盖需要完整的 HTTP/HTTPS API 地址；不会从连接补齐地址或密钥',
      })
    }
  }

  async getFallbacks(id: number): Promise<{ modelIds: number[] }> {
    if (!(await this.modelRepo.findById(id)))
      throw new AppError('MODEL_NOT_FOUND', { message: '模型配置不存在' })
    return { modelIds: modelFallbackIds(await this.configRepo?.get(modelFallbackKey(id)), id) }
  }

  async setFallbacks(id: number, modelIds: number[]): Promise<{ modelIds: number[] }> {
    if (!this.configRepo)
      throw new AppError('CONFIG_ERROR', { message: '模型回退配置服务尚未就绪' })
    if (
      modelIds.length > 32 ||
      modelIds.some((value) => !Number.isSafeInteger(value) || value <= 0)
    )
      throw new AppError('VALIDATION_ERROR', {
        message: '回退模型必须为有效模型卡片，最多配置 32 级回退',
      })
    if (!(await this.modelRepo.findById(id)))
      throw new AppError('MODEL_NOT_FOUND', { message: '模型配置不存在' })
    if (modelIds.includes(id) || new Set(modelIds).size !== modelIds.length)
      throw new AppError('VALIDATION_ERROR', { message: '回退模型不能包含自身或重复模型' })
    for (const candidate of modelIds)
      if (!(await this.modelRepo.findById(candidate)))
        throw new AppError('MODEL_NOT_FOUND', { message: `回退模型 ${candidate} 不存在` })
    await this.configRepo.set(modelFallbackKey(id), JSON.stringify(modelIds))
    this.modelRegistry.invalidateCache()
    logger.info(__t('logs.model', '模型多级回退顺序已更新'), {
      modelConfigId: id,
      fallbackModelIds: modelIds,
    })
    return { modelIds }
  }

  /** 将数据库可空默认值归一为API契约。 */
  private toDto(
    model: NonNullable<Awaited<ReturnType<ModelRepository['findById']>>>,
  ): ModelConfigDto {
    return {
      ...model,
      returnNativeReasoning: model.returnNativeReasoning ?? false,
      wireApi: model.wireApi ?? 'chat_completions',
      reasoningDialect: model.reasoningDialect ?? 'auto',
      stream: model.stream ?? true,
      apiKey: maskKey(model.apiKey),
    }
  }

  /** 列出所有模型配置 (API Key 遮蔽) */
  async list(): Promise<ModelConfigDto[]> {
    const models = await this.modelRepo.findAll()
    return models.map((model) => this.toDto(model))
  }

  /** 获取单个模型配置；编辑页需要回填完整密钥，列表接口仍保持遮蔽。 */
  async getById(id: number): Promise<ModelConfigDto> {
    const model = await this.modelRepo.findById(id)
    if (!model) {
      throw new AppError('MODEL_NOT_FOUND', {
        message: `未找到 ID 为 ${id} 的模型配置`,
        data: { modelId: id },
      })
    }
    return {
      ...this.toDto(model),
      apiKey: model.apiKey ?? '',
    }
  }

  /** 创建模型配置 */
  async create(data: CreateModelInput): Promise<ModelConfigDto> {
    await this.validateConnection(data)
    const model = await this.modelRepo.create(data, { selectMainIfFirst: true })
    this.modelRegistry.invalidateCache()
    logger.info(__t('logs.model', '模型配置已创建: {0} ({1})', [model.name, model.id]))
    return this.toDto(model)
  }

  /** 更新模型配置 */
  async update(id: number, data: UpdateModelInput): Promise<ModelConfigDto> {
    // 检查是否存在
    const existing = await this.modelRepo.findById(id)
    if (!existing) {
      throw new AppError('MODEL_NOT_FOUND', {
        message: `未找到 ID 为 ${id} 的模型配置`,
        data: { modelId: id },
      })
    }

    await this.validateConnection({ ...existing, ...data })
    const updated = await this.modelRepo.update(id, data)
    this.modelRegistry.invalidateCache()
    logger.info(__t('logs.model', '模型配置已更新: {0}', [id]))
    return this.toDto(updated!)
  }

  /** 删除模型配置 */
  async delete(id: number): Promise<void> {
    const existing = await this.modelRepo.findById(id)
    if (!existing) {
      throw new AppError('MODEL_NOT_FOUND', {
        message: `未找到 ID 为 ${id} 的模型配置`,
        data: { modelId: id },
      })
    }
    await this.modelRepo.deleteById(id)
    if (this.configRepo) {
      await this.configRepo.delete(modelFallbackKey(id))
      for (const entry of await this.configRepo.listAll('model.fallbacks.')) {
        const root = Number(entry.key.slice('model.fallbacks.'.length))
        const ids = modelFallbackIds(entry.value, root)
        if (ids.includes(id))
          await this.configRepo.set(entry.key, JSON.stringify(ids.filter((value) => value !== id)))
      }
    }
    this.modelRegistry.invalidateCache()
    logger.info(__t('logs.model', '模型配置已删除: {0} ({1})', [existing.name, id]))
  }

  /**
   * 获取远程模型列表
   *
   * 通过 provider + apiKey + apiBase 向远程 API 查询可用模型 ID 列表。
   */
  async listRemoteModels(params: {
    provider: string
    apiKey: string
    apiBase?: string
    protocol?: 'openai' | 'anthropic' | 'gemini'
    providerConnectionId?: string
    connectionOverride?: boolean
  }): Promise<string[]> {
    if (params.providerConnectionId && !params.connectionOverride) {
      return this.providers.listModels(params.providerConnectionId)
    }
    const results = await this.llmService.listModels({
      provider: params.provider,
      protocol: params.protocol,
      modelId: '', // listModels 不需要具体 modelId
      apiKey: params.apiKey,
      apiBase: params.apiBase,
    })
    return results
  }

  /** 测试模型连通性 */
  async test(id: number): Promise<TestResult> {
    const model = await this.modelRepo.findById(id)
    if (!model) {
      throw new AppError('MODEL_NOT_FOUND', {
        message: `未找到 ID 为 ${id} 的模型配置`,
        data: { modelId: id },
      })
    }

    try {
      const startTime = Date.now()
      const resolved = await this.modelRegistry.getById(id)
      if (!resolved) throw new AppError('MODEL_NOT_FOUND', { message: '模型配置不存在' })
      const response = await this.llmService.chat(
        {
          ...resolved,
          fallbackModels: [],
        },
        [{ role: 'user', content: '请只回复 OK。' }],
      )
      const durationMs = Date.now() - startTime

      return {
        success: true,
        durationMs,
        response: response.choices[0]?.message?.content?.slice(0, 50),
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      throw new AppError('LLM_ERROR', {
        message: `模型测试失败: ${errMsg}`,
        data: { success: false, error: errMsg },
      })
    }
  }
}
