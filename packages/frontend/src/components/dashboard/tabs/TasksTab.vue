<script setup lang="ts">
import { getDisplayLocale } from '../../../i18n/index'

import { t as __t } from '../../../i18n/index'

import '../../taskCenter/task-pixel.css'
/**
 * TasksTab — 任务中心（重构版）
 *
 * 三视图：
 * - 进行中：派发中的 BackgroundTask（活跃态）+ 待触发用户提醒
 * - 历史记录：completed/failed/cancelled 的归档（时间线样式条目）
 * - 定时与提醒：用户提醒列表 + 系统 cron 折叠区
 *
 * 视觉基线：像素字体与微立体面板 + ui 语义令牌（双主题安全），
 * 状态展示统一由 TaskStatusBadge / ReminderItem 承担。
 *
 * F3: 已对接 schedulerApi 真实后端。
 */
import {
  ref,
  shallowRef,
  computed,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
  watch,
} from 'vue'
import { PixelIcon, PButton, PBadge, PEmpty } from '../../pixel'
import { schedulerApi } from '../../../api/modules/schedulerApi'
import { threadsApi, type ThreadInfo } from '../../../api/modules/threadsApi'
import type {
  SchedulerTask,
  ReminderItem as ReminderItemData,
} from '../../../api/modules/schedulerApi'
import { useDashboardContext } from '../../../composables/dashboard'
import { useTaskCenterStore } from '../../../stores/taskCenterStore'
import TaskCard from '../../taskCenter/TaskCard.vue'
import TaskDetailModal from '../../taskCenter/TaskDetailModal.vue'
import DispatchTaskModal from '../../taskCenter/DispatchTaskModal.vue'
import ReminderItem from '../../taskCenter/ReminderItem.vue'
import CompanionActivityPanel from '../../taskCenter/CompanionActivityPanel.vue'
import SocialTurnPanel from '../../social/SocialTurnPanel.vue'
import type { BackgroundTaskInfo } from '../../../api/modules/backgroundTasksApi'

import { useAgentStore, useThreadStore } from '../../../stores'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import { getApiBaseUrl } from '../../../api/transport'
import { backgroundTasksApi } from '../../../api/modules/backgroundTasksApi'
import ProactiveModePanel from '../ProactiveModePanel.vue'
import { logger } from '../../../lib/logger'
import {
  requestTaskNavigation,
  useTaskNavigation,
} from '../../../composables/main/useTaskNavigation'
import { useTaskDetail } from '../../../composables/main/useTaskDetail'

const ctx = useDashboardContext()
const taskCenter = useTaskCenterStore()

const agentStore = useAgentStore()
// 常驻记录只描述现存角色，角色列表更新后立即收起旧缓存中的孤立条目。
const residentTasks = computed(() => {
  const agentIds = new Set(agentStore.agents.map((agent) => agent.id))
  return taskCenter.residentTasks.filter((task) => agentIds.has(task.agentId))
})
const threadStore = useThreadStore()
const notify = useNotificationStore()

/** 可用头像 URL（按 agentId 查 avatarUrl） */
function agentAvatarUrl(agentId: string): string | null {
  const url = agentStore.agents.find((a) => a.id === agentId)?.avatarUrl
  return url ? `${getApiBaseUrl()}${url}` : null
}

/** Agent 显示名 */
function agentDisplayName(agentId: string): string {
  return agentStore.agents.find((a) => a.id === agentId)?.name ?? agentId
}

// ── 三视图 ──
/** 当前激活的视图 */
const activeView = ref<'active' | 'history' | 'reminders'>('active')
const hasSocialAttention = ref(false)
const hasSocialHistory = ref(false)

/** 派发新任务弹窗 */
const isDispatchOpen = ref(false)
const dispatchTargetThreadId = ref<string | null>(null)

function openDispatch() {
  dispatchTargetThreadId.value = threadStore.threadId || null
  isDispatchOpen.value = true
}

/** 任务详情弹窗 */
const {
  task: detailTask,
  loading: detailLoading,
  error: detailError,
  open: openDetail,
  close: clearDetail,
  refresh: refreshDetail,
} = useTaskDetail()

const taskNavigation = useTaskNavigation()
let navigationSequence = 0
watch(
  () => taskNavigation.value?.revision,
  async () => {
    const navigation = taskNavigation.value
    const taskId = navigation?.taskId
    const sequence = ++navigationSequence
    if (!taskId) return
    try {
      const opened = await openDetail(taskId)
      if (sequence === navigationSequence) {
        if (opened && detailTask.value) {
          activeView.value = ['completed', 'failed', 'cancelled'].includes(detailTask.value.status)
            ? 'history'
            : 'active'
          if (!detailTask.value.readAt && activeView.value === 'history')
            void taskCenter.markRead(taskId).catch(() => {})
        } else if (detailError.value) notify.toast(detailError.value, 'error')
        if (taskNavigation.value === navigation) taskNavigation.value = null
      }
    } catch (error) {
      if (sequence === navigationSequence)
        notify.toast(
          error instanceof Error ? error.message : __t('ui.settings', '任务暂时无法打开'),
          'error',
        )
    }
  },
  { immediate: true, flush: 'post' },
)

/** 关闭任务详情弹窗 */
function closeDetail() {
  navigationSequence++
  taskNavigation.value = null
  clearDetail()
}

/** 恢复因服务重启中断的任务 */
async function resumeInterrupted(id: string) {
  try {
    await backgroundTasksApi.resumeInterrupted(id)
    await taskCenter.refreshActive()
    await taskCenter.refreshHistory()
    notify.toast(__t('ui.settings', '已恢复中断任务'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '任务中心')
      },
    })
  } catch (err) {
    notify.toast(err instanceof Error ? err.message : __t('ui.settings', '恢复失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '任务中心')
      },
    })
    logger.error('TasksTab', __t('logs.frontend.settings', '恢复中断任务失败'), err)
  }
}

// ── 提醒 ──

const scheduledAgentTime = ref('')
const scheduledAgentInstruction = ref('')
const scheduledAgentId = ref('')
const scheduledRepeat = ref('')
const scheduledThreadId = ref('')
const scheduledThreads = ref<ThreadInfo[]>([])
let scheduledThreadRequest = 0
watch(scheduledAgentId, async (agentId) => {
  const request = ++scheduledThreadRequest
  scheduledThreadId.value = ''
  scheduledThreads.value = []
  if (!agentId) return
  try {
    const response = await threadsApi.list({
      agentId,
      channel: 'desktop',
      purpose: 'conversation',
      pageSize: 100,
    })
    if (request !== scheduledThreadRequest) return
    scheduledThreads.value = response.data?.items ?? []
    if (
      agentId === threadStore.agentId &&
      scheduledThreads.value.some((item) => item.id === threadStore.threadId)
    )
      scheduledThreadId.value = threadStore.threadId
  } catch (error) {
    if (request === scheduledThreadRequest)
      notify.toast(
        error instanceof Error ? error.message : __t('ui.settings', '读取目标会话失败'),
        'error',
      )
  }
})
const creatingScheduledAgent = ref(false)
const scheduledComposer = ref<HTMLDetailsElement | null>(null)
const hasCompanionAttention = ref(false)

