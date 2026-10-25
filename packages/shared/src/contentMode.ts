/** 全局健全模式；未配置时默认启用。 */
export const WHOLESOME_MODE_KEY = 'system.wholesomeMode'

/** 全局回答预填充；开关与正文作为同一份配置保存，未配置时关闭。 */
export const ASSISTANT_PREFILL_KEY = 'system.assistantPrefill'
export const MAX_ASSISTANT_PREFILL_LENGTH = 8000

export interface AssistantPrefillConfig {
  enabled: boolean
  content: string
  mode?: 'once' | 'continuous'
}

/** 编译器固定的本轮请求策略，不属于对话历史或 Provider 参数。 */
export interface CompiledPromptPlan {
  assistantPrefill?: { content: string; mode: 'once' | 'continuous'; source: string }
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
