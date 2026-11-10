/**
 * Model API 模块
 *
 */

import { apiClient } from '../client'
import type { ReasoningEffort } from '@infos/shared'
export type { ReasoningEffort } from '@infos/shared'

/** 模型配置项 */
export interface ModelConfigItem {
  id: string
  name: string
  provider: string
  modelId: string
  apiKey: string
  apiBase?: string
  providerConnectionId?: string | null
  connectionOverride?: boolean
  connectionProtocol?: 'openai' | 'anthropic' | 'gemini' | null
  connectionAuthMode?: 'api_key' | 'none'
  temperature: number | null
  topP: number | null
  maxTokens: number | null
  contextWindowTokens: number | null
  maxReActTurns?: number | null
  reasoningEffort: ReasoningEffort | null
  returnNativeReasoning: boolean
  wireApi: 'chat_completions' | 'responses'
  reasoningDialect: 'auto' | 'openai' | 'deepseek' | 'openrouter' | 'generic'
  assistantPrefill?: 'auto' | 'supported' | 'unsupported'
  stream: boolean
  providerType?: string
  enableVision?: boolean
  /** 声明模型支持原生音频输入（非 ASR） */
  enableAudioInput?: boolean
  isDefault?: boolean
}

export const modelApi = {
  getFallbacks: (id: string) => apiClient.get<{ modelIds: number[] }>(`/models/${id}/fallbacks`),
  setFallbacks: (id: string, modelIds: number[]) =>
    apiClient.put<{ modelIds: number[] }>(`/models/${id}/fallbacks`, { modelIds }),
  /** 获取所有模型配置 */
  list: () => apiClient.get<ModelConfigItem[]>('/models'),

  /** 获取单个模型配置 */
  getById: (id: string) => apiClient.get<ModelConfigItem>(`/models/${id}`),

  /** 创建模型配置 */
  create: (data: Omit<ModelConfigItem, 'id'>) => apiClient.post<ModelConfigItem>('/models', data),

  /** 更新模型配置 */
  update: (id: string, data: Partial<ModelConfigItem>) =>
    apiClient.put<ModelConfigItem>(`/models/${id}`, data),

  /** 删除模型配置 */
  remove: (id: string) => apiClient.delete(`/models/${id}`),

  /** 测试模型连通性 */
  test: (id: string) =>
    apiClient.post<{ success: boolean; durationMs: number; response?: string }>(
      `/models/${id}/test`,
    ),

  /** 获取远程模型列表 */
  listRemote: (params: {
    provider: string
    apiKey: string
    apiBase?: string
    protocol?: 'openai' | 'anthropic' | 'gemini'
    providerConnectionId?: string
    connectionOverride?: boolean
  }) => apiClient.post<string[]>('/models/list-remote', params),
}
