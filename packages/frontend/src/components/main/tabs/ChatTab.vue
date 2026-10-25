<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * ChatTab — 对话 Tab (重构版)
 *
 * 一体化面板设计:
 * - 侧边栏与聊天区共享统一容器，细线分隔
 * - 侧边栏可收起为图标栏
 * - 支持 Thread 历史列表
 * - 像素边框仅用于选中态和品牌锚点
 *
 * 设计语言: Arc 现代骨架 + 像素萌系品牌细节
 * @see .docs/S06_UI_UX_DESIGN_SPEC.md
 */
import { ref, computed, inject, onMounted, onBeforeUnmount, watch, nextTick, type Ref } from 'vue'
import { useMobileLayout } from '../../../composables/ui/useMobileLayout'
import { useConversationNavigation } from '../../../composables/chat/useConversationNavigation'
import { ChatContainer } from '../../chat'
import AgentStateHover from '../../agent/AgentStateHover.vue'
import HistoryExportDialog from '../../chat/HistoryExportDialog.vue'
import ConversationRewindDialog from '../../chat/ConversationRewindDialog.vue'
import { PixelIcon, PButton, PEmpty, PDialog } from '../../pixel'
import { useAgentStore, useThreadStore } from '../../../stores'
import { useTaskCenterStore } from '../../../stores/taskCenterStore'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import { useConversationRewind } from '../../../composables/chat/useConversationRewind'
import { threadsApi } from '../../../api/modules/threadsApi'
import type { ThreadInfo } from '../../../api/modules/threadsApi'
import { getApiBaseUrl } from '../../../api/transport'
import { logger } from '../../../lib/logger'
import {
  buildConversationMarkdown,
  downloadMarkdown,
  type HistoryExportOptions,
} from '../../../utils/historyExport'

defineOptions({ name: 'ChatTab' })

const agentStore = useAgentStore()
const threadStore = useThreadStore()
const notify = useNotificationStore()
const rewind = useConversationRewind()
const taskCenter = useTaskCenterStore()
const navigation = useConversationNavigation()
const navigationBusy = ref(false)
const focusRequest = ref<{ messageId: string; revision: number } | undefined>()
const draftRequest = ref<{ text: string; revision: number } | undefined>()
const initialized = ref(false)
let navigationGeneration = 0

async function followNavigation() {
  if (!initialized.value || !navigation.value || isSwitchingAgent.value) return
  const request = navigation.value
  // 同一角色的活动草稿直接送入现有输入框，保留用户还没发送的文字。
  if (
    request.draft &&
    !navigationBusy.value &&
    !threadStore.isLoadingHistory &&
    request.target.agentId === agentStore.activeAgentId &&
    threadStore.agentId === request.target.agentId &&
    !request.target.threadId &&
    threadStore.threadId &&
    !threadStore.historyError
  ) {
    draftRequest.value = { text: request.draft, revision: request.revision }
    if (navigation.value === request) navigation.value = null
    return
  }
  const generation = ++navigationGeneration
  navigationBusy.value = true
  try {
    await nextTick()
    if (!agentStore.agents.some((agent) => agent.id === request.target.agentId))
      await agentStore.fetchAgents()
    await agentStore.switchAgent(request.target.agentId)
    if (generation !== navigationGeneration) return
    if (request.target.threadId) {
      const result = await threadStore.loadThreadMessages(
        request.target.threadId,
        request.target.agentId,
      )
      if (result.status === 'superseded') return
      if (result.status === 'failed') throw result.error
    } else if (!(await threadStore.ensureLatestThread(request.target.agentId, 'desktop'))) return
    if (generation !== navigationGeneration) return
    if (threadStore.historyError) throw new Error(threadStore.historyError)
    focusRequest.value = request.target.messageId
      ? { messageId: request.target.messageId, revision: request.revision }
      : undefined
    void loadThreadHistory(request.target.agentId)
    if (generation === navigationGeneration && request.draft)
      draftRequest.value = { text: request.draft, revision: request.revision }
  } catch (error) {
    if (generation !== navigationGeneration) return
    notify.toast(
      error instanceof Error ? error.message : __t('ui.navigation', '无法定位桌宠回复'),
      { type: 'error' },
    )
  } finally {
    if (generation === navigationGeneration) {
      navigationBusy.value = false
      if (navigation.value === request) navigation.value = null
    }
  }
}
watch(navigation, () => {
  void followNavigation()
})

function isAgentOccupied(agentId: string): boolean {
  return taskCenter.activeTasks.some(
    (task) => task.agentId === agentId && ['running', 'waiting_input'].includes(task.status),
  )
}

function handleRewindVisibility(visible: boolean): void {
  if (!visible) threadPendingDelete.value = null
}

const searchQuery = ref('')
const isLoading = ref(false)
const isCreatingSession = ref(false)
const showHistoryExport = ref(false)
const isExportingHistory = ref(false)

async function exportCurrentHistory(options: HistoryExportOptions): Promise<void> {
  if (!threadStore.threadId || !activeAgent.value) return
  isExportingHistory.value = true
  try {
    const response = await threadsApi.getProjection(threadStore.threadId)
    if (!response.data) throw new Error('服务端未返回会话历史')
    const title = currentThreadTitle.value || __t('ui.navigation', '当前会话')
    downloadMarkdown(
      title,
      buildConversationMarkdown(
        {
          title,
          channelLabel: '私聊 · desktop',
          participantNames: {
            [activeAgent.value.id]: activeAgent.value.name,
          },
          messages: response.data.messages,
        },
        options,
      ),
    )
    showHistoryExport.value = false
    notify.toast(__t('ui.navigation', '历史记录已导出到客户端'), { type: 'success' })
  } catch (error) {
    notify.toast(
      error instanceof Error ? error.message : __t('ui.navigation', '历史记录导出失败'),
      { type: 'error' },
    )
  } finally {
    isExportingHistory.value = false
  }
}