async function createScheduledAgentTask(): Promise<void> {
  if (
    creatingScheduledAgent.value ||
    !scheduledAgentId.value ||
    !scheduledAgentTime.value ||
    !scheduledAgentInstruction.value.trim()
  )
    return
  creatingScheduledAgent.value = true
  try {
    await schedulerApi.createAgentTask({
      agentId: scheduledAgentId.value,
      time: new Date(scheduledAgentTime.value).toISOString(),
      instruction: scheduledAgentInstruction.value.trim(),
      repeatIntervalMinutes: scheduledRepeat.value ? Number(scheduledRepeat.value) : undefined,
      threadId: scheduledThreadId.value || undefined,
    })
    scheduledAgentInstruction.value = ''
    await fetchReminders()
    if (scheduledComposer.value) {
      scheduledComposer.value.open = false
      scheduledComposer.value.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true })
    }
    notify.toast(__t('ui.settings', '定时 Agent 任务已创建'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '任务中心')
      },
    })
  } catch (error) {
    notify.toast(
      error instanceof Error ? error.message : __t('ui.settings', '创建失败，请稍后重试'),
      {
        type: 'error',
        get title() {
          return __t('ui.settings', '任务中心')
        },
      },
    )
  } finally {
    creatingScheduledAgent.value = false
  }
}

/** 用户提醒列表 */
const reminders = shallowRef<ReminderItemData[]>([])
const isLoadingReminders = ref(false)

/** 加载用户提醒列表 */
async function fetchReminders(): Promise<void> {
  isLoadingReminders.value = true
  try {
    const res = await schedulerApi.reminders()
    if (res.data) {
      reminders.value = res.data.items
    }
  } catch (e) {
    logger.error('TasksTab', __t('logs.frontend.settings', '加载提醒列表失败'), e)
  } finally {
    isLoadingReminders.value = false
  }
}

// ── 系统后台任务 ──

/** 系统后台任务列表，始终保持后端注册顺序 */
const cronTasks = shallowRef<SchedulerTask[]>([])
const showCronTasks = ref(false)
const cronLoading = ref(false)
const cronError = ref('')
const schedulerRunning = ref<boolean | null>(null)
const clockOffsetMs = ref(0)
const pageNow = ref(Date.now())
const triggeringTasks = ref(new Set<string>())
const expandedTasks = ref(new Set<string>())
const expandedHistoryTasks = ref(new Set<string>())
const markingHistoryRead = ref(false)

async function markHistoryRead(task: BackgroundTaskInfo): Promise<void> {
  expandedHistoryTasks.value = new Set([...expandedHistoryTasks.value, task.id])
  void openDetail(task)
  if (task.readAt) {
    return
  }
  try {
    await taskCenter.markRead(task.id)
  } catch (error) {
    logger.warn('TasksTab', __t('logs.frontend.settings', '标记历史记录已读失败'), error)
  }
}

async function markAllHistoryRead(): Promise<void> {
  if (markingHistoryRead.value) return
  markingHistoryRead.value = true
  try {
    const count = await taskCenter.markAllRead()
    notify.toast(
      count > 0
        ? __t('ui.settings', '已读 {0} 条历史记录', [count])
        : __t('ui.settings', '没有新的未读记录'),
      {
        type: 'success',
        get title() {
          return __t('ui.settings', '任务中心')
        },
      },
    )
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : __t('ui.settings', '一键已读失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '任务中心')
      },
    })
  } finally {
    markingHistoryRead.value = false
  }
}

async function deleteHistoryTask(task: BackgroundTaskInfo): Promise<void> {
  try {
    await taskCenter.remove(task.id)
    expandedHistoryTasks.value.delete(task.id)
    notify.toast(__t('ui.settings', '历史记录已删除'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '任务中心')
      },
    })
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : __t('ui.settings', '删除记录失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '任务中心')
      },
    })
  }
}

let cronTimer: ReturnType<typeof setInterval> | null = null
let componentActive = false

const runningCronTasks = computed(() => cronTasks.value.filter((task) => task.running).length)

/** 加载系统后台任务列表 */
async function fetchCronTasks(): Promise<void> {
  if (cronLoading.value) return
  cronLoading.value = true
  cronError.value = ''
  try {
    const res = await schedulerApi.tasks()
    if (!res.data) throw new Error('响应中缺少任务状态')
    cronTasks.value = res.data.items
    schedulerRunning.value = res.data.schedulerRunning
    clockOffsetMs.value = res.data.serverNow - Date.now()
    pageNow.value = Date.now()
  } catch (e) {
    schedulerRunning.value = null
    cronError.value = e instanceof Error ? e.message : '加载系统任务失败'
    logger.error('TasksTab', __t('logs.frontend.settings', '加载系统任务列表失败'), e)
  } finally {
    cronLoading.value = false
  }
}

function shouldPollCronTasks(): boolean {
  return componentActive && activeView.value === 'reminders' && showCronTasks.value
}

function stopCronPolling(): void {
  if (cronTimer) {
    clearInterval(cronTimer)
    cronTimer = null
  }
}

function syncCronPolling(immediate = false): void {
  stopCronPolling()
  if (!shouldPollCronTasks()) return
  if (immediate) void fetchCronTasks()
  cronTimer = setInterval(() => {
    pageNow.value = Date.now()
    void fetchCronTasks()
  }, 30_000)
}

function toggleCronTasks(): void {
  showCronTasks.value = !showCronTasks.value
}

function toggleCronDetail(name: string): void {
  const next = new Set(expandedTasks.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expandedTasks.value = next
}

/** 手动触发系统任务 */
async function triggerCronTask(task: SchedulerTask): Promise<void> {
  if (triggeringTasks.value.has(task.name)) return
  triggeringTasks.value = new Set(triggeringTasks.value).add(task.name)
  try {
    await schedulerApi.trigger(task.name)
    await fetchCronTasks()
    notify.toast(__t('ui.settings', '已触发 {0}', [task.displayName]), {
      type: 'success',
      get title() {
        return __t('ui.settings', '系统任务')
      },
    })
  } catch (e) {
    logger.error('TasksTab', __t('logs.frontend.settings', '触发系统任务失败'), e)
    notify.toast(__t('ui.settings', '触发失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '系统任务')
      },
    })
  } finally {
    const next = new Set(triggeringTasks.value)
    next.delete(task.name)
    triggeringTasks.value = next
  }
}

