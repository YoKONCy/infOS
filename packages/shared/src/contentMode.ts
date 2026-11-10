/** 全局健全模式；未配置时默认启用。 */
export const WHOLESOME_MODE_KEY = 'system.wholesomeMode'

/** 全局回答预填充；开关与正文作为同一份配置保存，未配置时关闭。 */
export const ASSISTANT_PREFILL_KEY = 'system.assistantPrefill'
export const MAX_ASSISTANT_PREFILL_LENGTH = 8000

/** 动态资料按稳定用户消息定位，0 贴近当前输入，1 前移到上一条输入。 */
export const DYNAMIC_CONTEXT_DEPTH_KEY = 'system.dynamicContextDepth'
export type DynamicContextDepth = 0 | 1

export function parseDynamicContextDepth(value?: string | null): DynamicContextDepth {
  return value === '1' ? 1 : 0
}

export interface AssistantPrefillConfig {
  enabled: boolean
  content: string
  mode?: 'once' | 'continuous'
}

/** 编译器固定的本轮请求策略，不属于对话历史或 Provider 参数。 */
export interface CompiledPromptPlan {
  assistantPrefill?: {
    content: string
    mode: 'once' | 'continuous'
    source: string
    /** 按模型能力确定的发送方式；未确定前（编译阶段）为空。 */
    protocol?: import('./assistantPrefill').AssistantPrefillProtocol
  }
  /** 用户开启了预填充，但当前模型组合不支持；请求与输出拼接都不再使用。 */
  assistantPrefillSkipped?: { reason: import('./assistantPrefill').AssistantPrefillSkipReason }
  dynamicContextDepth?: DynamicContextDepth
}

export function isAssistantPrefillConfig(value: unknown): value is AssistantPrefillConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  return (
    typeof config.enabled === 'boolean' &&
    typeof config.content === 'string' &&
    config.content.length <= MAX_ASSISTANT_PREFILL_LENGTH &&
    (config.mode === undefined || config.mode === 'once' || config.mode === 'continuous')
  )
}

/** 保留用户填写的空白和标签；无效配置不能自动开启预填充。 */
export function parseAssistantPrefillConfig(value?: string | null): AssistantPrefillConfig {
  try {
    const config: unknown = JSON.parse(value ?? '')
    if (isAssistantPrefillConfig(config))
      return { enabled: config.enabled, content: config.content, mode: config.mode ?? 'once' }
  } catch {
    /* 未配置或旧配置无效时使用关闭状态。 */
  }
  return { enabled: false, content: '', mode: 'once' }
}