// ── 侧边栏收起状态 ──
const { isMobile } = useMobileLayout()
const sidebarCollapsed = ref(isMobile.value)
const onboardingActive = inject<Ref<boolean>>('infos:onboarding-active', ref(false))
// 导览期间临时展示伙伴与历史列表，结束后恢复原来的折叠状态。
const isSidebarCollapsed = computed({
  get: () => (onboardingActive.value && !isMobile.value ? false : sidebarCollapsed.value),
  set: (value: boolean) => {
    sidebarCollapsed.value = value
  },
})
watch(isMobile, (value) => {
  isSidebarCollapsed.value = value
})
function closeMobileSidebar(event: KeyboardEvent) {
  if (isMobile.value && event.key === 'Escape') isSidebarCollapsed.value = true
}
onMounted(() => window.addEventListener('keydown', closeMobileSidebar))
onBeforeUnmount(() => window.removeEventListener('keydown', closeMobileSidebar))
const currentThreadTitle = ref('')

function toggleSidebar() {
  isSidebarCollapsed.value = !isSidebarCollapsed.value
}

// ── Thread 历史列表 ──
const threadHistory = ref<ThreadInfo[]>([])
const isLoadingThreads = ref(false)
const isSwitchingAgent = ref(false)
const pendingAgentId = ref('')
const conversationSelectionLocked = computed(() => isSwitchingAgent.value || navigationBusy.value)
let historyGeneration = 0
const threadPendingDelete = ref<ThreadInfo | null>(null)
const threadPendingRename = ref<ThreadInfo | null>(null)

async function loadThreadHistory(agentId: string) {
  if (!agentId) return
  const generation = ++historyGeneration
  isLoadingThreads.value = true
  try {
    const res = await threadsApi.list({ agentId, channel: 'desktop', pageSize: 20 })
    if (generation !== historyGeneration || activeAgent.value?.id !== agentId) return
    if (res.data?.items) threadHistory.value = res.data.items
  } catch (e) {
    if (generation === historyGeneration)
      logger.warn('ChatTab', __t('logs.frontend.navigation', '加载历史会话失败'), e)
  } finally {
    if (generation === historyGeneration) isLoadingThreads.value = false
  }
}

/** 打开整条会话的统一 rewind 预检与确认。 */
async function requestDeleteThread(thread: ThreadInfo) {
  if (
    (threadStore.isGenerating && threadStore.threadId === thread.id) ||
    isAgentOccupied(thread.agentId)
  ) {
    notify.toast(__t('ui.navigation', '角色忙碌中，请先停止任务'), {
      type: 'error',
      get title() {
        return __t('ui.navigation', '聊天会话')
      },
    })
    return
  }
  threadPendingDelete.value = thread
  try {
    await rewind.open({
      threadId: thread.id,
      wholeThread: true,
      title: thread.title || __t('ui.navigation', '未命名会话'),
      onSuccess: async () => {
        threadHistory.value = threadHistory.value.filter((item) => item.id !== thread.id)
        if (threadStore.threadId === thread.id) {
          const next = threadHistory.value[0]
          if (next) await switchThread(next)
          else threadStore.clearThread()
        }
        notify.toast(__t('ui.navigation', '会话已删除，文件保持原样'), {
          type: 'success',
          get title() {
            return __t('ui.navigation', '聊天会话')
          },
        })
      },
    })
  } catch (err) {
    threadPendingDelete.value = null
    notify.toast(err instanceof Error ? err.message : __t('ui.navigation', '回滚预检失败'), {
      type: 'error',
      get title() {
        return __t('ui.navigation', '聊天会话')
      },
    })
  }
}

/** 保存会话改名，并同步侧栏及当前标题。 */
async function confirmRenameThread(value?: string) {
  const target = threadPendingRename.value
  if (!target) return
  const title = value?.trim() ?? ''
  try {
    await threadsApi.rename(target.id, title)
    threadHistory.value = threadHistory.value.map((thread) =>
      thread.id === target.id ? { ...thread, title } : thread,
    )
    if (threadStore.threadId === target.id) currentThreadTitle.value = title || '未命名会话'
    notify.toast(__t('ui.navigation', '会话标题已更新'), {
      type: 'success',
      get title() {
        return __t('ui.navigation', '聊天会话')
      },
    })
  } catch (err) {
    notify.toast(err instanceof Error ? err.message : __t('ui.navigation', '会话改名失败'), {
      type: 'error',
      get title() {
        return __t('ui.navigation', '聊天会话')
      },
    })
  } finally {
    threadPendingRename.value = null
  }
}

/** 切换历史会话 */
async function switchThread(thread: ThreadInfo) {
  if (conversationSelectionLocked.value || thread.agentId !== activeAgent.value?.id) return
  if (thread.id === threadStore.threadId && !threadStore.navigationTarget) {
    if (isMobile.value) isSidebarCollapsed.value = true
    return
  }
  if (thread.id !== threadStore.threadId && isAgentOccupied(thread.agentId)) {
    notify.toast(__t('ui.navigation', '角色忙碌中，暂不能切换会话'), { type: 'error' })
    return
  }
  const result = await threadStore.loadThreadMessages(thread.id, thread.agentId)
  if (result.status !== 'loaded' || threadStore.threadId !== thread.id) return
  currentThreadTitle.value = thread.title || '未命名会话'
  if (isMobile.value) isSidebarCollapsed.value = true
}

/** 格式化时间 */
function formatThreadTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return __t('ui.navigation', '刚刚')
  if (diffMins < 60) return __t('ui.navigation', '{0}分钟前', [diffMins])
  if (diffHours < 24) return __t('ui.navigation', '{0}小时前', [diffHours])
  if (diffDays < 7) return __t('ui.navigation', '{0}天前', [diffDays])
  return `${date.getMonth() + 1}/${date.getDate()}`
}

// ── Agent 列表 ──
const filteredAgents = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return agentStore.agents
  return agentStore.agents.filter((a) => a.name?.toLowerCase().includes(q))
})

const activeAgent = computed(() => agentStore.currentAgent)
const activeThreadId = computed(() => threadStore.threadId)

