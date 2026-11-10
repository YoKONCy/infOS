import { t as __t } from '../../i18n/index'
import type { Ref } from 'vue'
import type { ConversationQueueSnapshot, QueuedConversationInput } from '@infos/shared'
import type { AttachmentInfo } from '../../api/modules/attachmentsApi'
import { useThreadStore, useNotificationStore } from '../../stores'

/** 本地已经显示的一轮：所属会话与两条乐观消息。 */
export type OptimisticTurn = { threadId: string; userId: string; assistantId: string }

/**
 * useOptimisticTurn — 消息队列的「发送即显示」。
 *
 * 队列空闲时，发送的这条消息会立刻开跑：先把用户消息与「正在思考」占位放进消息流，
 * 等实时画面或服务端历史接替。由 useConversationQueue 在各个节点调用。
 */
export function useOptimisticTurn(snapshot: Ref<ConversationQueueSnapshot>) {
  const threads = useThreadStore()
  const notify = useNotificationStore()
  /** 已被服务端接收的这一轮：队列项 ID 与两条乐观消息。 */
  let optimistic: (OptimisticTurn & { id: string }) | null = null

  /** 发送时插入、还没接上实时画面的「正在思考」占位。 */
  function pendingPlaceholder() {
    if (!optimistic || optimistic.threadId !== threads.threadId) return undefined
    const id = optimistic.assistantId
    return threads.messages.find(
      (message) =>
        message.id === id &&
        message.isStreaming &&
        !message.surfaceId &&
        threads.streamingMessageId === id,
    )
  }

  /**
   * 实时画面出现时让占位接手，返回是否已接手（接手后不再另插一条实时消息）。
   * 传入 surfaceId 时同时把画面挂到占位上；不传则交给 applySurfaceFrame 处理。
   */
  function adopt(surfaceId?: string): boolean {
    const placeholder = pendingPlaceholder()
    if (!placeholder) return false
    if (surfaceId)
      threads.messages = threads.messages.map((message) =>
        message.id === placeholder.id ? { ...message, surfaceId } : message,
      )
    threads.setRagProgress(null)
    return true
  }

  /** 队列空闲时这条消息会立刻开跑，可以先在消息流里显示出来。 */
  function runsImmediately(input: QueuedConversationInput): boolean {
    const current = snapshot.value
    return (
      threads.threadId === input.threadId &&
      !threads.isGenerating &&
      !threads.isLoadingHistory &&
      current.threadId === input.threadId &&
      !current.active &&
      !current.paused &&
      !current.items.some((entry) => entry.state === 'queued' || entry.state === 'running')
    )
  }

  /** 发送前调用：会立刻开跑时插入两条乐观消息，否则返回 null。 */
  function begin(
    input: QueuedConversationInput,
    attachments: AttachmentInfo[] = [],
    queueId?: string,
  ): OptimisticTurn | null {
    if (!runsImmediately(input)) return null
    return { threadId: input.threadId, ...threads.beginPendingTurn(input.content, attachments, queueId) }
  }

  /** 服务端已接收：记下这一轮，返回是否有乐观消息需要跟踪。 */
  function accept(turn: OptimisticTurn | null, id: string): boolean {
    if (!turn) return false
    optimistic = { id, ...turn }
    return true
  }

  /** 提交失败：撤下乐观消息。 */
  function cancel(turn: OptimisticTurn | null): void {
    if (turn) threads.cancelPendingTurn(turn)
  }

  /** 刚提交、服务端还没认领的这一轮仍在路上，不能当成已结束。 */
  function inFlight(threadId: string, next: ConversationQueueSnapshot): boolean {
    return (
      optimistic?.threadId === threadId &&
      !next.paused &&
      next.items.some((entry) => entry.id === optimistic?.id && entry.state === 'queued')
    )
  }

  /** 回合结束时取走本会话的这一轮并清空记录。 */
  function take(threadId: string): OptimisticTurn | null {
    const turn = optimistic?.threadId === threadId ? optimistic : null
    optimistic = null
    return turn
  }

  /** 回合在用户消息落盘前就失败了：气泡已撤下，至少告诉用户没发出去。 */
  function warnIfUnsent(turn: OptimisticTurn | null, next: ConversationQueueSnapshot): void {
    if (!turn || !next.paused) return
    const persisted = threads.messages.some(
      (message) => message.role === 'user' && threads.renderKey(message.id) === turn.userId,
    )
    if (!persisted)
      notify.toast(
        __t('ui.chat', '消息没有发出：{0}', [next.reason ?? __t('ui.chat', '执行失败')]),
        { type: 'error' },
      )
  }

  function reset(): void {
    optimistic = null
  }

  return { adopt, begin, accept, cancel, inFlight, take, warnIfUnsent, reset }
}
