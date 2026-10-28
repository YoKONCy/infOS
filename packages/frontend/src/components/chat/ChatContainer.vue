<script setup lang="ts">
import PackageSlot from '../integrations/PackageSlot.vue'
import { t as __t } from '../../i18n/index'

import { copyClientText } from '../../lib/clientPlatform'

/**
 * ChatContainer — 聊天主容器
 *
 * 组装消息列表 + 输入框 + 指令遮罩，接管滚动和流式逻辑。
 * F3: 已通过 useChat composable 接入 SSE 流式对话管道。
 *
 * @props agentId - 目标 Agent ID
 * @props agentName - Agent 名称
 */
import {
  ref,
  computed,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
  nextTick,
  watch,
} from 'vue'
import ConversationSurface from '../compositor/ConversationSurface.vue'
import SurfaceTransition from '../motion/SurfaceTransition.vue'
import MessageBubble from './MessageBubble.vue'
import { isLocalOwnerMessage } from '../../lib/userMessageIdentity'
import InputBar from './InputBar.vue'
import ConversationQueue from './ConversationQueue.vue'
import { useConversationQueue } from '../../composables/chat/useConversationQueue'
import { queueErrorMessage } from '../../composables/chat/queueFeedback'
import ThreadTodo from './ThreadTodo.vue'
import DesktopControlStatus from '../desktop/DesktopControlStatus.vue'
import BrowserObserver from './BrowserObserver.vue'
import CommandOverlay from './CommandOverlay.vue'
import AgentWorkBadge from './AgentWorkBadge.vue'
import ConversationRewindDialog from './ConversationRewindDialog.vue'
import PixelIcon from '../pixel/PixelIcon.vue'
import type { ChatMessage as BubbleMessage } from './MessageBubble.vue'
import type { ActiveCommand } from './CommandOverlay.vue'
import { useChatScroll, useMessageVisibility } from '../../composables'
import { useChat } from '../../composables/chat/useChat'
import { useConversationRewind } from '../../composables/chat/useConversationRewind'
import {
  useThreadStore,
  useNotificationStore,
  useApprovalStore,
  useCompositorStore,
  useAgentStore,
} from '../../stores'
import { logger } from '../../lib/logger'
import { chatApi } from '../../api/modules/chatApi'
import type { ChatWorkspaceContext } from '../../api/modules/chatApi'
import { voiceApi } from '../../api/modules/voiceApi'
import type { AttachmentInfo } from '../../api/modules/attachmentsApi'
import type { ChatMessage as StoredMessage } from '../../stores/useThreadStore'
import { listen } from '../../utils/ipcAdapter'
import { useFileDrop } from '../../composables/chat/useFileDrop'

export interface Props {
  switching?: boolean
  /** 从共同活动带来的可编辑草稿，不自动发送。 */
  draftRequest?: { text: string; revision: number }
  /** 用户从桌宠明确请求查看的持久化消息。 */
  focusRequest?: { messageId: string; revision: number }
  /** 目标 Agent ID */
  agentId: string
  /** Agent 名称 */
  agentName?: string
  /** 当前选中 Thread；变化时加载该会话而非最新会话。 */
  threadId?: string
  /** Agent 头像 URL。 */
  agentAvatarUrl?: string
  /** 工作区窄栏模式：输入台根据容器宽度自动压缩。 */
  compactInput?: boolean
  /** 是否展示当前会话的交互浮层，包含工具审批与 Agent 提问。 */
  showApprovals?: boolean
  /** 工作区模式：向发送内容附加当前文件/终端上下文。 */
  workspaceContext?: ChatWorkspaceContext
}

const props = withDefaults(defineProps<Props>(), {
  draftRequest: undefined,
  focusRequest: undefined,
  agentName: '助手',
  threadId: '',
  agentAvatarUrl: '',
  compactInput: false,
  showApprovals: true,
  workspaceContext: undefined,
  switching: false,
})

const emit = defineEmits<{
  draftConsumed: []
  /** 当前对话完成，供外层刷新会话列表。 */
  completed: []
  /** 显式选区只随本轮发送，成功提交后由工作区清除。 */
  contextConsumed: []
}>()

const containerRef = ref<HTMLElement | null>(null)
const inputAreaRef = ref<HTMLElement | null>(null)
const inputAreaHeight = ref(112)
let inputResizeObserver: ResizeObserver | undefined
function observeInputArea() {
  if (!inputAreaRef.value || typeof ResizeObserver === 'undefined') return
  inputAreaHeight.value = inputAreaRef.value.offsetHeight
  inputResizeObserver ??= new ResizeObserver(() => {
    inputAreaHeight.value = inputAreaRef.value?.offsetHeight ?? 112
    // 清单收放时保持底部阅读位置，用户翻阅历史时不抢滚动。
    if (isAtBottom.value && !props.focusRequest && !disposed) scrollToBottom(false)
  })
  inputResizeObserver.observe(inputAreaRef.value)
}
const bubbleMessageCache = new WeakMap<object, BubbleMessage>()
let scrollFrame: number | null = null

// ── 对话管道 (F3: 真实 SSE 流) ──
const {
  messages: chatMessages,
  isGenerating,
  isLoadingHistory,
  historyError,
  sendMessage: chatSend,
  stopGeneration,
} = useChat({ channel: 'desktop' })

const threadStore = useThreadStore()
const queue = useConversationQueue()
const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null)
const fileDrop = useFileDrop({
  enabled: () => !!inputBarRef.value && !props.switching && !threadStore.navigationTarget,
  files: async (files) => {
    await inputBarRef.value?.uploadFiles(files)
  },
  directory: () =>
    notif.toast(__t('ui.attachments', '请拖入文件，文件夹请先压缩'), { type: 'warning' }),
})
const restoringQueueDraft = ref(false)
const returnedWorkspaceContext = ref<ChatWorkspaceContext | undefined>()
const draftWarnings = new Set<string>()

