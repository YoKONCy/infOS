import {
  ASSISTANT_PREFILL_KEY,
  resolveAssistantPrefillForChain,
  type AssistantPrefillConfig,
  type AssistantPrefillTarget,
  type CompiledPromptPlan,
  type DynamicContextDepth,
} from '@infos/shared'
import type { ChatMessage } from '../llm/types'
import { stripBase64DataUris } from '../llm/sanitize'
import { omitPerceptionMessages, redactPerception } from '../conversation/perceptionContext'

export interface ModelRequestSnapshot {
  requestId?: number
  turn: number
  messages: ChatMessage[]
  tools: import('../llm/types').ToolDefinition[]
  prefill?: NonNullable<CompiledPromptPlan['assistantPrefill']>
  /** 用户开启了预填充但当前模型不支持时记录原因，审计与实际请求一致。 */
  prefillSkipped?: NonNullable<CompiledPromptPlan['assistantPrefillSkipped']>
  omitted?: boolean
}

/** 只在上下文编译阶段读取配置，执行阶段复用这份不可变策略。 */
export function compilePromptPlan(
  config: AssistantPrefillConfig,
  dynamicContextDepth: DynamicContextDepth = 0,
): CompiledPromptPlan {
  const plan: CompiledPromptPlan = {}
  if (config.enabled && config.content)
    plan.assistantPrefill = {
      content: config.content,
      mode: config.mode ?? 'once',
      source: ASSISTANT_PREFILL_KEY,
    }
  if (dynamicContextDepth === 1) plan.dynamicContextDepth = 1
  return plan
}

/** 只标记本轮动态资料，历史、附件与运行中的工具结果沿用原位置。 */
export function bindDynamicContext(
  messages: ChatMessage[],
  depth: DynamicContextDepth,
  previousUserKey?: string,
): void {
  if (depth !== 1 || !previousUserKey) return
  for (const message of messages) {
    const cache = message.cacheControl
    if (
      message.role === 'user' &&
      cache?.kind === 'snapshot' &&
      (cache.dynamicContext ||
        cache.key === 'prompt-slot:turn_context' ||
        cache.key === 'package-context' ||
        cache.key?.startsWith('context-region:'))
    )
      message.cacheControl = { ...cache, dynamicContextBefore: previousUserKey }
  }
}

/** 在请求副本中按固定用户锚点投影，保留规范轨迹供来源校验和跨轮复用。 */
function projectDynamicContext(messages: ChatMessage[]): ChatMessage[] {
  const users = new Map<string, ChatMessage>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    const cache = message.cacheControl
    const keys =
      cache?.kind === 'history'
        ? [cache.historySourceKey ?? cache.key]
        : cache?.kind === 'current'
          ? cache.currentKeys ?? []
          : []
    for (const key of keys) if (key && !users.has(key)) users.set(key, message)
  }
  const insertions = new Map<ChatMessage, ChatMessage[]>()
  const moved = new Set<ChatMessage>()
  for (const message of messages) {
    const key = message.cacheControl?.dynamicContextBefore
    if (!key || message.role !== 'user') continue
    const target = users.get(key)
    if (!target || target === message) continue
    const notice = '【动态资料快照：此处为注入位置，状态时间以正文记录为准。】'
    const content: ChatMessage['content'] = Array.isArray(message.content)
      ? [{ type: 'text', text: notice }, ...message.content]
      : `${notice}\n${message.content ?? ''}`
    const batch = insertions.get(target) ?? []
    batch.push({
      ...message,
      content,
      cacheControl: { ...message.cacheControl!, dynamicContextBefore: undefined },
    })
    insertions.set(target, batch)
    moved.add(message)
  }
  return moved.size
    ? messages.flatMap((message) => [
        ...(insertions.get(message) ?? []),
        ...(moved.has(message) ? [] : [message]),
      ])
    : messages
}

export function promptPlanOf(messages: ChatMessage[]): CompiledPromptPlan {
  return messages[0]?.promptPlan ?? {}
}

/**
 * 按实际模型（含回退链）确定“有效预填充计划”。请求编译、输出拼回、审计快照与热轨迹身份
 * 都使用这份结果；对已解析的计划重复调用得到相同结果。
 */
export function resolveEffectivePromptPlan(
  plan: CompiledPromptPlan,
  model: AssistantPrefillTarget & { fallbackModels?: AssistantPrefillTarget[] },
): CompiledPromptPlan {
  const segment = plan.assistantPrefill
  if (!segment) return plan
  const decision = resolveAssistantPrefillForChain([model, ...(model.fallbackModels ?? [])])
  const rest: CompiledPromptPlan = { ...plan }
  delete rest.assistantPrefill
  delete rest.assistantPrefillSkipped
  return decision.enabled
    ? { ...rest, assistantPrefill: { ...segment, protocol: decision.protocol } }
    : { ...rest, assistantPrefillSkipped: { reason: decision.reason } }
}

/** 调试保留消息结构及附件引用，不把每轮重复的媒体字节写入消息元数据。 */
export function auditModelRequestMessages(messages: ChatMessage[]): ChatMessage[] {
  return redactPerception(omitPerceptionMessages(messages)).map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => {
          if (part.type === 'image_url')
            return {
              ...part,
              image_url: {
                ...part.image_url,
                url: part.image_url.url.startsWith('data:')
                  ? 'attachment:inline-image'
                  : part.image_url.url,
              },
            }
          if (part.type === 'input_audio')
            return {
              ...part,
              input_audio: { ...part.input_audio, data: 'attachment:inline-audio' },
            }
          return { ...part, text: stripBase64DataUris(part.text) }
        })
      : typeof message.content === 'string'
        ? stripBase64DataUris(message.content)
        : message.content,
  }))
}

/**
 * 每次模型调用统一编译请求；预填充作为独立段出现，不向历史写入未完成消息。
 * iteration 为 0 表示 once 预填充尚未用掉：ReAct 循环在出现带正文的回复后才传非 0，
 * 社交链路按轮次传入（只有第一轮带）。plan 应先经 resolveEffectivePromptPlan。
 */
export function compileModelRequest(
  messages: ChatMessage[],
  iteration: number,
  plan: CompiledPromptPlan = promptPlanOf(messages),
): { messages: ChatMessage[]; prefill: string; plan: CompiledPromptPlan } {
  const segment = plan.assistantPrefill
  const prefill =
    segment && (iteration === 0 || segment.mode === 'continuous') ? segment.content : ''
  const projected = plan.dynamicContextDepth === 1 ? projectDynamicContext(messages) : messages
  const message: ChatMessage = {
    role: 'assistant',
    content: prefill,
    promptSegment: 'assistant_prefill',
  }
  if (segment?.protocol === 'deepseek_prefix') message.prefillProtocol = 'deepseek_prefix'
  return {
    messages: prefill ? [...projected, message] : projected,
    prefill,
    plan,
  }
}
