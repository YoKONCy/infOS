/**
 * 回答预填充能力判断
 *
 * 预填充依赖上游把末尾 assistant 当作“同一条回复的开头”继续写；这不是各接口共有的合同。
 * 本模块只做本地静态判断，不发探测请求。后端执行计划与前端模型编辑界面共用同一份规则。
 */

/** 模型卡片上的能力声明；auto 由协议、接口、模型与思考状态共同判断。 */
export type AssistantPrefillSupport = 'auto' | 'supported' | 'unsupported'
export const ASSISTANT_PREFILL_SUPPORT_VALUES = ['auto', 'supported', 'unsupported'] as const

/** 实际发送方式：普通末尾 assistant，或 DeepSeek Beta 的 prefix:true。 */
export type AssistantPrefillProtocol = 'assistant_tail' | 'deepseek_prefix'

/** 本次不发送预填充的原因；作为稳定代码在展示边界本地化。 */
export type AssistantPrefillSkipReason =
  | 'user_disabled'
  | 'claude_thinking'
  | 'claude_prefill_removed'
  | 'gemini_unknown'
  | 'openai_responses'
  | 'openai_chat'
  | 'deepseek_no_beta'
  | 'deepseek_thinking'
  | 'fallback_unsupported'

export type AssistantPrefillDecision =
  | { enabled: true; protocol: AssistantPrefillProtocol }
  | { enabled: false; reason: AssistantPrefillSkipReason }

/** 判断所需的模型连接事实；字段与后端 ModelConfig 同名，前端表单也可直接传入。 */
export interface AssistantPrefillTarget {
  provider?: string
  protocol?: 'openai' | 'anthropic' | 'gemini' | null
  modelId?: string
  apiBase?: string | null
  wireApi?: 'chat_completions' | 'responses' | null
  reasoningDialect?: 'auto' | 'openai' | 'deepseek' | 'openrouter' | 'generic' | null
  reasoningEffort?: string | null
  assistantPrefill?: AssistantPrefillSupport | null
}

/** 与 OpenAI 兼容 Provider 相同的方言识别：显式配置优先，否则按地址推断。 */
export function resolveReasoningDialect(
  configured: AssistantPrefillTarget['reasoningDialect'],
  apiBase: string | null | undefined,
): 'openai' | 'deepseek' | 'openrouter' | 'generic' {
  if (configured && configured !== 'auto') return configured
  const base = (apiBase ?? '').toLowerCase()
  if (base.includes('deepseek')) return 'deepseek'
  if (base.includes('openrouter')) return 'openrouter'
  if (base.includes('openai.com')) return 'openai'
  return 'generic'
}

/**
 * Anthropic 官方说明 4.6 及之后的 Claude（含 Opus/Sonnet/Haiku 5 系列、Fable、Mythos）
 * 对末尾 assistant 预填充返回 400，与是否开启思考无关。名称允许中转常见的前缀和点号写法。
 */
const CLAUDE_PREFILL_REMOVED =
  /claude[-_.]?(?:(?:opus|sonnet|haiku)[-_.](?:4[-_.][6-9]|[5-9])(?![0-9])|fable|mythos)|mythos/i

function anthropicProtocol(target: AssistantPrefillTarget): boolean {
  const protocol = target.protocol ?? target.provider
  return protocol === 'anthropic' || protocol === 'claude'
}

function thinkingRequested(target: AssistantPrefillTarget): boolean {
  return !!target.reasoningEffort && target.reasoningEffort !== 'off'
}

function deepseekDialect(target: AssistantPrefillTarget): boolean {
  return (
    target.provider === 'deepseek' ||
    resolveReasoningDialect(target.reasoningDialect, target.apiBase) === 'deepseek'
  )
}

/** 解析单个模型的预填充能力；只做本地判断，不访问网络。 */
export function resolveAssistantPrefillCapability(
  target: AssistantPrefillTarget,
): AssistantPrefillDecision {
  const declared = target.assistantPrefill ?? 'auto'
  if (declared === 'unsupported') return { enabled: false, reason: 'user_disabled' }
  const protocol = target.protocol ?? target.provider
  const openAiChat =
    !anthropicProtocol(target) && protocol !== 'gemini' && target.wireApi !== 'responses'
  // 显式声明支持时仍按接口选择正确的发送字段，避免对 DeepSeek 只发普通 assistant。
  const preferredProtocol: AssistantPrefillProtocol =
    openAiChat && deepseekDialect(target) ? 'deepseek_prefix' : 'assistant_tail'
  if (declared === 'supported') return { enabled: true, protocol: preferredProtocol }

  if (anthropicProtocol(target)) {
    if (CLAUDE_PREFILL_REMOVED.test(target.modelId ?? ''))
      return { enabled: false, reason: 'claude_prefill_removed' }
    if (thinkingRequested(target)) return { enabled: false, reason: 'claude_thinking' }
    return { enabled: true, protocol: 'assistant_tail' }
  }
  if (protocol === 'gemini') return { enabled: false, reason: 'gemini_unknown' }
  if (target.wireApi === 'responses') return { enabled: false, reason: 'openai_responses' }
  if (deepseekDialect(target)) {
    // 官方前缀续写只在 /beta 地址提供；仅改名或走普通地址不满足合同。
    if (!/\/beta(?:\/|$)/i.test(target.apiBase ?? ''))
      return { enabled: false, reason: 'deepseek_no_beta' }
    if (thinkingRequested(target) || /reasoner/i.test(target.modelId ?? ''))
      return { enabled: false, reason: 'deepseek_thinking' }
    return { enabled: true, protocol: 'deepseek_prefix' }
  }
  return { enabled: false, reason: 'openai_chat' }
}

/**
 * 主模型与回退链共用一份请求计划：任一模型不支持或发送方式不同，整份计划不发送预填充，
 * 避免回退后请求与输出拼回各走一套。
 */
export function resolveAssistantPrefillForChain(
  targets: AssistantPrefillTarget[],
): AssistantPrefillDecision {
  const [primary, ...fallbacks] = targets
  if (!primary) return { enabled: false, reason: 'openai_chat' }
  const first = resolveAssistantPrefillCapability(primary)
  if (!first.enabled) return first
  for (const target of fallbacks) {
    const next = resolveAssistantPrefillCapability(target)
    if (!next.enabled || next.protocol !== first.protocol)
      return { enabled: false, reason: 'fallback_unsupported' }
  }
  return first
}