watch(
  () => [queue.snapshot.value.drafts, inputBarRef.value, props.switching],
  async () => {
    if (
      restoringQueueDraft.value ||
      props.switching ||
      !inputBarRef.value ||
      !queue.snapshot.value.drafts?.length
    )
      return
    restoringQueueDraft.value = true
    try {
      for (const item of queue.snapshot.value.drafts ?? []) {
        if (item.input.threadId !== threadStore.threadId) continue
        const bar = inputBarRef.value
        const historyVersion = queue.historyVersion.value
        if (
          !bar ||
          !(await bar.restoreQueuedDraft(
            item,
            () =>
              historyVersion === queue.historyVersion.value &&
              queue.snapshot.value.drafts?.some(
                (draft) => draft.id === item.id && draft.revision === item.revision,
              ) === true,
          ))
        )
          continue
        returnedWorkspaceContext.value = item.input.workspaceContext
        await queue.acknowledgeDraft(item)
      }
    } catch (error) {
      const message = `${queueErrorMessage(error)}，草稿已保留`
      if (!draftWarnings.has(message)) {
        draftWarnings.add(message)
        logger.warn('ChatContainer', __t('logs.frontend.chat', '队列草稿暂未取回'), error)
        notif.toast(message, { type: 'warning' })
      }
    } finally {
      restoringQueueDraft.value = false
    }
  },
)
watch(
  () => threadStore.threadId,
  () => {
    returnedWorkspaceContext.value = undefined
  },
)
const resumingDesktop = ref(false)
const desktopPause = computed(() => {
  const last = chatMessages.value.at(-1)
  return last?.role === 'assistant' ? last.executionPause : undefined
})
async function resumeDesktopTask(input: { threadId?: string; callId: string }) {
  if (
    resumingDesktop.value ||
    isGenerating.value ||
    props.switching ||
    threadStore.navigationTarget ||
    input.threadId !== threadStore.threadId ||
    desktopPause.value?.callId !== input.callId
  )
    return
  resumingDesktop.value = true
  try {
    await chatSend(
      '继续之前因桌面操作暂停的任务。先核对已有结果与当前状态，桌面操作前重新观察；不要重复已经成功的操作。预览生成的 HTML 请展开高级工具并使用内置浏览器。',
      [],
      [],
      'auto',
      includedContext.value,
      'continue',
    )
  } finally {
    resumingDesktop.value = false
  }
}
const currentAgent = useAgentStore()
const compositor = useCompositorStore()
const notif = useNotificationStore()
const rewind = useConversationRewind()
const approvalStore = useApprovalStore()
const playingMsgId = ref<string | null>(null)
const isLoadingAudio = ref(false)
const excludedContext = ref({ file: false, terminal: false, selection: false })
const includedContext = computed<ChatWorkspaceContext | undefined>(() => {
  const source = returnedWorkspaceContext.value ?? props.workspaceContext
  if (!source) return undefined
  return {
    filePath: excludedContext.value.file ? undefined : source.filePath,
    fileHash: excludedContext.value.file ? undefined : source.fileHash,
    fileDirty: excludedContext.value.file ? undefined : source.fileDirty,
    terminalId: excludedContext.value.terminal ? undefined : source.terminalId,
    selection:
      excludedContext.value.file || excludedContext.value.selection ? undefined : source.selection,
  }
})

watch(
  () => [
    props.workspaceContext?.filePath,
    props.workspaceContext?.terminalId,
    props.workspaceContext?.selection?.text,
  ],
  () => {
    excludedContext.value = { file: false, terminal: false, selection: false }
  },
)
let messageAudioContext: AudioContext | null = null
let messageAudioAbort: AbortController | null = null
let messageAudioSource: AudioBufferSourceNode | null = null
let audioRequest = 0
const interactionSurfaces = computed(() =>
  [...compositor.surfaces.values()].filter(
    (surface) =>
      surface.scopeId === `conversation:${threadStore.threadId || props.threadId}` &&
      !surface.messageId,
  ),
)

watch(
  () =>
    [...approvalStore.pending.values()]
      .map((request) => `${request.id}:${request.status}`)
      .join('|'),
  () => restoreProjection(),
)

// ── 消息原始转写 ──
function extractThinking(rawContent?: string | null): string | undefined {
  if (!rawContent) return undefined
  const blocks: string[] = []
  const pattern = /<(selfMinding|think|thinking|thought)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(rawContent)) !== null) {
    const content = match[2]?.trim()
    if (content) blocks.push(content)
  }
  return blocks.length > 0 ? blocks.join('\n\n') : undefined
}

// 生成结束时通知外层刷新会话列表。
watch(isGenerating, (generating, wasGenerating) => {
  if (!generating && wasGenerating) emit('completed')
})

// ── 指令遮罩状态 ──

const activeCommand = ref<ActiveCommand | null>(null)

// ── 消息列表 ──

/** 映射消息 Shell；所有可见富内容统一从 Compositor Surface 读取。 */
const messages = computed<BubbleMessage[]>(() => {
  return chatMessages.value.map((m) => {
    const surface = m.surfaceId ? compositor.get(m.surfaceId) : undefined
    const cached = bubbleMessageCache.get(m)
    if (cached && cached.surface === surface) return cached
    const hasThinkingSurface = surface?.nodes.some((node) => node.kind === 'thinking') ?? false
    const mapped: BubbleMessage = {
      id: m.id,
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content ?? '',
      thinkingContent:
        m.role === 'assistant' && !hasThinkingSurface ? extractThinking(m.rawContent) : undefined,
      timestamp: m.timestamp ? new Date(m.timestamp).getTime() : undefined,
      outputTokens: m.outputTokens,
      spokenReply: m.spokenReply,
      senderId: m.senderId,
      ragFailureTrace: m.ragFailureTrace,
      surface,
      imageTranscription: m.imageTranscription,
    }
    bubbleMessageCache.set(m, mapped)
    return mapped
  })
})

const messageCount = computed(() => messages.value.length)

// ── 滚动管理 ──

const { showScrollDown, scrollToBottom, isAtBottom, observeContent, unobserveContent } =
  useChatScroll(
    containerRef,
    messageCount,
    () =>
      !props.focusRequest ||
      focusedRequest === props.focusRequest.revision + ':' + props.focusRequest.messageId,
  )
let focusingMessage = false
let focusedRequest = ''
let disposed = false
let removeSpeechAction: (() => void) | undefined
let highlightTimer: ReturnType<typeof setTimeout> | undefined