// ── 格式化工具 ──

function serverNow(): number {
  return pageNow.value + clockOffsetMs.value
}

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return '-'
  if (ms < 1000) return __t('ui.settings', '{0} 毫秒', [ms])
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return __t('ui.settings', '{0} 秒', [sec])
  if (sec < 3600) return __t('ui.settings', '{0} 分 {1} 秒', [Math.floor(sec / 60), sec % 60])
  return __t('ui.settings', '{0} 小时 {1} 分', [
    Math.floor(sec / 3600),
    Math.floor((sec % 3600) / 60),
  ])
}

function formatDateTime(timestamp: number | null): string {
  if (timestamp === null) return '-'
  return new Date(timestamp).toLocaleString(getDisplayLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRelative(timestamp: number | null): string {
  if (timestamp === null) return __t('ui.settings', '尚未执行')
  const elapsed = Math.max(0, serverNow() - timestamp)
  if (elapsed < 60_000) return __t('ui.settings', '不足 1 分钟前')
  if (elapsed < 3_600_000) return __t('ui.settings', '{0} 分钟前', [Math.floor(elapsed / 60_000)])
  if (elapsed < 86_400_000)
    return __t('ui.settings', '{0} 小时前', [Math.floor(elapsed / 3_600_000)])
  return __t('ui.settings', '{0} 天前', [Math.floor(elapsed / 86_400_000)])
}

function formatCountdown(task: SchedulerTask): string {
  const remaining = Math.max(0, task.nextDueAt - serverNow())
  if (remaining === 0) return __t('ui.settings', '等待调度')
  if (remaining < 60_000) return __t('ui.settings', '不足 1 分钟')
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return __t('ui.settings', '{0} 分钟后', [minutes])
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24)
    return restMinutes
      ? __t('ui.settings', '{0} 小时 {1} 分钟后', [hours, restMinutes])
      : __t('ui.settings', '{0} 小时后', [hours])
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours
    ? __t('ui.settings', '{0} 天 {1} 小时后', [days, restHours])
    : __t('ui.settings', '{0} 天后', [days])
}

function progressPercent(task: SchedulerTask): number {
  if (task.running) return 100
  const cycleStartedAt = task.nextDueAt - task.intervalMs
  return Math.min(100, Math.max(0, ((serverNow() - cycleStartedAt) / task.intervalMs) * 100))
}

type CronVisualStatus = 'running' | 'error' | 'stopped' | 'unavailable' | 'due' | 'soon' | 'waiting'

function cronStatus(task: SchedulerTask): CronVisualStatus {
  if (schedulerRunning.value === null) return 'unavailable'
  if (!schedulerRunning.value) return 'stopped'
  if (task.running) return 'running'
  if (task.lastOutcome === 'error') return 'error'
  const remaining = task.nextDueAt - serverNow()
  if (remaining <= 0) return 'due'
  if (remaining <= Math.min(60_000, task.intervalMs * 0.1)) return 'soon'
  return 'waiting'
}

function statusText(task: SchedulerTask): string {
  const status = cronStatus(task)
  return {
    get running() {
      return __t('ui.settings', '运行中')
    },
    get error() {
      return __t('ui.settings', '执行失败')
    },
    get stopped() {
      return __t('ui.settings', '调度器已停止')
    },
    get unavailable() {
      return __t('ui.settings', '状态不可用')
    },
    get due() {
      return __t('ui.settings', '等待调度')
    },
    get soon() {
      return __t('ui.settings', '即将执行')
    },
    get waiting() {
      return __t('ui.settings', '等待中')
    },
  }[status]
}

function statusVariant(
  task: SchedulerTask,
): 'default' | 'primary' | 'success' | 'warning' | 'danger' {
  const status = cronStatus(task)
  if (status === 'running') return 'success'
  if (status === 'error' || status === 'unavailable') return 'danger'
  if (status === 'soon' || status === 'due' || status === 'stopped') return 'warning'
  return 'primary'
}

function outcomeText(task: SchedulerTask): string {
  if (task.lastOutcome === 'success')
    return __t('ui.settings', '成功 · {0}', [formatRelative(task.lastFinishedAt)])
  if (task.lastOutcome === 'error')
    return __t('ui.settings', '失败 · {0}', [formatRelative(task.lastFinishedAt)])
  return __t('ui.settings', '尚未执行')
}

/** 历史时间线条目结束时间（completedAt 优先，回退 updatedAt） */
function historyEndTime(task: BackgroundTaskInfo): string {
  const iso = task.completedAt ?? task.updatedAt
  if (!iso) return ''
  const d = new Date(iso.replace(' ', 'T'))
  return d.toLocaleString(getDisplayLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ── 生命周期 ──

watch(
  () => taskCenter.pendingOpenTask,
  (task) => {
    if (!task) return
    void openDetail(task)
    taskCenter.consumePendingOpenTask()
  },
  { immediate: true },
)

watch(
  () => ctx.refreshKey.value,
  () => {
    if (!scheduledAgentId.value)
      scheduledAgentId.value = agentStore.activeAgentId || agentStore.agents[0]?.id || ''
    fetchReminders()
    fetchCronTasks()
  },
)

watch([activeView, showCronTasks], () => syncCronPolling(true))

onMounted(() => {
  componentActive = true
  void agentStore.fetchAgents()
  void taskCenter.refreshActive()
  if (!scheduledAgentId.value)
    scheduledAgentId.value = agentStore.activeAgentId || agentStore.agents[0]?.id || ''
  fetchReminders()
  // M05: 历史任务首次进入时预加载（进行中已由 MainView 全局拉取）
  taskCenter.refreshHistory()
  syncCronPolling(true)
})

onActivated(() => {
  if (!componentActive) {
    void agentStore.fetchAgents()
    void taskCenter.refreshActive()
  }
  componentActive = true
  syncCronPolling(true)
})

onDeactivated(() => {
  componentActive = false
  closeDetail()
  stopCronPolling()
})

onUnmounted(() => {
  navigationSequence++
  scheduledThreadRequest++
  componentActive = false
  stopCronPolling()
})
</script>

<template>
  <div class="tasks-tab task-pixel-surface">
    <p v-if="detailLoading && !detailTask" class="task-open-status" role="status">
      {{ __t('ui.taskCenter', '正在打开任务…') }}
      <button type="button" @click="closeDetail">{{ __t('ui.taskCenter', '取消') }}</button>
    </p>
    <!-- ═══ 页头 ═══ -->
    <header class="tasks-tab__header">
      <div class="tasks-tab__header-left">
        <!-- 标题与其他 Tab 一致：像素字体 + 加粗大字号 -->
        <h2 class="tasks-tab__title flex items-center gap-3 text-2xl font-black font-pixel">
          <PixelIcon name="bell" size="md" class="tasks-tab__title-icon" />
          {{ __t('ui.settings', '任务中心') }}
        </h2>
        <div class="tasks-tab__stats">
          <span v-if="taskCenter.activeCount > 0" class="tasks-tab__stat tasks-tab__stat--active">
            {{ taskCenter.activeCount }} {{ __t('ui.settings', '进行中') }}
          </span>
          <span v-if="reminders.length > 0" class="tasks-tab__stat tasks-tab__stat--reminder">
            {{ reminders.length }} {{ __t('ui.settings', '条待触发') }}
          </span>
        </div>
      </div>
      <PButton variant="primary" size="sm" @click="openDispatch">
        <PixelIcon name="plus" size="xs" />
        {{ __t('ui.settings', '派发新任务') }}
      </PButton>
    </header>

    <!-- ═══ 三视图切换 ═══ -->
    <nav class="tasks-tab__nav" role="tablist">
      <button
        v-for="v in ['active', 'history', 'reminders'] as const"
        :key="v"
        type="button"
        role="tab"
        :aria-selected="activeView === v"
        class="tasks-tab__nav-item"
        :class="{ 'tasks-tab__nav-item--active': activeView === v }"
        @click="activeView = v"
      >
        {{
          v === 'active'
            ? __t('ui.settings', '进行中')
            : v === 'history'
              ? __t('ui.settings', '历史记录')
              : __t('ui.settings', '定时与提醒')
        }}
      </button>
    </nav>

    <!-- ═══ 进行中视图 ═══ -->
    <section v-if="activeView === 'active'" class="tasks-tab__section">
      <SocialTurnPanel
        :agent-id="agentStore.activeAgentId"
        tasks-only
        @attention-change="hasSocialAttention = $event"
      />
      <CompanionActivityPanel
        :agent-id="agentStore.activeAgentId"
        attention-only
        @attention-change="hasCompanionAttention = $event"
      />
      <PEmpty
        v-if="
          taskCenter.activeTasks.length === 0 &&
          reminders.length === 0 &&
          !hasCompanionAttention &&
          !hasSocialAttention
        "
        :description="__t('ui.settings', '暂无任务，可点击「派发新任务」')"
      />

      <!-- 进行中后台任务 -->
      <div v-if="taskCenter.activeTasks.length > 0" class="tasks-tab__group">
        <h3 class="tasks-tab__group-title">
          <PixelIcon name="activity" size="xs" />
          {{ __t('ui.settings', '后台任务 ·') }} {{ taskCenter.activeTasks.length }}
        </h3>
        <div class="tasks-tab__list">
          <TaskCard
            v-for="task in taskCenter.activeTasks"
            :key="task.id"
            :task="task"
            :avatar-url="agentAvatarUrl(task.agentId)"
            :agent-name="agentDisplayName(task.agentId)"
            @detail="openDetail"
            @pause="(t) => taskCenter.pause(t.id)"
            @resume="(t) => taskCenter.resume(t.id)"
            @cancel="(t) => taskCenter.cancel(t.id)"
          />
        </div>
      </div>

      <!-- 常驻状态只供查看，不进入普通任务控制与计数。 -->
      <details v-if="residentTasks.length" class="tasks-tab__group">
        <summary class="tasks-tab__group-title">
          <PixelIcon name="activity" size="xs" />
          {{ __t('ui.settings', '系统常驻 · 只读状态') }}
        </summary>
        <div class="tasks-tab__list">
          <TaskCard
            v-for="task in residentTasks"
            :key="task.id"
            :task="task"
            :avatar-url="agentAvatarUrl(task.agentId)"
            :agent-name="agentDisplayName(task.agentId)"
            @detail="openDetail"
          />
        </div>
      </details>

      <!-- 待触发提醒（无后台任务时也展示） -->
      <div v-if="reminders.length > 0" class="tasks-tab__group">
        <h3 class="tasks-tab__group-title">
          <PixelIcon name="clock" size="xs" />
          {{ __t('ui.settings', '待触发提醒 ·') }} {{ reminders.length }}
        </h3>
        <div class="tasks-tab__list">
          <ReminderItem
            v-for="item in reminders"
            :key="item.id"
            :item="item"
            @changed="fetchReminders"
          />
        </div>
      </div>
    </section>

    <!-- ═══ 历史记录视图（时间线） ═══ -->
    <section
      v-if="activeView === 'history'"
      class="tasks-tab__section"
      :aria-busy="taskCenter.isLoadingHistory"
    >
      <form class="task-history-filter" @submit.prevent="taskCenter.refreshHistory({ page: 1 })">
        <label class="task-history-search">
          <PixelIcon name="search" size="xs" />
          <input
            v-model="taskCenter.historyFilter.keyword"
            type="search"
            :placeholder="__t('ui.taskCenter', '搜索任务标题或目标')"
            :aria-label="__t('ui.taskCenter', '搜索任务标题或目标')"
          />
          <button type="submit">{{ __t('ui.taskCenter', '搜索') }}</button>
        </label>
        <select
          v-model="taskCenter.historyFilter.status"
          :aria-label="__t('ui.taskCenter', '任务状态')"
          @change="taskCenter.refreshHistory({ page: 1 })"
        >
          <option :value="undefined">{{ __t('ui.taskCenter', '全部状态') }}</option>
          <option value="completed">{{ __t('ui.taskCenter', '已完成') }}</option>
          <option value="failed">{{ __t('ui.taskCenter', '失败') }}</option>
          <option value="cancelled">{{ __t('ui.taskCenter', '已取消') }}</option>
        </select>
      </form>
      <SocialTurnPanel
        :agent-id="agentStore.activeAgentId"
        tasks-only
        history
        @history-change="hasSocialHistory = $event"
      />
      <div v-if="taskCenter.historyTasks.length" class="history-toolbar">
        <div class="history-toolbar__info">
          <span class="history-toolbar__icon"><PixelIcon name="mail" size="xs" /></span>
          <div>
            <strong>{{ __t('ui.settings', '历史消息') }}</strong>
            <span>{{ __t('ui.settings', '打开未读记录后将自动标记为已读') }}</span>
          </div>
          <b v-if="taskCenter.historyTasks.some((task) => !task.readAt)">
            {{ taskCenter.historyTasks.filter((task) => !task.readAt).length }}
            {{ __t('ui.settings', '条未读') }}
          </b>
          <b v-else class="history-toolbar__all-read">{{ __t('ui.settings', '已全部读完') }}</b>
        </div>
        <button
          type="button"
          class="history-toolbar__read-all"
          :disabled="markingHistoryRead || !taskCenter.historyTasks.some((task) => !task.readAt)"
          @click="markAllHistoryRead"
        >
          <PixelIcon
            :name="markingHistoryRead ? 'refresh' : 'check'"
            size="xs"
            :animation="markingHistoryRead ? 'spin' : undefined"
          />
          {{ markingHistoryRead ? __t('ui.settings', '处理中…') : __t('ui.settings', '一键已读') }}
        </button>
      </div>
      <PEmpty
        v-if="taskCenter.historyTasks.length === 0 && !hasSocialHistory"
        :description="
          taskCenter.historyFilter.keyword || taskCenter.historyFilter.status
            ? __t('ui.taskCenter', '没有符合条件的任务')
            : __t('ui.settings', '任务完成、失败或取消后会归档在这里~')
        "
      />
      <ol v-if="taskCenter.historyTasks.length" class="tasks-tab__timeline">
        <li v-for="task in taskCenter.historyTasks" :key="task.id" class="tasks-tab__timeline-item">
          <!-- 时间线节点 -->
          <span class="tasks-tab__timeline-rail" aria-hidden="true">
            <span
              class="tasks-tab__timeline-node"
              :class="`tasks-tab__timeline-node--${task.status}`"
            />
          </span>
          <div class="tasks-tab__timeline-content">
            <TaskCard
              :task="task"
              :avatar-url="agentAvatarUrl(task.agentId)"
              :agent-name="agentDisplayName(task.agentId)"
              history
              :delete-open="expandedHistoryTasks.has(task.id)"
              @read="markHistoryRead"
              @delete="deleteHistoryTask"
              @detail="openDetail"
              @resume-interrupted="(t) => resumeInterrupted(t.id)"
              @retry="(t) => taskCenter.retry(t.id)"
            />
            <span class="tasks-tab__timeline-time">{{ historyEndTime(task) }}</span>
          </div>
        </li>
      </ol>
      <nav
        v-if="taskCenter.historyTotal > (taskCenter.historyFilter.pageSize ?? 20)"
        class="task-history-pages"
        :aria-label="__t('ui.taskCenter', '历史任务分页')"
      >
        <PButton
          size="sm"
          variant="ghost"
          :disabled="taskCenter.isLoadingHistory || (taskCenter.historyFilter.page ?? 1) <= 1"
          @click="taskCenter.refreshHistory({ page: (taskCenter.historyFilter.page ?? 1) - 1 })"
        >
          {{ __t('ui.taskCenter', '上一页') }}
        </PButton>
        <span>
          {{
            __t('ui.taskCenter', '第 {0} 页 · 共 {1} 条', [
              taskCenter.historyFilter.page ?? 1,
              taskCenter.historyTotal,
            ])
          }}
        </span>
        <PButton
          size="sm"
          variant="ghost"
          :disabled="
            taskCenter.isLoadingHistory ||
            (taskCenter.historyFilter.page ?? 1) * (taskCenter.historyFilter.pageSize ?? 20) >=
              taskCenter.historyTotal
          "
          @click="taskCenter.refreshHistory({ page: (taskCenter.historyFilter.page ?? 1) + 1 })"
        >
          {{ __t('ui.taskCenter', '下一页') }}
        </PButton>
      </nav>
    </section>

    <!-- ═══ 定时与提醒视图 ═══ -->
    <section v-if="activeView === 'reminders'" class="tasks-tab__section">
      <details ref="scheduledComposer" class="scheduled-agent-composer">
        <summary>
          <PixelIcon name="clock" size="sm" />
          <strong>{{ __t('ui.settings', '安排稍后的任务') }}</strong>
          <span>{{ __t('ui.settings', '选择角色、时间和要做的事') }}</span>
          <PixelIcon name="plus" size="sm" />
        </summary>
        <form class="scheduled-agent-form" @submit.prevent="createScheduledAgentTask">
          <label>
            <span>{{ __t('ui.settings', '交给谁') }}</span>
            <select v-model="scheduledAgentId" required>
              <option v-for="agent in agentStore.agents" :key="agent.id" :value="agent.id">
                {{ agent.name ?? agent.id }}
              </option>
            </select>
          </label>
          <label>
            <span>{{ __t('ui.settings', '执行时间') }}</span>
            <input v-model="scheduledAgentTime" type="datetime-local" required />
          </label>
          <label>
            <span>{{ __t('ui.settings', '结果会话与工具模式来源') }}</span>
            <select v-model="scheduledThreadId">
              <option value="">{{ __t('ui.settings', '使用角色最近的会话') }}</option>
              <option v-for="thread in scheduledThreads" :key="thread.id" :value="thread.id">
                {{ thread.title || __t('ui.settings', '未命名会话') }} ·
                {{
                  thread.interactionMode === 'minimal'
                    ? __t('ui.settings', '极简')
                    : thread.interactionMode === 'chat'
                      ? __t('ui.settings', '聊天')
                      : __t('ui.settings', '工作')
                }}
              </option>
            </select>
          </label>
          <label>
            <span>{{ __t('ui.settings', '重复安排') }}</span>
            <select v-model="scheduledRepeat">
              <option value="">{{ __t('ui.settings', '仅一次') }}</option>
              <option value="60">{{ __t('ui.settings', '每小时') }}</option>
              <option value="1440">{{ __t('ui.settings', '每 24 小时') }}</option>
              <option value="10080">{{ __t('ui.settings', '每 7 天') }}</option>
            </select>
          </label>
          <label class="scheduled-agent-form__instruction">
            <span>{{ __t('ui.settings', '任务内容') }}</span>
            <textarea
              v-model="scheduledAgentInstruction"
              rows="3"
              required
              maxlength="4000"
              :placeholder="__t('ui.settings', '描述到时希望角色帮你完成的事情…')"
            />
          </label>
          <footer>
            <span>{{ __t('ui.settings', '按所选会话的模式和工具执行，结果发送到该会话。') }}</span>
            <PButton
              type="submit"
              variant="primary"
              size="sm"
              :loading="creatingScheduledAgent"
              :disabled="
                !scheduledAgentId || !scheduledAgentTime || !scheduledAgentInstruction.trim()
              "
            >
              <PixelIcon name="plus" size="xs" />
              {{ __t('ui.settings', '创建任务') }}
            </PButton>
          </footer>
        </form>
      </details>

      <ProactiveModePanel />

      <!-- 用户提醒 -->
      <div class="tasks-tab__group">
        <h3 class="tasks-tab__group-title">
          <PixelIcon name="bell" size="xs" />
          {{ __t('ui.settings', '用户提醒 ·') }} {{ reminders.length }}
        </h3>
        <PEmpty
          v-if="!isLoadingReminders && reminders.length === 0"
          :description="__t('ui.settings', '通过聊天让 Agent 帮你设置提醒吧~')"
        />
        <div v-else class="tasks-tab__list">
          <ReminderItem
            v-for="item in reminders"
            :key="item.id"
            :item="item"
            @changed="fetchReminders"
          />
        </div>
      </div>

      <!-- 系统后台任务（折叠） -->
      <div class="tasks-tab__cron">
        <button type="button" class="tasks-tab__cron-header" @click="toggleCronTasks">
          <span class="tasks-tab__cron-title">
            <PixelIcon name="desktop" size="xs" />
            {{ __t('ui.settings', '系统后台任务 ·') }} {{ cronTasks.length }}
          </span>
          <span v-if="runningCronTasks > 0" class="tasks-tab__stat tasks-tab__stat--active">
            {{ runningCronTasks }} {{ __t('ui.settings', '运行中') }}
          </span>
          <PixelIcon :name="showCronTasks ? 'chevron-up' : 'chevron-down'" size="xs" />
        </button>

        <div v-if="showCronTasks" class="tasks-tab__list">
          <div v-if="cronError" class="cron-feedback cron-feedback--error">
            <span>{{ cronError }}</span>
            <PButton variant="secondary" size="sm" :loading="cronLoading" @click="fetchCronTasks">
              {{ __t('ui.settings', '重试') }}
            </PButton>
          </div>
          <div v-else-if="cronLoading && cronTasks.length === 0" class="cron-feedback">
            {{ __t('ui.settings', '正在加载任务状态…') }}
          </div>

          <article
            v-for="task in cronTasks"
            :key="task.name"
            class="cron-card"
            :class="{
              'cron-card--running': task.running,
              'cron-card--error': task.lastOutcome === 'error',
            }"
          >
            <div class="cron-card__main">
              <div class="cron-card__heading">
                <div class="cron-card__heading-text">
                  <h4 class="cron-card__title">{{ task.displayName }}</h4>
                  <p class="cron-card__description">{{ task.description }}</p>
                </div>
                <PBadge :variant="statusVariant(task)" size="sm">{{ statusText(task) }}</PBadge>
              </div>

              <div class="cron-card__schedule">
                <span>{{ __t('ui.settings', '周期') }} {{ task.intervalDesc }}</span>
                <span v-if="!task.running">
                  {{ __t('ui.settings', '预计') }} {{ formatCountdown(task) }} ·
                  {{ formatDateTime(task.nextDueAt) }}
                </span>
                <span v-else>{{ __t('ui.settings', '本次任务正在执行') }}</span>
              </div>
              <div
                class="cron-card__progress"
                :class="{ 'cron-card__progress--running': task.running }"
                role="progressbar"
                :aria-valuenow="Math.round(progressPercent(task))"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <span :style="{ width: `${progressPercent(task)}%` }" />
              </div>

              <div class="cron-card__summary">
                <span :class="{ 'cron-card__outcome--error': task.lastOutcome === 'error' }">
                  {{ __t('ui.settings', '最近结果：') }}{{ outcomeText(task) }}
                </span>
                <span>
                  {{ __t('ui.settings', '最近耗时：')
                  }}{{ formatElapsed(task.stats.lastDurationMs) }}
                </span>
              </div>
            </div>

            <div class="cron-card__actions">
              <PButton
                variant="secondary"
                size="sm"
                :loading="triggeringTasks.has(task.name)"
                :disabled="task.running || triggeringTasks.has(task.name)"
                @click.stop="triggerCronTask(task)"
              >
                {{ __t('ui.settings', '立即执行') }}
              </PButton>
              <button
                type="button"
                class="cron-card__detail-toggle"
                @click="toggleCronDetail(task.name)"
              >
                {{
                  expandedTasks.has(task.name)
                    ? __t('ui.settings', '收起详情')
                    : __t('ui.settings', '展开详情')
                }}
                <PixelIcon
                  :name="expandedTasks.has(task.name) ? 'chevron-up' : 'chevron-down'"
                  size="xs"
                />
              </button>
            </div>

            <dl v-if="expandedTasks.has(task.name)" class="cron-card__details">
              <div>
                <dt>{{ __t('ui.settings', '最近开始') }}</dt>
                <dd>{{ formatDateTime(task.lastStartedAt) }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.settings', '最近完成') }}</dt>
                <dd>{{ formatDateTime(task.lastFinishedAt) }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.settings', '最近成功') }}</dt>
                <dd>{{ formatDateTime(task.lastSuccessAt) }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.settings', '最近失败') }}</dt>
                <dd>{{ formatDateTime(task.lastFailureAt) }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.settings', '执行统计') }}</dt>
                <dd>
                  {{ __t('ui.settings', '共') }} {{ task.stats.totalRuns }}
                  {{ __t('ui.settings', '次 · 成功') }} {{ task.stats.successCount }}
                  {{ __t('ui.settings', '· 失败') }} {{ task.stats.errorCount }}
                </dd>
              </div>
              <div>
                <dt>{{ __t('ui.settings', '平均耗时') }}</dt>
                <dd>{{ formatElapsed(task.stats.averageDurationMs) }}</dd>
              </div>
              <div class="cron-card__detail-wide">
                <dt>{{ __t('ui.settings', '最近错误') }}</dt>
                <dd>{{ task.stats.lastError || '-' }}</dd>
              </div>
              <div class="cron-card__detail-wide">
                <dt>{{ __t('ui.settings', '内部任务标识') }}</dt>
                <dd>
                  <code>{{ task.name }}</code>
                </dd>
              </div>
            </dl>
          </article>
        </div>
      </div>
    </section>

    <!-- 派发新任务弹窗 -->
    <DispatchTaskModal
      :show="isDispatchOpen"
      :target-thread-id="dispatchTargetThreadId"
      @close="isDispatchOpen = false"
    />

    <!-- 任务详情弹窗 -->
    <TaskDetailModal
      v-if="detailTask"
      :task="detailTask"
      :avatar-url="agentAvatarUrl(detailTask.agentId)"
      :agent-name="agentDisplayName(detailTask.agentId)"
      :refresh-error="detailError"
      @close="closeDetail"
      @open-task="requestTaskNavigation"
      @updated="
        () => {
          refreshDetail()
          taskCenter.refreshActive()
          taskCenter.refreshHistory()
        }
      "
    />
  </div>
</template>

<style scoped>
.task-open-status {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin: 0 0 14px;
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  font-size: 12px;
}
.task-open-status button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.task-history-filter {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
  font-family: var(--ui-font-sans);
}
.task-history-search {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-xs);
  color: var(--ui-text-tertiary);
  background: var(--ui-bg-surface);
}
.task-history-search input {
  min-width: 0;
  width: 100%;
  border: 0;
  background: transparent;
  outline: none;
  color: var(--ui-text-primary);
  font: 12px var(--ui-font-sans);
}
.task-history-search:focus-within {
  border-color: var(--ui-accent-sky);
}
.task-history-search button {
  border: 0;
  background: transparent;
  color: var(--ui-accent-sky);
  white-space: nowrap;
  font-size: 12px;
  cursor: pointer;
}
.task-history-filter select {
  max-width: 40%;
  padding: 8px;
  color: var(--ui-text-secondary);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-xs);
  font-size: 12px;
}
.task-history-pages {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-block: 20px;
  color: var(--ui-text-tertiary);
  font-size: 12px;
}
.scheduled-agent-composer {
  border: 1px solid var(--ui-border-subtle);
  border-radius: 0;
  background: var(--task-fill);
  border-color: var(--ui-border-default);
  box-shadow: var(--task-raised);
}
.scheduled-agent-composer > summary {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 16px;
  list-style: none;
  cursor: pointer;
  color: var(--ui-accent-purple);
}
.scheduled-agent-composer > summary::-webkit-details-marker {
  display: none;
}
.scheduled-agent-composer > summary strong {
  color: var(--ui-text-primary);
  font-size: 12px;
  font-weight: 600;
}
.scheduled-agent-composer > summary span {
  flex: 1;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.scheduled-agent-composer > summary > :last-child {
  margin-left: auto;
}
.scheduled-agent-composer[open] > summary {
  border-bottom: 1px solid var(--ui-border-subtle);
}
.scheduled-agent-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  padding: 16px;
}
.scheduled-agent-form label {
  display: grid;
  gap: 7px;
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.scheduled-agent-form__instruction {
  grid-column: 1 / -1;
}
.scheduled-agent-form select,
.scheduled-agent-form input,
.scheduled-agent-form textarea {
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
  font: 12px/1.6 var(--ui-font-pixel);
  outline: none;
  box-shadow: var(--task-inset);
}
.scheduled-agent-form textarea {
  resize: vertical;
  min-height: 76px;
}
.scheduled-agent-form :is(input, select, textarea):focus {
  border-color: var(--ui-accent-purple);
  box-shadow: var(--task-inset);
  outline: 1px solid var(--ui-accent-purple);
  outline-offset: 2px;
}
.scheduled-agent-form footer {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.scheduled-agent-form footer > span {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
@media (max-width: 700px) {
  .scheduled-agent-form {
    grid-template-columns: minmax(0, 1fr);
  }
  .scheduled-agent-composer > summary span {
    display: none;
  }
  .scheduled-agent-form footer > span {
    max-width: 55%;
  }
}

/* ── 页面骨架 ── */
.tasks-tab {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-4);
  padding: var(--ui-space-6) var(--ui-space-8);
  height: 100%;
  overflow-y: auto;
  /* 任务界面统一像素字体，层次由字级与明暗区分 */
  font-family: var(--ui-font-pixel);
  color: var(--ui-text-primary);
}

/* ── 页头 ── */
.tasks-tab__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-space-4);
}

.tasks-tab__header-left {
  display: flex;
  align-items: center;
  gap: var(--ui-space-3);
  min-width: 0;
  flex-wrap: wrap;
}

/* 尺寸/字重/字体由 Tailwind 类（text-2xl font-black font-pixel）控制，这里只保留布局与颜色 */
.tasks-tab__title {
  margin: 0;
  color: var(--ui-text-primary);
}

.tasks-tab__title-icon {
  color: var(--ui-warning);
}

.tasks-tab__stats {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
}

/* 方块统计标签 */
.tasks-tab__stat {
  padding: 2px 10px;
  border-radius: 0;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--ui-font-pixel);
  border: 1px solid var(--ui-border-default);
  box-shadow: inset 1px 1px 0 var(--task-highlight);
}

.tasks-tab__stat--active {
  color: var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
}

.tasks-tab__stat--reminder {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

/* ── 三视图切换 ── */
.tasks-tab__nav {
  display: flex;
  gap: var(--ui-space-1);
  border-bottom: 1px solid var(--ui-border-default);
}

.tasks-tab__nav-item {
  padding: 8px 16px;
  margin-bottom: -1px;
  border: 1px solid transparent;
  border-bottom: 2px solid transparent;
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-tertiary);
  cursor: pointer;
  transition:
    color var(--ui-duration-fast) steps(3, end),
    border-color var(--ui-duration-fast) steps(3, end);
  font-family: var(--ui-font-pixel);
}

.tasks-tab__nav-item:hover {
  color: var(--ui-text-secondary);
}

.tasks-tab__nav-item--active {
  color: var(--ui-accent-sky);
  border-color: var(--ui-border-subtle);
  border-bottom-color: var(--ui-accent-sky);
  background: var(--task-fill);
  box-shadow: inset 1px 1px 0 var(--task-highlight);
}

.tasks-tab__nav-item:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: -2px;
}

/* ── 视图分区 ── */
.tasks-tab__section {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-4);
}

.tasks-tab__group {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-2);
}

