<script setup lang="ts">
import { getDisplayLocale } from '../../../i18n/index'

import { t as __t } from '../../../i18n/index'

import { copyClientText } from '../../../lib/clientPlatform'

/**
 * LogsTab — 对话日志 Tab (F1-3)
 *
 * 对标 v1 气泡式聊天 UI：
 * - 工具栏 PCard (Agent选择/来源筛选/日期/排序)
 * - 会话列表 → 点击展开为气泡对话视图
 * - 头像 + 角色标签 + 消息气泡 + hover 装饰
 */
import { ref, shallowRef, computed, onMounted, onUnmounted, watch } from 'vue'
import { PixelIcon, PInput, PSelect, PButton, PEmpty, PCard, PDialog } from '../../pixel'
import UserAvatar from '../../user/UserAvatar.vue'
import { isLocalOwnerMessage } from '../../../lib/userMessageIdentity'
import { threadsApi } from '../../../api/modules/threadsApi'
import { strongholdApi } from '../../../api/modules/strongholdApi'
import type { ThreadInfo, ThreadMessageInfo } from '../../../api/modules/threadsApi'
import { useDashboardContext } from '../../../composables/dashboard'
import { useConversationRewind } from '../../../composables/chat/useConversationRewind'
import ConversationRewindDialog from '../../chat/ConversationRewindDialog.vue'
import { useAgentStore, useNotificationStore } from '../../../stores'
import { getApiBaseUrl } from '../../../api/transport'
import { logger } from '../../../lib/logger'

// 弹窗与业务区是多个根节点，显式把主题作用域和布局属性交给业务区。
defineOptions({ inheritAttrs: false })

const ctx = useDashboardContext()
const notif = useNotificationStore()
const rewind = useConversationRewind()
const agentStore = useAgentStore()

function handleRewindVisibility(visible: boolean): void {
  if (!visible) threadPendingDelete.value = null
}

// ── 当前激活角色 ──
const activeAgentName = computed(() => {
  return agentStore.currentAgent?.name || ctx.activeAgentId.value || __t('ui.settings', '未知')
})

// ── 类型 ──

interface LogMessage {
  id: string
  role: string
  content: string
  /** 群聊权威消息的实际发言 Agent；普通 Thread 消息为 null。 */
  agentId?: string | null
  /** Agent 回复的原始内容（含调试块），仅 assistant 可能有值。 */
  rawContent?: string | null
  /** 包含实际模型请求快照与 Token 使用量。 */
  metadataJson?: string
  /** Assistant 可见输出的总 Token。 */
  outputTokens?: number
  timestamp?: string
}

interface InitialPromptMessage {
  promptSegment?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
}

interface LogEntry {
  id: string
  threadId: string
  /** group 日志以 roomId 聚合；普通日志保留 null。 */
  roomId?: string
  agentId: string
  agentName: string
  summary: string
  /** 列表加载时即携带真实消息数；展开后不再以已加载条数覆盖。 */
  messageCount: number
  channel: string
  createdAt: string
  /** 展开后加载的消息 */
  messages: LogMessage[]
  /** 消息是否已加载 */
  messagesLoaded: boolean
  /** 是否正在加载消息 */
  isLoadingMessages: boolean
}

// ── 状态 ──

const logs = shallowRef<LogEntry[]>([])
const roomNames = shallowRef(new Map<string, string>())
const isLoading = ref(false)
const searchQuery = ref('')
const filterAgent = ref('all')
const filterChannel = ref('all')
const selectedSort = ref('desc')
const expandedId = ref<string | null>(null)
const threadPendingDelete = ref<LogEntry | null>(null)
const threadPendingRename = ref<LogEntry | null>(null)
const currentPage = ref(1)
const totalCount = ref(0)

const agentOptions = computed(() => [
  {
    get label() {
      return __t('ui.settings', '全部角色')
    },
    value: 'all',
  },
  ...agentStore.agents.map((agent) => ({
    label: agent.name || agent.id,
    value: agent.id,
  })),
])

const channelOptions = [
  {
    get label() {
      return __t('ui.settings', '全部频道')
    },
    value: 'all',
  },
  { label: 'Desktop', value: 'desktop' },
  { label: 'Group', value: 'group' },
]

/** 从据点群聊 Thread 的平台标识中提取房间 ID（格式：{roomId}:{agentId}）。 */
function getStrongholdRoomId(thread: ThreadInfo): string | null {
  if (thread.channel !== 'group' || thread.platform !== 'stronghold') return null
  return thread.platformIdentifier?.split(':', 1)[0] || null
}