async function focusRequestedMessage(): Promise<void> {
  const target = props.focusRequest
  if (!target || !containerRef.value || isLoadingHistory.value || focusingMessage) return
  const key = target.revision + ':' + target.messageId
  if (focusedRequest === key) return
  focusingMessage = true
  isAtBottom.value = false
  const stillRequested = () => !disposed && props.focusRequest === target
  try {
    while (
      stillRequested() &&
      !threadStore.messages.some((message) => message.id === target.messageId) &&
      threadStore.hasMoreHistory
    ) {
      const added = await threadStore.loadOlderMessages()
      if (!added) break
    }
    await nextTick()
    if (!stillRequested()) return
    const element = [
      ...(containerRef.value?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []),
    ].find((item) => item.dataset.messageId === target.messageId)
    if (!element) {
      notif.toast(__t('ui.chat', '这条回复已移除或暂时无法定位'), { type: 'info' })
      focusedRequest = key
      return
    }
    element.scrollIntoView({ block: 'center', behavior: 'instant' })
    element.tabIndex = -1
    element.focus({ preventScroll: true })
    element.classList.add('pet-message-focus')
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => element.classList.remove('pet-message-focus'), 1800)
    focusedRequest = key
  } finally {
    focusingMessage = false
  }
}
watch(
  [() => props.focusRequest, isLoadingHistory, messageCount],
  () => {
    void focusRequestedMessage()
  },
  { flush: 'post' },
)

// ── IntersectionObserver 不可见消息暂停 ──

const { observe, unobserve } = useMessageVisibility(containerRef, (element, visible) => {
  const surfaceId = element.dataset.surfaceId
  if (surfaceId) compositor.setSuspended(surfaceId, !visible)
})

function getComponentRootElement(event: unknown): Element | null {
  if (event instanceof Element) return event
  if (event && typeof event === 'object') {
    const instance = event as { el?: unknown; $el?: unknown }
    if (instance.el instanceof Element) return instance.el
    if (instance.$el instanceof Element) return instance.$el
  }
  return null
}

function onBubbleMounted(event: unknown) {
  const element = getComponentRootElement(event)
  observe(element)
  observeContent(element)
}

function onBubbleUnmounted(event: unknown) {
  const element = getComponentRootElement(event)
  unobserve(element)
  unobserveContent(element)
}

async function loadOlderWithAnchor(): Promise<void> {
  const container = containerRef.value
  if (!container || !threadStore.hasMoreHistory || threadStore.isLoadingOlderHistory) return
  const previousHeight = container.scrollHeight
  const previousTop = container.scrollTop
  const ownerThread = threadStore.threadId
  const anchor = [...container.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    (element) => element.offsetTop + element.offsetHeight >= previousTop,
  )
  const anchorOffset = anchor ? anchor.offsetTop - previousTop : 0
  const added = await threadStore.loadOlderMessages()
  if (!added || ownerThread !== threadStore.threadId || disposed) return
  const userMoved = Math.abs(container.scrollTop - previousTop) > 2
  await nextTick()
  if (userMoved) return
  // 原消息作为锚点，避免尾部同步增长被误计为头部新增历史的高度。
  if (anchor?.isConnected) container.scrollTop = anchor.offsetTop - anchorOffset
  else container.scrollTop = previousTop + container.scrollHeight - previousHeight
}

function handleMessageScroll(): void {
  if (scrollFrame !== null) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null
    const container = containerRef.value
    if (container?.scrollTop !== undefined && container.scrollTop < 240) {
      void loadOlderWithAnchor()
    }
  })
}

async function restoreMessageViewport(): Promise<void> {
  await nextTick()
}

// ── 发送消息 ──

async function handleSend(
  text: string,
  _mentions: string[],
  attachmentIds: string[],
  _attachments: AttachmentInfo[],
  imageMode: 'auto' | 'native' | 'relay',
  complete: (success: boolean) => void,
) {
  if (props.switching || threadStore.navigationTarget) {
    complete(false)
    return
  }
  const requestAgentId = props.agentId
  // 工作区上下文作为隐式请求字段发送，不拼进用户正文，避免 <workspace_context> 泄漏到气泡和历史消息。
  const workspaceContext = includedContext.value
  if (!threadStore.threadId || threadStore.agentId !== requestAgentId) {
    try {
      await threadStore.ensureLatestThread(requestAgentId, 'desktop')
    } catch {
      complete(false)
      return
    }
  }
  if (
    props.switching ||
    props.agentId !== requestAgentId ||
    threadStore.navigationTarget ||
    !threadStore.threadId ||
    threadStore.agentId !== requestAgentId
  ) {
    complete(false)
    return
  }
  const requestThreadId = threadStore.threadId
  const success = await queue.enqueue({
    threadId: requestThreadId,
    agentId: requestAgentId,
    content: text,
    attachmentIds,
    imageMode,
    workspaceContext,
  })
  if (success && threadStore.threadId === requestThreadId && props.agentId === requestAgentId) {
    returnedWorkspaceContext.value = undefined
    excludedContext.value = { file: false, terminal: false, selection: false }
    emit('contextConsumed')
  }
  complete(success)
  await nextTick()
  scrollToBottom()
}

async function handleNewThread() {
  await threadStore.createNewThread(props.agentId, 'desktop')
}

/** 停止生成 */
async function handleStop() {
  await stopGeneration()
}

/** 跳过指令等待 */
function handleSkipCommand() {
  activeCommand.value = null
}

// ── 消息编辑/删除 ──

/** 编辑状态 */
const editingMessage = ref<BubbleMessage | null>(null)
const editText = ref('')
const editTextarea = ref<HTMLTextAreaElement | null>(null)
const editSaving = ref(false)
const editContext = ref<{
  threadId: string
  agentId: string
  revision?: number
  origin?: { message: StoredMessage; occurrenceFromEnd: number }
} | null>(null)

/** 进入编辑模式 */
function handleEdit(msg: BubbleMessage) {
  if (isGenerating.value || editSaving.value) return
  editingMessage.value = msg
  const snapshot = threadStore.messages.find((message) => message.id === msg.id)
  const matching = snapshot
    ? threadStore.messages.filter(
        (message) => message.role === snapshot.role && message.content === snapshot.content,
      )
    : []
  editContext.value = {
    threadId: threadStore.threadId,
    agentId: props.agentId,
    revision: snapshot?.revision,
    origin: snapshot
      ? {
          message: { ...snapshot },
          occurrenceFromEnd: matching.length - 1 - matching.indexOf(snapshot),
        }
      : undefined,
  }
  editText.value = msg.content
  nextTick(() => {
    if (editingMessage.value?.id === msg.id) editTextarea.value?.focus()
  })
}

