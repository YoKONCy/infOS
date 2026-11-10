import { t as __t } from '../../lib/i18n'
/**
 * imageUnderstandingService — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import type { ConfigRepository } from '../../repositories/config.repo'
import type { ModelRepository } from '../../repositories/model.repo'
import type { LlmService, ModelConfig } from '../llm/llmService'
import type { ContentPart } from '../llm/types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('ImageUnderstandingService')

export type ImageUnderstandingMode = 'auto' | 'native' | 'relay'
export type TranscriptionDetail = 'brief' | 'standard' | 'detailed'

export interface ImageTranscription {
  summary: string
  modelId: string
}

/**
 * 图片理解服务。
 *
 * 原图仅用于当前轮理解；返回的文字可持久化到 Thread。
 * 历史默认加载文字和来源，回看原图由 read_image 显式发起。
 */
export class ImageUnderstandingService {
  constructor(
    private readonly configRepo: ConfigRepository,
    private readonly modelRepo: ModelRepository,
    private readonly llmService: LlmService,
  ) {}

  async getConfig(): Promise<{
    enabled: boolean
    modelConfigId: number | null
    detail: TranscriptionDetail
    available: boolean
  }> {
    const enabled = (await this.configRepo.get('multimodalRelay.enabled')) === 'true'
    const rawId = await this.configRepo.get('multimodalRelay.modelConfigId')
    const modelConfigId = rawId && Number.isInteger(Number(rawId)) ? Number(rawId) : null
    const detailValue = await this.configRepo.get('multimodalRelay.detail')
    const detail: TranscriptionDetail =
      detailValue === 'brief' || detailValue === 'detailed' ? detailValue : 'standard'
    const model = modelConfigId ? await this.modelRepo.findById(modelConfigId) : undefined
    return { enabled, modelConfigId, detail, available: enabled && model?.enableVision === true }
  }

  async transcribe(
    images: Array<{ mimeType: string; bytes: Buffer; name?: string }>,
    signal?: AbortSignal,
    agentId?: string,
  ): Promise<ImageTranscription | null> {
    signal?.throwIfAborted()
    if (!images.length) return null
    const settings = await this.getConfig()
    if (!settings.available || settings.modelConfigId === null) return null
    const row = await this.modelRepo.findById(settings.modelConfigId)
    if (!row?.enableVision) return null

    const labels = images.map((image, index) => `${index + 1}. ${image.name ?? '图片'}`).join('\n')
    const detailPrompt: Record<TranscriptionDetail, string> = {
      brief: '用一到三句话概括图片主体与最关键的信息。',
      standard: '描述图片主体、界面状态、关键细节与清晰可见的文字。',
      detailed: '尽可能完整描述布局、对象关系、界面状态、错误信息和可见文字；不确定处要明确说明。',
    }
    const content: ContentPart[] = [
      {
        type: 'text',
        text: __t('server.attachment', '图片列表：\n{0}', [labels]),
      },
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: {
          url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`,
          detail: 'auto',
        },
      })),
    ]

    try {
      const response = await this.llmService.chat(
        this.toModelConfig(row),
        [{ role: 'user', content }],
        {
          signal,
          promptTask: 'vision.describe',
          promptVariables: { detail: detailPrompt[settings.detail] },
          usageContext: { agentId, purpose: 'vision' },
          temperature: 0.2,
          maxTokens:
            settings.detail === 'detailed' ? 1800 : settings.detail === 'brief' ? 400 : 900,
        },
      )
      const summary = response.choices[0]?.message.content?.trim()
      return summary ? { summary, modelId: row.modelId } : null
    } catch (error) {
      signal?.throwIfAborted()
      logger.warn(
        __t('logs.attachment', '图片转述失败: {0}', [
          error instanceof Error ? error.message : String(error),
        ]),
      )
      return null
    }
  }

  private toModelConfig(
    row: NonNullable<Awaited<ReturnType<ModelRepository['findById']>>>,
  ): ModelConfig {
    return {
      provider: row.provider ?? 'openai',
      modelId: row.modelId,
      apiKey: row.apiKey ?? '',
      apiBase: row.apiBase ?? undefined,
      temperature: row.temperature ?? undefined,
      topP: row.topP ?? undefined,
      maxTokens: row.maxTokens ?? undefined,
      contextWindowTokens: row.contextWindowTokens ?? undefined,
      reasoningEffort: (row.reasoningEffort as ModelConfig['reasoningEffort']) ?? undefined,
      returnNativeReasoning: row.returnNativeReasoning ?? false,
      wireApi: (row.wireApi as ModelConfig['wireApi']) ?? 'chat_completions',
      reasoningDialect: (row.reasoningDialect as ModelConfig['reasoningDialect']) ?? 'auto',
      assistantPrefill: (row.assistantPrefill as ModelConfig['assistantPrefill']) ?? 'auto',
      enableVision: true,
    }
  }
}