/** 据点群聊仅以房间聚合，Agent 隔离 Thread 仅供后端编译上下文，不作为日志分组依据。 */
function groupLogsByRoom(threads: ThreadInfo[]): LogEntry[] {
  const groupLogs = new Map<string, LogEntry>()
  const entries: LogEntry[] = []

  for (const thread of threads) {
    const roomId = getStrongholdRoomId(thread)
    if (!roomId) {
      entries.push(toLogEntry(thread))
      continue
    }

    const createdAt = thread.updatedAt || thread.createdAt
    const existing = groupLogs.get(roomId)
    if (!existing || new Date(createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      groupLogs.set(roomId, {
        id: `stronghold-room-${roomId}`,
        threadId: thread.id,
        roomId,
        // group 日志不归属单一角色；保留空值仅满足已有 LogEntry 结构。
        agentId: '',
        agentName: '据点房间',
        summary: roomNames.value.get(roomId) || `据点房间 · ${roomId}`,
        messageCount: 0,
        channel: 'group',
        createdAt,
        messages: [],
        messagesLoaded: false,
        isLoadingMessages: false,
      })
    }
  }

  return [...entries, ...groupLogs.values()]
}

const sortOptions = [
  {
    get label() {
      return __t('ui.settings', '最新在前')
    },
    value: 'desc',
  },
  {
    get label() {
      return __t('ui.settings', '最早在前')
    },
    value: 'asc',
  },
]

const filteredLogs = computed(() => {
  let list = logs.value
  if (filterAgent.value !== 'all') {
    // 据点群聊按房间展示，不隶属任何单个 Agent，因此不受角色筛选影响。
    list = list.filter((log) => log.roomId || log.agentId === filterAgent.value)
  }
  if (filterChannel.value !== 'all') {
    list = list.filter((l) => l.channel === filterChannel.value)
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter((l) => l.summary.toLowerCase().includes(q))
  }
  // 排序
  if (selectedSort.value === 'asc') {
    list = [...list].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
  }
  return list
})

// ── API 操作 ──

async function fetchSessions(): Promise<void> {
  isLoading.value = true
  try {
    // group Thread 按角色隔离只是后端上下文实现；日志聚合必须总能取得同房间的全部 Thread。
    const agentId = undefined
    const channel = filterChannel.value !== 'all' ? filterChannel.value : undefined
    const [threadsResponse, roomsResponse] = await Promise.all([
      threadsApi.list({
        agentId,
        channel,
        page: currentPage.value,
        // group Thread 按角色隔离，日志页需要在同一页看到所有房间对应 Thread 才能正确聚合。
        pageSize: 100,
      }),
      strongholdApi.listRooms(),
    ])
    const data = threadsResponse.data
    if (roomsResponse.data) {
      roomNames.value = new Map(roomsResponse.data.map((room) => [room.id, room.name]))
    }
    if (data) {
      // 保留已加载的消息状态（删除/手动刷新时避免展开的对话详情被重置）
      const oldLogs = logs.value
      const grouped = groupLogsByRoom(data.items)
      // 据点房间的消息数须从群聊表实时统计：
      // group Thread 的 messageCount 仅覆盖触发过 RAG 的回合，不代表房间全部消息，不权威。
      await Promise.all(
        [...new Set(grouped.filter((e) => e.roomId).map((e) => e.roomId!))].map(async (roomId) => {
          try {
            const res = await strongholdApi.getMessageCount(roomId)
            grouped.forEach((entry) => {
              if (entry.roomId === roomId) entry.messageCount = res.data?.count ?? 0
            })
          } catch (err) {
            logger.error(
              'LogsTab',
              __t('logs.frontend.settings', '加载据点房间消息数失败: {0}', [roomId]),
              err,
            )
          }
        }),
      )
      logs.value = grouped.map((entry) => {
        const old = oldLogs.find((log) => log.id === entry.id)
        // 若该条已展开且消息已加载,保留原有 messages/messagesLoaded/isLoadingMessages,
        // 防止刷新时展开的详情区域全部消失（UX 事故）。
        // messageCount 始终使用最新拉取的真实总数，与消息预览窗口解耦。
        if (old && old.messagesLoaded) {
          entry.messages = old.messages
          entry.messagesLoaded = true
          entry.isLoadingMessages = false
        }
        return entry
      })
      totalCount.value = data.total
    }
  } catch (e) {
    logger.error('LogsTab', __t('logs.frontend.settings', '加载 Thread 列表失败'), e)
  } finally {
    isLoading.value = false
  }
}

/** 展开时加载消息详情 */
async function toggleExpand(id: string): Promise<void> {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  expandedId.value = id

  const log = logs.value.find((item) => item.id === id)
  if (log && !log.messagesLoaded) {
    logs.value = logs.value.map((item) =>
      item.id === id ? { ...item, isLoadingMessages: true } : item,
    )
    try {
      let roomMessages: LogMessage[] | undefined
      if (log.roomId) {
        const response = await strongholdApi.getProjection(log.roomId, 100)
        roomMessages =
          response.data?.messages.map((message) => ({
            id: message.messageId,
            role: message.role,
            content: message.content,
            agentId: message.senderId,
            timestamp: message.timestamp ?? undefined,
          })) ?? []
      }

      if (roomMessages) {
        logs.value = logs.value.map((item) =>
          item.id === id
            ? {
                ...item,
                messages: roomMessages,
                // 不覆盖 messageCount：列表已展示房间真实总数，展开窗口只是预览
                messagesLoaded: true,
                isLoadingMessages: false,
              }
            : item,
        )
        return
      }

      const res = await threadsApi.get(log.threadId, { pageSize: 30 })
      const data = res.data
      if (data) {
        const threadMessages = [...data.messages].reverse().map((message: ThreadMessageInfo) => ({
          // 后端 id 为 number，本地统一转 string 以兼容删除等 API 调用
          id: String(message.id),
          role: message.role,
          content: message.content,
          agentId: message.agentId,
          // 使用后端返回的原始内容（含调试块），缺失时回退为 null
          rawContent: message.rawContent ?? null,
          metadataJson: message.metadataJson,
          // 后端字段名为 timestamp（不是 createdAt）
          timestamp: message.timestamp ?? undefined,
        }))
        logs.value = logs.value.map((item) =>
          item.id === id
            ? {
                ...item,
                messages: threadMessages,
                // 不覆盖 messageCount：列表已展示 Thread 真实总数，展开窗口只是预览
                messagesLoaded: true,
                isLoadingMessages: false,
              }
            : item,
        )
      }
    } catch (e) {
      logger.error('LogsTab', __t('logs.frontend.settings', '加载 Thread 详情失败'), e)
    } finally {
      if (!logs.value.find((item) => item.id === id)?.messagesLoaded) {
        logs.value = logs.value.map((item) =>
          item.id === id ? { ...item, isLoadingMessages: false } : item,
        )
      }
    }
  }
}

function getAgentName(agentId: string): string {
  return agentStore.agents.find((agent) => agent.id === agentId)?.name || agentId
}

function isOwnerMessage(log: LogEntry, message: LogMessage): boolean {
  return isLocalOwnerMessage({
    role: message.role,
    channel: log.channel,
    platform: log.roomId ? 'stronghold' : undefined,
    senderId: message.agentId,
  })
}

function toLogEntry(t: ThreadInfo): LogEntry {
  return {
    id: t.id,
    threadId: t.id,
    agentId: t.agentId,
    agentName: getAgentName(t.agentId),
    summary: t.title || __t('ui.settings', '未命名会话'),
    // 后端列表已返回真实计数，无需展开即可展示
    messageCount: t.messageCount ?? 0,
    channel: t.channel || 'desktop',
    createdAt: t.updatedAt || t.createdAt,
    messages: [],
    messagesLoaded: false,
    isLoadingMessages: false,
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(getDisplayLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatMsgTime(ts?: string): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString(getDisplayLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 动态获取 agent 头像完整 URL */
function getAgentAvatar(agentId: string): string | null {
  const agent = agentStore.agents.find((a) => a.id === agentId)
  if (agent?.avatarUrl) {
    return `${getApiBaseUrl()}${agent.avatarUrl}`
  }
  return null
}

/** 群聊权威消息携带实际发言者；普通 Thread 则使用所属 Agent。 */
function getMessageAgentName(log: LogEntry, message: LogMessage): string {
  return message.agentId ? getAgentName(message.agentId) : log.agentName
}

/** 复制记录到剪贴板 */
async function handleCopy(content: string) {
  try {
    await copyClientText(content)
    logger.info('LogsTab', __t('logs.frontend.settings', '已复制日志内容'))
    notif.toast(__t('ui.settings', '已复制'), { type: 'success' })
  } catch (err) {
    logger.error('LogsTab', __t('logs.frontend.settings', '复制失败'), err)
    notif.toast(__t('ui.settings', '复制失败'), { type: 'error' })
  }
}

/** 修改日志中的会话标题，并立即同步当前列表。 */
async function confirmRenameThread(value?: string) {
  const target = threadPendingRename.value
  if (!target) return
  const title = value?.trim() ?? ''
  try {
    await threadsApi.rename(target.threadId, title)
    logs.value = logs.value.map((log) =>
      log.id === target.id ? { ...log, summary: title || '未命名会话' } : log,
    )
    notif.toast(__t('ui.settings', '会话标题已更新'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '对话日志')
      },
    })
  } catch (err) {
    logger.error('LogsTab', __t('logs.frontend.settings', '会话改名失败'), err)
    notif.toast(err instanceof Error ? err.message : __t('ui.settings', '会话改名失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '对话日志')
      },
    })
  } finally {
    threadPendingRename.value = null
  }
}

/** 打开整条会话的统一 rewind 预检。 */
async function requestDeleteThread(log: LogEntry) {
  threadPendingDelete.value = log
  try {
    await rewind.open({
      threadId: log.threadId,
      wholeThread: true,
      title: log.summary || __t('ui.settings', '未命名会话'),
      onSuccess: () => {
        logs.value = logs.value.filter((item) => item.id !== log.id)
        totalCount.value = Math.max(0, totalCount.value - 1)
        if (expandedId.value === log.id) expandedId.value = null
        notif.toast(__t('ui.settings', '会话已删除，文件保持原样'), {
          type: 'success',
          get title() {
            return __t('ui.settings', '对话日志')
          },
        })
      },
    })
  } catch (err) {
    threadPendingDelete.value = null
    notif.toast(err instanceof Error ? err.message : __t('ui.settings', '回滚预检失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '对话日志')
      },
    })
  }
}

/** 在日志中链式回滚目标轮次及后续所有轮次。 */
async function handleDeletePair(log: LogEntry, id: string) {
  try {
    await rewind.open({
      threadId: log.threadId,
      messageId: Number(id),
      onSuccess: (result) => {
        const deletedIds = new Set(result.deletedMessageIds.map(String))
        logs.value = logs.value.map((item) =>
          item.id === log.id
            ? {
                ...item,
                messages: item.messages.filter((message) => !deletedIds.has(message.id)),
                messageCount: Math.max(0, item.messageCount - deletedIds.size),
              }
            : item,
        )
        window.dispatchEvent(
          new CustomEvent('infos:conversation-rewound', {
            detail: {
              threadId: log.threadId,
              deletedMessageIds: result.deletedMessageIds.map(String),
              projection: result.projection,
            },
          }),
        )
        notif.toast(__t('ui.settings', '已回滚 {0} 轮对话', [result.preview.pairCount]), {
          type: 'success',
          get title() {
            return __t('ui.settings', '对话日志')
          },
        })
      },
    })
  } catch (err) {
    logger.error('LogsTab', __t('logs.frontend.settings', '回滚预检失败'), err)
    notif.toast(err instanceof Error ? err.message : __t('ui.settings', '回滚预检失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '对话日志')
      },
    })
  }
}