function getAgentAvatarUrl(agentId: string): string | null {
  const avatarUrl = agentStore.agents.find((agent) => agent.id === agentId)?.avatarUrl
  return avatarUrl ? `${getApiBaseUrl()}${avatarUrl}` : null
}

async function switchAgent(agent: { id: string; name: string }) {
  if (conversationSelectionLocked.value) return
  if (activeAgent.value?.id === agent.id) {
    if (isMobile.value) isSidebarCollapsed.value = true
    return
  }
  if (activeAgent.value && isAgentOccupied(activeAgent.value.id)) {
    notify.toast(__t('ui.navigation', '任务进行中，暂不能切换角色'), { type: 'error' })
    return
  }
  isSwitchingAgent.value = true
  pendingAgentId.value = agent.id
  try {
    await agentStore.switchAgent(agent.id)
    // 主对话页必须落入目标角色的最近会话；没有历史时立即创建正式空会话。
    if (!(await threadStore.ensureLatestThread(agent.id, 'desktop'))) return
    if (isMobile.value) isSidebarCollapsed.value = true
    void loadThreadHistory(agent.id)
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : __t('ui.navigation', '切换角色失败'), {
      type: 'error',
      get title() {
        return __t('ui.navigation', '聊天会话')
      },
    })
  } finally {
    isSwitchingAgent.value = false
    pendingAgentId.value = ''
    if (navigation.value) void followNavigation()
  }
}

async function createNewChatSession() {
  if (
    !activeAgent.value ||
    conversationSelectionLocked.value ||
    threadStore.isGenerating ||
    isCreatingSession.value
  )
    return

  const agentId = activeAgent.value.id
  isCreatingSession.value = true
  try {
    await threadStore.createNewThread(agentId, 'desktop')
    if (isMobile.value) isSidebarCollapsed.value = true
    notify.toast(__t('ui.navigation', '新会话已创建'), {
      type: 'success',
      get title() {
        return __t('ui.navigation', '聊天会话')
      },
    })
    if (activeAgent.value?.id === agentId) void loadThreadHistory(agentId)
  } catch (err) {
    const message = err instanceof Error ? err.message : '新建会话失败'
    notify.toast(message, {
      type: 'error',
      get title() {
        return __t('ui.navigation', '聊天会话')
      },
    })
  } finally {
    isCreatingSession.value = false
  }
}

async function loadAgents() {
  isLoading.value = true
  try {
    await agentStore.fetchAgents()
    initialized.value = true
    // 加载当前 Agent 的历史会话
    if (activeAgent.value) {
      void loadThreadHistory(activeAgent.value.id)
    }
  } finally {
    isLoading.value = false
  }
}

onMounted(async () => {
  if (agentStore.agents.length && activeAgent.value && !agentStore.isLoading) {
    initialized.value = true
    void loadThreadHistory(activeAgent.value.id)
  } else await loadAgents()
  initialized.value = true
  await followNavigation()
})

// 监听 Agent 切换，刷新历史
watch(
  () => activeAgent.value?.id,
  (id) => {
    threadHistory.value = []
    currentThreadTitle.value = '当前会话'
    if (id) void loadThreadHistory(id)
  },
)

watch([() => threadStore.threadId, threadHistory], () => {
  const active = threadHistory.value.find((t) => t.id === threadStore.threadId)
  if (active) currentThreadTitle.value = active.title || '未命名会话'
})
</script>

