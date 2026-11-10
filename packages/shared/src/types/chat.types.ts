/**
 * 聊天系统类型定义
 *
 * @module packages/shared/src/types/chat.types
 */

/** 对话角色 */
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

/** 对话日志数据传输对象 */
export interface ConversationLogDto {
  id: number
  sessionId: string
  source: string
  role: ChatRole
  content: string
  timestamp: string
  pairId: string | null
  sentiment: string | null
  importance: number | null
  agentId: string
}

/** Scorer 分析状态 */
export type AnalysisStatus = 'pending' | 'processing' | 'completed' | 'failed'

/** AI 模型配置传输对象 */
export interface AiModelConfigDto {
  id: number
  name: string
  modelId: string
  provider: string
  providerType: 'global' | 'custom'
  temperature: number | null
  topP: number | null
  maxTokens: number | null
  contextWindowTokens: number | null
  maxReActTurns?: number | null
  returnNativeReasoning: boolean
  wireApi: 'chat_completions' | 'responses'
  reasoningDialect: 'auto' | 'openai' | 'deepseek' | 'openrouter' | 'generic'
  /** 回答预填充能力声明；auto 由本地规则判断。 */
  assistantPrefill?: 'auto' | 'supported' | 'unsupported'
  stream: boolean
  enableVision: boolean
  enableAudioInput: boolean
  enableVoice: boolean
  enableVideo: boolean
}
