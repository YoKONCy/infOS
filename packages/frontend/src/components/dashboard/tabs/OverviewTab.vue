<script setup lang="ts">
import PackageSlot from '../../integrations/PackageSlot.vue'
import { getDisplayLocale } from '../../../i18n/index'

import { t as __t } from '../../../i18n/index'

/**
 * OverviewTab — 总览 Tab (像素风)
 *
 * 对标 v1 全部功能模块：
 * 1. 像素风统计入口与当前角色状态
 * 2. 当前状态面板 (心情/氛围/想法 + Agent 切换)
 * 3. 全局互斥的智能陪伴与自主行动设置
 * 4. 最近对话时间线
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import WeatherCard from '../../weather/WeatherCard.vue'
import TokenUsageCard from '../../usage/TokenUsageCard.vue'
import AchievementsCard from '../../achievements/AchievementsCard.vue'
import { useDashboardContext } from '../../../composables/dashboard'
import { PixelIcon, PCard } from '../../pixel'
import { systemApi } from '../../../api/modules/systemApi'
import { memoryApi } from '../../../api/modules/memoryApi'
import { schedulerApi } from '../../../api/modules/schedulerApi'
import { threadsApi } from '../../../api/modules/threadsApi'
import ProactiveModePanel from '../ProactiveModePanel.vue'
import { useGateway } from '../../../composables/dashboard'
import { getApiBaseUrl } from '../../../api/transport'
import { logger } from '../../../lib/logger'
import { useAgentStore, usePetStateStore } from '../../../stores'

// ══════ DashboardContext 接入 ══════
const ctx = useDashboardContext()
const agentStore = useAgentStore()
const petStateStore = usePetStateStore()

const isLoading = ref(true)

// ══════ 统计数据 ══════
const stats = ref({
  totalMemories: 0,
  totalChats: 0,
  totalTasks: 0,
})

// ══════ Agent 管理 ══════
const agents = computed(() => agentStore.agents)
const activeAgent = computed(() => agentStore.currentAgent)
const isSwitchingAgent = ref(false)
const showAgentDropdown = ref(false)
const agentSelector = ref<HTMLElement | null>(null)
const agentTrigger = ref<HTMLButtonElement | null>(null)
function closeAgentDropdown() {
  showAgentDropdown.value = false
  agentTrigger.value?.focus()
}
function onAgentOutside(event: PointerEvent) {
  if (event.target instanceof Node && !agentSelector.value?.contains(event.target)) {
    showAgentDropdown.value = false
  }
}

async function switchAgent(id: string) {
  if (isSwitchingAgent.value || id === activeAgent.value?.id) return
  isSwitchingAgent.value = true
  try {
    await agentStore.switchAgent(id)
    ctx.activeAgentId.value = agentStore.activeAgentId
    await loadPetState()
  } catch (e) {
    logger.error('OverviewTab', __t('logs.frontend.settings', '切换 Agent 失败'), e)
  } finally {
    isSwitchingAgent.value = false
  }
}

/** 选择 Agent 并关闭下拉菜单 */
function selectAgent(id: string) {
  switchAgent(id)
  showAgentDropdown.value = false
}

// ══════ 宠物状态 (心情/氛围/想法) ══════
// 三状态唯一由 PetStateStore 管理；总览与 Pet3DView 读取同一响应式数据。
const petState = computed(() => petStateStore.stateFor(agentStore.activeAgentId))
const overviewMetrics = computed(() => [
  {
    key: 'memories',
    tab: 'memories',
    label: __t('ui.settings', '核心记忆'),
    icon: 'brain',
    value: stats.value.totalMemories,
    tone: 'purple',
  },
  {
    key: 'chats',
    tab: 'logs',
    label: __t('ui.settings', '近期对话'),
    icon: 'chat',
    value: stats.value.totalChats,
    tone: 'sky',
  },
  {
    key: 'tasks',
    tab: 'tasks',
    label: __t('ui.settings', '任务中心'),
    icon: 'flash',
    value: stats.value.totalTasks,
    tone: 'amber',
  },
])
// 角色状态是文字投影，没有可量化的强度，不展示固定百分比。
const overviewStates = computed(() => [
  { key: 'mood', label: __t('ui.settings', '心情'), icon: 'paw', value: petState.value.mood },
  { key: 'vibe', label: __t('ui.settings', '氛围'), icon: 'sparkle', value: petState.value.vibe },
  {
    key: 'mind',
    label: __t('ui.settings', '想法'),
    icon: 'thought',
    value: petState.value.mind || __t('ui.settings', '在发呆...'),
  },
])