// ══════ 调试日志查看器 ══════
const showDebugDialog = ref(false)
const currentDebugMsg = ref<LogMessage | null>(null)
const debugViewMode = ref<'prompt' | 'raw'>('prompt')

function hasStoredRawContent(msg: LogMessage): boolean {
  return Boolean(msg.rawContent?.trim())
}

/** 调试弹窗中显示原始转写；旧记录未落库时回退可见回复。 */
function getDebugRawContent(msg: LogMessage): string {
  return msg.rawContent?.trim() || msg.content
}

const debugRequestTurn = ref(1)
interface DebugModelRequest {
  requestId: number
  turn: number
  messages: InitialPromptMessage[]
  prefill?: { content: string; mode: string }
  omitted?: boolean
}
function getModelRequests(msg: LogMessage): DebugModelRequest[] {
  try {
    const data = JSON.parse(msg.metadataJson ?? '{}')
    return Array.isArray(data.modelRequests)
      ? data.modelRequests.map((request: DebugModelRequest, index: number) => ({
          ...request,
          requestId: request.requestId ?? index + 1,
        }))
      : []
  } catch {
    return []
  }
}

/** 新记录显示所选轮次的请求编译结果；旧记录保留历史快照。 */
function getInitialPromptMessages(msg: LogMessage): InitialPromptMessage[] {
  const request = getModelRequests(msg).find((item) => item.requestId === debugRequestTurn.value)
  if (request) return request.messages
  if (!msg.metadataJson) return []
  try {
    const parsed = JSON.parse(msg.metadataJson) as {
      initialPromptMessages?: InitialPromptMessage[]
    }
    return Array.isArray(parsed.initialPromptMessages) ? parsed.initialPromptMessages : []
  } catch {
    return []
  }
}

