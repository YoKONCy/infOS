/**
 * LLM 类型定义
 *
 * 统一的消息格式和 Provider 接口。
 * 所有 Provider 的输出统一转换为 OpenAI 格式。
 *
 * @module packages/backend/src/services/llm/types
 */

import type { ReasoningEffort } from '@infos/shared'

// ─────────────────────────────────────────────
// 消息类型 (以 OpenAI 格式为基准)
// ─────────────────────────────────────────────

/** 聊天消息 */
export interface ChatMessage {
  /** 编译产物随检查点保留；各 Provider 仅序列化消息协议字段。 */
  promptPlan?: import('@infos/shared').CompiledPromptPlan
  promptSegment?: 'assistant_prefill'
  /** 本地文件事实，Provider 不序列化；检查点与跨轮投影使用同一来源。 */
  fileObservations?: import('../context/fileWorkingContext').FileObservation[]
  toolExecutionFailed?: boolean
  /** 本地缓存锚点，Provider 序列化时不发送。 */
  cacheControl?: {
    kind: 'history' | 'snapshot' | 'current'
    key?: string
    reply?: string
    currentKeys?: string[]
    turnStart?: boolean
    edited?: boolean
    historyMessageId?: number
    historyRevision?: number
    /** 展开的工具轨迹仍归属同一条持久化消息，用于校验热轨迹续接。 */
    historySourceKey?: string
    reasoningModelKey?: string
    pairId?: string
  }
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  /** 推理模型返回的内部思考字段，仅向兼容 Provider 回传。 */
  reasoningContent?: string
  /** Provider原生推理结构，用于跨工具轮无损重放。 */
  nativeReasoning?: NativeReasoningPayload[]
  name?: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

/** 多模态内容部分 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | {
      type: 'input_audio'
      input_audio: { data: string; format: string; mimeType?: string; durationMs?: number }
    }

/** 工具调用 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** 工具定义 (OpenAI function calling 格式) */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// ─────────────────────────────────────────────
// 调用选项
// ─────────────────────────────────────────────

/** 模型推理强度；undefined 表示完全不向 Provider 传参。 */
export type { ReasoningEffort } from '@infos/shared'
export type LlmWireApi = 'chat_completions' | 'responses'
export type ReasoningDialect = 'auto' | 'openai' | 'deepseek' | 'openrouter' | 'generic'

export interface NativeReasoningPayload {
  format: 'reasoning_content' | 'reasoning_details' | 'responses_reasoning'
  text?: string
  opaque?: unknown
}

export interface ChatOptions {
  /** 本地提示词任务标识与模板变量，不发送到 Provider。 */
  promptTask?: string
  promptChannel?: string
  promptVariables?: Record<string, unknown>
  /** 明确来自受管理模板的变量，允许在插入前单独渲染；普通数据不填此项。 */
  promptSources?: string[]
  /** 仅用于本地用量归属，不发送到模型接口。 */
  usageContext?: {
    agentId?: string
    purpose?: import('@infos/shared').TokenUsagePurpose
    channel?: string
    threadId?: string
    applicationId?: string
    executionId?: string
    step?: number
  }
  /** 温度 (0-2) */
  temperature?: number
  /** Top P (0-1) */
  topP?: number
  /** 正文与工具参数输出额度；思考由 Provider 另行预留，不包含在此额度内。 */
  maxTokens?: number
  /** 模型推理强度 */
  reasoningEffort?: ReasoningEffort
  /** 是否请求Provider返回可展示的原生思考摘要。 */
  returnNativeReasoning?: boolean
  /** 工具定义列表 */
  tools?: ToolDefinition[]
  /** 响应格式 (如 json_object) */
  responseFormat?: Record<string, unknown>
  /** 请求超时 (毫秒) */
  timeout?: number
  /** 单次请求总时长，不随流式心跳延长。 */
  totalTimeout?: number
  /** 工具选择策略 */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  /** 停止序列 */
  stop?: string[]
  /** 取消在飞请求的信号 */
  signal?: AbortSignal
  /** 调用方已管理批次恢复时关闭内部重试，避免多层次数相乘。 */
  maxRetries?: number
  /** 仅受控 ReAct 可在清理当前响应草稿后重新请求，普通流式调用默认禁止重放半截输出。 */
  retryPartialResponse?: boolean
  /** 本地重试通知，不发送给 Provider。 */
  onRetry?: (retry: import('@infos/shared').ModelRetryInfo) => void
  /** 每次真实模型尝试前执行通道限流等准入逻辑，重试与回退也不能绕过。 */
  beforeAttempt?: () => Promise<void>
}

// ─────────────────────────────────────────────
// 返回类型
// ─────────────────────────────────────────────

/** Token 使用量 */
export interface UsageInfo {
  inputReported?: boolean
  outputReported?: boolean
  cachedReadTokens?: number
  cachedWriteTokens?: number
  reasoningTokens?: number
  /** 输入 Token 数 */
  promptTokens: number
  /** 输出 Token 数 */
  completionTokens: number
  /** 总 Token 数 */
  totalTokens: number
}

/** 非流式完整回复 */
export interface ChatCompletion {
  choices: Array<{
    message: {
      role: 'assistant'
      content: string | null
      toolCalls?: ToolCall[]
      reasoningContent?: string
      nativeReasoning?: NativeReasoningPayload[]
    }
    finishReason?: string
  }>
  /** Token 用量 */
  usage?: UsageInfo
}

/** 流式增量中的工具调用片段 */
export interface StreamToolCallDelta {
  /** 数组索引 (用于匹配同一工具调用的多个增量) */
  index: number
  /** 调用 ID (仅首次出现时有值) */
  id?: string
  /** 类型 (仅首次出现时有值) */
  type?: 'function'
  /** 函数增量 */
  function?: {
    name?: string
    arguments?: string
  }
}

/** 流式增量 */
export interface ChatDelta {
  /** 本地控制事件，choices 为空；不得作为模型正文序列化。 */
  retry?: import('@infos/shared').ModelRetryInfo
  choices: Array<{
    delta: {
      role?: string
      content?: string
      toolCalls?: StreamToolCallDelta[]
      reasoningContent?: string
      nativeReasoning?: NativeReasoningPayload[]
    }
    finishReason?: string | null
  }>
  /** Token 用量 (部分 Provider 在最后一个 chunk 中包含) */
  usage?: UsageInfo
}

// ─────────────────────────────────────────────
// Provider 接口
// ─────────────────────────────────────────────

/** LLM Provider 接口 */
export interface LlmProvider {
  /** 与真实请求共用序列化逻辑，仅返回会进入模型上下文的字段。 */
  getInputTokenPayload(messages: ChatMessage[], opts: ChatOptions): Record<string, unknown>
  /** 非流式调用 */
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatCompletion>
  /** 流式调用 */
  chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatDelta>
  /** 列出可用模型 */
  listModels(): Promise<string[]>
}

/** Provider 基础配置 */
export interface ProviderConfig {
  /** API Key */
  apiKey: string
  /** API 基址 */
  apiBase: string
  /** 模型 ID */
  modelId: string
  /** 最大 Token 数 (Anthropic 必填) */
  maxTokens?: number
  wireApi?: LlmWireApi
  reasoningDialect?: ReasoningDialect
}
