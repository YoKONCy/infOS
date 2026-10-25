import {
  normalizeReasoningEffort,
  nativeAudioEnabled,
  type ReasoningEffort,
  type ThreadModelSettings,
} from '@infos/shared'
import type { ThreadRepository } from '../../repositories/thread.repo'
import type { ModelRepository } from '../../repositories/model.repo'
import type { ModelRoleResolver } from '../llm/modelRoles'
import type { ModelConfig } from '../llm/llmService'
import { AppError } from '../../lib/appError'

export class ThreadModelService {
  constructor(
    private threads: ThreadRepository,
    private models: ModelRepository,
    private roles: ModelRoleResolver,
  ) {}

  private async thread(id: string) {
    const thread = await this.threads.getThread(id)
    if (!thread) throw new AppError('NOT_FOUND', { message: '会话不存在' })
    return thread
  }

  async settings(threadId: string): Promise<ThreadModelSettings> {
    const thread = await this.thread(threadId)
    const models = await this.models.findAll()
    const config =
      thread.modelConfigId != null
        ? await this.roles.resolveById(thread.modelConfigId)
        : await this.roles.resolve('main')
    const row = models.find((item) => item.id === (thread.modelConfigId ?? config?.configId))
    const modelId = row?.modelId ?? config?.modelId ?? ''
    const inheritedEffort =
      (row?.reasoningEffort as ReasoningEffort | null | undefined) ?? config?.reasoningEffort
    return {
      threadId,
      modelConfigId: thread.modelConfigId ?? null,
      reasoningEffort: normalizeReasoningEffort(modelId, thread.reasoningEffort) ?? null,
      effective: {
        name: row?.name ?? modelId,
        modelId,
        reasoningEffort:
          normalizeReasoningEffort(modelId, thread.reasoningEffort ?? inheritedEffort) ?? null,
        enableVision: row?.enableVision ?? config?.enableVision ?? false,
        enableAudioInput: row?.enableAudioInput ?? config?.enableAudioInput ?? false,
        nativeAudioAvailable: nativeAudioEnabled(config),
      },
      models: models.map((item) => ({
        id: item.id,
        name: item.name,
        modelId: item.modelId,
        reasoningEffort: item.reasoningEffort as ReasoningEffort | null,
      })),
    }
  }

  async update(
    threadId: string,
    input: { modelConfigId: number | null; reasoningEffort: ReasoningEffort | null },
  ) {
    const thread = await this.thread(threadId)
    if (thread.channel !== 'desktop' || (thread.purpose ?? 'conversation') !== 'conversation')
      throw new AppError('INVALID_PARAMETER', { message: '仅支持普通聊天会话' })
    const row =
      input.modelConfigId === null ? null : await this.models.findById(input.modelConfigId)
    if (input.modelConfigId !== null && !row)
      throw new AppError('NOT_FOUND', { message: '模型卡片已删除，请重新选择' })
    const main = row ? null : await this.roles.resolve('main')
    const settings = {
      modelConfigId: input.modelConfigId,
      reasoningEffort:
        normalizeReasoningEffort(row?.modelId ?? main?.modelId ?? '', input.reasoningEffort) ??
        null,
    }
    if (!(await this.threads.updateModelSettings(threadId, settings)))
      throw new AppError('NOT_FOUND', { message: '会话不存在' })
    return this.settings(threadId)
  }

  /** 仅普通桌面对话使用会话配置；委派任务的明确模型选择保持优先。 */
  async resolve(
    threadId: string,
    agentId: string,
    explicitModelId?: number,
  ): Promise<ModelConfig | null> {
    if (explicitModelId !== undefined) return this.roles.resolveById(explicitModelId)
    const thread = await this.thread(threadId)
    if (thread.channel !== 'desktop' || (thread.purpose ?? 'conversation') !== 'conversation')
      return this.roles.resolveAgent(agentId)
    const config =
      thread.modelConfigId == null
        ? await this.roles.resolve('main')
        : await this.roles.resolveById(thread.modelConfigId)
    if (!config) return null
    const apply = (model: ModelConfig): ModelConfig => ({
      ...model,
      usageAgentId: agentId,
      reasoningEffort: normalizeReasoningEffort(
        model.modelId,
        thread.reasoningEffort ?? model.reasoningEffort,
      ),
      fallbackModels: model.fallbackModels?.map(apply),
    })
    return apply(config)
  }
}