.tasks-tab__group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--ui-text-tertiary);
  text-transform: uppercase;
}

.tasks-tab__list {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-2);
}

/* ── 历史记录工具条 ── */
.history-toolbar {
  display: flex;
  min-height: 54px;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-space-4);
  padding: 8px 10px 8px 12px;
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-left: 2px solid var(--ui-accent-sky);
  border-radius: 0;
  background: linear-gradient(90deg, var(--ui-accent-sky-soft), transparent 48%), var(--task-fill);
  box-shadow: var(--task-raised);
}

.history-toolbar__info {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.history-toolbar__icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--ui-accent-sky);
  border-radius: 0;
  background: var(--task-fill);
  color: var(--ui-accent-sky);
  box-shadow: var(--task-control);
}

.history-toolbar__info > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.history-toolbar__info strong {
  color: var(--ui-text-primary);
  font-size: 11px;
  font-weight: 800;
}

.history-toolbar__info > div > span {
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-toolbar__info > b {
  flex: 0 0 auto;
  padding: 3px 7px;
  border: 1px solid var(--ui-accent-primary);
  border-radius: 0;
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
  font: 600 11px var(--ui-font-pixel);
}

.history-toolbar__info > b.history-toolbar__all-read {
  border-color: var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
}

.history-toolbar__read-all {
  display: inline-flex;
  min-height: 30px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 11px;
  border: 1px solid var(--ui-accent-sky);
  border-radius: 0;
  background: var(--ui-accent-sky);
  color: #fff;
  font: 600 12px var(--ui-font-pixel);
  cursor: pointer;
  box-shadow: var(--task-control);
  transition:
    transform var(--ui-duration-fast),
    box-shadow var(--ui-duration-fast),
    opacity var(--ui-duration-fast);
}

.history-toolbar__read-all:hover:not(:disabled) {
  transform: translate(-1px, -1px);
  box-shadow: var(--task-control);
}

.history-toolbar__read-all:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: var(--task-inset);
}