<template>
  <div class="chat-tab-root">
    <!-- 一体化面板容器 -->
    <div class="chat-panel">
      <button
        v-if="isMobile && !isSidebarCollapsed"
        class="chat-mobile-backdrop"
        :aria-label="__t('ui.navigation', '关闭会话列表')"
        @click="isSidebarCollapsed = true"
      />
      <!-- 侧边栏 -->
      <aside class="chat-sidebar" :class="{ 'chat-sidebar--collapsed': isSidebarCollapsed }">
        <!-- 收起/展开按钮 -->
        <button
          class="chat-sidebar-toggle"
          :title="
            isSidebarCollapsed
              ? __t('ui.navigation', '展开侧边栏')
              : __t('ui.navigation', '收起侧边栏')
          "
          @click="toggleSidebar"
        >
          <PixelIcon :name="isSidebarCollapsed ? 'chevron-right' : 'chevron-left'" size="xs" />
        </button>

        <!-- 展开态内容 -->
        <template v-if="!isSidebarCollapsed">
          <!-- 角色舰桥式伙伴区标头 -->
          <div class="chat-partner-header">
            <span class="chat-partner-brand">{{ __t('ui.navigation', '伙伴') }}</span>
            <span class="chat-partner-signal" />
            <div class="chat-partner-search">
              <PixelIcon name="search" size="xs" class="chat-search-icon" />
              <input
                v-model="searchQuery"
                type="text"
                :placeholder="__t('ui.navigation', '搜索助手...')"
                class="chat-search-input"
              />
            </div>
          </div>

          <!-- Agent 列表 -->
          <div class="chat-agent-section">
            <div class="chat-agent-toolbar">
              <button
                class="chat-refresh-btn"
                :title="__t('ui.navigation', '刷新列表')"
                @click="loadAgents"
              >
                <PixelIcon name="refresh" size="xs" :animation="isLoading ? 'spin' : ''" />
              </button>
            </div>

            <div class="chat-agent-list chat-scrollbar">
              <PEmpty
                v-if="filteredAgents.length === 0 && !isLoading"
                :message="__t('ui.navigation', '暂无助手')"
              />

              <div
                v-for="agent in filteredAgents"
                :key="agent.id"
                role="button"
                :tabindex="conversationSelectionLocked ? -1 : 0"
                :aria-disabled="conversationSelectionLocked"
                :aria-pressed="activeAgent?.id === agent.id"
                :class="[
                  'chat-agent-card',
                  activeAgent?.id === agent.id ? 'chat-agent-card--active' : '',
                  { 'chat-agent-card--pending': pendingAgentId === agent.id },
                ]"
                @click="switchAgent(agent)"
                @keydown.enter.prevent="switchAgent(agent)"
                @keydown.space.prevent="switchAgent(agent)"
              >
                <!-- 像素光轨 -->
                <div v-if="activeAgent?.id === agent.id" class="chat-agent-trail" />

                <!-- 角色头像与共享相框 -->
                <div
                  class="chat-agent-avatar agent-portrait"
                  :class="{ 'agent-portrait--selected': activeAgent?.id === agent.id }"
                >
                  <img
                    v-if="getAgentAvatarUrl(agent.id)"
                    :src="getAgentAvatarUrl(agent.id)!"
                    :alt="agent.name"
                  />
                  <span v-else>{{ agent.name?.[0]?.toUpperCase() ?? '?' }}</span>
                </div>

                <div class="chat-agent-info">
                  <span
                    class="chat-agent-name"
                    :class="{ 'chat-agent-name--active': activeAgent?.id === agent.id }"
                  >
                    {{ agent.name }}
                  </span>
                  <span
                    class="chat-agent-status"
                    :class="{ 'chat-agent-status--online': activeAgent?.id === agent.id }"
                  >
                    <span class="chat-agent-status-dot" />
                    {{
                      activeAgent?.id === agent.id
                        ? __t('ui.navigation', '在线')
                        : __t('ui.navigation', '待机')
                    }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- Thread 历史 -->
          <div class="chat-thread-section">
            <div class="chat-section-title">
              <div class="chat-section-title-main">
                <PixelIcon name="chat" size="xs" />
                <span class="chat-history-title-text">{{ __t('ui.navigation', '历史会话') }}</span>
              </div>
              <span class="chat-section-title-en">HISTORY</span>
            </div>

            <div
              class="chat-thread-list chat-scrollbar"
              :inert="conversationSelectionLocked || undefined"
              :aria-busy="isLoadingThreads || conversationSelectionLocked"
            >
              <div v-if="isLoadingThreads && !threadHistory.length" class="chat-thread-loading">
                <PixelIcon name="refresh" size="xs" animation="spin" />
                <span>{{ __t('ui.navigation', '加载中...') }}</span>
              </div>

              <div v-else-if="threadHistory.length === 0" class="chat-thread-empty">
                {{ __t('ui.navigation', '暂无历史会话') }}
              </div>

              <div
                v-for="thread in threadHistory"
                :key="thread.id"
                :class="[
                  'chat-thread-item',
                  {
                    'chat-thread-item--pending':
                      threadStore.navigationTarget?.threadId === thread.id,
                  },
                  threadStore.threadId === thread.id ? 'chat-thread-item--active' : '',
                ]"
                @click="switchThread(thread)"
              >
                <button
                  class="chat-thread-content"
                  type="button"
                  :aria-current="threadStore.threadId === thread.id ? 'true' : undefined"
                  @click.stop="switchThread(thread)"
                >
                  <span class="chat-thread-title">
                    {{ thread.title || __t('ui.navigation', '未命名会话') }}
                  </span>
                  <span class="chat-thread-meta">
                    <span class="chat-thread-count">
                      {{ thread.messageCount }} {{ __t('ui.navigation', '条消息') }}
                    </span>
                    <span class="chat-thread-time">
                      {{ formatThreadTime(thread.lastMessageAt) }}
                    </span>
                  </span>
                </button>
                <button
                  class="chat-thread-delete chat-thread-rename"
                  :title="__t('ui.navigation', '修改会话标题')"
                  :aria-label="__t('ui.navigation', '修改会话标题')"
                  @click.stop="threadPendingRename = thread"
                >
                  <PixelIcon name="pencil" size="xs" />
                </button>
                <button
                  class="chat-thread-delete"
                  :title="__t('ui.navigation', '删除整条会话')"
                  :aria-label="__t('ui.navigation', '删除整条会话')"
                  @click.stop="requestDeleteThread(thread)"
                >
                  <PixelIcon name="trash" size="xs" />
                </button>
              </div>
            </div>
          </div>

          <!-- 新建会话按钮 -->
          <div class="chat-sidebar-footer">
            <button
              class="chat-new-session-btn"
              :disabled="
                !activeAgent ||
                conversationSelectionLocked ||
                threadStore.isGenerating ||
                isCreatingSession
              "
              @click="createNewChatSession"
            >
              <PixelIcon name="plus" size="xs" :animation="isCreatingSession ? 'spin' : ''" />
              <span>{{ __t('ui.navigation', '建立新会话') }}</span>
              <span class="chat-new-session-mark">NEW</span>
            </button>
          </div>
        </template>

        <!-- 收起态: 只显示图标 -->
        <template v-else>
          <div class="chat-sidebar-collapsed-icons">
            <button
              v-for="agent in filteredAgents.slice(0, 5)"
              :key="agent.id"
              class="chat-collapsed-agent"
              :class="{ 'chat-collapsed-agent--active': activeAgent?.id === agent.id }"
              :title="agent.name"
              @click="switchAgent(agent)"
            >
              <img
                v-if="getAgentAvatarUrl(agent.id)"
                :src="getAgentAvatarUrl(agent.id)!"
                :alt="agent.name"
              />
              <span v-else>{{ agent.name?.[0]?.toUpperCase() ?? '?' }}</span>
            </button>
          </div>
        </template>
      </aside>

      <!-- 聊天主区 -->
      <div class="chat-main" :inert="isMobile && !isSidebarCollapsed">
        <header class="chat-main-header">
          <button
            v-if="isMobile"
            class="chat-mobile-conversations"
            :aria-label="__t('ui.navigation', '选择角色与会话')"
            :aria-expanded="!isSidebarCollapsed"
            @click="toggleSidebar"
          >
            <PixelIcon name="users" size="sm" />
          </button>
          <div class="chat-main-agent">
            <div class="chat-avatar-slot">
              <Transition name="identity-swap">
                <AgentStateHover
                  :key="activeAgent?.id || 'empty'"
                  class="chat-main-avatar agent-portrait agent-portrait--current"
                  :thread-id="threadStore.threadId"
                  :agent-id="activeAgent?.id"
                  :agent-name="activeAgent?.name"
                >
                  <img
                    v-if="activeAgent && getAgentAvatarUrl(activeAgent.id)"
                    :src="getAgentAvatarUrl(activeAgent.id)!"
                    :alt="activeAgent.name"
                  />
                  <span v-else>{{ activeAgent?.name?.[0]?.toUpperCase() ?? 'P' }}</span>
                </AgentStateHover>
              </Transition>
            </div>
            <div class="chat-identity-slot">
              <Transition name="identity-swap">
                <div :key="`${activeAgent?.id}:${threadStore.threadId}`" class="chat-main-info">
                  <span class="chat-main-name">{{ activeAgent?.name ?? 'Pero' }}</span>
                  <span class="chat-main-channel">
                    {{ currentThreadTitle || __t('ui.navigation', '当前会话') }}
                    {{ __t('ui.navigation', '· desktop 频道') }}
                  </span>
                </div>
              </Transition>
            </div>
          </div>

          <div class="chat-main-status">
            <PButton
              class="chat-main-export"
              variant="ghost"
              size="sm"
              :disabled="!threadStore.threadId"
              :title="__t('ui.navigation', '导出当前会话历史')"
              @click="showHistoryExport = true"
            >
              <PixelIcon name="download" size="xs" />
              {{ __t('ui.navigation', '导出') }}
            </PButton>
            <span class="chat-main-status-dot" />
            <span class="chat-main-status-text">
              {{
                conversationSelectionLocked || isCreatingSession || threadStore.navigationTarget
                  ? __t('ui.navigation', '正在切换')
                  : __t('ui.navigation', '{0} 已就位', [activeAgent?.name ?? '助手'])
              }}
            </span>
          </div>
        </header>

        <ChatContainer
          v-if="activeAgent && initialized"
          :switching="isSwitchingAgent || navigationBusy || isCreatingSession"
          :agent-id="activeAgent.id"
          :agent-name="activeAgent.name"
          :thread-id="activeThreadId"
          :focus-request="focusRequest"
          :draft-request="draftRequest"
          :agent-avatar-url="getAgentAvatarUrl(activeAgent.id) ?? ''"
          class="chat-main-container"
          @completed="loadThreadHistory(activeAgent.id)"
          @draft-consumed="draftRequest = undefined"
        />

        <div v-else class="chat-empty-state">
          <div class="chat-empty-icon">
            <PixelIcon name="chat" size="3xl" />
          </div>
          <p class="chat-empty-title">{{ __t('ui.navigation', '等待连接...') }}</p>
          <p class="chat-empty-subtitle">
            {{ __t('ui.navigation', '请从左侧选择一个助手开始聊天') }}
          </p>
        </div>
      </div>
    </div>

    <PDialog
      :model-value="Boolean(threadPendingRename)"
      :title="__t('ui.navigation', '修改会话标题')"
      mode="prompt"
      :default-value="threadPendingRename?.title || ''"
      :placeholder="__t('ui.navigation', '未命名会话')"
      :confirm-text="__t('ui.navigation', '保存标题')"
      @update:model-value="
        (visible) => {
          if (!visible) threadPendingRename = null
        }
      "
      @confirm="confirmRenameThread"
    />

    <HistoryExportDialog
      v-model="showHistoryExport"
      :disabled="isExportingHistory"
      @confirm="exportCurrentHistory"
    />

    <ConversationRewindDialog
      v-model="rewind.visible.value"
      :preview="rewind.preview.value"
      :loading="rewind.loading.value"
      @update:model-value="handleRewindVisibility"
      @confirm="rewind.confirm"
    />
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════
 * 根容器: 角色工作台画布
 * ═══════════════════════════════════════════════════════════════ */

