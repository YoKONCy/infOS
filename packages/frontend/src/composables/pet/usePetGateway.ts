import {
  resourceFromToolResult,
  type SurfaceFrame,
  type SurfaceDescriptor,
  type ConversationMessageProjection,
  type MessageResource,
  type PetConversationTarget,
} from '@infos/shared'
import { computed, ref, shallowRef, onMounted, onUnmounted, watch } from 'vue'
import '@infos/shared/i18n/catalogs/petActivity'
import '@infos/shared/i18n/catalogs/petConversations'
import { t } from '../../i18n'
import { usePetActivity } from './usePetActivity'
import { splitResourceCards } from '../../lib/resourceLinks'
import { resolveResourceLink } from '../resources/useResources'
import { useGateway } from '../gateway/useGateway'
import { usePetStateStore } from '../../stores'
import { threadsApi, type ThreadInfo } from '../../api/modules/threadsApi'
import { ApiError } from '../../api/errors'
import { readPetThread, rememberPetThread } from './petConversationSelection'
import { agentApi } from '../../api/modules/agentApi'
import { chatApi } from '../../api/modules/chatApi'
import { invoke, isElectron, listen } from '../../utils/ipcAdapter'

export interface PetReply extends PetConversationTarget {
  spokenReply: string
}

/** 桌宠仅保留轻量活动与资源引用，完整对话仍由主应用承载。 */
export function usePetGateway() {
  const activeAgentId = ref('pero')
  const activeSessionId = ref<string | null>(null)
  const activeThread = shallowRef<ThreadInfo | null>(null)
  const switching = ref(false)
  const sendingThreads = ref(new Set<string>())
  const isThinking = ref(false)
  const stage = ref('')
  const hint = ref('')
  const latestReply = ref<PetReply | null>(null)
  const unread = ref(false)
  const deliveries = shallowRef<MessageResource[]>([])
  const deliveryKey = ref('')
  const deliveryTarget = shallowRef<PetConversationTarget | null>(null)
  const activity = usePetActivity()
  let resourceRequest: AbortController | undefined
  let surfaceGeneration = ''
  let surfaceSequence = -1
  const petState = usePetStateStore()
  let disposed = false
  let stateGeneration = 0
  let selectionGeneration = 0
  let agentGeneration = 0
  let agentReady = false
  let surfaceId = ''
  let presenceGeneration = 0
  let presenceTimer: ReturnType<typeof setInterval> | undefined
  const gateway = useGateway({ onSurface: applySurface })
  const chatState = computed(() => ({
    ...petState.stateFor(activeAgentId.value),
    isThinking:
      isThinking.value ||
      sendingThreads.value.has(`${activeAgentId.value}:${activeSessionId.value}`),
    thinkingMessage: stage.value,
  }))
  const conversationTarget = computed<PetConversationTarget>(() => ({
    agentId: activeAgentId.value,
    threadId: activeSessionId.value ?? undefined,
    messageId:
      latestReply.value?.threadId === activeSessionId.value
        ? latestReply.value.messageId
        : undefined,
  }))
  async function publishPresence(): Promise<void> {
    if (!isElectron() || disposed || !agentReady || !gateway.sessionId.value) return
    const generation = ++presenceGeneration
    const session = gateway.sessionId.value
    const agentId = activeAgentId.value
    try {
      const state = (await invoke('get-pet-window-state')) as { visible?: boolean } | null
      if (
        disposed ||
        generation !== presenceGeneration ||
        session !== gateway.sessionId.value ||
        agentId !== activeAgentId.value
      )
        return
      await gateway.request(
        'gateway.pet_presence',
        { agentId, visible: state?.visible === true },
        10_000,
      )
    } catch {
      /* 状态不能确认时不补报显示；连接租约到期后后端自动停用口语提示。 */
    }
  }
  function acceptReply(data: Record<string, unknown>, markUnread = true) {
    if (data.agentId !== activeAgentId.value || typeof data.threadId !== 'string') return
    if (data.threadId !== activeSessionId.value) return
    const messageId = typeof data.messageId === 'string' ? data.messageId : undefined
    if (messageId && latestReply.value?.messageId === messageId) return
    activeSessionId.value = data.threadId
    latestReply.value = {
      agentId: activeAgentId.value,
      threadId: data.threadId,
      messageId,
      spokenReply:
        typeof data.spokenReply === 'string' && data.spokenReply.length <= 240
          ? data.spokenReply
          : '',
    }
    isThinking.value = false
    stage.value = ''
    activity.finish()
    if (markUnread) unread.value = true
  }
  function resourceKey(item: MessageResource) {
    return item.id || `${item.origin?.type}:${item.origin?.value}`
  }
  function addDelivery(item: MessageResource) {
    if (
      (!item.id && !item.origin) ||
      deliveries.value.some((entry) => resourceKey(entry) === resourceKey(item))
    )
      return
    deliveries.value = [...deliveries.value, item]
  }
  async function collectDeliveries(message: ConversationMessageProjection) {
    resourceRequest?.abort()
    const controller = new AbortController()
    resourceRequest = controller
    const key = `${message.threadId}:${message.messageId}`
    if (deliveryKey.value !== key) deliveries.value = []
    deliveryKey.value = key
    deliveryTarget.value = {
      agentId: activeAgentId.value,
      threadId: message.threadId,
      messageId: message.messageId,
    }
    for (const item of message.attachments) addDelivery(item)
    for (const call of message.toolCalls) {
      const item = resourceFromToolResult(call.name, call.result)
      if (item) addDelivery(item)
    }
    const references = splitResourceCards(message.content).filter(
      (item) => item.type === 'resource-reference',
    )
    const context = { agentId: activeAgentId.value, threadId: message.threadId }
    // 顺序解析并去重，关闭或切换回合后丢弃旧请求，不预读文档正文。
    for (const reference of references) {
      if (controller.signal.aborted) return
      try {
        const item = await resolveResourceLink(reference.source, context, controller.signal)
        if (controller.signal.aborted || deliveryKey.value !== key) return
        addDelivery(item)
      } catch {
        /* 不可访问的引用仍可从完整对话查看，不影响其他交付。 */
      }
    }
  }
  function hydrateSurface(surface: SurfaceDescriptor) {
    surfaceId = surface.surfaceId
    surfaceGeneration = surface.generation
    surfaceSequence = surface.sequence
    activeSessionId.value = surface.threadId
    activity.reset(surface.state === 'open')
    for (const node of surface.nodes) activity.node(node)
    isThinking.value = surface.state === 'open' && activity.activity.value.phase !== 'idle'
    if (!isThinking.value) activity.finish()
  }
  function applySurface(frame: SurfaceFrame) {
    if (frame.threadGeneration !== undefined && activeThread.value && frame.threadGeneration < activeThread.value.generation) return
    const operation = frame.operation
    if (operation.type === 'surface.open') {
      if (
        operation.principalId !== activeAgentId.value ||
        operation.threadId !== activeSessionId.value
      )
        return
      if (
        frame.surfaceId === surfaceId &&
        frame.generation === surfaceGeneration &&
        frame.sequence <= surfaceSequence
      )
        return
      surfaceId = frame.surfaceId
      surfaceGeneration = frame.generation
      surfaceSequence = frame.sequence
      activeSessionId.value = operation.threadId
      isThinking.value = true
      stage.value = ''
      activity.reset(true)
      for (const node of operation.nodes || []) activity.node(node)
      return
    }
    if (
      frame.surfaceId !== surfaceId ||
      frame.generation !== surfaceGeneration ||
      frame.sequence <= surfaceSequence
    )
      return
    surfaceSequence = frame.sequence
    if (operation.type === 'surface.publish') {
      const message = [...operation.snapshot.messages].reverse().find((item) => item.role === 'assistant' && !item.executionRecord)
      if (message) acceptReply({ agentId: activeAgentId.value, threadId: operation.snapshot.threadId,
        messageId: message.messageId, spokenReply: message.spokenReply })
      return
    }
    if (operation.type === 'surface.settled') {
      activity.finish()
      isThinking.value = false
      return
    }
    if (operation.type === 'surface.commit') {
      if (operation.surface.principalId !== activeAgentId.value) return
      acceptReply({
        agentId: operation.surface.principalId,
        threadId: operation.snapshot.threadId,
        messageId: operation.message.messageId,
        spokenReply: operation.message.spokenReply,
      })
      activity.finish()
      isThinking.value = false
      void collectDeliveries(operation.message)
      return
    }
    if (operation.type === 'surface.fail') {
      isThinking.value = false
      unread.value = true
      activity.finish()
      hint.value = t('ui.pet-activity', '回复遇到问题，请在主应用查看')
    } else if (operation.type === 'surface.upsert-node') {
      activity.node(operation.node)
      if (
        operation.node.kind === 'status' &&
        ['idle', 'failed'].includes(activity.activity.value.phase)
      )
        isThinking.value = false
    } else if (operation.type === 'surface.patch-node') {
      activity.patch(operation.nodeId, operation.patch)
      if (['idle', 'failed'].includes(activity.activity.value.phase)) isThinking.value = false
    } else if (operation.type === 'surface.append-text') {
      // 正文不存入轻量投影；思考与生成阶段由节点和状态事件区分。
    } else if (operation.type === 'surface.dispose') {
      isThinking.value = false
      activity.finish()
    }
  }
  function notification(data: Record<string, unknown>) {
    if (data.principalId && data.principalId !== activeAgentId.value) return
    hint.value =
      typeof data.title === 'string' ? data.title.slice(0, 70) : '有新事项，请在主应用查看'
  }
  function stateUpdate(data: Record<string, unknown>) {
    if (data.agentId && data.agentId !== activeAgentId.value) return
    petState.applyPush(data)
  }
  function threadReset(data: Record<string, unknown>) {
    if (data.threadId !== activeSessionId.value || typeof data.generation !== 'number') return
    if (data.generation < (activeThread.value?.generation ?? 1)) return
    if (activeThread.value) activeThread.value = { ...activeThread.value, generation: data.generation }
    clearConversation()
    void restore()
  }
  watch(
    [activeAgentId, activeSessionId],
    ([agentId, threadId]) => {
      petState.selectThread(agentId, threadId ?? '')
    },
    { immediate: true },
  )
  function clearConversation() {
    stateGeneration++
    selectionGeneration++
    resourceRequest?.abort()
    deliveries.value = []
    deliveryKey.value = ''
    deliveryTarget.value = null
    latestReply.value = null
    unread.value = false
    hint.value = ''
    stage.value = ''
    isThinking.value = false
    activity.reset()
    surfaceId = ''
    surfaceGeneration = ''
    surfaceSequence = -1
  }
  async function restore(): Promise<boolean> {
    const agentId = activeAgentId.value
    const generation = ++stateGeneration
    try {
      await gateway.selectPrincipal(agentId)
      if (disposed || generation !== stateGeneration) return false
      await publishPresence()
      const selectedId = activeSessionId.value || readPetThread(agentId)
      let thread: ThreadInfo | undefined
      if (selectedId) {
        try {
          thread = (await threadsApi.get(selectedId, { pageSize: 1 })).data?.thread
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'NOT_FOUND') throw error
        }
        if (
          thread &&
          (thread.agentId !== agentId || thread.channel !== 'desktop' || thread.status !== 'active')
        )
          thread = undefined
      }
      if (disposed || generation !== stateGeneration) return false
      if (!thread)
        thread = (await threadsApi.getLatest({ agentId, channel: 'desktop' })).data?.thread
      if (disposed || generation !== stateGeneration || !thread) return false
      if (activeSessionId.value && activeSessionId.value !== thread.id) clearConversation()
      // 清理失效会话会递增版本，后续快照仍须绑定本次选中的目标。
      const snapshotGeneration = stateGeneration
      activeSessionId.value = thread.id
      activeThread.value = thread
      rememberPetThread(agentId, thread.id)
      await gateway.subscribe('thread:' + thread.id)
      const before = { id: surfaceId, sequence: surfaceSequence }
      const [response, liveResponse] = await Promise.all([
        threadsApi.getProjection(thread.id, { pageSize: 1 }),
        chatApi.queueLive(thread.id),
      ])
      if (disposed || snapshotGeneration !== stateGeneration || activeSessionId.value !== thread.id)
        return false
      const live = liveResponse.data
      if (live?.state === 'open' && live.principalId === agentId) {
        if (live.surfaceId !== surfaceId || live.sequence >= surfaceSequence) hydrateSurface(live)
        return true
      }
      if (before.id === surfaceId && before.sequence === surfaceSequence) {
        isThinking.value = false
        activity.finish()
      }
      const surface = response.data?.surfaces.filter((item) => item.messageId).at(-1)
      if (
        surface &&
        !isThinking.value &&
        (surface.surfaceId !== surfaceId || surface.sequence > surfaceSequence)
      )
        hydrateSurface(surface)
      const message = [...(response.data?.messages ?? [])]
        .reverse()
        .find((item) => item.role === 'assistant')
      if (
        message &&
        latestReply.value?.messageId !== message.messageId &&
        !isThinking.value &&
        surface?.state !== 'open'
      )
        acceptReply(
          {
            agentId,
            threadId: thread.id,
            messageId: message.messageId,
            spokenReply: message.spokenReply,
          },
          false,
        )
      if (message && !isThinking.value) void collectDeliveries(message)
      return true
    } catch {
      /* 重连恢复失败时由连接状态提示，保留现有投影。 */
      return false
    }
  }
  async function loadAgent(agentId?: string): Promise<boolean> {
    if (agentId && agentReady && agentId === activeAgentId.value) return true
    const generation = ++agentGeneration
    let id = agentId
    if (!id && isElectron()) {
      const selected = await invoke('get-client-default-agent')
      if (typeof selected === 'string' && selected) id = selected
    }
    if (!id) {
      const response = await agentApi.getActive()
      id = response.data?.agentId || response.data?.id || 'pero'
    }
    if (disposed || generation !== agentGeneration) return false
    if (agentReady && id === activeAgentId.value) return true
    presenceGeneration++
    if (agentReady && gateway.sessionId.value) {
      void gateway
        .request('gateway.pet_presence', { agentId: activeAgentId.value, visible: false }, 1000)
        .catch(() => {})
    }
    clearConversation()
    agentReady = true
    activeAgentId.value = id
    activeSessionId.value = null
    activeThread.value = null
    await petState.load(id, '')
    if (disposed || generation !== agentGeneration) return false
    return restore()
  }
  async function selectAgent(agentId: string): Promise<boolean> {
    if (switching.value) return false
    if (agentId === activeAgentId.value) return true
    switching.value = true
    const version = agentGeneration
    try {
      const profile = (await agentApi.get(agentId)).data
      if (disposed || version !== agentGeneration || !profile?.isEnabled) return false
      const restored = await loadAgent(agentId)
      if (!restored) throw new Error('PET_SELECTION_UNAVAILABLE')
      if (isElectron()) await invoke('set-client-default-agent', { agentId })
      return true
    } catch {
      if (!disposed) hint.value = t('ui.pet-conversations', '切换失败，请重试')
      return false
    } finally {
      switching.value = false
    }
  }
  async function selectThread(threadId: string): Promise<boolean> {
    if (switching.value) return false
    switching.value = true
    const agentId = activeAgentId.value
    const version = agentGeneration
    try {
      if (threadId === activeSessionId.value) return await restore()
      const thread = (await threadsApi.get(threadId, { pageSize: 1 })).data?.thread
      if (
        disposed ||
        version !== agentGeneration ||
        !thread ||
        thread.agentId !== agentId ||
        thread.channel !== 'desktop' ||
        thread.status !== 'active'
      )
        return false
      clearConversation()
      activeSessionId.value = threadId
      activeThread.value = thread
      rememberPetThread(agentId, threadId)
      return await restore()
    } catch {
      if (!disposed) hint.value = t('ui.pet-conversations', '切换失败，请重试')
      return false
    } finally {
      switching.value = false
    }
  }
  async function createThread(): Promise<boolean> {
    if (switching.value) return false
    switching.value = true
    const agentId = activeAgentId.value
    const version = agentGeneration
    try {
      const thread = (await threadsApi.create({ agentId, channel: 'desktop' })).data?.thread
      if (disposed || version !== agentGeneration || !thread) return false
      clearConversation()
      activeSessionId.value = thread.id
      activeThread.value = thread
      rememberPetThread(agentId, thread.id)
      await gateway.subscribe('thread:' + thread.id)
      return true
    } catch {
      if (!disposed) hint.value = t('ui.pet-conversations', '新建失败，请重试')
      return false
    } finally {
      switching.value = false
    }
  }
  async function sendChat(text: string, speak = true): Promise<boolean> {
    if (!text.trim() || switching.value || !activeSessionId.value || chatState.value.isThinking)
      return false
    isThinking.value = true
    stage.value = ''
    activity.reset(true)
    hint.value = ''
    const requestAgentId = activeAgentId.value
    const requestThreadId = activeSessionId.value
    const target = `${requestAgentId}:${requestThreadId}`
    const version = selectionGeneration
    let dispatched = false
    sendingThreads.value = new Set([...sendingThreads.value, target])
    try {
      await gateway.selectPrincipal(requestAgentId, true)
      await publishPresence()
      if (
        disposed ||
        activeAgentId.value !== requestAgentId ||
        activeSessionId.value !== requestThreadId ||
        version !== selectionGeneration
      )
        return false
      dispatched = true
      const response = await gateway.request(
        'chat',
        {
          messages: [{ role: 'user', content: text }],
          source: 'desktop',
          agentId: requestAgentId,
          threadId: requestThreadId,
          speak,
        },
        300_000,
      )
      if (
        activeAgentId.value !== requestAgentId ||
        activeSessionId.value !== requestThreadId ||
        version !== selectionGeneration ||
        disposed
      )
        return true
      acceptReply({ ...response, agentId: requestAgentId })
      if (activeSessionId.value)
        await gateway.subscribe('thread:' + activeSessionId.value).catch(() => {})
      return true
    } catch {
      if (
        activeAgentId.value !== requestAgentId ||
        activeSessionId.value !== requestThreadId ||
        version !== selectionGeneration ||
        disposed
      )
        return false
      isThinking.value = false
      activity.finish()
      latestReply.value = null
      unread.value = true
      hint.value = '消息发送失败，请检查连接后重试'
      return false
    } finally {
      sendingThreads.value = new Set([...sendingThreads.value].filter((item) => item !== target))
      if (
        !dispatched &&
        !disposed &&
        activeAgentId.value === requestAgentId &&
        activeSessionId.value === requestThreadId
      ) {
        isThinking.value = false
        activity.finish()
      }
    }
  }
  function stopSpeech(agentId = activeAgentId.value) {
    void gateway.request('stop_speech', { agentId }).catch(() => {})
  }
  function proactiveReply(data: Record<string, unknown>) {
    acceptReply(data)
  }
  const removeAgentListeners: Array<() => void> = []
  function agentChanged(data: unknown) {
    const id = (data as { agentId?: unknown } | null)?.agentId
    if (typeof id === 'string' && id)
      void loadAgent(id).catch(() => {
        if (!disposed) hint.value = '角色信息暂时无法读取'
      })
  }
  function backendAgentChanged(data: Record<string, unknown>) {
    // 桌面端以当前客户端选择为准，Web 端沿用后端活跃角色。
    if (!isElectron()) agentChanged(data)
  }
  async function bindAgentEvent(channel: string) {
    const remove = await listen(channel, agentChanged)
    if (disposed) remove()
    else removeAgentListeners.push(remove)
  }
  async function bindVisibilityEvent() {
    const remove = await listen('pet-window-visibility-changed', () => {
      void publishPresence()
      if (agentReady && gateway.isConnected.value) void restore()
    })
    if (disposed) remove()
    else removeAgentListeners.push(remove)
  }
  watch(gateway.sessionId, (session) => {
    if (session && agentReady) void restore()
  })
  function restoreFromSnapshot(event: Event) {
    const streamId = (event as CustomEvent<{ streamId?: string }>).detail?.streamId
    if (agentReady && (!streamId || streamId === `thread:${activeSessionId.value}`)) void restore()
  }
  onMounted(() => {
    window.addEventListener('infos:gateway-snapshot-required', restoreFromSnapshot)
    gateway.onPush('conversation_reply_ready', acceptReply)
    gateway.onPush('proactive_message', proactiveReply)
    gateway.onPush('durable_notification', notification)
    gateway.onPush('state_update', stateUpdate)
    gateway.onPush('thread_reset', threadReset)
    gateway.onPush('agent_changed', backendAgentChanged)
    void gateway.connect()
    presenceTimer = setInterval(() => {
      void publishPresence()
    }, 30_000)
    void (async () => {
      await Promise.all([
        bindAgentEvent('client-agent-changed'),
        bindAgentEvent('agent_changed'),
        bindVisibilityEvent(),
      ])
      if (!disposed) await loadAgent()
    })().catch(() => {
      if (!disposed) hint.value = '角色信息暂时无法读取'
    })
  })
  onUnmounted(() => {
    window.removeEventListener('infos:gateway-snapshot-required', restoreFromSnapshot)
    resourceRequest?.abort()
    if (presenceTimer) clearInterval(presenceTimer)
    presenceGeneration++
    if (agentReady && gateway.sessionId.value) {
      void gateway
        .request('gateway.pet_presence', { agentId: activeAgentId.value, visible: false }, 1000)
        .catch(() => {})
    }
    disposed = true
    gateway.offPush('conversation_reply_ready', acceptReply)
    gateway.offPush('proactive_message', proactiveReply)
    gateway.offPush('durable_notification', notification)
    gateway.offPush('state_update', stateUpdate)
    gateway.offPush('thread_reset', threadReset)
    gateway.offPush('agent_changed', backendAgentChanged)
    for (const remove of removeAgentListeners) remove()
    gateway.disconnect()
  })
  return {
    activity: activity.activity,
    deliveries,
    deliveryKey,
    deliveryTarget,
    chatState,
    activeAgentId,
    activeSessionId,
    activeThread,
    switching,
    selectAgent,
    selectThread,
    createThread,
    conversationTarget,
    latestReply,
    unread,
    hint,
    wsState: gateway.state,
    sendChat,
    stopSpeech,
    selectPrincipal: gateway.selectPrincipal,
  }
}