.history-toolbar__read-all:disabled {
  cursor: default;
  opacity: 0.45;
  box-shadow: none;
}

@media (max-width: 680px) {
  .history-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .history-toolbar__read-all {
    width: 100%;
  }
  .history-toolbar__info > b {
    margin-left: auto;
  }
}

/* ── 历史时间线 ── */
.tasks-tab__timeline {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tasks-tab__timeline-item {
  display: flex;
  gap: var(--ui-space-3);
}

.tasks-tab__timeline-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  width: 16px;
  padding-top: 18px;
}

.tasks-tab__timeline-node {
  width: 6px;
  height: 6px;
  border-radius: 0;
  border: 1px solid
    color-mix(in srgb, var(--node-color, var(--ui-text-disabled)) 70%, var(--ui-border-strong));
  background: var(--node-color, var(--ui-text-disabled));
  box-shadow:
    inset 1px 1px 0 var(--task-highlight),
    1px 1px 0 var(--task-side);
}

/* 节点竖线（除最后一个外向下延伸） */
.tasks-tab__timeline-rail::after {
  content: '';
  flex: 1;
  width: 1px;
  margin-top: 4px;
  background: repeating-linear-gradient(
    to bottom,
    var(--ui-border-default) 0 3px,
    transparent 3px 6px
  );
}