.chat-tab-root {
  width: 100%;
  height: 100%;
  padding: 14px;
  background:
    radial-gradient(circle at 78% 12%, rgba(236, 72, 153, 0.08) 0%, transparent 32%),
    radial-gradient(circle at 18% 72%, rgba(14, 165, 233, 0.07) 0%, transparent 35%),
    repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(15, 23, 42, 0.018) 20px),
    var(--ui-bg-canvas);
  position: relative;
  overflow: hidden;
}

[data-theme='dark'] .chat-tab-root {
  background:
    radial-gradient(circle at 75% 15%, rgba(244, 114, 182, 0.08) 0%, transparent 34%),
    radial-gradient(circle at 15% 75%, rgba(139, 92, 246, 0.1) 0%, transparent 36%),
    repeating-linear-gradient(
      45deg,
      transparent,
      transparent 14px,
      rgba(255, 255, 255, 0.015) 15px
    ),
    var(--ui-bg-canvas);
}

/* ═══════════════════════════════════════════════════════════════
 * 一体化面板: 侧边栏 + 聊天区共享容器
 * ═══════════════════════════════════════════════════════════════ */

.chat-panel {
  display: flex;
  width: 100%;
  height: 100%;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-xl);
  box-shadow: var(--ui-shadow-md);
  overflow: hidden;
}

[data-theme='dark'] .chat-panel {
  background: rgba(26, 29, 39, 0.95);
  border-color: rgba(139, 92, 246, 0.2);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

/* ═══════════════════════════════════════════════════════════════
 * 侧边栏
 * ═══════════════════════════════════════════════════════════════ */

.chat-sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--ui-bg-surface-soft);
  border-right: 1px solid var(--ui-border-subtle);
  position: relative;
  transition: width var(--ui-duration-normal) var(--ui-ease-standard);
}

[data-theme='dark'] .chat-sidebar {
  background: rgba(15, 16, 26, 0.5);
  border-right-color: rgba(139, 92, 246, 0.12);
}

.chat-sidebar--collapsed {
  width: 56px;
}

/* 收起/展开按钮 */
.chat-sidebar-toggle {
  position: absolute;
  top: 12px;
  right: -12px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-full);
  color: var(--ui-text-tertiary);
  cursor: pointer;
  z-index: 10;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
  box-shadow: var(--ui-shadow-sm);
}

.chat-sidebar-toggle:hover {
  color: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
  box-shadow: var(--ui-glow-pink);
}