/** 刷新当前所选会话的角色状态投影。 */
async function loadPetState() {
  await petStateStore.load(agentStore.activeAgentId)
}

// ── Gateway 实时推送：统一写入 PetStateStore ──
const { onPush: onOverviewPush } = useGateway()
onOverviewPush('state_update', (payload) => {
  const updateAgentId = payload.agentId
  const currentId = activeAgent.value?.id ?? ctx.activeAgentId.value
  if (typeof updateAgentId === 'string' && currentId && updateAgentId !== currentId) return
  petStateStore.applyPush(payload)
})

// ══════ 最近对话 ══════
const recentChats = ref<
  Array<{
    id: string
    summary: string
    agent: string
    time: string
    messageCount: number
    pairCount: number
  }>
>([])

// ══════ 系统健康 ══════
const systemHealth = ref({
  cpu: 0,
  memoryUsed: 0,
  memoryTotal: 0,
  sqliteSize: 0,
  triviumSize: 0,
  vectorCount: 0,
})

// ══════ 加载 ══════
async function loadOverview() {
  isLoading.value = true
  try {
    const [sysRes, memRes, taskRes, sessRes] = await Promise.allSettled([
      systemApi.info(),
      memoryApi.archive({ agentId: ctx.activeAgentId.value ?? 'pero', pageSize: 1 }),
      schedulerApi.reminders(),
      threadsApi.list({ pageSize: 5 }),
    ])
    await agentStore.fetchAgents()
    ctx.activeAgentId.value = agentStore.activeAgentId

    // 系统信息
    if (sysRes.status === 'fulfilled' && sysRes.value.data) {
      const info = sysRes.value.data
      systemHealth.value.memoryUsed = info.runtime.memoryUsage.rss
      systemHealth.value.memoryTotal = info.runtime.totalMemoryMB
      systemHealth.value.cpu = info.runtime.cpuPercent
      systemHealth.value.sqliteSize = info.storage.sqliteSizeMB
      systemHealth.value.triviumSize = info.storage.triviumSizeMB
      systemHealth.value.vectorCount = info.storage.triviumNodeCount
    }

    // EventNote 数量用于顶部核心记忆统计，TDB 节点总数由系统信息接口提供。
    if (memRes.status === 'fulfilled' && memRes.value.data) {
      stats.value.totalMemories = memRes.value.data.total
    }

    // 待触发提醒统计 (用户通过 Agent 创建的 reminder/topic/reaction)
    if (taskRes.status === 'fulfilled' && taskRes.value.data) {
      stats.value.totalTasks = taskRes.value.data.total
    }

    // 最近对话 (Thread 列表)
    // totalChats 统计真实消息总数（各 Thread messageCount 之和），而非 Thread 数
    if (sessRes.status === 'fulfilled' && sessRes.value.data) {
      const threadItems = sessRes.value.data.items
      stats.value.totalChats = threadItems.reduce((sum, t) => sum + (t.messageCount ?? 0), 0)
      recentChats.value = threadItems.map((thread) => ({
        id: thread.id,
        summary: thread.title || '未命名会话',
        agent: thread.agentId || 'Pero',
        time: new Date(thread.lastMessageAt || thread.updatedAt || thread.createdAt).toLocaleString(
          getDisplayLocale(),
          {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          },
        ),
        messageCount: thread.messageCount ?? 0,
        pairCount: thread.pairCount ?? 0,
      }))
    }

    // 加载当前角色状态
    await loadPetState()
  } catch (err) {
    logger.error('OverviewTab', __t('logs.frontend.settings', '加载总览数据失败'), err)
  } finally {
    isLoading.value = false
  }
}

// 监听全局刷新
watch(
  () => ctx.refreshKey.value,
  () => loadOverview(),
)

