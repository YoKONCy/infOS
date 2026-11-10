/**
 * 判断一个气泡能不能被批改，并按需加载所在会话的标记。
 *
 * 只有已落库、已完成的助手回复可以批改：流式中的临时消息没有稳定的消息号，
 * 据点群聊的消息不属于会话消息表，接口也无法校验。
 */
import { computed, watch, type ComputedRef } from 'vue'
import { ensureThreadMarks, isExpressionReady } from './useExpressionMarks'
import type { ExpressionTarget } from './expressionTypes'

export interface ExpressionBubbleInput {
  message: {
    id: string
    role: string
    senderId?: string
    surface?: {
      surfaceId?: string
      threadId?: string
      principalId?: string
      state?: string
    }
  }
  agentId?: string
  streaming?: boolean
}

export function expressionTargetOf(input: ExpressionBubbleInput): ExpressionTarget | null {
  const { message, streaming } = input
  const surface = message.surface
  if (streaming || message.role !== 'assistant' || !surface?.threadId) return null
  if (surface.state !== 'committed' || !/^\d+$/.test(message.id)) return null
  if (surface.surfaceId?.startsWith('stronghold-message:')) return null
  const agentId = input.agentId || message.senderId || surface.principalId
  return agentId ? { agentId, threadId: surface.threadId, messageId: message.id } : null
}

export function useExpressionTarget(input: () => ExpressionBubbleInput): {
  target: ComputedRef<ExpressionTarget | null>
  ready: ComputedRef<boolean>
} {
  const target = computed(() => expressionTargetOf(input()))
  const ready = computed(() => isExpressionReady(target.value))
  watch(
    () => (target.value ? [target.value.agentId, target.value.threadId] : null),
    (ids) => {
      if (ids) void ensureThreadMarks(ids[0]!, ids[1]!)
    },
    { immediate: true },
  )
  return { target, ready }
}