/** 保存编辑：后端确认后再更新本地，避免持久化失败造成界面与服务端不一致。 */
async function saveEdit(regenerate = false) {
  if (!editingMessage.value || !editContext.value || editSaving.value || isGenerating.value) return
  const target = editingMessage.value
  const context = editContext.value
  const nextContent = editText.value
  if (!nextContent.trim()) return
  const stillCurrent = () =>
    threadStore.threadId === context.threadId &&
    threadStore.agentId === context.agentId &&
    currentAgent.activeAgentId === context.agentId &&
    props.agentId === context.agentId &&
    !props.switching &&
    !threadStore.navigationTarget
  editSaving.value = true
  let saved = false
  try {
    if (!stillCurrent()) throw new Error('会话已切换，请返回原会话后保存')
    const response = await threadStore.editMessage(
      target.id,
      nextContent,
      context.revision,
      context.origin,
    )
    saved = true
    editingMessage.value = null
    notif.toast(__t('ui.chat', '消息已保存'), { type: 'success' })
    if (regenerate) {
      if (!stillCurrent()) throw new Error('消息已保存，会话已切换，未重新生成')
      const list = response.projection.messages
      const index = list.findIndex((message) => message.messageId === response.message.id)
      const input =
        target.role === 'user'
          ? list[index]
          : list
              .slice(0, index + 1)
              .reverse()
              .find(
                (message) =>
                  message.role === 'user' &&
                  (!response.message.pairId || message.pairId === response.message.pairId),
              )
      if (!input || input.role !== 'user') throw new Error('消息已保存，未找到本轮用户消息')
      await rewind.open({
        threadId: context.threadId,
        messageId: Number(input.messageId),
        autoConfirmWithoutFiles: true,
        preserveInputAttachments: true,
        beforeConfirm: () => {
          if (!stillCurrent() || threadStore.isGenerating)
            throw new Error('会话已切换或正在生成，请稍后重试')
        },
        onSuccess: async (result) => {
          const attachments: AttachmentInfo[] = input.attachments.map((attachment) => ({
            id: attachment.id,
            threadId: context.threadId,
            messageId: null,
            kind: attachment.kind as AttachmentInfo['kind'],
            originalName: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            contextPolicy: 'once',
            status: 'uploaded',
          }))
          // 回滚请求在途时可能切换会话；已确认的重新生成仍归属原会话，不借用新页面的角色。
          if (!stillCurrent()) {
            chatApi.stream(
              {
                threadId: context.threadId,
                agentId: context.agentId,
                content: input.content,
                attachmentIds: attachments.map((attachment) => attachment.id),
                generationType: 'regenerate',
              },
              {
                onSurface: (frame) => compositor.enqueue(frame),
                onDone: () => {
                  window.dispatchEvent(
                    new CustomEvent('infos:conversation-completed', {
                      detail: { agentId: context.agentId, threadId: context.threadId },
                    }),
                  )
                  if (
                    threadStore.threadId === context.threadId &&
                    threadStore.agentId === context.agentId
                  )
                    void threadStore.refreshCurrentThread(context.agentId)
                },
                onError: (error) =>
                  notif.toast(__t('ui.chat', '重新生成失败：{0}', [error.message]), 'error'),
              },
            )
            return
          }
          if (result.projection) threadStore.applyProjection(result.projection)
          void chatSend(
            input.content,
            attachments.map((attachment) => attachment.id),
            attachments,
            'auto',
            undefined,
            'regenerate',
          )
            .then((started) => {
              if (!started && stillCurrent()) {
                threadStore.inputText = input.content
                notif.toast(__t('ui.chat', '重新生成未完成，请重试'), 'error')
              }
            })
            .catch((error) => {
              if (stillCurrent())
                notif.toast(
                  error instanceof Error ? error.message : __t('ui.chat', '重新生成失败'),
                  'error',
                )
            })
        },
      })
    }
  } catch (err) {
    logger.error('ChatContainer', __t('logs.frontend.chat', '消息编辑保存失败'), err)
    notif.toast(
      `${saved ? __t('ui.chat', '消息已保存。') : ''}${err instanceof Error ? err.message : __t('ui.chat', '保存失败，编辑内容已保留')}`,
      { type: 'error' },
    )
  } finally {
    editSaving.value = false
  }
}

/** 取消编辑 */
function cancelEdit() {
  if (editSaving.value) return
  editingMessage.value = null
}

/** 退场后再清理草稿，避免淡出期间输入内容突然变空。 */
function clearClosedEditDraft() {
  if (!editingMessage.value) editText.value = ''
}

/**
 * 级联删除对话对，并在后端确认后精确更新本地 UI。
 * 临时 msg_* ID 表示消息尚未完成服务端回灌，删除前先刷新并定位真实数据库 ID。
 */
async function handleDeletePair(id: string) {
  let target = threadStore.messages.find((message) => message.id === id)
  if (!target || !threadStore.threadId) return

  try {
    if (!/^\d+$/.test(target.id)) {
      const snapshot = target
      const snapshotIndex = threadStore.messages.findIndex((message) => message.id === snapshot.id)
      const precedingUser =
        snapshotIndex > 0
          ? threadStore.messages
              .slice(0, snapshotIndex)
              .reverse()
              .find((message) => message.role === 'user')
          : undefined
      await threadStore.refreshCurrentThread(props.agentId)
      const candidates = threadStore.messages.filter((message) => message.role === snapshot.role)
      target =
        candidates.find((message) => message.content === snapshot.content) ??
        (snapshot.role === 'assistant' && precedingUser
          ? threadStore.messages.find(
              (message) => message.role === 'user' && message.content === precedingUser.content,
            )
          : undefined)
      if (!target || !/^\d+$/.test(target.id)) {
        throw new Error('消息尚未完成服务端同步，请稍后重试')
      }
    }

    await rewind.open({
      threadId: threadStore.threadId,
      messageId: Number(target.id),
      onSuccess: async (result) => {
        if (!result.projection) throw new Error('未能恢复会话记录，请刷新')
        threadStore.applyProjection(result.projection)
        window.dispatchEvent(
          new CustomEvent('infos:conversation-rewound', {
            detail: {
              threadId: threadStore.threadId,
              deletedMessageIds: result.deletedMessageIds.map(String),
              projection: result.projection,
            },
          }),
        )
        notif.toast(__t('ui.chat', '已回滚 {0} 轮对话', [result.preview.pairCount]), {
          type: 'success',
        })
      },
    })
  } catch (err) {
    logger.error('ChatContainer', __t('logs.frontend.chat', '删除对话对失败'), err)
    notif.toast(err instanceof Error ? err.message : __t('ui.chat', '删除失败，请稍后重试'), {
      type: 'error',
    })
  }
}