/* ═══════════════════════════════════════════════════════════════
 * 伙伴领域标头 + 搜索框
 * ═══════════════════════════════════════════════════════════════ */

.chat-partner-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 16px 12px 8px;
}

.chat-partner-brand {
  font-family: var(--font-pixel);
  font-size: 12px;
  font-weight: 800;
  color: var(--ui-accent-primary);
  letter-spacing: 0.18em;
}

.chat-partner-signal {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--ui-accent-primary), transparent);
  opacity: 0.3;
}

.chat-partner-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  width: 100%;
  margin-top: 8px;
  background: var(--ui-bg-hover);
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: var(--ui-radius-sm);
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
  box-sizing: border-box;
}

.chat-partner-search:focus-within {
  background: var(--ui-bg-surface);
  border-bottom-color: var(--ui-accent-primary);
}

.chat-search-icon {
  color: var(--ui-text-tertiary);
  flex-shrink: 0;
}

.chat-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ui-text-primary);
  font-size: 13px;
  font-weight: 500;
  caret-color: var(--ui-focus-color);
}

.chat-search-input::placeholder {
  color: var(--ui-text-tertiary);
}

/* ═══════════════════════════════════════════════════════════════
 * 区块标题
 * ═══════════════════════════════════════════════════════════════ */

/* 历史会话模块标题：与其他 Tab 的像素短标题保持同一视觉语言。 */
.chat-section-title {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 10px 10px 8px;
  padding: 10px 11px 9px;
  overflow: hidden;
  background:
    linear-gradient(90deg, rgba(236, 72, 153, 0.1), rgba(14, 165, 233, 0.04)), var(--ui-bg-surface);
  border: 1px solid rgba(236, 72, 153, 0.18);
  border-left: 3px solid var(--ui-accent-primary);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-shadow-xs);
}

.chat-section-title::after {
  content: '';
  position: absolute;
  right: -13px;
  bottom: -13px;
  width: 34px;
  height: 34px;
  border: 2px solid rgba(236, 72, 153, 0.1);
  transform: rotate(45deg);
}

.chat-section-title-main {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ui-accent-primary);
  font-family: var(--ui-font-pixel), 'Zpix', monospace;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.chat-history-title-text {
  font-family: 'Zpix', monospace !important;
  font-weight: normal !important;
  font-synthesis: none;
  font-size: 13px;
  line-height: 1;
  letter-spacing: 0;
  -webkit-font-smoothing: none;
  text-rendering: geometricPrecision;
}

.chat-section-title-en {
  position: relative;
  z-index: 1;
  color: var(--ui-text-tertiary);
  font-family: var(--ui-font-mono), monospace;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.13em;
}

[data-theme='dark'] .chat-section-title {
  background:
    linear-gradient(90deg, rgba(244, 114, 182, 0.11), rgba(167, 139, 250, 0.05)),
    var(--ui-bg-surface);
  border-color: rgba(244, 114, 182, 0.22);
}

.chat-refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  color: var(--ui-text-tertiary);
  cursor: pointer;
  border-radius: var(--ui-radius-xs);
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}

.chat-refresh-btn:hover {
  color: var(--ui-accent-primary);
  background: var(--ui-bg-hover);
}

/* ═══════════════════════════════════════════════════════════════
 * Agent 列表
 * ═══════════════════════════════════════════════════════════════ */

.chat-agent-section {
  flex-shrink: 0;
  max-height: 40%;
  display: flex;
  flex-direction: column;
}

.chat-agent-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 0 16px 4px;
}

.chat-agent-list {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 8px 8px;
  min-height: 0;
}

.chat-agent-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 4px;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-sm);
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}

.chat-agent-card:hover {
  background: var(--ui-bg-hover);
}

.chat-agent-card--active {
  background: var(--ui-bg-active);
  border-color: var(--ui-border-active);
  box-shadow: var(--ui-glow-pink);
}

[data-theme='dark'] .chat-agent-card--active {
  background: rgba(139, 92, 246, 0.15);
  box-shadow: var(--ui-glow-purple);
}

/* 像素光轨 */
.chat-agent-trail {
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  background: var(--ui-accent-primary);
  border-radius: 0 2px 2px 0;
}

[data-theme='dark'] .chat-agent-trail {
  background: var(--ui-accent-purple);
  box-shadow: 0 0 8px rgba(167, 139, 250, 0.5);
}

.chat-agent-info {
  min-width: 0;
  flex: 1;
}

.chat-agent-name {
  display: block;
  overflow: hidden;
  color: var(--ui-text-secondary);
  font-size: 13px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-agent-name--active {
  color: var(--ui-accent-primary);
}

[data-theme='dark'] .chat-agent-name--active {
  color: var(--ui-accent-purple);
}

.chat-agent-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--ui-text-tertiary);
  margin-top: 2px;
}

.chat-agent-status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ui-text-tertiary);
}

.chat-agent-status--online .chat-agent-status-dot {
  background: var(--ui-success);
  box-shadow: 0 0 4px var(--ui-success);
}

.chat-agent-status--online {
  color: var(--ui-success);
}

/* ═══════════════════════════════════════════════════════════════
 * Thread 历史列表
 * ═══════════════════════════════════════════════════════════════ */

.chat-thread-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--ui-border-subtle);
  min-height: 0;
}

[data-theme='dark'] .chat-thread-section {
  border-top-color: rgba(139, 92, 246, 0.12);
}

.chat-thread-list {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 8px 8px;
}

.chat-thread-loading,
.chat-thread-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 20px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}

.chat-thread-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 11px 9px 14px;
  margin: 0 2px 6px;
  cursor: pointer;
  overflow: hidden;
  background: color-mix(in srgb, var(--ui-bg-surface) 86%, transparent);
  border: 1px solid var(--ui-border-subtle);
  border-left: 3px solid transparent;
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-shadow-xs);
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}

.chat-thread-item::after {
  content: '';
  position: absolute;
  right: 7px;
  top: 7px;
  width: 4px;
  height: 4px;
  background: var(--ui-text-disabled);
  opacity: 0.45;
}