onMounted(() => {
  void loadOverview()
  document.addEventListener('pointerdown', onAgentOutside)
})
onUnmounted(() => document.removeEventListener('pointerdown', onAgentOutside))
</script>

<template>
  <div class="overview-tab p-6 space-y-6 overflow-y-auto h-full custom-scrollbar">
    <PackageSlot region="dashboard.overview" />
    <!-- 加载中 -->
    <div
      v-if="isLoading"
      class="flex flex-col items-center justify-center gap-3 h-72 text-slate-400 font-bold"
    >
      <PixelIcon name="refresh" size="lg" animation="spin" />
      <span class="font-pixel text-sm">{{ __t('ui.settings', '加载中...') }}</span>
    </div>

    <template v-else>
      <div class="overview-utilities">
        <WeatherCard />
        <TokenUsageCard />
      </div>
      <AchievementsCard />
      <!-- 统计与状态共用页面的像素卡片材质，不另设固定不透明底色。 -->
      <div class="overview-summary">
        <dl class="overview-metrics">
          <div
            v-for="metric in overviewMetrics"
            :key="metric.key"
            class="overview-metric"
            :class="`overview-metric--${metric.tone}`"
          >
            <dt>
              <span class="overview-metric-icon" aria-hidden="true">
                <PixelIcon :name="metric.icon" size="sm" />
              </span>
              {{ metric.label }}
            </dt>
            <dd>
              <span>{{ metric.value.toLocaleString(getDisplayLocale()) }}</span>
              <button
                type="button"
                class="overview-metric-link"
                :aria-label="metric.label"
                @click="ctx.currentTab.value = metric.tab"
              >
                <PixelIcon name="chevron-right" size="sm" />
              </button>
            </dd>
          </div>
        </dl>

        <section class="overview-state" aria-labelledby="overview-state-title">
          <header class="overview-state-header">
            <h3 id="overview-state-title">
              <span class="overview-state-heading-icon"><PixelIcon name="paw" size="sm" /></span>
              {{ __t('ui.settings', '当前状态') }}
            </h3>
            <div ref="agentSelector" class="overview-agent" @keydown.esc.stop="closeAgentDropdown">
              <span id="overview-agent-label" class="overview-agent-label">
                {{ __t('ui.settings', '当前角色') }}
              </span>
              <button
                ref="agentTrigger"
                type="button"
                class="overview-agent-trigger"
                :aria-expanded="showAgentDropdown"
                aria-controls="overview-agent-options"
                aria-labelledby="overview-agent-label overview-agent-name"
                :disabled="isSwitchingAgent || agents.length === 0"
                @click="showAgentDropdown = !showAgentDropdown"
              >
                <span class="overview-agent-avatar">
                  <img
                    v-if="activeAgent?.avatarUrl"
                    :src="`${getApiBaseUrl()}${activeAgent.avatarUrl}`"
                    alt=""
                  />
                  <PixelIcon v-else name="paw" size="xs" />
                </span>
                <span id="overview-agent-name" class="overview-agent-name">
                  {{ activeAgent?.name || __t('ui.settings', '未知') }}
                </span>
                <PixelIcon
                  name="chevron-down"
                  size="xs"
                  class="overview-agent-chevron"
                  :class="{ 'is-open': showAgentDropdown }"
                />
              </button>
              <div v-if="showAgentDropdown" id="overview-agent-options" class="overview-agent-menu">
                <div class="overview-agent-menu-label">{{ __t('ui.settings', '切换角色') }}</div>
                <button
                  v-for="agent in agents"
                  :key="agent.id"
                  type="button"
                  class="overview-agent-option"
                  :aria-pressed="agent.id === activeAgent?.id"
                  :disabled="isSwitchingAgent || agent.id === activeAgent?.id || !agent.isEnabled"
                  @click="selectAgent(agent.id)"
                >
                  <span class="overview-agent-avatar">
                    <img
                      v-if="agent.avatarUrl"
                      :src="`${getApiBaseUrl()}${agent.avatarUrl}`"
                      alt=""
                    />
                    <PixelIcon v-else name="paw" size="xs" />
                  </span>
                  <span class="overview-agent-name">{{ agent.name }}</span>
                  <span
                    v-if="agent.id === activeAgent?.id"
                    class="overview-agent-selected"
                    aria-hidden="true"
                  ></span>
                </button>
              </div>
            </div>
          </header>
          <dl class="overview-state-grid">
            <div
              v-for="state in overviewStates"
              :key="state.key"
              class="overview-state-item"
              :class="`overview-state-item--${state.key}`"
            >
              <dt>
                <PixelIcon :name="state.icon" size="sm" />
                {{ state.label }}
              </dt>
              <dd>{{ state.value }}</dd>
            </div>
          </dl>
        </section>
      </div>

      <ProactiveModePanel />

      <!-- ═══ 最近对话 + 系统健康 ═══ -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- 最近对话 -->
        <PCard pixel>
          <h3
            class="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 font-pixel"
          >
            <PixelIcon name="chat" size="xs" />
            {{ __t('ui.settings', '最近对话') }}
          </h3>
          <div class="flex flex-col">
            <div
              v-for="chat in recentChats"
              :key="chat.id"
              class="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-b-0"
            >
              <div class="w-1.5 h-1.5 bg-sky-400 mt-1.5 flex-shrink-0" />
              <div class="min-w-0">
                <span class="text-sm font-bold text-slate-700 block truncate">
                  {{ chat.summary }}
                </span>
                <div class="flex gap-2.5 mt-0.5 text-[10px] text-slate-400 font-bold font-pixel">
                  <span>{{ chat.agent }}</span>
                  <span>{{ chat.pairCount }} {{ __t('ui.settings', '轮') }}</span>
                  <span>{{ chat.messageCount }} {{ __t('ui.settings', '条') }}</span>
                  <span>{{ chat.time }}</span>
                </div>
              </div>
            </div>
          </div>
        </PCard>

        <!-- 系统健康 -->
        <PCard pixel>
          <h3
            class="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 font-pixel"
          >
            <PixelIcon name="desktop" size="xs" />
            {{ __t('ui.settings', '系统健康') }}
          </h3>
          <div class="flex flex-col gap-2.5">
            <!-- CPU -->
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold text-slate-400 min-w-8 font-pixel">CPU</span>
              <div class="flex-1 h-1.5 bg-slate-100">
                <div
                  class="h-full transition-all duration-500"
                  :class="
                    systemHealth.cpu > 80
                      ? 'bg-rose-400'
                      : systemHealth.cpu > 50
                        ? 'bg-amber-400'
                        : 'bg-emerald-400'
                  "
                  :style="{ width: systemHealth.cpu + '%' }"
                />
              </div>
              <span class="text-[10px] font-bold text-slate-500 min-w-12 text-right font-pixel">
                {{ systemHealth.cpu }}%
              </span>
            </div>
            <!-- 内存 -->
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold text-slate-400 min-w-8 font-pixel">MEM</span>
              <div class="flex-1 h-1.5 bg-slate-100">
                <div
                  class="h-full bg-pink-face transition-all duration-500"
                  :style="{
                    width:
                      systemHealth.memoryTotal > 0
                        ? (systemHealth.memoryUsed / systemHealth.memoryTotal) * 100 + '%'
                        : '0%',
                  }"
                />
              </div>
              <span class="text-[10px] font-bold text-slate-500 min-w-12 text-right font-pixel">
                {{ systemHealth.memoryUsed }}MB
              </span>
            </div>
            <!-- SQLite -->
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold text-slate-400 min-w-8 font-pixel">SQL</span>
              <span class="text-[10px] font-bold text-slate-500 ml-auto font-pixel">
                {{ systemHealth.sqliteSize }} MB
              </span>
            </div>
            <!-- TriviumDB -->
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold text-slate-400 min-w-8 font-pixel">TDB</span>
              <span class="text-[10px] font-bold text-slate-500 ml-auto font-pixel">
                {{ systemHealth.triviumSize }} MB
              </span>
            </div>
            <!-- 向量 -->
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold text-slate-400 min-w-8 font-pixel">VEC</span>
              <span class="text-[10px] font-bold text-slate-500 ml-auto font-pixel">
                {{ systemHealth.vectorCount }} {{ __t('ui.settings', '条') }}
              </span>
            </div>
          </div>
        </PCard>
      </div>
    </template>
  </div>
</template>

<style scoped src="./overview-summary.css"></style>
