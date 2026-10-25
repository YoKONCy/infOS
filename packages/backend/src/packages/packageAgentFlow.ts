import type { ChatMessage } from '../services/pipeline/types'

export interface PackageFlowEmitter {
  emitHook<T>(event: string, data: T): Promise<T>
}

/** 流程钩子可调整普通消息正文，不能改身份、工具调用协议或系统规则。 */
export async function packageRequestMessages(
  hooks: PackageFlowEmitter | undefined,
  messages: ChatMessage[],
  scope: Record<string, unknown>,
  accept?: (messages: ChatMessage[]) => boolean,
): Promise<ChatMessage[]> {
  if (!hooks) return messages
  const result = await hooks.emitHook('agent:beforeRequest', { ...scope, messages })
  const next = result?.messages
  if (!Array.isArray(next) || next.length !== messages.length) return messages
  for (let index = 0; index < messages.length; index++) {
    const original = messages[index]!
    const candidate = next[index]
    if (
      !candidate ||
      JSON.stringify({ ...candidate, content: undefined }) !==
        JSON.stringify({ ...original, content: undefined })
    )
      return messages
    if (
      original.role === 'system' ||
      original.role === 'tool' ||
      typeof original.content !== 'string'
    ) {
      if (JSON.stringify(candidate.content) !== JSON.stringify(original.content)) return messages
    } else if (
      typeof candidate.content !== 'string' ||
      candidate.content.length > original.content.length + 16000
    )
      return messages
  }
  try {
    return !accept || accept(next) ? next : messages
  } catch {
    return messages
  }
}
