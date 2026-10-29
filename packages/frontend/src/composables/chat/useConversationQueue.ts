import { t as __t } from '../../i18n/index'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  ConversationQueueItem,
  ConversationQueueSnapshot,
  QueuedConversationInput,
  SurfaceFrame,
} from '@infos/shared'
import { chatApi } from '../../api/modules/chatApi'
import { clientAccessApi } from '../../api/modules/clientAccessApi'
import { ApiError } from '../../api/errors'
import { getClientToken, isLocalBackendRuntime } from '../../api/transport'
import { useThreadStore, useNotificationStore, useCompositorStore } from '../../stores'
import { useGateway } from '../gateway/useGateway'
import { createClientUuid } from '../../lib/clientPlatform'
import { logger } from '../../lib/logger'
import { publishWorkspaceChanges } from './workspaceChanges'
import { queueErrorMessage } from './queueFeedback'

/** 队列内容以服务端为准；轮询负责断线补偿，Gateway 只负责实时显示。 */
export function useConversationQueue() {
  const threads = useThreadStore()
  const compositor = useCompositorStore()
  const notify = useNotificationStore()
  const snapshot = ref<ConversationQueueSnapshot>({ threadId: '', paused: false, items: [] })
  const changing = ref(false)
  const unavailable = ref(false)
  const historyVersion = ref(0)
  const pendingIds = new Map<string, string>()
  const submittedIds = new Set<string>()
  const liveSurfaces = new Set<string>()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let mutationVersion = 0
  let loading = false
  let queuedRunObserved = false
  let lastRunId = ''
  let needsHistorySync = false
  let lastFrameAt = 0
  let lastWarningAt = 0
  let waitingForAuthentication = false
  let nextAuthenticationCheck = 0
  useGateway({ onSurface: applyFrame })

  function applyFrame(frame: SurfaceFrame) {
    const operation = frame.operation
    if (operation.type === 'surface.open') {
      if (operation.threadId !== threads.threadId || operation.principalId !== threads.agentId)
        return
      liveSurfaces.add(frame.surfaceId)
      queuedRunObserved = true
      needsHistorySync = true
      const id = `queue-live:${frame.surfaceId}`
      if (!threads.messages.some((message) => message.id === id)) {
        threads.addMessage({
          id,
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
          senderId: threads.agentId,
          isStreaming: true,
          surfaceId: frame.surfaceId,
        })
      }
      threads.streamingMessageId = id
      threads.generationState = 'thinking'
      void refresh()
    }
    if (!liveSurfaces.has(frame.surfaceId)) return
    lastFrameAt = Date.now()
    threads.applySurfaceFrame(frame)
    if (operation.type === 'surface.commit')
      publishWorkspaceChanges(operation.message, threads.agentId, threads.threadId)
    if (operation.type === 'surface.commit' || operation.type === 'surface.fail') {
      liveSurfaces.delete(frame.surfaceId)
      threads.finishStreaming()
      void refresh()
    } else if (operation.type === 'surface.upsert-node' && operation.node.kind === 'status') {
      const state = (operation.node.props as { state?: string }).state
      threads.generationState =
        state === 'calling'
          ? 'tool_calling'
          : state === 'assembling'
            ? 'tool_assembling'
            : state === 'generating'
              ? 'generating'
              : 'thinking'
    }
  }

  async function refresh() {
    const threadId = threads.threadId
    if (!threadId || disposed || loading) return
    loading = true
    const epoch = revision
    const mutation = mutationVersion
    try {
      if (isLocalBackendRuntime() && !getClientToken()) {
        unavailable.value = true
        waitingForAuthentication = true
        nextAuthenticationCheck = 0
        return
      }
      if (waitingForAuthentication) {
        if (Date.now() < nextAuthenticationCheck) return
        nextAuthenticationCheck = Date.now() + 5000
        // 公开状态端点返回真实身份状态；不反复拿业务轮询制造同一种 401。
        const status = await clientAccessApi.session()
        if (!status.data?.authenticated || disposed || epoch !== revision) return
        waitingForAuthentication = false
      }
      const response = await chatApi.queue(threadId)
      if (
        disposed ||
        epoch !== revision ||
        mutation !== mutationVersion ||
        threads.threadId !== threadId ||
        !response.data
      )
        return
      const next = response.data
      snapshot.value = next
      unavailable.value = false
      for (const id of submittedIds) {
        if (next.items.some((entry) => entry.id === id)) continue
        submittedIds.delete(id)
        // 极快完成或准备失败时，轮询可能看不到 running，也要读取已保存的消息和错误。
        queuedRunObserved = true
        needsHistorySync = true
      }
      const running = next.items.find((entry) => entry.state === 'running')
      if (running) {
        queuedRunObserved = true
        if (lastRunId !== running.id || needsHistorySync) {
          lastRunId = running.id
          needsHistorySync = false
          // 正式用户消息已经由服务端写入；快照读取保留本地正在流式展示的 Shell。
          await threads.loadThreadMessages(threadId, threads.agentId)
          if (epoch !== revision || disposed) return
        }
        if (!liveSurfaces.size || Date.now() - lastFrameAt > 8_000) {
          const live = (await chatApi.queueLive(threadId)).data
          if (epoch !== revision || disposed || threads.threadId !== threadId) return
          if (live && live.state === 'open') {
            compositor.flush()
            const current = compositor.get(live.surfaceId)
            if (
              !current ||
              current.generation !== live.generation ||
              current.sequence <= live.sequence
            )
              compositor.install(live)
            liveSurfaces.add(live.surfaceId)
            if (
              !threads.messages.some(
                (message) => message.isStreaming && message.surfaceId === live.surfaceId,
              )
            ) {
              const id = `queue-live:${live.surfaceId}`
              threads.addMessage({
                id,
                role: 'assistant',
                content: '',
                senderId: threads.agentId,
                timestamp: new Date().toISOString(),
                surfaceId: live.surfaceId,
                isStreaming: true,
              })
              threads.streamingMessageId = id
            }
            lastFrameAt = Date.now()
          }
        }
        if (!threads.isGenerating) threads.generationState = 'thinking'
      } else if (queuedRunObserved && !next.active) {
        queuedRunObserved = false
        threads.finishStreaming()
        await threads.loadThreadMessages(threadId, threads.agentId)
        if (epoch === revision && !disposed)
          window.dispatchEvent(
            new CustomEvent('infos:conversation-completed', {
              detail: { threadId, agentId: threads.agentId },
            }),
          )
      }
    } catch (error) {
      if (epoch === revision && !disposed) {
        unavailable.value = true
        if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
          waitingForAuthentication = true
          nextAuthenticationCheck = Date.now() + 5000
        }
      }
      if (Date.now() - lastWarningAt > 30_000) {
        lastWarningAt = Date.now()
        logger.warn(
          'ConversationQueue',
          __t('logs.frontend.chat', '消息队列同步暂时失败，将自动重连'),
          error,
        )
      }
    } finally {
      loading = false
    }
  }

  async function enqueue(input: QueuedConversationInput): Promise<boolean> {
    mutationVersion++
    const key = JSON.stringify(input)
    const id = pendingIds.get(key) ?? createClientUuid()
    pendingIds.set(key, id)
    const epoch = revision
    changing.value = true
    try {
      const response = await chatApi.enqueue(input, id)
      pendingIds.delete(key)
      if (epoch === revision && response.data) {
        snapshot.value = response.data
        submittedIds.add(id)
      }
      void refresh()
      return true
    } catch (error) {
      // 请求可能已经提交成功，只是确认响应丢失；使用同一身份核对，绝不换 ID 重发。
      try {
        const response = await chatApi.queue(input.threadId)
        if (response.data?.items.some((entry) => entry.id === id)) {
          pendingIds.delete(key)
          if (epoch === revision) {
            snapshot.value = response.data
            submittedIds.add(id)
          }
          return true
        }
      } catch {
        /* 保留提交身份，用户重试仍然幂等。 */
      }
      logger.warn('ConversationQueue', __t('logs.frontend.chat', '消息提交暂未确认'), error)
      notify.toast(queueErrorMessage(error), {
        type: 'error',
      })
      return false
    } finally {
      changing.value = false
    }
  }

  async function change(
    item: ConversationQueueItem,
    action: 'edit' | 'cancel' | 'immediate' | 'draft',
    content?: string,
  ) {
    if (item.input.threadId !== snapshot.value.threadId) return false
    return mutate(() =>
      chatApi.changeQueued(item.input.threadId, item.id, item.revision, action, content),
    )
  }
  async function mutate(operation: () => ReturnType<typeof chatApi.controlQueue>, quiet = false) {
    if (changing.value) return false
    mutationVersion++
    changing.value = true
    const epoch = revision
    try {
      const response = await operation()
      if (epoch === revision && response.data) snapshot.value = response.data
      return epoch === revision
    } catch (error) {
      if (!quiet) {
        logger.warn('ConversationQueue', __t('logs.frontend.chat', '队列操作失败'), error)
        notify.toast(queueErrorMessage(error), { type: 'error' })
      }
      void refresh()
      return false
    } finally {
      changing.value = false
    }
  }
  async function acknowledgeDraft(item: ConversationQueueItem) {
    if (item.input.threadId !== snapshot.value.threadId) return false
    return mutate(
      () => chatApi.changeQueued(item.input.threadId, item.id, item.revision, 'cancel'),
      true,
    )
  }
  const control = (paused: boolean) =>
    mutate(() => chatApi.controlQueue(snapshot.value.threadId, paused))
  function move(item: ConversationQueueItem, offset: number) {
    const queued = snapshot.value.items.filter(
      (entry) => entry.state === 'queued' && !entry.immediate,
    )
    const index = queued.findIndex((entry) => entry.id === item.id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= queued.length) return
    ;[queued[index], queued[target]] = [queued[target]!, queued[index]!]
    return mutate(() =>
      chatApi.reorderQueue(
        snapshot.value.threadId,
        queued.map(({ id, revision: rev }) => ({ id, revision: rev })),
      ),
    )
  }
  watch(
    () => [threads.threadId, threads.agentId],
    () => {
      revision++
      historyVersion.value++
      liveSurfaces.clear()
      submittedIds.clear()
      queuedRunObserved = false
      lastRunId = ''
      snapshot.value = { threadId: threads.threadId, paused: false, items: [] }
      lastFrameAt = 0
      void refresh()
    },
  )
  async function poll() {
    await refresh()
    if (!disposed) timer = setTimeout(poll, document.hidden ? 8_000 : 2_000)
  }
  const wake = () => {
    if (!document.hidden) void refresh()
  }
  const authorized = () => {
    nextAuthenticationCheck = 0
    void refresh()
  }
  const historyChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ threadId: string; discardPending: boolean }>).detail
    if (detail.threadId !== threads.threadId) return
    revision++
    historyVersion.value++
    mutationVersion++
    submittedIds.clear()
    snapshot.value = {
      ...snapshot.value,
      paused: true,
      reason: '历史已更新',
      ...(detail.discardPending ? { items: [], drafts: [], active: false } : {}),
    }
    if (detail.discardPending) {
      liveSurfaces.clear()
      queuedRunObserved = false
      lastRunId = ''
    }
    void refresh()
  }
  onMounted(() => {
    void poll()
    window.addEventListener('online', wake)
    window.addEventListener('infos:authorized', authorized)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('infos:conversation-history-changed', historyChanged)
  })
  onUnmounted(() => {
    disposed = true
    revision++
    clearTimeout(timer)
    window.removeEventListener('online', wake)
    window.removeEventListener('infos:authorized', authorized)
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('infos:conversation-history-changed', historyChanged)
  })
  return {
    snapshot,
    changing,
    unavailable,
    historyVersion,
    enqueue,
    change,
    acknowledgeDraft,
    move,
    control,
    hasPending: computed(() => snapshot.value.items.some((entry) => entry.state === 'queued')),
  }
}