function stopMessageAudio(): void {
  audioRequest++
  messageAudioAbort?.abort()
  messageAudioAbort = null
  messageAudioSource?.stop()
  messageAudioSource = null
  void messageAudioContext?.close()
  messageAudioContext = null
  playingMsgId.value = null
  isLoadingAudio.value = false
}

async function handleTtsPlay(message: BubbleMessage): Promise<void> {
  if (playingMsgId.value === message.id) {
    stopMessageAudio()
    return
  }

  stopMessageAudio()
  window.dispatchEvent(new Event('infos:stop-message-audio'))
  const text = message.spokenReply?.trim() ?? ''
  if (!text) {
    notif.toast(__t('ui.chat', '这条回复没有独立口语答复'), { type: 'warning' })
    return
  }
  const request = audioRequest
  playingMsgId.value = message.id
  isLoadingAudio.value = true
  try {
    messageAudioAbort = new AbortController()
    const audio = await voiceApi.synthesize(
      { text, agentId: message.senderId || props.agentId },
      messageAudioAbort.signal,
    )
    if (request !== audioRequest || playingMsgId.value !== message.id) return
    const context = new AudioContext()
    messageAudioContext = context
    const buffer = await context.decodeAudioData(audio.slice(0))
    if (request !== audioRequest || playingMsgId.value !== message.id) {
      await context.close()
      return
    }
    const source = context.createBufferSource()
    messageAudioSource = source
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      if (messageAudioSource !== source) return
      messageAudioSource = null
      messageAudioContext = null
      playingMsgId.value = null
      isLoadingAudio.value = false
      void context.close()
    }
    isLoadingAudio.value = false
    source.start()
  } catch (error) {
    if (request !== audioRequest) return
    stopMessageAudio()
    logger.error('ChatContainer', __t('logs.frontend.chat', '朗读消息失败'), error)
    notif.toast(__t('ui.chat', '朗读消息失败：{0}', [(error as Error).message]), { type: 'error' })
  }
}

/** 复制消息内容到剪贴板 */
async function handleCopy(content: string) {
  try {
    await copyClientText(content)
    logger.info('ChatContainer', __t('logs.frontend.chat', '消息已复制到剪贴板'))
    notif.toast(__t('ui.chat', '已复制到剪贴板'), { type: 'success' })
  } catch (err) {
    logger.error('ChatContainer', __t('logs.frontend.chat', '复制失败'), err)
    notif.toast(__t('ui.chat', '复制失败'), { type: 'error' })
  }
}

let historyActivationGeneration = 0
let displayedThreadId = props.threadId
watch(
  () => [props.agentId, props.threadId, props.switching] as const,
  async ([agentId, threadId, switching]) => {
    const generation = ++historyActivationGeneration
    // 外层正在执行明确导航时只呈现过渡，避免默认会话恢复抢占指定目标。
    if (switching) return
    const previousThreadId = displayedThreadId
    displayedThreadId = threadId
    if (previousThreadId && previousThreadId !== threadId) {
      compositor.disposeScope(`conversation:${previousThreadId}`)
    }
    try {
      // Store 已提交的会话直接复用，避免 threadId 更新再次触发相同 Projection 请求。
      if (threadId && threadStore.agentId === agentId) {
        if (threadStore.threadId !== threadId || threadStore.historyError) {
          await threadStore.loadThreadMessages(threadId, agentId)
        }
      } else {
        const activated = await threadStore.ensureLatestThread(agentId, 'desktop')
        if (!activated) return
      }
      if (generation !== historyActivationGeneration || props.agentId !== agentId) return
      await nextTick()
      if (generation !== historyActivationGeneration || props.agentId !== agentId) return
      if (props.focusRequest) await focusRequestedMessage()
      else scrollToBottom(false)
    } catch (error) {
      if (generation !== historyActivationGeneration || props.agentId !== agentId) return
      // 真实错误由已有的历史加载错误区显示，异步 watch 不再抛到全局异常处理器。
      if (!threadStore.historyError) {
        threadStore.historyError = error instanceof Error ? error.message : String(error)
      }
      logger.error('ChatContainer', __t('logs.frontend.chat', '恢复聊天会话失败'), error)
    }
  },
  { immediate: true },
)

function restoreProjection(): void {
  if (!props.switching) void threadStore.refreshCurrentThread(props.agentId)
}

function handleConversationRewound(event: Event): void {
  const detail = (
    event as CustomEvent<{
      threadId?: string
      projection?: import('@infos/shared').ConversationProjectionSnapshot
    }>
  ).detail
  if (!detail?.threadId || detail.threadId !== threadStore.threadId) return
  if (detail.projection) threadStore.applyProjection(detail.projection)
  else restoreProjection()
}

onMounted(() => {
  observeInputArea()
  window.addEventListener('infos:stop-message-audio', stopMessageAudio)
  void listen('pet-controls:action', (data) => {
    if ((data as { action?: string }).action === 'stop-speech') stopMessageAudio()
  }).then((remove) => {
    if (disposed) remove()
    else removeSpeechAction = remove
  })
  window.addEventListener('online', restoreProjection)
  window.addEventListener('infos:conversation-rewound', handleConversationRewound)
  if (!props.focusRequest) scrollToBottom(false)
})

onActivated(() => {
  observeInputArea()
  void restoreMessageViewport()
})
onDeactivated(() => inputResizeObserver?.disconnect())

onUnmounted(() => {
  window.removeEventListener('infos:stop-message-audio', stopMessageAudio)
  disposed = true
  inputResizeObserver?.disconnect()
  historyActivationGeneration++
  removeSpeechAction?.()
  clearTimeout(highlightTimer)
  stopMessageAudio()
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
  scrollFrame = null
  window.removeEventListener('online', restoreProjection)
  window.removeEventListener('infos:conversation-rewound', handleConversationRewound)
  if (threadStore.threadId) compositor.disposeScope(`conversation:${threadStore.threadId}`)
})
</script>

