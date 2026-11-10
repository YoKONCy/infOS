import { t as __t } from '../i18n/index'
/**
 * threadPendingTurn — 会话消息的乐观插入与渲染 key 接替
 *
 * 发送后立即显示用户消息和「正在思考」占位，直到服务端真实消息接替；
 * 接替时沿用占位的渲染 key，气泡原地更新而不是删掉重建。
 * 由 useThreadStore 创建并接线，状态仍归 store 所有。
 */

import type { Ref, ShallowRef } from 'vue'
import type { AttachmentInfo } from '../api/modules/attachmentsApi'
import type { ChatMessage, GenerationState, RagFailureTrace } from './useThreadStore'

export interface PendingTurnDeps {
  messages: ShallowRef<ChatMessage[]>
  threadId: Ref<string>
  threadKind: Ref<'main' | 'side'>
  threadGeneration: Ref<number>
  agentId: Ref<string>
  streamingMessageId: Ref<string | null>
  generationState: Ref<GenerationState>
  ragFailureTrace: Ref<RagFailureTrace | null>
  ragProgressMessage: Ref<string | null>
  installLocalMessageSurface: (
    localId: string,
    content: string,
    attachments?: AttachmentInfo[],
  ) => string
}

export function createPendingTurnTracker(deps: PendingTurnDeps) {
  const {
    messages,
    threadId,
    agentId,
    streamingMessageId,
    generationState,
    ragFailureTrace,
    ragProgressMessage,
  } = deps

  /**
   * 持久消息 ID → 首次显示时的渲染 key。
   * 本地占位被服务端真实消息接替时 ID 会变，沿用旧 key 才不会整条气泡重建、重播入场动画。
   */
  const renderKeys = new Map<string, string>()

  function renderKey(id: string): string {
    return renderKeys.get(id) ?? id
  }

  /** 真实回复沿用占位气泡的渲染 key，原地接替而不是删掉重建。 */
  function inheritStreamingRenderKey(committedMessageId: string): void {
    const shellId = streamingMessageId.value
    if (shellId && shellId !== committedMessageId)
      renderKeys.set(committedMessageId, renderKey(shellId))
  }

  function clearRenderKeys(): void {
    renderKeys.clear()
  }

  function lastPersistedMessageId(): number {
    let last = 0
    for (const message of messages.value) {
      const id = Number(message.id)
      if (Number.isSafeInteger(id) && id > last) last = id
    }
    return last
  }

  /**
   * 用服务端快照接替本地待确认的用户消息：匹配到的登记渲染 key，返回仍未落盘的那些。
   * keepUnmatched 为 false 时（例如回合已经结束）未匹配的本地消息直接丢弃。
   */
  function adoptPendingMessages(persisted: ChatMessage[], keepUnmatched: boolean): ChatMessage[] {
    const pending = messages.value.filter((message) => message.localPending)
    if (!pending.length) return []
    const claimed = new Set<string>()
    const unmatched: ChatMessage[] = []
    for (const local of pending) {
      const { afterId, queueId, generation } = local.localPending!
      const candidates = persisted.filter(
        (message) =>
          message.role === local.role &&
          !claimed.has(message.id) &&
          Number.isSafeInteger(Number(message.id)) &&
          Number(message.id) > afterId,
      )
      const match = queueId
        ? candidates.find((message) =>
            message.publicationId === `conversation:${threadId.value}:${generation}:${queueId}:input` ||
            message.pairId === `queue_${queueId}`,
          )
        : candidates.find((message) => message.content.trim() === local.content.trim())
      if (match) {
        claimed.add(match.id)
        renderKeys.set(match.id, renderKey(local.id))
      } else if (keepUnmatched) unmatched.push(local)
    }
    return unmatched
  }

  /**
   * 队列马上开跑的一轮：立即显示用户消息和「正在思考」占位，
   * 一直保持到服务端真实消息接替，期间历史刷新不会把它们冲掉。
   */
  function beginPendingTurn(
    content: string,
    attachments: AttachmentInfo[] = [],
    queueId?: string,
  ): { userId: string; assistantId: string } {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString()
    const userId = `pending-user:${suffix}`
    const assistantId = `pending-reply:${suffix}`
    const user: ChatMessage = {
      id: userId,
      role: 'user',
      content,
      timestamp,
      localPending: { afterId: lastPersistedMessageId(), queueId, generation: deps.threadGeneration.value },
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        threadId: threadId.value,
        messageId: null,
        kind: attachment.kind,
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        contextPolicy: attachment.contextPolicy,
        status: attachment.status,
      })),
    }
    user.surfaceId = deps.installLocalMessageSurface(userId, content, attachments)
    const assistant: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp,
      senderId: agentId.value,
      executionRecord: deps.threadKind.value === 'main',
      isStreaming: true,
    }
    messages.value = [...messages.value, user, assistant]
    streamingMessageId.value = assistantId
    generationState.value = 'thinking'
    ragFailureTrace.value = null
    ragProgressMessage.value = __t('ui.chat', '正在编译对话上下文')
    return { userId, assistantId }
  }

  /** 提交失败时撤回乐观插入的两条消息。 */
  function cancelPendingTurn(turn: { userId: string; assistantId: string }): void {
    messages.value = messages.value.filter(
      (message) => message.id !== turn.userId && message.id !== turn.assistantId,
    )
    if (streamingMessageId.value === turn.assistantId) {
      streamingMessageId.value = null
      generationState.value = 'idle'
      ragProgressMessage.value = null
    }
  }

  return {
    renderKey,
    inheritStreamingRenderKey,
    clearRenderKeys,
    adoptPendingMessages,
    beginPendingTurn,
    cancelPendingTurn,
  }
}