function getInputTokenCount(msg: LogMessage): number | undefined {
  if (!msg.metadataJson) return undefined
  try {
    const parsed = JSON.parse(msg.metadataJson) as { tokenUsage?: { inputTokens?: unknown } }
    const value = parsed.tokenUsage?.inputTokens
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function formatPromptContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return JSON.stringify(content, null, 2)
}

/** 打开调试弹窗。 */
function openDebugDialog(msg: LogMessage): void {
  debugRequestTurn.value = getModelRequests(msg)[0]?.requestId ?? 1
  currentDebugMsg.value = msg
  debugViewMode.value = 'prompt'
  showDebugDialog.value = true
}

// 监听全局刷新
watch(
  () => ctx.refreshKey.value,
  () => fetchSessions(),
)

function handleConversationCompleted(): void {
  void fetchSessions()
}

function handleConversationRewound(event: Event): void {
  const detail = (event as CustomEvent<{ threadId?: string }>).detail
  if (!detail?.threadId) return
  void fetchSessions()
}

onMounted(async () => {
  window.addEventListener('infos:conversation-completed', handleConversationCompleted)
  window.addEventListener('infos:conversation-rewound', handleConversationRewound)
  // Dashboard 窗口可能独立于 Launcher 打开，需要先拿到完整 Agent 列表再渲染筛选项和显示名
  if (!agentStore.agents.length) await agentStore.fetchAgents()
  await fetchSessions()
})

onUnmounted(() => {
  window.removeEventListener('infos:conversation-completed', handleConversationCompleted)
  window.removeEventListener('infos:conversation-rewound', handleConversationRewound)
})
</script>

<template>
  <div v-bind="$attrs" class="logs-tab h-full flex flex-col overflow-hidden">
    <!-- 工具栏 -->
    <div class="p-6 pb-0 flex-none">
      <PCard pixel overflow-visible class="relative group/toolbar z-30">
        <!-- 背景装饰 ✨ -->
        <div
          class="absolute -right-20 -top-20 w-40 h-40 bg-sky-400/5 blur-[60px] rounded-full pointer-events-none group-hover/toolbar:bg-sky-400/15 transition-all duration-1000"
        />
        <div
          class="absolute -left-10 -bottom-10 w-32 h-32 bg-sky-300/5 blur-[50px] rounded-full pointer-events-none group-hover/toolbar:bg-sky-300/10 transition-all duration-1000 delay-150"
        />

        <div class="flex flex-wrap items-end gap-5 relative z-10">
          <!-- 标题 -->
          <div class="flex flex-col gap-1.5 min-w-[120px]">
            <h2 class="flex items-center gap-2 text-xl font-black text-ui-text-primary font-pixel">
              <span
                class="group-hover/toolbar:scale-110 group-hover/toolbar:rotate-6 transition-transform duration-500"
              >
                <PixelIcon name="chat" size="md" />
              </span>
              {{ __t('ui.settings', '对话日志') }}
              <span
                class="opacity-0 group-hover/toolbar:opacity-100 transition-opacity duration-500"
              >
                <PixelIcon name="paw" size="xs" />
              </span>
            </h2>
          </div>

          <!-- 当前角色头像徽标 -->
          <div class="flex items-center gap-2.5 ml-auto mr-4">
            <div
              class="current-agent-badge relative flex items-center gap-2 px-3 py-1.5 pixel-border-sky group/avatar cursor-default transition-all"
            >
              <div
                class="w-8 h-8 pixel-border-sky overflow-hidden flex items-center justify-center bg-ui-accent-sky-soft group-hover/avatar:scale-110 transition-transform"
              >
                <img
                  v-if="agentStore.currentAgent?.avatarUrl"
                  :src="`${getApiBaseUrl()}${agentStore.currentAgent.avatarUrl}`"
                  :alt="activeAgentName"
                  class="w-full h-full object-cover"
                />
                <PixelIcon v-else name="cat" size="sm" class="text-ui-accent-sky" />
              </div>
              <span class="current-agent-name text-sm font-bold transition-colors">
                {{ activeAgentName }}
              </span>
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-sm" />
            </div>
          </div>

          <!-- 搜索 -->
          <div class="flex flex-col gap-1.5 flex-1 min-w-[160px] max-w-[280px]">
            <label
              class="text-[10px] font-bold text-ui-text-secondary flex items-center gap-1.5 ml-1 uppercase tracking-wider"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-ui-accent-sky" />
              {{ __t('ui.settings', '搜索') }}
              <span class="opacity-50 font-normal">Search</span>
            </label>
            <PInput
              v-model="searchQuery"
              :placeholder="__t('ui.settings', '搜索对话摘要...')"
              class="!text-sm"
            />
          </div>

          <!-- Agent -->
          <div class="flex flex-col gap-1.5 min-w-[130px]">
            <label
              class="text-[10px] font-bold text-ui-text-secondary flex items-center gap-1.5 ml-1 uppercase tracking-wider"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-ui-accent-sky animate-pulse" />
              {{ __t('ui.settings', '角色') }}
              <span class="opacity-50 font-normal">Agent</span>
            </label>
            <PSelect v-model="filterAgent" :options="agentOptions" @change="fetchSessions" />
          </div>

          <!-- 来源 -->
          <div class="flex flex-col gap-1.5 min-w-[130px]">
            <label
              class="text-[10px] font-bold text-ui-text-secondary flex items-center gap-1.5 ml-1 uppercase tracking-wider"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-ui-accent-sky" />
              {{ __t('ui.settings', '来源') }}
              <span class="opacity-50 font-normal">Source</span>
            </label>
            <PSelect v-model="filterChannel" :options="channelOptions" @change="fetchSessions" />
          </div>

          <!-- 排序 -->
          <div class="flex flex-col gap-1.5 min-w-[120px]">
            <label
              class="text-[10px] font-bold text-ui-text-secondary flex items-center gap-1.5 ml-1 uppercase tracking-wider"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-ui-accent-sky" />
              {{ __t('ui.settings', '排序') }}
              <span class="opacity-50 font-normal">Sort</span>
            </label>
            <PSelect v-model="selectedSort" :options="sortOptions" />
          </div>

          <!-- 刷新 -->
          <div class="pb-0.5 ml-auto">
            <PButton
              variant="secondary"
              :loading="isLoading"
              class="group/refresh"
              @click="fetchSessions"
            >
              <span
                class="group-hover/refresh:rotate-180 transition-transform duration-700 inline-block"
              >
                <PixelIcon name="refresh" size="xs" />
              </span>
              {{ __t('ui.settings', '刷新') }}
            </PButton>
          </div>
        </div>
      </PCard>
    </div>

    <!-- 聊天列表 -->
    <div class="flex-1 overflow-y-auto px-6 pb-6 pt-4 logs-scrollbar">
      <PEmpty v-if="filteredLogs.length === 0">
        <template #description>
          <div class="flex items-center gap-2 justify-center">
            {{ __t('ui.settings', '暂无对话记录') }}
            <PixelIcon name="thought" size="xs" />
          </div>
        </template>
      </PEmpty>

      <div v-else class="space-y-3 max-w-4xl mx-auto">
        <div v-for="log in filteredLogs" :key="log.id" class="group/session">
          <!-- 会话头 -->
          <PCard pixel hoverable padding="sm" class="cursor-pointer" @click="toggleExpand(log.id)">
            <div class="flex justify-between items-center relative">
              <!-- 头像 + 摘要 -->
              <div class="flex items-center gap-3 min-w-0">
                <div
                  class="w-11 h-11 flex items-center justify-center bg-gradient-to-br from-sky-400 to-sky-600 text-white font-black text-base flex-shrink-0 shadow-lg shadow-sky-200/30 group-hover/session:scale-110 group-hover/session:rotate-6 transition-all duration-500 relative overflow-hidden"
                >
                  <!-- 据点群聊使用与据点页面一致的五边形 Logo，不显示任意角色头像。 -->
                  <svg
                    v-if="log.roomId"
                    viewBox="0 0 48 48"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    :aria-label="__t('ui.settings', '据点房间')"
                    class="w-full h-full p-1"
                  >
                    <path
                      d="M24 2 L44.92 17.2 L36.93 41.8 L11.07 41.8 L3.08 17.2 Z"
                      fill="#1e3a5f"
                    />
                    <path
                      d="M24 6 L41.15 18.42 L34.6 38.6 L13.4 38.6 L6.85 18.42 Z"
                      fill="#38bdf8"
                    />
                    <path d="M16.4 24.4 L31.6 24.4 L24 13.4 Z" fill="#f8fafc" opacity="0.95" />
                    <rect
                      x="16.4"
                      y="24.4"
                      width="15.2"
                      height="10"
                      fill="#f8fafc"
                      opacity="0.95"
                    />
                    <rect x="22.1" y="27.6" width="3.8" height="6.8" rx="1.9" fill="#1e3a5f" />
                  </svg>
                  <img
                    v-else-if="getAgentAvatar(log.agentId)"
                    :src="getAgentAvatar(log.agentId)!"
                    class="w-full h-full object-cover"
                    :alt="log.agentName"
                  />
                  <template v-else>
                    <div class="absolute inset-0 bg-gradient-to-tr from-white/20 to-transparent" />
                    <span class="relative z-10">{{ log.agentName[0] }}</span>
                  </template>
                  <!-- 🐾 小脚印装饰 -->
                  <div
                    class="absolute -bottom-1 -right-1 text-[10px] opacity-0 group-hover/session:opacity-100 transition-opacity duration-500 z-20"
                  >
                    <PixelIcon name="paw" size="xs" animation="bounce" />
                  </div>
                </div>
                <div class="min-w-0">
                  <h4 class="text-[13px] font-bold text-ui-text-primary truncate">
                    {{ log.summary }}
                  </h4>
                  <div class="flex gap-3 mt-1 flex-wrap">
                    <span class="text-[10px] text-ui-text-secondary flex items-center gap-1">
                      <PixelIcon name="chat" size="xs" />
                      {{ log.messageCount }} {{ __t('ui.settings', '条') }}
                    </span>
                    <span
                      class="text-[10px] font-bold px-1.5 py-0.5 bg-ui-accent-sky-soft text-ui-accent-sky border border-ui-border-default"
                    >
                      {{ log.channel }}
                    </span>
                    <span class="text-[10px] text-ui-text-secondary font-pixel">
                      {{ formatDate(log.createdAt) }}
                    </span>
                  </div>
                </div>
              </div>
              <!-- 会话操作 -->
              <div class="flex items-center gap-1 relative z-20">
                <button
                  class="p-1.5 text-ui-text-secondary hover:text-ui-accent-sky hover:bg-ui-accent-sky-soft transition-colors"
                  :title="__t('ui.settings', '修改会话标题')"
                  :aria-label="__t('ui.settings', '修改会话标题')"
                  @click.stop="threadPendingRename = log"
                >
                  <PixelIcon name="pencil" size="xs" />
                </button>
                <button
                  class="p-1.5 text-ui-text-secondary hover:text-ui-danger hover:bg-ui-danger-soft transition-colors"
                  :title="__t('ui.settings', '删除整条会话')"
                  :aria-label="__t('ui.settings', '删除整条会话')"
                  @click.stop="requestDeleteThread(log)"
                >
                  <PixelIcon name="trash" size="xs" />
                </button>
                <PixelIcon
                  :name="expandedId === log.id ? 'chevron-up' : 'chevron-down'"
                  size="xs"
                  class="text-ui-text-secondary flex-shrink-0 transition-transform duration-500"
                  :class="expandedId === log.id ? 'rotate-0' : ''"
                />
              </div>
              <!-- 装饰水印 -->
              <div
                class="absolute -right-3 -bottom-3 opacity-[0.03] group-hover/session:opacity-[0.08] transition-all duration-700 pointer-events-none"
              >
                <PixelIcon name="thought" size="3xl" />
              </div>
            </div>
          </PCard>

          <!-- 展开后的气泡式对话 -->
          <div
            v-if="expandedId === log.id"
            class="mt-2 ml-4 pl-4 border-l-2 border-ui-border-default space-y-4 py-3"
          >
            <!-- 加载中 -->
            <div
              v-if="log.isLoadingMessages"
              class="flex items-center gap-2 text-ui-text-secondary text-sm font-bold py-4 justify-center"
            >
              <PixelIcon name="refresh" size="sm" animation="spin" />
              <span class="font-pixel">{{ __t('ui.settings', '加载消息中...') }}</span>
            </div>

            <!-- 消息气泡 -->
            <template v-else>
              <div
                v-for="(msg, i) in log.messages"
                :key="i"
                class="flex gap-3 group/msg"
                :class="msg.role === 'user' ? 'flex-row-reverse' : ''"
              >
                <!-- 头像 -->
                <div
                  class="message-avatar flex-none w-9 h-9 flex items-center justify-center text-sm border transition-all duration-500 group-hover/msg:scale-110 group-hover/msg:rotate-3 relative overflow-hidden flex-shrink-0"
                  :class="
                    msg.role === 'user' ? 'message-avatar--user' : 'message-avatar--assistant'
                  "
                >
                  <UserAvatar v-if="isOwnerMessage(log, msg)" :size="36" :framed="false" />
                  <PixelIcon
                    v-else-if="msg.role === 'user'"
                    name="user"
                    size="sm"
                    class="relative z-10"
                  />
                  <template v-else>
                    <!-- 据点房间消息统一使用据点 Logo，避免视觉上重新绑定到某个 Agent。 -->
                    <svg
                      v-if="log.roomId"
                      viewBox="0 0 48 48"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      :aria-label="__t('ui.settings', '据点房间')"
                      class="w-full h-full p-1 relative z-10"
                    >
                      <path
                        d="M24 2 L44.92 17.2 L36.93 41.8 L11.07 41.8 L3.08 17.2 Z"
                        fill="#1e3a5f"
                      />
                      <path
                        d="M24 6 L41.15 18.42 L34.6 38.6 L13.4 38.6 L6.85 18.42 Z"
                        fill="#38bdf8"
                      />
                      <path d="M16.4 24.4 L31.6 24.4 L24 13.4 Z" fill="#f8fafc" opacity="0.95" />
                      <rect
                        x="16.4"
                        y="24.4"
                        width="15.2"
                        height="10"
                        fill="#f8fafc"
                        opacity="0.95"
                      />
                      <rect x="22.1" y="27.6" width="3.8" height="6.8" rx="1.9" fill="#1e3a5f" />
                    </svg>
                    <img
                      v-else-if="getAgentAvatar(log.agentId)"
                      :src="getAgentAvatar(log.agentId)!"
                      class="w-full h-full object-cover relative z-10"
                    />
                    <PixelIcon v-else name="robot" size="sm" class="relative z-10" />
                  </template>
                </div>

                <!-- 气泡 -->
                <div
                  class="flex flex-col max-w-[80%]"
                  :class="msg.role === 'user' ? 'items-end' : 'items-start'"
                >
                  <!-- 角色标签 -->
                  <div
                    class="flex items-center gap-2 mb-1 text-[10px] text-ui-text-secondary px-2 font-bold"
                  >
                    <span
                      class="tracking-wider uppercase flex items-center gap-1"
                      :class="msg.role === 'user' ? 'text-ui-accent-sky' : 'text-ui-accent-purple'"
                    >
                      <PixelIcon
                        v-if="msg.role !== 'user'"
                        name="sparkle"
                        size="xs"
                        animation="spin"
                      />
                      {{
                        msg.role === 'user'
                          ? __t('ui.settings', '主人')
                          : getMessageAgentName(log, msg)
                      }}
                      <PixelIcon
                        v-if="msg.role === 'user'"
                        name="heart"
                        size="xs"
                        animation="pulse"
                      />
                    </span>
                    <span v-if="msg.timestamp" class="text-ui-text-secondary font-mono text-[9px]">
                      {{ formatMsgTime(msg.timestamp) }}
                    </span>
                    <span
                      v-if="msg.role !== 'user' && msg.outputTokens !== undefined"
                      class="text-ui-text-secondary font-mono text-[9px]"
                    >
                      {{ msg.outputTokens.toLocaleString(getDisplayLocale()) }} Token
                    </span>
                  </div>

                  <!-- 气泡主体 -->
                  <div
                    class="message-bubble relative px-5 py-3 text-[13px] leading-relaxed transition-all duration-500 border group/bubble"
                    :class="
                      msg.role === 'user' ? 'message-bubble--user' : 'message-bubble--assistant'
                    "
                  >
                    <!-- 浮动装饰 -->
                    <div
                      v-if="msg.role !== 'user'"
                      class="absolute -right-4 -top-4 opacity-0 group-hover/bubble:opacity-100 transition-all duration-700 transform scale-0 group-hover/bubble:scale-110 rotate-12 group-hover/bubble:rotate-0"
                    >
                      <PixelIcon name="sparkle" size="sm" animation="spin" />
                    </div>
                    <div
                      v-if="msg.role === 'user'"
                      class="absolute -left-4 -top-4 opacity-0 group-hover/bubble:opacity-100 transition-all duration-700 transform scale-0 group-hover/bubble:scale-110 -rotate-12 group-hover/bubble:rotate-0"
                    >
                      <PixelIcon name="paw" size="sm" animation="bounce" />
                    </div>
                    <p class="whitespace-pre-wrap break-words relative z-10">{{ msg.content }}</p>

                    <!-- 气泡操作栏 (Hover 时浮现) -->
                    <div
                      v-if="!log.roomId"
                      class="logs-bubble-actions absolute -top-4 right-2 opacity-0 group-hover/bubble:opacity-100 transition-opacity flex items-center z-20 rounded-sm overflow-hidden"
                    >
                      <button
                        class="p-1.5 text-ui-text-secondary hover:text-ui-accent-sky hover:bg-ui-accent-sky-soft transition-colors"
                        :title="__t('ui.settings', '复制')"
                        @click.stop="handleCopy(msg.content)"
                      >
                        <PixelIcon name="copy" size="sm" />
                      </button>
                      <button
                        class="p-1.5 text-ui-text-secondary hover:text-ui-danger hover:bg-ui-danger-soft transition-colors"
                        :title="__t('ui.settings', '删除该对话对')"
                        @click.stop="handleDeletePair(log, msg.id)"
                      >
                        <PixelIcon name="trash" size="sm" />
                      </button>
                      <button
                        v-if="msg.role === 'assistant'"
                        class="p-1.5 text-ui-text-secondary hover:text-ui-accent-purple hover:bg-ui-accent-purple-soft transition-colors border-l border-ui-border-default"
                        :title="__t('ui.settings', '查看内部构造')"
                        @click.stop="openDebugDialog(msg)"
                      >
                        <PixelIcon name="terminal" size="sm" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 底部提示 -->
              <div class="text-center pt-2">
                <span
                  class="text-[10px] text-ui-text-secondary font-bold px-3 py-1 bg-ui-accent-sky-soft border border-ui-border-default inline-flex items-center gap-1.5"
                >
                  <PixelIcon name="thought" size="xs" />
                  {{ __t('ui.settings', '展示前') }} {{ log.messages.length }}
                  {{ __t('ui.settings', '条消息') }}
                  <PixelIcon name="paw" size="xs" />
                </span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ 调试日志弹窗 ═══ -->
  <PDialog
    :model-value="Boolean(threadPendingRename)"
    :title="__t('ui.settings', '修改会话标题')"
    mode="prompt"
    :default-value="
      threadPendingRename?.summary === '未命名会话' ? '' : threadPendingRename?.summary || ''
    "
    :placeholder="__t('ui.settings', '未命名会话')"
    :confirm-text="__t('ui.settings', '保存标题')"
    @update:model-value="
      (visible) => {
        if (!visible) threadPendingRename = null
      }
    "
    @confirm="confirmRenameThread"
  />

  <ConversationRewindDialog
    v-model="rewind.visible.value"
    :preview="rewind.preview.value"
    :loading="rewind.loading.value"
    @update:model-value="handleRewindVisibility"
    @confirm="rewind.confirm"
  />

  <PDialog
    v-model="showDebugDialog"
    :title="__t('ui.settings', '对话调试详情 (Debug View)')"
    width="800px"
  >
    <div v-if="currentDebugMsg" class="debug-dialog-body space-y-4">
      <div
        class="debug-view-switch"
        role="tablist"
        :aria-label="__t('ui.settings', '调试内容视图')"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="debugViewMode === 'prompt'"
          :class="{ active: debugViewMode === 'prompt' }"
          @click="debugViewMode = 'prompt'"
        >
          <PixelIcon name="terminal" size="xs" />
          <span>{{ __t('ui.settings', '完整提示词') }}</span>
          <small>PROMPT</small>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="debugViewMode === 'raw'"
          :class="{ active: debugViewMode === 'raw' }"
          @click="debugViewMode = 'raw'"
        >
          <PixelIcon name="file" size="xs" />
          <span>{{ __t('ui.settings', '原始文本') }}</span>
          <small>RAW</small>
        </button>
      </div>

      <!-- 元信息 -->
      <div class="debug-meta flex flex-wrap items-center gap-4 p-3 text-[11px] font-pixel">
        <div class="flex items-center gap-1.5">
          <span class="opacity-50 uppercase">Log ID:</span>
          <span class="font-bold border-b border-current opacity-60">{{ currentDebugMsg.id }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="opacity-50 uppercase">Role:</span>
          <span
            class="debug-role-badge px-1.5 py-0.5 font-bold uppercase tracking-wider"
            :class="
              currentDebugMsg.role === 'user'
                ? 'debug-role-badge--user'
                : 'debug-role-badge--assistant'
            "
          >
            {{ currentDebugMsg.role }}
          </span>
        </div>
        <div v-if="debugViewMode === 'prompt'" class="flex items-center gap-1.5">
          <span class="opacity-50 uppercase">{{ __t('ui.settings', '输入 Token:') }}</span>
          <span class="font-bold font-mono">
            {{
              getInputTokenCount(currentDebugMsg)?.toLocaleString(getDisplayLocale()) ??
              __t('ui.settings', '历史记录无统计')
            }}
          </span>
        </div>
        <div class="flex items-center gap-1.5 ml-auto">
          <span class="opacity-50 uppercase">Storage:</span>
          <span class="font-bold flex items-center gap-1">
            <template v-if="hasStoredRawContent(currentDebugMsg)">
              <PixelIcon name="check" size="xs" class="text-ui-success" />
              {{ __t('ui.settings', '已保存原始日志 (')
              }}{{ currentDebugMsg.rawContent!.length }} bytes)
            </template>
            <template v-else>
              <PixelIcon name="alert" size="xs" class="text-ui-warning" />
              {{ __t('ui.settings', '历史记录未保存原始转写，已显示可见回复') }}
            </template>
          </span>
        </div>
      </div>

      <!-- 完整提示词按实际请求轮次展示，兼容旧记录的初始快照。 -->
      <div v-if="debugViewMode === 'prompt'" class="prompt-view logs-scrollbar">
        <div v-if="getModelRequests(currentDebugMsg).length" class="request-selection">
          <select v-model="debugRequestTurn" :aria-label="__t('ui.settings', '模型请求轮次')">
            <option
              v-for="request in getModelRequests(currentDebugMsg)"
              :key="request.requestId"
              :value="request.requestId"
            >
              {{ __t('ui.settings', '第 {0} 次模型请求', [request.requestId]) }}
            </option>
          </select>
          <small>{{ __t('ui.settings', '请求编译结果，媒体内容以引用展示') }}</small>
          <p
            v-if="
              getModelRequests(currentDebugMsg).find((item) => item.requestId === debugRequestTurn)
                ?.omitted
            "
          >
            {{ __t('ui.settings', '此轮请求过大，未保存重复正文') }}
          </p>
        </div>
        <template v-if="getInitialPromptMessages(currentDebugMsg).length">
          <article
            v-for="(message, index) in getInitialPromptMessages(currentDebugMsg)"
            :key="`${message.role}:${index}`"
            class="prompt-message"
            :class="`is-${message.role}`"
          >
            <header>
              <span>{{ message.role }}</span>
              <span v-if="message.promptSegment === 'assistant_prefill'">
                {{ __t('ui.settings', '预填充') }}
              </span>
              <small>#{{ String(index + 1).padStart(2, '0') }}</small>
            </header>
            <pre><code>{{ formatPromptContent(message.content) }}</code></pre>
          </article>
        </template>
        <div v-else class="prompt-view__empty">
          <PixelIcon name="info" size="md" />
          <strong>{{ __t('ui.settings', '无提示词记录') }}</strong>
          <span>{{ __t('ui.settings', '此记录未保存提示词。') }}</span>
        </div>
      </div>

      <!-- 原始模型转写。 -->
      <div v-else class="max-h-[50vh] overflow-y-auto pr-2 logs-scrollbar">
        <pre
          class="debug-raw p-4 border text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto"
        ><code>{{ getDebugRawContent(currentDebugMsg) }}</code></pre>
      </div>
    </div>

    <template #footer>
      <PButton variant="secondary" size="sm" @click="showDebugDialog = false">
        {{ __t('ui.settings', '关闭') }}
      </PButton>
    </template>
  </PDialog>
</template>

<style scoped src="./logsTab.css"></style>
