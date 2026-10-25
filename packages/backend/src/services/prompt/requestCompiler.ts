import {
  ASSISTANT_PREFILL_KEY,
  type AssistantPrefillConfig,
  type CompiledPromptPlan,
} from '@infos/shared'
import type { ChatMessage } from '../llm/types'
import { stripBase64DataUris } from '../llm/sanitize'

export interface ModelRequestSnapshot {
  requestId?: number
  turn: number
  messages: ChatMessage[]
  tools: import('../llm/types').ToolDefinition[]
  prefill?: NonNullable<CompiledPromptPlan['assistantPrefill']>
  omitted?: boolean
}

/** 只在上下文编译阶段读取配置，执行阶段复用这份不可变策略。 */
export function compilePromptPlan(config: AssistantPrefillConfig): CompiledPromptPlan {
  return config.enabled && config.content
    ? {
        assistantPrefill: {
          content: config.content,
          mode: config.mode ?? 'once',
          source: ASSISTANT_PREFILL_KEY,
        },
      }
    : {}
}

export function promptPlanOf(messages: ChatMessage[]): CompiledPromptPlan {
  return messages[0]?.promptPlan ?? {}
}

/** 调试保留消息结构及附件引用，不把每轮重复的媒体字节写入消息元数据。 */
export function auditModelRequestMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
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

/** 每次模型调用统一编译请求；预填充作为独立段出现，不向历史写入未完成消息。 */
export function compileModelRequest(
  messages: ChatMessage[],
  iteration: number,
  plan: CompiledPromptPlan = promptPlanOf(messages),
): { messages: ChatMessage[]; prefill: string; plan: CompiledPromptPlan } {
  const segment = plan.assistantPrefill
  const prefill =
    segment && (iteration === 0 || segment.mode === 'continuous') ? segment.content : ''
  return {
    messages: prefill
      ? [...messages, { role: 'assistant', content: prefill, promptSegment: 'assistant_prefill' }]
      : messages,
    prefill,
    plan,
  }
}