.tasks-tab__timeline-item:last-child .tasks-tab__timeline-rail::after {
  display: none;
}

.tasks-tab__timeline-node--completed {
  --node-color: var(--ui-success);
}
.tasks-tab__timeline-node--failed {
  --node-color: var(--ui-danger);
}
.tasks-tab__timeline-node--cancelled {
  --node-color: var(--ui-text-disabled);
}

.tasks-tab__timeline-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: var(--ui-space-4);
}

.tasks-tab__timeline-time {
  font-size: 11px;
  color: var(--ui-text-tertiary);
  font-variant-numeric: tabular-nums;
  padding-left: 2px;
}

/* ── 系统 cron 折叠区 ── */
.tasks-tab__cron {
  border-top: 1px solid var(--ui-border-subtle);
  padding-top: var(--ui-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-2);
}

.tasks-tab__cron-header {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  padding: 4px 0;
  border: none;
  background: transparent;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--ui-text-tertiary);
  text-transform: uppercase;
  cursor: pointer;
  transition: color var(--ui-duration-fast) steps(3, end);
}

.tasks-tab__cron-header:hover {
  color: var(--ui-text-secondary);
}

.tasks-tab__cron-header:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  border-radius: 0;
}

.tasks-tab__cron-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* ── 系统任务卡片 ── */
.cron-feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-space-3);
  padding: 12px 14px;
  color: var(--ui-text-tertiary);
  background: var(--ui-bg-surface);
  border: 1px dashed var(--ui-border-default);
  border-radius: 0;
  font-size: 12px;
}

