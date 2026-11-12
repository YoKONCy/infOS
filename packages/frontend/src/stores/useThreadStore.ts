import { t as __t } from '../i18n/index'
/**
 * useThreadStore — Thread 状态管理
 *
 * 基于 AIOS 第三阶段 Thread + ContextCompiler 架构，替代旧 useSessionStore。
 * 管理 Thread 内的消息列表、输入、生成状态等。
 * 消息列表使用 shallowRef 以避免深度响应性能问题。
 */

import type {
  ConversationMessageProjection,
  InteractionMode,
  LiveContextBudget,
  StatusSurfaceProps,
  SurfaceFrame,
} from '@infos/shared'
import { resolveExecutionMode, type ExecutionMode } from '@infos/shared'
import { defineStore } from 'pinia'
import { ref, shallowRef, computed, onScopeDispose } from 'vue'
import { chatApi } from '../api/modules/chatApi'
import { threadsApi } from '../api/modules/threadsApi'
import { ApiError } from '../api/errors'
import type { ThreadChannel, ThreadAttachmentInfo } from '../api/modules/threadsApi'
import { logger } from '../lib/logger'
import { useCompositorStore } from './useCompositorStore'
import { createPendingTurnTracker } from './threadPendingTurn'

export interface RagFailureTrace {
  kind: 'embedding' | 'rag'
  message: string
}

/** 聊天消息（保持与旧 ChatMessage 接口兼容，避免组件迁移时改动过大） */
export interface ChatMessage {
  executionPause?: ConversationMessageProjection['executionPause']
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  spokenReply?: string
  /** Assistant 原始转写，用于按需展开 Thinking 标签内容。 */
  rawContent?: string | null
  /** 时间戳 (ISO) */
  timestamp: string
  /** 对话对 ID，用于精确级联删除。 */
  pairId?: string | null
  publicationId?: string | null
  executionId?: string | null
  executionRecord?: boolean
  sourceMessages?: import('@infos/shared').ConversationSource[]
  revision?: number
  /** 当前流式消息对应的 Internal Surface。 */
  surfaceId?: string
  /** 当前回复携带的 RAG 降级轨迹。 */
  ragFailureTrace?: RagFailureTrace
  /** Assistant 可见输出的总 Token。 */
  outputTokens?: number
  /** 是否正在流式生成中 */
  isStreaming?: boolean
  /** 发送者 ID (多 Agent 场景) */
  senderId?: string
  /** 用户消息附带的图片 URLs（旧字段兼容） */
  images?: string[]
  /** 持久化附件 */
  attachments?: ThreadAttachmentInfo[]
  /** 是否为持久化的图片理解文字档案。 */
  imageTranscription?: boolean
  /**
   * 发送后立即显示的用户消息（尚未出现在服务端快照里）。
   * afterId 是发送时最后一条持久消息的 ID，快照里出现更新的用户消息时由它接替。
   */
  localPending?: { afterId: number; queueId?: string; generation: number }
  /** 工具调用信息 */
  toolCalls?: Array<{
    name: string
    args: string
    callId?: string
    result?: string
    isError?: boolean
    /** 工具执行耗时（毫秒） */
    durationMs?: number
  }>
}

/** 生成状态 */
export type GenerationState =
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'tool_assembling'
  | 'tool_calling'

type ThreadLoadResult =
  | { status: 'loaded'; threadId: string }
  | { status: 'superseded' }
  | { status: 'failed'; error: Error }