<template>
  <div
    class="chat-container"
    :class="{ 'chat-container--compact': compactInput }"
    :style="{ '--chat-input-height': `${inputAreaHeight}px` }"
    @dragenter="fileDrop.enter"
    @dragover="fileDrop.over"
    @dragleave="fileDrop.leave"
    @drop="fileDrop.drop"
  >
    <div v-if="fileDrop.dragging.value" class="chat-file-drop" aria-hidden="true">
      <PixelIcon name="file" size="lg" />
      <strong>{{ __t('ui.attachments', '松开以上传文件') }}</strong>
      <span>{{ __t('ui.attachments', '支持多文件，上传后可按需读取') }}</span>
    </div>
    <BrowserObserver
      :agent-id="agentId"
      :agent-name="agentName"
      :thread-id="threadStore.threadId || threadId"
      :active="!switching"
    />
    <!-- M05-B1: 角色工作状态徽章（后台任务进行中提示，点击跳转任务中心） -->
    <PackageSlot region="chat.header" />
    <div class="chat-work-badge">
      <AgentWorkBadge :agent-id="agentId" />
    </div>

    <!-- 指令执行遮罩 -->
    <CommandOverlay :command="activeCommand" @skip="handleSkipCommand" />

    <!-- 消息列表 -->
    <SurfaceTransition
      class="chat-messages-region"
      fill
      variant="conversation"
      :identity="`${agentId}:${threadStore.threadId || threadId}`"
      :pending="switching || !!threadStore.navigationTarget"
      :label="__t('ui.chat', '正在切换会话')"
    >
      <div ref="containerRef" class="chat-messages" @scroll.passive="handleMessageScroll">
        <div
          v-if="isLoadingHistory && !threadStore.navigationTarget && !messages.length"
          class="chat-history-state"
        >
          <PixelIcon name="refresh" size="sm" animation="spin" />
          <span>{{ __t('ui.chat', '正在同步历史聊天记录...') }}</span>
        </div>

        <div v-else-if="historyError" class="chat-history-state chat-history-error">
          <PixelIcon name="alert" size="sm" />
          <span>{{ __t('ui.chat', '历史记录同步失败：') }}{{ historyError }}</span>
        </div>

        <div v-if="threadStore.isLoadingOlderHistory" class="chat-history-state">
          <PixelIcon name="refresh" size="sm" animation="spin" />
          <span>{{ __t('ui.chat', '正在加载更早消息...') }}</span>
        </div>

        <MessageBubble
          v-for="msg in messages"
          :key="msg.id"
          v-memo="[
            msg,
            msg.surface?.revision,
            playingMsgId === msg.id,
            isLoadingAudio,
            isGenerating,
            threadStore.ragProgressMessage,
            threadStore.ragFailureTrace,
          ]"
          :message="msg"
          :is-owner-message="isLocalOwnerMessage({ role: msg.role, channel: threadStore.channel })"
          :agent-id="agentId"
          :agent-name="agentName"
          :agent-avatar-url="agentAvatarUrl"
          :allow-mutations="!isGenerating"
          :progress-label="threadStore.ragProgressMessage ?? ''"
          :rag-failure="
            msg.ragFailureTrace ??
            (isGenerating && msg === messages[messages.length - 1]
              ? threadStore.ragFailureTrace
              : null)
          "
          :is-streaming="
            isGenerating && msg === messages[messages.length - 1] && msg.role === 'assistant'
          "
          @edit="handleEdit"
          @delete-pair="handleDeletePair"
          @copy="handleCopy"
          @tts-play="handleTtsPlay"
          @vue:mounted="onBubbleMounted"
          @vue:unmounted="onBubbleUnmounted"
        />
      </div>
      <!-- 按钮定位在消息视口内，输入栏或队列增高时也不会遮挡输入。 -->
      <Transition name="scroll-down">
        <button
          v-if="showScrollDown"
          type="button"
          class="chat-scroll-down"
          :title="__t('ui.chat', '回到最新消息')"
          :aria-label="__t('ui.chat', '回到最新消息')"
          @click="scrollToBottom()"
        >
          <PixelIcon name="chevron-down" size="sm" />
        </button>
      </Transition>
    </SurfaceTransition>

    <div v-if="showApprovals && interactionSurfaces.length" class="chat-approvals">
      <ConversationSurface
        v-for="surface in interactionSurfaces"
        :key="surface.surfaceId"
        :surface="surface"
      />
    </div>

    <!-- 输入框 -->
    <div ref="inputAreaRef" class="chat-input-area">
      <PackageSlot region="chat.footer" />
      <ThreadTodo :thread-id="threadStore.threadId || props.threadId" :agent-id="props.agentId" />
      <div
        v-if="
          includedContext?.filePath || includedContext?.selection || includedContext?.terminalId
        "
        class="work-material-bar"
        :aria-label="__t('ui.chat', '本轮附带的工作区材料')"
      >
        <span
          v-if="includedContext?.filePath"
          class="work-material-chip"
          :title="includedContext.filePath"
        >
          <PixelIcon name="file" size="xs" />
          <span>{{ includedContext.filePath }}</span>
          <button
            type="button"
            :title="__t('ui.chat', '本轮不附带当前文件')"
            @click="excludedContext.file = true"
          >
            <PixelIcon name="close" size="xs" />
          </button>
        </span>
        <span v-if="includedContext?.selection" class="work-material-chip">
          <PixelIcon name="code" size="xs" />
          <span>
            {{ __t('ui.chat', '第') }} {{ includedContext.selection.startLine }}–{{
              includedContext.selection.endLine
            }}
            {{ __t('ui.chat', '行') }}
          </span>
          <button
            type="button"
            :title="__t('ui.chat', '本轮不附带选区')"
            @click="excludedContext.selection = true"
          >
            <PixelIcon name="close" size="xs" />
          </button>
        </span>
        <span v-if="includedContext?.terminalId" class="work-material-chip">
          <PixelIcon name="terminal" size="xs" />
          <span>{{ __t('ui.chat', '当前终端') }}</span>
          <button
            type="button"
            :title="__t('ui.chat', '本轮不附带终端')"
            @click="excludedContext.terminal = true"
          >
            <PixelIcon name="close" size="xs" />
          </button>
        </span>
      </div>
      <DesktopControlStatus
        :thread-id="threadStore.threadId || undefined"
        :pause="desktopPause"
        :busy="isGenerating || resumingDesktop"
        @resume-task="resumeDesktopTask"
      />
      <ConversationQueue
        :snapshot="queue.snapshot.value"
        :busy="queue.changing.value || restoringQueueDraft"
        :unavailable="queue.unavailable.value"
        @change="queue.change"
        @move="queue.move"
        @control="queue.control"
      />
      <InputBar
        ref="inputBarRef"
        :queue-enabled="true"
        :queue-pending="queue.hasPending.value"
        :submission-busy="queue.changing.value || restoringQueueDraft"
        :disabled="switching || !!threadStore.navigationTarget"
        :draft-request="draftRequest"
        :compact="compactInput"
        :is-sending="isGenerating || !!queue.snapshot.value.active"
        @send="handleSend"
        @stop="handleStop"
        @new-thread="handleNewThread"
        @draft-consumed="emit('draftConsumed')"
      />
    </div>

    <!-- 编辑对话框 -->
    <Teleport to="body">
      <Transition name="chat-edit" @after-leave="clearClosedEditDraft">
        <div
          v-if="editingMessage"
          class="chat-edit-overlay"
          @click.self="cancelEdit"
          @keydown.esc.stop="cancelEdit"
        >
          <div
            class="chat-edit-dialog"
            role="dialog"
            aria-modal="true"
            :aria-label="__t('ui.chat', '编辑消息')"
          >
            <header class="chat-edit-header">
              <span class="chat-edit-icon" aria-hidden="true">
                <PixelIcon name="edit" size="sm" />
              </span>
              <h2>{{ __t('ui.chat', '编辑消息') }}</h2>
              <button
                class="chat-edit-close"
                type="button"
                :aria-label="__t('ui.chat', '关闭编辑消息')"
                @click="cancelEdit"
              >
                <PixelIcon name="close" size="sm" />
              </button>
            </header>
            <div class="chat-edit-body">
              <textarea
                ref="editTextarea"
                v-model="editText"
                class="chat-edit-textarea"
                :aria-label="__t('ui.chat', '消息内容')"
                :disabled="editSaving"
                rows="5"
              />
            </div>
            <footer class="chat-edit-actions">
              <button class="chat-edit-btn chat-edit-cancel" type="button" @click="cancelEdit">
                {{ __t('ui.chat', '取消') }}
              </button>
              <button
                class="chat-edit-btn chat-edit-cancel"
                type="button"
                :disabled="editSaving || isGenerating || !editText.trim()"
                @click="saveEdit(false)"
              >
                {{ __t('ui.chat', '仅保存') }}
              </button>
              <button
                class="chat-edit-btn chat-edit-save"
                type="button"
                :disabled="editSaving || isGenerating || !editText.trim()"
                @click="saveEdit(true)"
              >
                <PixelIcon name="check" size="xs" />
                {{ editSaving ? __t('ui.chat', '保存中…') : __t('ui.chat', '保存并重新生成') }}
              </button>
            </footer>
          </div>
        </div>
      </Transition>
    </Teleport>
    <ConversationRewindDialog
      v-model="rewind.visible.value"
      :preview="rewind.preview.value"
      :loading="rewind.loading.value"
      :regenerating="rewind.request.value?.preserveInputAttachments === true"
      @confirm="rewind.confirm"
    />
  </div>