.chat-thread-item:hover {
  background: var(--ui-bg-surface);
  border-color: rgba(236, 72, 153, 0.18);
  transform: translateX(2px);
  box-shadow: var(--ui-shadow-sm);
}

.chat-thread-item--active {
  border-color: rgba(236, 72, 153, 0.22);
  border-left-color: var(--ui-accent-primary);
  background: linear-gradient(90deg, var(--ui-bg-active), var(--ui-bg-surface));
  box-shadow:
    var(--ui-shadow-sm),
    0 0 16px rgba(236, 72, 153, 0.06);
}

.chat-thread-item--active::after {
  background: var(--ui-accent-primary);
  opacity: 1;
  box-shadow: 0 0 7px var(--ui-accent-primary);
}

[data-theme='dark'] .chat-thread-item--active {
  border-left-color: var(--ui-accent-purple);
  background: rgba(139, 92, 246, 0.12);
}

.chat-thread-content {
  min-width: 0;
  flex: 1;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.chat-thread-content:focus-visible,
.chat-agent-card:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: 3px;
  border-radius: var(--ui-radius-xs);
}
.chat-thread-content > .chat-thread-title {
  display: block;
}

.chat-thread-delete {
  position: relative;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  color: var(--ui-text-tertiary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-xs);
  opacity: 0;
  cursor: pointer;
  transition:
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard);
}

.chat-thread-item:hover .chat-thread-delete,
.chat-thread-item:focus-within .chat-thread-delete,
.chat-thread-item--active .chat-thread-delete,
.chat-thread-delete:focus-visible {
  opacity: 1;
}

.chat-thread-delete:hover {
  color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 9%, var(--ui-bg-surface));
  border-color: color-mix(in srgb, var(--ui-danger) 24%, transparent);
}

.chat-thread-delete:focus-visible {
  outline: 2px solid var(--ui-danger);
  outline-offset: 1px;
}

.chat-thread-rename:hover {
  color: var(--ui-accent-primary);
  background: color-mix(in srgb, var(--ui-accent-primary) 9%, var(--ui-bg-surface));
  border-color: color-mix(in srgb, var(--ui-accent-primary) 24%, transparent);
}

.chat-thread-rename:focus-visible {
  outline-color: var(--ui-focus-color);
}

.chat-thread-title {
  padding-right: 10px;
  font-family: var(--ui-font-pixel), 'Zpix', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--ui-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-thread-item--active .chat-thread-title {
  color: var(--ui-accent-primary);
}

[data-theme='dark'] .chat-thread-item--active .chat-thread-title {
  color: var(--ui-accent-purple);
}

.chat-thread-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 3px;
}

.chat-thread-count {
  font-size: 10px;
  color: var(--ui-text-tertiary);
}

.chat-thread-time {
  font-size: 10px;
  color: var(--ui-text-tertiary);
}

/* ═══════════════════════════════════════════════════════════════
 * 侧边栏底部
 * ═══════════════════════════════════════════════════════════════ */

.chat-sidebar-footer {
  padding: 12px;
  border-top: 1px solid var(--ui-border-subtle);
  flex-shrink: 0;
  background:
    repeating-linear-gradient(90deg, transparent, transparent 11px, rgba(236, 72, 153, 0.025) 12px),
    var(--ui-bg-surface-soft);
}

.chat-new-session-btn {
  position: relative;
  display: grid;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 42px;
  padding: 8px 10px;
  overflow: hidden;
  background:
    linear-gradient(100deg, rgba(236, 72, 153, 0.12), rgba(14, 165, 233, 0.05)),
    var(--ui-bg-surface);
  color: var(--ui-accent-primary);
  border: 1px solid rgba(236, 72, 153, 0.26);
  border-radius: 4px;
  box-shadow:
    -2px 0 0 rgba(236, 72, 153, 0.5),
    0 2px 0 rgba(14, 165, 233, 0.14),
    var(--ui-shadow-sm);
  font-family: var(--ui-font-pixel), 'Zpix', monospace;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}

.chat-new-session-btn > :first-child {
  width: 24px;
  height: 24px;
  padding: 5px;
  color: white;
  background: var(--ui-accent-primary);
  border-radius: 3px;
}

.chat-new-session-mark {
  padding: 3px 5px 2px;
  color: var(--ui-text-tertiary);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-subtle);
  font-family: var(--ui-font-mono), monospace;
  font-size: 7px;
  line-height: 1;
  letter-spacing: 0.12em;
}

.chat-new-session-btn:hover:not(:disabled) {
  color: white;
  background: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
  box-shadow:
    inset 3px 0 0 rgba(255, 255, 255, 0.55),
    var(--ui-shadow-sm),
    var(--ui-glow-pink);
  transform: translateY(-1px);
}

.chat-new-session-btn:active:not(:disabled) {
  transform: translateY(0);
}

.chat-new-session-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

/* ═══════════════════════════════════════════════════════════════
 * 收起态图标
 * ═══════════════════════════════════════════════════════════════ */

.chat-sidebar-collapsed-icons {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
}

.chat-collapsed-agent {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 900;
  color: white;
  border-radius: 4px;
  background: linear-gradient(135deg, var(--ui-accent-sky), #7dd3fc);
  cursor: pointer;
  border: 2px solid transparent;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}

.chat-collapsed-agent img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.chat-collapsed-agent:hover {
  transform: scale(1.05);
}

.chat-collapsed-agent--active {
  border-color: var(--ui-accent-primary);
  box-shadow: var(--ui-glow-pink);
}

/* ═══════════════════════════════════════════════════════════════
 * 聊天主区
 * ═══════════════════════════════════════════════════════════════ */

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  position: relative;
  isolation: isolate;
  background: var(--convo-paper-tint);
}

/* 静态装饰直接绘制在对话区，不再被外层面板底色遮住，也不随消息滚动。 */
.chat-main::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(ellipse at 82% 8%, var(--convo-air-top) 0%, transparent 58%),
    radial-gradient(ellipse at 4% 92%, var(--convo-air-bottom) 0%, transparent 58%);
}