.cron-feedback--error {
  color: var(--ui-danger);
  border-color: var(--ui-danger);
  background: var(--ui-danger-soft);
}

.cron-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--ui-space-3) var(--ui-space-4);
  padding: 14px 16px;
  border-radius: 0;
  background: var(--task-fill);
  border: 1px solid var(--ui-border-subtle);
  box-shadow: var(--task-raised);
  border-color: var(--ui-border-default);
}

.cron-card--running {
  border-left: 2px solid var(--ui-success);
}

.cron-card--error {
  border-left: 2px solid var(--ui-danger);
}

.cron-card__main,
.cron-card__heading-text {
  min-width: 0;
}

.cron-card__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ui-space-3);
}

.cron-card__title {
  margin: 0;
  color: var(--ui-text-primary);
  font-size: 14px;
  font-weight: 700;
}

.cron-card__description {
  margin: 3px 0 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.cron-card__schedule,
.cron-card__summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 9px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.cron-card__progress {
  box-shadow: var(--task-inset);
  height: 6px;
  margin-top: 7px;
  overflow: hidden;
  border: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-hover);
}

.cron-card__progress > span {
  background-image: repeating-linear-gradient(
    90deg,
    transparent 0 6px,
    var(--task-highlight) 6px 8px
  );
  display: block;
  height: 100%;
  background-color: var(--ui-accent-sky);
  transition: width var(--ui-duration-normal) steps(3, end);
}