</template>

<style scoped>
:deep(.pet-message-focus) {
  border-radius: 8px;
  outline: 1px solid var(--ui-accent-purple);
  outline-offset: 5px;
  background: var(--ui-accent-purple-soft);
}

.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: transparent;
}
.chat-file-drop {
  position: absolute;
  inset: 12px;
  z-index: 45;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border: 2px solid var(--ui-accent-cyan);
  border-radius: 0;
  background: color-mix(in srgb, var(--ui-bg-surface) 92%, transparent);
  color: var(--ui-accent-cyan);
  box-shadow:
    4px 4px 0 var(--ui-border-default),
    inset 0 0 0 4px color-mix(in srgb, var(--ui-accent-cyan) 10%, transparent);
}
.chat-file-drop strong {
  font-family: var(--ui-font-pixel);
  font-size: 20px;
  font-weight: 400;
}
.chat-file-drop span {
  color: var(--ui-text-secondary);
  font-size: 12px;
}

/* M05-B1: 工作徽章悬浮于消息区右上角，不占布局 */
.chat-work-badge {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 10;
}

.chat-messages-region {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.chat-messages {
  position: relative;
  z-index: 1;
  height: 100%;
  overflow-y: auto;
  padding: 24px 28px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chat-approvals {
  position: absolute;
  right: 28px;
  bottom: calc(var(--chat-input-height, 112px) + 8px);
  z-index: 24;
  display: grid;
  width: min(560px, calc(100% - 56px));
  max-height: min(62vh, 480px, max(80px, calc(100% - var(--chat-input-height, 112px) - 48px)));
  overflow-y: auto;
  filter: drop-shadow(5px 6px 0 color-mix(in srgb, var(--ui-text-primary) 16%, transparent));
}

.chat-container--compact .chat-approvals {
  right: 8px;
  width: calc(100% - 16px);
}

.chat-container :deep(.deck--compact) {
  max-width: 100%;
  min-width: 0;
}
.chat-container :deep(.deck--compact .deck-status) {
  width: 100%;
}

.chat-input-area {
  position: relative;
  min-width: 0;
  flex-shrink: 0;
  padding: 0 28px 24px;
}

.work-material-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0 0 8px;
  font-size: 11px;
  color: var(--ui-text-secondary);
}
.work-material-chip {
  border: 1px solid var(--ui-border-subtle);
  border-radius: 4px;
  background: var(--ui-bg-hover);
  padding: 4px 7px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.work-material-chip button {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
}
.work-material-chip > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.work-material-chip > .pixel-icon {
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
}

.chat-history-state {
  align-self: center;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 16px;
  padding: 8px 16px;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-secondary);
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--ui-radius-full);
  border: 1px solid var(--ui-border-subtle);
}

.chat-history-error {
  background: var(--ui-accent-red-soft);
  color: var(--ui-danger);
  border-color: var(--ui-danger);
}

/* 回到底部按钮 */
.chat-scroll-down {
  position: absolute;
  right: clamp(12px, 2vw, 24px);
  bottom: 12px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ui-bg-surface);
  color: var(--ui-accent-primary);
  cursor: pointer;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-full);
  box-shadow: var(--ui-shadow-md);
  transition:
    transform var(--ui-duration-fast),
    background-color var(--ui-duration-fast),
    color var(--ui-duration-fast),
    box-shadow var(--ui-duration-fast);
  z-index: 10;
}
.chat-scroll-down:hover {
  background: var(--ui-accent-primary);
  color: white;
  box-shadow: var(--ui-glow-pink);
  transform: translateY(-2px);
}
.chat-scroll-down:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: 3px;
}
.chat-container--compact .chat-scroll-down {
  right: 12px;
}
@media (pointer: coarse) {
  .chat-scroll-down {
    width: 44px;
    height: 44px;
  }
}