export const useThreadStore = defineStore('thread', () => {
  const compositor = useCompositorStore()
  // ── 状态 ──
  /** 当前 Thread ID */
  const threadId = ref<string>('')
  const threadKind = ref<'main' | 'side'>('side')
  const canFork = ref(false)
  const threadGeneration = ref(1)
  const selectedThreads = new Map<string, string>()
  function rememberThread(agent: string, id: string): void {
    selectedThreads.set(agent, id)
    try { sessionStorage.setItem(`infos:conversation:${agent}`, id) } catch { /* 窗口内仍保留选择。 */ }
  }
  /** 当前频道 */
  const channel = ref<ThreadChannel>('desktop')
  const interactionMode = ref<InteractionMode>('chat')
  const executionMode = ref<ExecutionMode>('manual')

  /** 消息列表 (shallowRef 避免深度代理) */
  const messages = shallowRef<ChatMessage[]>([])

  /** 当前生成状态 */
  const generationState = ref<GenerationState>('idle')

  /** 模型调用前自动 RAG 的实时阶段文案。 */
  const ragProgressMessage = ref<string | null>(null)
  const ragFailureTrace = ref<RagFailureTrace | null>(null)

  /** 用户输入 */
  const inputText = ref('')

  /** 当前正在生成的消息 ID */
  const streamingMessageId = ref<string | null>(null)

  /** 当前 Thread 所属 Agent */
  const agentId = ref<string>('pero')

  /** 当前会话每轮模型请求的上下文占用，随 Surface 增量更新，不累计多轮消费。 */
  const liveContextBudget = computed<LiveContextBudget | null>(() => {
    let latest: LiveContextBudget | null = null
    for (const surface of compositor.surfaces.values()) {
      if (
        surface.state !== 'open' ||
        surface.threadId !== threadId.value ||
        surface.principalId !== agentId.value
      )
        continue
      const status = surface.nodes.find((node) => node.kind === 'status')
      const budget = (status?.props as StatusSurfaceProps | undefined)?.contextBudget
      if (budget && (!latest || budget.updatedAt >= latest.updatedAt)) latest = budget
    }
    return latest
  })

  /** 历史记录加载状态 */
  const isLoadingHistory = ref(false)
  /** 仅描述正在切换的目标，普通刷新不触发导航动效。 */
  const navigationTarget = shallowRef<{ agentId: string; threadId?: string } | null>(null)
  const isLoadingOlderHistory = ref(false)
  const hasMoreHistory = ref(false)
  const historyCursor = ref<string | undefined>(undefined)
  const HISTORY_PAGE_SIZE = 60

  /** 历史记录加载错误 */
  const historyError = ref<string | null>(null)

  /**
   * 消息加载请求序号（非响应式）。
   * 每次 loadThreadMessages 递增；响应返回时若序号已落后，说明有更新的加载请求，
   * 直接丢弃本次结果，避免快速切换会话时旧响应覆盖新会话（竞态防护，等价于任务系统的串行链锁）。
   */
  let loadGeneration = 0
  /** 最新 Thread 查询序号，与具体消息加载分离，避免嵌套加载互相误判过期。 */
  let latestGeneration = 0
  /** 所有最近会话入口共享请求，主窗口与聊天组件不能互相取消同一目标的初始化。 */
  const loadingLatestThreads = new Map<
    string,
    { generation: number; operation: Promise<ThreadLoadResult> }
  >()

  const {
    renderKey,
    inheritStreamingRenderKey,
    clearRenderKeys,
    adoptPendingMessages,
    beginPendingTurn,
    beginPendingRegeneration,
    cancelPendingTurn,
  } = createPendingTurnTracker({
    messages,
    threadId,
    threadKind,
    threadGeneration,
    agentId,
    streamingMessageId,
    generationState,
    ragFailureTrace,
    ragProgressMessage,
    installLocalMessageSurface,
  })

  // ── 动作 ──

  function installLocalMessageSurface(
    localId: string,
    content: string,
    attachments: import('../api/modules/attachmentsApi').AttachmentInfo[] = [],
  ): string {
    return compositor.installLocalMessage({
      localId,
      threadId: threadId.value,
      threadGeneration: threadGeneration.value,
      principalId: agentId.value,
      content,
      attachments,
    })
  }

  /** 添加消息 (触发 shallowRef 更新) */
  function addMessage(msg: ChatMessage) {
    messages.value = [...messages.value, msg]
  }

  /** 直接替换当前 Thread 消息，用于服务端历史回灌 */
  function setMessages(nextMessages: ChatMessage[]) {
    messages.value = [...nextMessages]
  }

  /** 将 Projection 消息映射为仅承担布局与业务操作的本地 Shell。 */
  function fromProjection(message: ConversationMessageProjection): ChatMessage {
    return {
      id: message.messageId,
      role: message.role,
      content: message.content,
      spokenReply: message.spokenReply,
      executionPause: message.executionPause,
      rawContent: message.rawContent,
      timestamp: message.timestamp,
      pairId: message.pairId,
      publicationId: message.publicationId,
      executionId: message.executionId,
      executionRecord: message.executionRecord,
      sourceMessages: message.sourceMessages,
      revision: message.revision,
      surfaceId: `conversation-message:${message.messageId}`,
      senderId: message.senderId ?? message.agentId ?? undefined,
      attachments: message.attachments.map((item) => ({
        id: item.id,
        threadId: message.threadId,
        messageId: Number(message.messageId),
        kind: item.kind as ThreadAttachmentInfo['kind'],
        originalName: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        contextPolicy: 'once',
        status: 'bound',
      })),
      imageTranscription: message.imageTranscription,
      outputTokens: message.outputTokens,
      isStreaming: false,
    }
  }

  function openSurfaceForThread(targetThreadId: string) {
    return [...compositor.surfaces.values()]
      .filter(
        (surface) =>
          surface.threadId === targetThreadId &&
          surface.principalId === agentId.value &&
          surface.state === 'open',
      )
      .sort((left, right) => right.sequence - left.sequence)[0]
  }

  function generationStateFromSurface(
    surface: ReturnType<typeof openSurfaceForThread>,
  ): GenerationState {
    const status = surface?.nodes.find((node) => node.kind === 'status')
    const state = (status?.props as { state?: string } | undefined)?.state
    if (state === 'assembling') return 'tool_assembling'
    if (state === 'calling') return 'tool_calling'
    if (state === 'generating') return 'generating'
    return 'thinking'
  }

  function restoreStreamingShell(
    persisted: ChatMessage[],
    targetThreadId: string,
    targetAgentId: string,
    sameConversation: boolean,
  ): ChatMessage[] {
    const surface = openSurfaceForThread(targetThreadId)
    const existing = sameConversation
      ? messages.value.find(
          (message) => message.isStreaming && (!surface || message.surfaceId === surface.surfaceId),
        )
      : undefined
    if (!surface && existing && generationState.value !== 'idle') {
      streamingMessageId.value = existing.id
      return [...persisted.filter((message) => message.id !== existing.id), existing]
    }
    if (!surface) {
      generationState.value = 'idle'
      streamingMessageId.value = null
      return persisted
    }
    const shell: ChatMessage = existing ?? {
      id: `streaming:${surface.executionId ?? surface.surfaceId}`,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      senderId: targetAgentId,
      surfaceId: surface.surfaceId,
      isStreaming: true,
    }
    streamingMessageId.value = shell.id
    generationState.value = generationStateFromSurface(surface)
    return [...persisted.filter((message) => message.id !== shell.id), shell]
  }

  interface CachedThreadSnapshot {
    threadId: string
    agentId: string
    channel: ThreadChannel
    threadKind: 'main' | 'side'
    canFork: boolean
    threadGeneration: number
    interactionMode: InteractionMode
    executionMode: ExecutionMode
    projection: import('@infos/shared').ConversationProjectionSnapshot
    messages: ChatMessage[]
    historyCursor: string | undefined
    hasMoreHistory: boolean
  }
  const THREAD_CACHE_LIMIT = 12
  const threadSnapshotCache = new Map<string, CachedThreadSnapshot>()

  /** 清除失效会话的快照、Surface 和窗口选择，供删除与失效恢复共用。 */
  function forgetThread(targetThreadId: string, targetAgentId: string): void {
    threadSnapshotCache.delete(targetThreadId)
    if (selectedThreads.get(targetAgentId) === targetThreadId) selectedThreads.delete(targetAgentId)
    try {
      const key = `infos:conversation:${targetAgentId}`
      if (sessionStorage.getItem(key) === targetThreadId) sessionStorage.removeItem(key)
    } catch { /* 窗口内选择已清理。 */ }
    for (const [id, surface] of compositor.surfaces)
      if (surface.threadId === targetThreadId) compositor.dispose(id)
    if (navigationTarget.value?.threadId === targetThreadId) {
      loadGeneration++
      isLoadingHistory.value = false
      navigationTarget.value = null
    }
  }

  function writeThreadCache(entry: CachedThreadSnapshot): void {
    threadSnapshotCache.delete(entry.threadId)
    threadSnapshotCache.set(entry.threadId, entry)
    while (threadSnapshotCache.size > THREAD_CACHE_LIMIT) {
      const oldest = threadSnapshotCache.keys().next().value
      if (oldest === undefined) break
      threadSnapshotCache.delete(oldest)
      if (oldest !== threadId.value) {
        compositor.disposeScope(`conversation:${oldest}`)
      }
    }
  }

  function mergeProjectionForCache(
    previous: import('@infos/shared').ConversationProjectionSnapshot | undefined,
    incoming: import('@infos/shared').ConversationProjectionSnapshot,
  ): import('@infos/shared').ConversationProjectionSnapshot {
    if (
      !previous ||
      (incoming.threadGeneration !== undefined &&
        incoming.threadGeneration !== previous.threadGeneration)
    ) {
      return incoming
    }
    const deleted = new Set(incoming.deletedMessageIds ?? [])
    const bySurfaceId = new Map(previous.surfaces.map((item) => [item.surfaceId, item]))
    for (const item of incoming.surfaces) bySurfaceId.set(item.surfaceId, item)
    const byMessageId = new Map(previous.messages.map((item) => [item.messageId, item]))
    for (const item of incoming.messages) byMessageId.set(item.messageId, item)
    for (const id of deleted) {
      byMessageId.delete(id)
      bySurfaceId.delete(`conversation-message:${id}` as import('@infos/shared').SurfaceId)
    }
    return {
      ...previous,
      ...incoming,
      messages: [...byMessageId.values()],
      surfaces: [...bySurfaceId.values()],
    }
  }

  function syncActiveThreadCache(
    incomingProjection?: import('@infos/shared').ConversationProjectionSnapshot,
  ): void {
    const activeId = threadId.value
    if (!activeId) return
    const existing = threadSnapshotCache.get(activeId)
    const projection = incomingProjection
      ? mergeProjectionForCache(existing?.projection, incomingProjection)
      : existing?.projection
    if (!projection) return
    const persisted = messages.value.filter(
      (message) => !message.isStreaming && !message.localPending,
    )
    writeThreadCache({
      threadId: activeId,
      agentId: agentId.value,
      channel: channel.value,
      threadKind: threadKind.value,
      canFork: canFork.value,
      threadGeneration: threadGeneration.value,
      interactionMode: interactionMode.value,
      executionMode: executionMode.value,
      projection,
      messages: persisted,
      historyCursor: historyCursor.value,
      hasMoreHistory: hasMoreHistory.value,
    })
  }

  function applyCachedSnapshot(cached: CachedThreadSnapshot): void {
    clearRenderKeys()
    threadId.value = cached.threadId
    threadKind.value = cached.threadKind
    canFork.value = cached.canFork
    threadGeneration.value = cached.threadGeneration
    agentId.value = cached.agentId
    channel.value = cached.channel
    interactionMode.value = cached.interactionMode
    executionMode.value = cached.executionMode
    historyCursor.value = cached.historyCursor
    hasMoreHistory.value = cached.hasMoreHistory
    historyError.value = null
    compositor.mergeSnapshot(cached.projection)
    messages.value = restoreStreamingShell(cached.messages, cached.threadId, cached.agentId, false)
  }

  /** 加载权威 Projection；过期响应、真实失败与成功具有不同结果。 */
  async function loadThreadProjection(
    nextThreadId: string,
    currentAgentId: string,
    signal?: AbortSignal,
  ): Promise<ThreadLoadResult> {
    if (!nextThreadId || signal?.aborted) return { status: 'superseded' }
    let sameConversation = threadId.value === nextThreadId && agentId.value === currentAgentId
    const cached = !sameConversation ? threadSnapshotCache.get(nextThreadId) : undefined
    const hydratedFromCache = Boolean(cached && cached.agentId === currentAgentId)
    if (hydratedFromCache && cached) {
      applyCachedSnapshot(cached)
      sameConversation = true
    }

    const generation = ++loadGeneration
    if (!hydratedFromCache) {
      navigationTarget.value =
        threadId.value !== nextThreadId || agentId.value !== currentAgentId
          ? { agentId: currentAgentId, threadId: nextThreadId }
          : null
      isLoadingHistory.value = true
    } else {
      navigationTarget.value = null
      isLoadingHistory.value = false
    }
    historyError.value = null
    const abandon = () => {
      if (generation !== loadGeneration) return
      // 停止或替换恢复任务后，迟到的快照不能把界面重新改成执行中。
      loadGeneration++
      isLoadingHistory.value = false
      navigationTarget.value = null
    }
    signal?.addEventListener('abort', abandon, { once: true })
    try {
      const [threadResponse, projectionResponse] = await Promise.all([
        threadsApi.get(nextThreadId, { page: 1, pageSize: 1 }),
        threadsApi.getProjection(nextThreadId, { pageSize: HISTORY_PAGE_SIZE }),
      ])
      if (generation !== loadGeneration) return { status: 'superseded' }
      const thread = threadResponse.data?.thread
      const projection = projectionResponse.data
      if (!thread || !projection) throw new Error('服务端未返回 Conversation Projection')
      if (projection.threadGeneration !== undefined && projection.threadGeneration < thread.generation)
        return loadThreadProjection(nextThreadId, currentAgentId, signal)
      if (thread.agentId !== currentAgentId || projection.principalId !== currentAgentId) {
        threadSnapshotCache.delete(nextThreadId)
        throw new Error(
          `会话归属不匹配：${thread.id} 属于 ${thread.agentId}，不是 ${currentAgentId}`,
        )
      }
      const resolvedGeneration = projection.threadGeneration ?? thread.generation
      const resolvedExecutionMode = resolveExecutionMode(
        thread.executionMode,
        thread.autoExecuteTools,
      )
      threadId.value = thread.id
      threadKind.value = thread.threadKind
      canFork.value = thread.canFork
      threadGeneration.value = resolvedGeneration
      rememberThread(thread.agentId, thread.id)
      agentId.value = thread.agentId
      channel.value = thread.channel
      interactionMode.value = thread.interactionMode
      executionMode.value = resolvedExecutionMode
      // 持久历史不含尚未提交的回复；同步用户消息时保留同会话的实时画面。
      compositor.flush()
      const liveSurfaces = sameConversation
        ? [...compositor.surfaces.values()].filter(
            (surface) =>
              surface.threadId === thread.id &&
              surface.principalId === currentAgentId &&
              surface.state === 'open',
          )
        : []
      compositor.replaceSnapshot(projection)
      for (const surface of liveSurfaces) {
        const committed = projection.surfaces.some(
          (item) =>
            item.executionId && item.executionId === surface.executionId && item.state !== 'open',
        )
        if (!committed) compositor.install(surface)
      }
      historyCursor.value = projection.beforeCursor
      hasMoreHistory.value = projection.hasMoreBefore ?? false
      const existing = new Map<string, ChatMessage>(
        messages.value.map((message) => [message.id, message]),
      )
      const persisted = projection.messages.map(fromProjection).map((message) => {
        const current = existing.get(message.id)
        return current && current.revision === message.revision ? current : message
      })
      writeThreadCache({
        threadId: thread.id,
        agentId: thread.agentId,
        channel: thread.channel,
        threadKind: thread.threadKind,
        canFork: thread.canFork,
        threadGeneration: resolvedGeneration,
        interactionMode: thread.interactionMode,
        executionMode: resolvedExecutionMode,
        projection,
        messages: persisted,
        historyCursor: projection.beforeCursor,
        hasMoreHistory: projection.hasMoreBefore ?? false,
      })
      // 回合进行中，快照还没包含的本地用户消息要留在原位，排在「正在思考」占位之前。
      const pending = sameConversation
        ? adoptPendingMessages(persisted, generationState.value !== 'idle')
        : []
      messages.value = restoreStreamingShell(
        [...persisted, ...pending],
        thread.id,
        thread.agentId,
        sameConversation,
      )
      return { status: 'loaded', threadId: thread.id }
    } catch (err) {
      if (generation !== loadGeneration) return { status: 'superseded' }
      const error = err instanceof Error ? err : new Error(String(err))
      if (!hydratedFromCache) historyError.value = error.message
      logger.error('ThreadStore', __t('logs.frontend.useThreadStore', 'Thread 消息加载失败'), error)
      return { status: 'failed', error }
    } finally {
      signal?.removeEventListener('abort', abandon)
      if (generation === loadGeneration) {
        isLoadingHistory.value = false
        navigationTarget.value = null
      }
    }
  }

  /** 显式选择历史会话时，取消尚未完成的最近会话恢复。 */
  async function loadThreadMessages(
    nextThreadId: string,
    currentAgentId: string,
    signal?: AbortSignal,
  ) {
    if (!nextThreadId) return { status: 'superseded' } as const
    latestGeneration++
    return loadThreadProjection(nextThreadId, currentAgentId, signal)
  }

  async function loadOlderMessages(): Promise<number> {
    if (!threadId.value || !hasMoreHistory.value || isLoadingOlderHistory.value) return 0
    isLoadingOlderHistory.value = true
    try {
      const response = await threadsApi.getProjection(threadId.value, {
        beforeCursor: historyCursor.value,
        pageSize: HISTORY_PAGE_SIZE,
      })
      const projection = response.data
      if (!projection || projection.threadId !== threadId.value) return 0
      if (projection.threadGeneration !== undefined && projection.threadGeneration !== threadGeneration.value) return 0
      compositor.mergeSnapshot(projection)
      const existing = new Map(messages.value.map((message) => [message.id, message]))
      const older = projection.messages.map(fromProjection).map((message) => {
        const current = existing.get(message.id)
        return current && current.revision === message.revision ? current : message
      })
      const additions = older.filter((message) => !existing.has(message.id))
      messages.value = [...additions, ...messages.value]
      historyCursor.value = projection.beforeCursor
      hasMoreHistory.value = projection.hasMoreBefore ?? false
      return additions.length
    } catch (error) {
      logger.error('ThreadStore', __t('logs.frontend.useThreadStore', '更早历史加载失败'), error)
      return 0
    } finally {
      isLoadingOlderHistory.value = false
    }
  }

  /** 加载指定 Agent / Channel 的最新 Thread（命中本地快照时 0ms 秒开并静默校准，消除串行预检往返） */
  function loadLatestThread(
    currentAgentId: string,
    nextChannel: ThreadChannel = 'desktop',
  ): Promise<ThreadLoadResult> {
    const key = `${currentAgentId}:${nextChannel}`
    const pending = loadingLatestThreads.get(key)
    if (pending?.generation === latestGeneration) return pending.operation

    let selected = selectedThreads.get(currentAgentId)
    try {
      selected ??= sessionStorage.getItem(`infos:conversation:${currentAgentId}`) ?? undefined
    } catch {
      /* 使用窗口内选择。 */
    }
    const cached = selected ? threadSnapshotCache.get(selected) : undefined
    const hydratedFromCache = Boolean(
      cached && cached.agentId === currentAgentId && cached.channel === nextChannel,
    )

    if (hydratedFromCache && cached) {
      latestGeneration++
      loadGeneration++
      applyCachedSnapshot(cached)
      navigationTarget.value = null
      isLoadingHistory.value = false
    } else {
      // 未命中缓存时清除旧 Thread，禁止 UI 在异步窗口内形成“新 Agent + 旧 Thread”。
      clearThread()
      agentId.value = currentAgentId
      navigationTarget.value = { agentId: currentAgentId }
      channel.value = nextChannel
      isLoadingHistory.value = true
      historyError.value = null
    }
    const generation = latestGeneration
    const operation = (async (): Promise<ThreadLoadResult> => {
      try {
        if (selected) {
          const directResult = await loadThreadProjection(selected, currentAgentId)
          if (generation !== latestGeneration) return { status: 'superseded' }
          if (directResult.status === 'loaded') return directResult
          if (directResult.status === 'superseded') return directResult
          const isStaleSelection =
            (directResult.error instanceof ApiError && directResult.error.code === 'NOT_FOUND') ||
            directResult.error.message.startsWith('会话归属不匹配')
          if (!isStaleSelection) return directResult
          // 若所记历史会话已不存在或归属变更，清除失效记忆并回退至服务端最新会话
          forgetThread(selected, currentAgentId)
          historyError.value = null
        }
        const latest = (
          await threadsApi.getLatest({ agentId: currentAgentId, channel: nextChannel })
        ).data?.thread
        if (generation !== latestGeneration) return { status: 'superseded' }
        if (!latest) throw new Error('服务端未返回最近会话')
        if (latest.agentId !== currentAgentId) throw new Error('服务端返回了其他 Agent 的最新会话')

        channel.value = latest.channel || nextChannel
        const result = await loadThreadProjection(latest.id, currentAgentId)
        if (generation !== latestGeneration) return { status: 'superseded' }
        return result
      } catch (err) {
        if (generation !== latestGeneration) return { status: 'superseded' }
        const error = err instanceof Error ? err : new Error(String(err))
        if (!hydratedFromCache) historyError.value = error.message
        logger.error(
          'ThreadStore',
          __t('logs.frontend.useThreadStore', '最新 Thread 加载失败'),
          error,
        )
        return { status: 'failed', error }
      } finally {
        if (generation === latestGeneration) {
          isLoadingHistory.value = false
          navigationTarget.value = null
        }
      }
    })()
    const tracked = operation.finally(() => {
      if (loadingLatestThreads.get(key)?.operation === tracked) loadingLatestThreads.delete(key)
    })
    loadingLatestThreads.set(key, { generation, operation: tracked })
    return tracked
  }

  /** 激活指定 Agent 的最近 conversation Thread；后端在不存在时原子创建。 */
  async function ensureLatestThread(
    currentAgentId: string,
    nextChannel: ThreadChannel = 'desktop',
  ): Promise<string | null> {
    // 页面重新激活复用已经加载的会话；显式刷新仍走 loadLatestThread。
    if (
      threadId.value &&
      agentId.value === currentAgentId &&
      channel.value === nextChannel &&
      !isLoadingHistory.value &&
      !historyError.value
    )
      return threadId.value
    const result = await loadLatestThread(currentAgentId, nextChannel)
    if (result.status === 'failed') throw result.error
    if (result.status === 'superseded') return null
    return result.threadId
  }

  /** 刷新当前 Thread 消息，用服务端持久化记录校准本地消息 ID。 */
  async function refreshCurrentThread(currentAgentId = agentId.value) {
    // 审批与网络恢复触发的后台刷新不能抢占用户正在选择的会话。
    if (
      !threadId.value ||
      navigationTarget.value ||
      isLoadingHistory.value ||
      currentAgentId !== agentId.value
    )
      return
    await loadThreadMessages(threadId.value, currentAgentId)
  }

  function mergeProjectionMessages(
    snapshot: import('@infos/shared').ConversationProjectionSnapshot,
  ): ChatMessage[] {
    const existing = new Map<string, ChatMessage>(
      messages.value.map((message) => [message.id, message]),
    )
    const deleted = new Set(snapshot.deletedMessageIds ?? [])
    const projected = snapshot.messages.map(fromProjection).map((message) => {
      const current = existing.get(message.id)
      return current && current.revision === message.revision ? current : message
    })
    adoptPendingMessages(projected, false)
    const firstProjectedId = Number(projected.find((message) => !message.executionRecord)?.id)
    const retainedHistory = Number.isSafeInteger(firstProjectedId)
      ? messages.value.filter(
          (message) =>
            (Number.isSafeInteger(Number(message.id)) && Number(message.id) < firstProjectedId) ||
            (message.executionRecord && Boolean(message.sourceMessages?.length) &&
              message.sourceMessages!.every((source) => source.messageId < firstProjectedId)),
        )
      : []
    return [...retainedHistory, ...projected].filter((message) => !deleted.has(message.id))
  }

  function applyProjection(snapshot: import('@infos/shared').ConversationProjectionSnapshot): void {
    compositor.mergeSnapshot(snapshot)
    if (snapshot.threadId !== threadId.value || snapshot.principalId !== agentId.value) {
      threadSnapshotCache.delete(snapshot.threadId)
      return
    }
    if (snapshot.threadGeneration !== undefined && snapshot.threadGeneration < threadGeneration.value) return
    if (snapshot.threadGeneration !== undefined && snapshot.threadGeneration > threadGeneration.value) {
      messages.value = []
      threadGeneration.value = snapshot.threadGeneration
    }
    messages.value = mergeProjectionMessages(snapshot)
    historyCursor.value = messages.value.find((message) => !message.executionRecord)?.id
    const formalCount = messages.value.filter((message) => !message.executionRecord).length
    hasMoreHistory.value = formalCount < (snapshot.totalMessages ?? formalCount)
    syncActiveThreadCache(snapshot)
  }

  /** 应用实时 Surface 帧，并在 commit 时把临时消息原子归一为持久消息 Shell。 */
  function applySurfaceFrame(frame: SurfaceFrame): void {
    if (frame.threadId === threadId.value && frame.threadGeneration !== undefined) {
      if (frame.threadGeneration < threadGeneration.value) return
      if (frame.threadGeneration > threadGeneration.value) {
        messages.value = []
        threadGeneration.value = frame.threadGeneration
        threadSnapshotCache.delete(frame.threadId)
        compositor.invalidateThreadGeneration(frame.threadId, frame.threadGeneration)
      }
    }
    const owner =
      frame.operation.type === 'surface.open'
        ? frame.operation
        : frame.operation.type === 'surface.commit' || frame.operation.type === 'surface.publish' || frame.operation.type === 'surface.settled'
          ? frame.operation.snapshot
          : compositor.get(frame.surfaceId)
    compositor.enqueue(frame)
    if (!owner || owner.threadId !== threadId.value || owner.principalId !== agentId.value) {
      if (
        owner &&
        (frame.operation.type === 'surface.commit' ||
          frame.operation.type === 'surface.publish' ||
          frame.operation.type === 'surface.settled')
      ) {
        threadSnapshotCache.delete(owner.threadId)
      }
      return
    }
    if (frame.operation.type === 'surface.open') {
      if (!streamingMessageId.value) return
      messages.value = messages.value.map((message) =>
        message.id === streamingMessageId.value
          ? { ...message, surfaceId: frame.surfaceId }
          : message,
      )
      return
    }
    if (frame.operation.type === 'surface.publish' || frame.operation.type === 'surface.settled') {
      const shell = messages.value.find((message) => message.id === streamingMessageId.value)
      compositor.mergeSnapshot(frame.operation.snapshot)
      messages.value = mergeProjectionMessages(frame.operation.snapshot)
      if (frame.operation.type === 'surface.publish' && shell && !/^\d+$/.test(shell.id))
        messages.value.push(shell)
      syncActiveThreadCache(frame.operation.snapshot)
      return
    }
    if (frame.operation.type !== 'surface.commit') return
    inheritStreamingRenderKey(frame.operation.message.messageId)
    compositor.mergeSnapshot(frame.operation.snapshot)
    messages.value = mergeProjectionMessages(frame.operation.snapshot)
    const committedMessageId = frame.operation.message.messageId
    if (ragFailureTrace.value) {
      const failure = { ...ragFailureTrace.value }
      messages.value = messages.value.map((message) =>
        message.id === committedMessageId ? { ...message, ragFailureTrace: failure } : message,
      )
    }
    streamingMessageId.value = committedMessageId
    syncActiveThreadCache(frame.operation.snapshot)
  }

  function setRagProgress(message: string | null): void {
    ragProgressMessage.value = message
  }

  function setRagFailure(trace: RagFailureTrace | null): void {
    ragFailureTrace.value = trace
  }

  /** 没收到失败帧时，也在当前消息上直接显示错误，不依赖历史回灌成功。 */
  function failStreaming(code: string, message: string): void {
    compositor.flush()
    const id = streamingMessageId.value
    const shell = messages.value.find((item) => item.id === id)
    if (!shell) return
    const existing = compositor.get(shell.surfaceId)
    const surfaceId = (shell.surfaceId ??
      `local-error:${shell.id}`) as import('@infos/shared').SurfaceId
    compositor.install({
      surfaceId,
      threadGeneration: threadGeneration.value,
      generation: existing?.generation ?? `local:${shell.id}`,
      threadId: threadId.value,
      principalId: agentId.value,
      revision: (existing?.revision ?? 0) + 1,
      sequence: existing?.sequence ?? 0,
      state: 'failed',
      nodes: [
        ...(existing?.nodes.filter((node) => node.kind !== 'status' && node.kind !== 'error') ??
          []),
        {
          nodeId: `${surfaceId}:error` as import('@infos/shared').SurfaceNodeId,
          kind: 'error',
          lifecycle: 'stable',
          revision: 1,
          props: { code, message },
        },
      ],
    })
    messages.value = messages.value.map((item) => (item.id === id ? { ...item, surfaceId } : item))
  }

  /** 完成流式生成 */
  function finishStreaming() {
    compositor.flush()
    const list = messages.value
    if (list.length) {
      const last = list[list.length - 1]!
      const updated = { ...last, isStreaming: false }
      messages.value = [...list.slice(0, -1), updated]
    }

    generationState.value = 'idle'
    ragProgressMessage.value = null
    ragFailureTrace.value = null
    streamingMessageId.value = null
  }

  /** 清空当前 Thread */
  function clearThread() {
    latestGeneration++
    loadGeneration++
    isLoadingHistory.value = false
    navigationTarget.value = null
    messages.value = []
    clearRenderKeys()
    threadId.value = ''
    threadKind.value = 'side'
    canFork.value = false
    threadGeneration.value = 1
    interactionMode.value = 'chat'
    executionMode.value = 'manual'
    generationState.value = 'idle'
    ragProgressMessage.value = null
    ragFailureTrace.value = null
    streamingMessageId.value = null
    inputText.value = ''
    historyError.value = null
    historyCursor.value = undefined
    hasMoreHistory.value = false
    isLoadingOlderHistory.value = false
  }

  /**
   * 编辑指定消息内容 (本地 + 后端同步)
   * 后端路由：PATCH /threads/:threadId/messages/:msgId
   */
  async function resolvePersistedMessage(
    id: string,
    origin?: { message: ChatMessage; occurrenceFromEnd: number },
  ): Promise<ChatMessage> {
    const requestThread = threadId.value,
      requestAgent = agentId.value
    const snapshot = messages.value.find((message) => message.id === id) ?? origin?.message
    if (!requestThread || !snapshot) throw new Error('消息已变化，请重新打开编辑')
    if (/^\d+$/.test(id)) return snapshot
    const reference = origin?.message ?? snapshot
    const matching = messages.value.filter(
      (message) => message.role === reference.role && message.content === reference.content,
    )
    const occurrenceFromEnd =
      origin?.occurrenceFromEnd ?? Math.max(0, matching.length - 1 - matching.indexOf(snapshot))
    await refreshCurrentThread(requestAgent)
    if (threadId.value !== requestThread || agentId.value !== requestAgent)
      throw new Error('会话已切换，已保留编辑内容')
    const candidates = messages.value.filter(
      (message) => /^\d+$/.test(message.id) && message.role === reference.role,
    )
    const target =
      candidates.find(
        (message) => reference.surfaceId && message.surfaceId === reference.surfaceId,
      ) ??
      candidates.find((message) => reference.pairId && message.pairId === reference.pairId) ??
      candidates
        .filter((message) => message.content === reference.content)
        .at(-1 - occurrenceFromEnd)
    if (!target) throw new Error('消息尚未完成同步，请稍后重试')
    return target
  }

  /**
   * 乐观预览已编辑的消息文本及对应 Surface，失败时可通过返回函数无痕回滚。
   */
  function previewEditedMessage(id: string, newContent: string): (() => void) | null {
    const target = messages.value.find((message) => message.id === id)
    if (!target) return null
    const previousMessage = target
    const rollbackSurface = compositor.previewMarkdownText(target.surfaceId, newContent)
    messages.value = messages.value.map((message) =>
      message.id === id ? { ...message, content: newContent } : message,
    )
    return () => {
      rollbackSurface?.()
      messages.value = messages.value.map((message) =>
        message.id === id && message.content === newContent ? previousMessage : message,
      )
    }
  }

  async function editMessage(
    id: string,
    newContent: string,
    expectedRevision?: number,
    origin?: { message: ChatMessage; occurrenceFromEnd: number },
  ) {
    const requestThread = threadId.value,
      requestAgent = agentId.value
    const target = await resolvePersistedMessage(id, origin)
    if (threadId.value !== requestThread || agentId.value !== requestAgent)
      throw new Error('会话已切换')
    const response = await chatApi.editMessage(
      requestThread,
      target.id,
      newContent,
      expectedRevision ?? target.revision,
    )
    if (!response.data) throw new Error('服务端未返回保存后的消息')
    if (threadId.value === requestThread && agentId.value === requestAgent) {
      compositor.mergeSnapshot(response.data)
      const updated = new Map(response.data.messages.map((message) => [message.messageId, message]))
      messages.value = messages.value.map((message) => {
        const changed = updated.get(message.id)
        return changed ? fromProjection(changed) : message
      })
      syncActiveThreadCache(response.data)
    } else {
      threadSnapshotCache.delete(requestThread)
    }
    const saved = response.data.messages.find((message) => message.messageId === target.id)
    return {
      message: saved ? fromProjection(saved) : { ...target, content: newContent, revision: (target.revision ?? 1) + 1 },
      threadId: requestThread,
      projection: response.data,
    }
  }

  /**
   * 删除指定消息 (本地 + 后端同步)
   * 后端路由：DELETE /threads/:threadId/messages/:msgId
   */
  function deleteMessage(id: string) {
    messages.value = messages.value.filter((m) => m.id !== id)
    syncActiveThreadCache()
    // 后端同步
    if (threadId.value && id) {
      chatApi.deleteMessage(threadId.value, id).catch((err) => {
        logger.error('ThreadStore', __t('logs.frontend.useThreadStore', '消息删除同步失败'), err)
      })
    }
  }

  /** 设置新 Thread */
  function startThread(
    newThreadId: string,
    newChannel: ThreadChannel = 'desktop',
    newAgentId = agentId.value,
  ) {
    clearThread()
    threadId.value = newThreadId
    channel.value = newChannel
    agentId.value = newAgentId
    rememberThread(newAgentId, newThreadId)
  }

  /** 向后端申请并切换到新 Thread */
  async function createNewThread(
    currentAgentId = agentId.value,
    nextChannel: ThreadChannel = 'desktop',
  ) {
    const generation = ++latestGeneration
    loadGeneration++
    navigationTarget.value = { agentId: currentAgentId }
    isLoadingHistory.value = true
    try {
      const res = await threadsApi.create({ agentId: currentAgentId, channel: nextChannel })
      const nextThread = res.data?.thread
      if (!nextThread) throw new Error('服务端未返回新 Thread')
      // 创建期间若用户选了其他会话，只保留新建结果，不抢回当前页面。
      if (generation !== latestGeneration) return nextThread.id
      startThread(nextThread.id, nextThread.channel || nextChannel, currentAgentId)
      threadKind.value = nextThread.threadKind
      canFork.value = nextThread.canFork
      threadGeneration.value = nextThread.generation
      interactionMode.value = nextThread.interactionMode
      executionMode.value = resolveExecutionMode(
        nextThread.executionMode,
        nextThread.autoExecuteTools,
      )
      logger.info(
        'ThreadStore',
        __t('logs.frontend.useThreadStore', '新 Thread 已创建: {0}', [nextThread.id]),
      )
      return nextThread.id
    } finally {
      if (generation === latestGeneration) {
        isLoadingHistory.value = false
        navigationTarget.value = null
      }
    }
  }

  /** 是否正在生成 (便捷 getter) */
  const isGenerating = computed(() => generationState.value !== 'idle')
  const syncOnForeground = () => {
    compositor.flush()
    if (document.hidden || isGenerating.value || isLoadingHistory.value || !threadId.value) return
    void refreshCurrentThread()
  }
  const onThreadReset = (event: Event) => {
    const data = (event as CustomEvent<{ threadId: string; generation: number }>).detail
    if (!data?.threadId || !Number.isSafeInteger(data.generation)) return
    threadSnapshotCache.delete(data.threadId)
    compositor.invalidateThreadGeneration(data.threadId, data.generation)
    if (threadId.value !== data.threadId) return
      if (data.generation < threadGeneration.value) return
    threadGeneration.value = data.generation
    generationState.value = 'idle'
    streamingMessageId.value = null
    inputText.value = ''
    void loadThreadProjection(data.threadId, agentId.value)
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('focus', syncOnForeground)
    window.addEventListener('infos:thread-reset', onThreadReset)
    window.addEventListener('online', syncOnForeground)
    window.addEventListener('pageshow', syncOnForeground)
    window.addEventListener('infos:gateway-ready', syncOnForeground)
    window.addEventListener('infos:gateway-snapshot-required', syncOnForeground)
    document.addEventListener('visibilitychange', syncOnForeground)
    onScopeDispose(() => {
      window.removeEventListener('focus', syncOnForeground)
      window.removeEventListener('infos:thread-reset', onThreadReset)
      window.removeEventListener('online', syncOnForeground)
      window.removeEventListener('pageshow', syncOnForeground)
      window.removeEventListener('infos:gateway-ready', syncOnForeground)
      window.removeEventListener('infos:gateway-snapshot-required', syncOnForeground)
      document.removeEventListener('visibilitychange', syncOnForeground)
    })
  }

  return {
    threadId,
    threadKind,
    canFork,
    threadGeneration,
    channel,
    interactionMode,
    executionMode,
    agentId,
    messages,
    generationState,
    liveContextBudget,
    ragProgressMessage,
    ragFailureTrace,
    isGenerating,
    inputText,
    streamingMessageId,
    isLoadingHistory,
    navigationTarget,
    isLoadingOlderHistory,
    hasMoreHistory,
    historyError,
    installLocalMessageSurface,
    renderKey,
    beginPendingTurn,
    beginPendingRegeneration,
    cancelPendingTurn,
    addMessage,
    setMessages,
    applyProjection,
    applySurfaceFrame,
    setRagProgress,
    setRagFailure,
    finishStreaming,
    failStreaming,
    clearThread,
    forgetThread,
    previewEditedMessage,
    editMessage,
    resolvePersistedMessage,
    deleteMessage,
    startThread,
    createNewThread,
    loadLatestThread,
    ensureLatestThread,
    loadThreadMessages,
    loadOlderMessages,
    refreshCurrentThread,
  }
})