/* 极淡斜纹覆盖空白区域；文字、工具卡片和输入栏始终位于纹理上方。 */
.chat-main::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: repeating-linear-gradient(
    45deg,
    transparent 0,
    transparent 14px,
    var(--convo-texture-line) 14px,
    var(--convo-texture-line) 15px
  );
}

.chat-main-header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
  flex-shrink: 0;
}

[data-theme='dark'] .chat-main-header {
  background: rgba(15, 16, 26, 0.3);
  border-bottom-color: rgba(139, 92, 246, 0.12);
}

.chat-main-agent {
  display: flex;
  align-items: center;
  gap: 12px;
}

.chat-main-info {
  display: flex;
  flex-direction: column;
}

.chat-main-name {
  font-size: 15px;
  font-weight: 800;
  color: var(--ui-text-primary);
}

.chat-main-channel {
  font-size: 11px;
  color: var(--ui-text-tertiary);
  margin-top: 1px;
}

/* 像素化会话操作区 */
.chat-main-status {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px 4px 4px;
  background: var(--ui-bg-surface);
  color: var(--ui-accent-primary);
  border: 2px solid var(--ui-border-default);
  border-radius: 3px;
  font-family: var(--font-pixel);
  font-size: 10px;
  letter-spacing: 0.06em;
  font-weight: 800;
  box-shadow: 3px 3px 0 rgba(236, 72, 153, 0.22);
  transition:
    transform 0.12s steps(2, end),
    box-shadow 0.12s steps(2, end);
}

.chat-main-status::before {
  content: '';
  position: absolute;
  top: -2px;
  left: 10px;
  width: 18px;
  height: 2px;
  background: var(--ui-accent-primary);
}

.chat-main-status::after {
  content: '';
  position: absolute;
  right: -2px;
  bottom: 7px;
  width: 2px;
  height: 8px;
  background: var(--ui-accent-purple);
}

.chat-main-status:hover {
  transform: translate(-1px, -1px);
  box-shadow: 4px 4px 0 rgba(236, 72, 153, 0.28);
}

.chat-main-status :deep(.chat-main-export) {
  min-height: 26px;
  padding: 3px 7px;
  border-color: transparent;
  border-radius: 2px;
  box-shadow: none;
}

.chat-main-status :deep(.chat-main-export:hover:not(:disabled)) {
  background: var(--ui-accent-primary-soft);
  border-color: var(--ui-border-subtle);
}

[data-theme='dark'] .chat-main-status {
  background: var(--ui-bg-surface-soft);
  color: var(--ui-accent-purple);
  border-color: rgba(167, 139, 250, 0.42);
  box-shadow: 3px 3px 0 rgba(139, 92, 246, 0.3);
}

[data-theme='dark'] .chat-main-status:hover {
  box-shadow: 4px 4px 0 rgba(139, 92, 246, 0.38);
}

.chat-main-status-dot {
  width: 6px;
  height: 6px;
  background: var(--ui-success);
  border: 1px solid var(--ui-bg-surface);
  border-radius: 1px;
  box-shadow:
    0 0 0 1px var(--ui-success),
    2px 2px 0 rgba(16, 185, 129, 0.25);
  animation: status-pulse 1.8s steps(2, end) infinite;
}

.chat-main-container {
  flex: 1;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

/* ═══════════════════════════════════════════════════════════════
 * 空状态
 * ═══════════════════════════════════════════════════════════════ */

.chat-empty-state {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--ui-text-tertiary);
}

.chat-empty-icon {
  padding: 24px;
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-lg);
  color: var(--ui-accent-primary);
  opacity: 0.3;
}

.chat-empty-title {
  font-size: 15px;
  font-weight: 800;
  color: var(--ui-text-secondary);
}

.chat-empty-subtitle {
  font-size: 12px;
}

/* ═══════════════════════════════════════════════════════════════
 * 滚动条
 * ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
 * 动画
 * ═══════════════════════════════════════════════════════════════ */

@keyframes status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

/* 减少动画偏好 */
@media (prefers-reduced-motion: reduce) {
  .chat-main-status {
    transition: none;
  }

  .chat-main-status-dot {
    animation: none;
  }
}
</style>

<style scoped>
.chat-avatar-slot,
.chat-identity-slot {
  display: grid;
  align-items: center;
}
.chat-avatar-slot {
  min-width: 40px;
  min-height: 40px;
}
.chat-avatar-slot > *,
.chat-identity-slot > * {
  grid-area: 1 / 1;
}
.identity-swap-enter-active {
  transition:
    opacity 220ms ease,
    transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
}
.identity-swap-leave-active {
  transition:
    opacity 120ms ease,
    transform 160ms ease;
  pointer-events: none;
}
.identity-swap-enter-from {
  opacity: 0;
  transform: translateY(5px);
}
.identity-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.chat-thread-item--pending,
.chat-agent-card--pending {
  border-color: var(--ui-accent-primary);
  background: var(--ui-bg-active);
}
.chat-thread-item--pending::after {
  background: var(--ui-accent-primary);
  animation: chat-navigation-intent 1.2s ease-in-out infinite;
}
@keyframes chat-navigation-intent {
  50% {
    opacity: 0.3;
  }
}
@media (prefers-reduced-motion: reduce) {
  .identity-swap-enter-active,
  .identity-swap-leave-active {
    transition: opacity 100ms ease;
  }
  .identity-swap-enter-from,
  .identity-swap-leave-to {
    transform: none;
  }
  .chat-thread-item--pending::after {
    animation: none;
  }
}
:global([data-motion='reduced']) .identity-swap-enter-from,
:global([data-motion='reduced']) .identity-swap-leave-to {
  transform: none;
}
:global([data-motion='reduced']) .identity-swap-enter-active,
:global([data-motion='reduced']) .identity-swap-leave-active {
  transition: opacity 100ms ease;
}
:global([data-motion='reduced']) .chat-thread-item--pending::after {
  animation: none;
}
</style>