.scroll-down-enter-active {
  transition:
    opacity 0.2s ease-out,
    transform 0.2s ease-out;
}
.scroll-down-leave-active {
  transition:
    opacity 0.15s ease-in,
    transform 0.15s ease-in;
}
.scroll-down-enter-from,
.scroll-down-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
@media (prefers-reduced-motion: reduce) {
  .chat-scroll-down,
  .scroll-down-enter-active,
  .scroll-down-leave-active {
    transition: none;
  }
}

/* 不可见消息只暂停动画和媒体，不启用 content-visibility 高度占位。 */
:deep(.msg-paused) {
  content-visibility: visible;
}

:deep(.msg-paused) video,
:deep(.msg-paused) canvas {
  visibility: hidden;
}

:deep(.msg-paused) * {
  animation-play-state: paused !important;
}

/* ── 流式渲染区域 ── */
:deep(.stream-stable) {
  contain: content;
}

:deep(.stream-tail) {
  contain: none;
}
</style>

<!-- 编辑对话框的局部材质，Teleport 后仍保留组件作用域。 -->
<style scoped>
.chat-edit-overlay {
  --edit-highlight: color-mix(in srgb, white 16%, transparent);
  --edit-shade: color-mix(in srgb, var(--ui-text-primary) 9%, transparent);
  --edit-side: color-mix(in srgb, var(--ui-border-strong) 50%, var(--ui-bg-canvas));
  --edit-ink: color-mix(in srgb, var(--ui-accent-primary) 80%, var(--ui-text-primary));
  position: fixed;
  inset: 0;
  padding: 24px;
  background: var(--ui-overlay-backdrop);
  backdrop-filter: blur(var(--ui-overlay-blur));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--ui-z-modal);
}

.chat-edit-dialog {
  position: relative;
  width: min(480px, 100%);
  max-height: calc(100dvh - 48px);
  background: color-mix(in srgb, var(--ui-bg-elevated) 97%, transparent);
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 20%, var(--ui-border-strong));
  border-radius: 0;
  display: flex;
  flex-direction: column;
  color: var(--ui-text-primary);
  box-shadow:
    inset 1px 1px var(--edit-highlight),
    inset -1px -1px var(--edit-shade),
    3px 3px 0 var(--edit-side),
    var(--ui-shadow-md);
}
.chat-edit-dialog::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 18px;
  width: 28px;
  height: 2px;
  background: var(--ui-accent-primary);
  box-shadow: 32px 0 0 var(--ui-accent-purple-soft);
  pointer-events: none;
}

.chat-edit-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: color-mix(in srgb, var(--ui-accent-sky) 3%, transparent);
}
.chat-edit-header h2 {
  flex: 1;
  margin: 0;
  font: 400 14px/1.5 var(--ui-font-pixel);
}
.chat-edit-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary) 22%, var(--ui-border-default));
  background: var(--ui-accent-primary-soft);
  box-shadow:
    inset 1px 1px var(--edit-highlight),
    1px 1px 0 var(--edit-side);
  color: var(--edit-ink);
}
.chat-edit-close {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.chat-edit-close:hover {
  border-color: var(--ui-border-default);
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}
.chat-edit-body {
  min-height: 0;
  padding: 16px 18px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.chat-edit-textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 140px;
  max-height: min(440px, 50dvh);
  padding: 12px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--dash-input-bg);
  color: var(--ui-text-primary);
  font: 13px/1.75 var(--ui-font-sans);
  caret-color: var(--ui-accent-primary);
  box-shadow:
    inset 1px 1px var(--edit-shade),
    inset -1px -1px var(--edit-highlight);
  resize: vertical;
  outline: none;
  transition: border-color var(--ui-duration-fast) var(--ui-ease-standard);
}

.chat-edit-textarea:focus {
  border-color: color-mix(in srgb, var(--ui-accent-primary) 65%, var(--ui-border-default));
}

.chat-edit-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
}

.chat-edit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 64px;
  min-height: 30px;
  padding: 5px 14px;
  font: 12px/1.5 var(--ui-font-pixel);
  cursor: pointer;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  box-shadow:
    inset 1px 1px var(--edit-highlight),
    inset -1px -1px var(--edit-shade),
    2px 2px 0 var(--edit-side);
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-instant) steps(2, end),
    transform var(--ui-duration-instant) steps(2, end);
}

.chat-edit-cancel {
  background: var(--ui-bg-surface);
  color: var(--ui-text-secondary);
}

.chat-edit-cancel:hover {
  background: var(--ui-bg-hover);
}

.chat-edit-save {
  background: color-mix(in srgb, var(--ui-accent-primary) 12%, var(--ui-bg-surface));
  color: var(--edit-ink);
  border-color: color-mix(in srgb, var(--ui-accent-primary) 45%, var(--ui-border-default));
}

.chat-edit-save:hover {
  background: color-mix(in srgb, var(--ui-accent-primary) 20%, var(--ui-bg-surface));
  border-color: var(--ui-accent-primary);
}
.chat-edit-btn:active {
  transform: translate(1px, 1px);
  box-shadow: inset 1px 1px var(--edit-shade);
}
.chat-edit-btn:focus-visible,
.chat-edit-close:focus-visible {
  outline: 1px solid var(--ui-accent-primary);
  outline-offset: 3px;
}
.chat-edit-enter-active,
.chat-edit-leave-active {
  transition: opacity var(--ui-duration-fast) var(--ui-ease-standard);
}
.chat-edit-enter-active .chat-edit-dialog,
.chat-edit-leave-active .chat-edit-dialog {
  transition: transform var(--ui-duration-fast) steps(4, end);
}
.chat-edit-enter-from,
.chat-edit-leave-to {
  opacity: 0;
}
.chat-edit-enter-from .chat-edit-dialog,
.chat-edit-leave-to .chat-edit-dialog {
  transform: translateY(var(--ui-motion-distance-sm));
}

@media (prefers-reduced-motion: reduce) {
  .chat-edit-btn,
  .chat-edit-enter-active,
  .chat-edit-leave-active,
  .chat-edit-enter-active .chat-edit-dialog,
  .chat-edit-leave-active .chat-edit-dialog {
    transition: none;
  }
}
</style>