.cron-card__progress--running > span {
  background-color: var(--ui-success);
  animation: cron-progress-pulse 1.8s steps(3, end) infinite;
}

.cron-card__outcome--error {
  color: var(--ui-danger);
}

.cron-card__actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 8px;
}

.cron-card__detail-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 3px;
  border: 0;
  background: transparent;
  color: var(--ui-text-tertiary);
  font-size: 11px;
  cursor: pointer;
}

.cron-card__detail-toggle:hover {
  color: var(--ui-accent-sky);
}

.cron-card__details {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  margin: 0;
  padding: 12px;
  border-top: 1px dashed var(--ui-border-default);
  background: var(--ui-bg-hover);
  font-size: 11px;
}

.cron-card__details > div {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 8px;
}

.cron-card__details dt {
  color: var(--ui-text-tertiary);
}

.cron-card__details dd {
  min-width: 0;
  margin: 0;
  color: var(--ui-text-secondary);
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}

.cron-card__detail-wide {
  grid-column: 1 / -1;
}

.cron-card__details code {
  font-family: var(--ui-font-mono);
}

@keyframes cron-progress-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}

@media (max-width: 700px) {
  .cron-card {
    grid-template-columns: 1fr;
  }

  .cron-card__actions {
    flex-direction: row;
    justify-content: flex-end;
  }

  .cron-card__details {
    grid-template-columns: 1fr;
  }

  .cron-card__detail-wide {
    grid-column: auto;
  }
}

/* 减少动画偏好：关闭运行态动画 */
@media (prefers-reduced-motion: reduce) {
  .cron-card__progress > span {
    transition: none;
  }

  .cron-card__progress--running > span {
    animation: none;
  }
}
</style>
