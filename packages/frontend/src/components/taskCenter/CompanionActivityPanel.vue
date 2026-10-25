<script setup lang="ts">
import { getDisplayLocale } from '../../i18n/index'

import { t as __t } from '../../i18n/index'

import './task-pixel.css'
import { computed, onDeactivated, ref, toRef, watch } from 'vue'
import { useCompanionActivity } from '../../composables/pet/useCompanionActivity'
import { schedulerApi } from '../../api/modules/schedulerApi'
import TaskDetailModal from './TaskDetailModal.vue'
import PixelIcon from '../pixel/PixelIcon.vue'
import { backgroundTasksApi, type BackgroundTaskInfo } from '../../api/modules/backgroundTasksApi'
import { useTaskDetail } from '../../composables/main/useTaskDetail'

const props = defineProps<{
  agentId: string
  compact?: boolean
  /** 桌宠仅呈现需要处理的轻提示，空闲和普通后台执行不占据桌面。 */
  floating?: boolean
  attentionOnly?: boolean
}>()
const emit = defineEmits<{ 'attention-change': [value: boolean] }>()
const { activity, summary, needsAttention, error, busy, refresh, perform } = useCompanionActivity(
  toRef(props, 'agentId'),
)
const expanded = ref(!props.compact && !props.floating)
const {
  task: selectedTask,
  error: detailError,
  open: openDetail,
  close: clearDetail,
  refresh: refreshDetail,
} = useTaskDetail()
onDeactivated(clearDetail)
const dismissedSignature = ref('')
const focused = computed(() => props.floating || props.attentionOnly)
const tasks = computed(() =>
  (activity.value?.tasks ?? []).filter(
    (task) => !focused.value || ['waiting_input', 'blocked'].includes(task.status),
  ),
)
const suggestions = computed(() =>
  (activity.value?.suggestions ?? []).filter((item) => !focused.value || item.status === 'open'),
)
const scheduled = computed(() =>
  (activity.value?.scheduled ?? []).filter((item) => !focused.value || item.status === 'failed'),
)
const recent = computed(() =>
  (activity.value?.recent ?? []).filter(
    (task) => !focused.value || (task.status === 'failed' && !task.readAt),
  ),
)
const attentionSignature = computed(() =>
  [
    ...tasks.value
      .filter((task) => ['waiting_input', 'blocked'].includes(task.status))
      .map((task) => task.id + ':' + (task.inputQuestion ?? '')),
    ...suggestions.value.filter((item) => item.status === 'open').map((item) => item.id),
    ...scheduled.value
      .filter((item) => item.status === 'failed')
      .map((item) => item.id + ':' + item.lastError),
    ...recent.value
      .filter((task) => task.status === 'failed' && !task.readAt)
      .map((task) => task.id + ':' + task.errorMessage),
  ]
    .sort()
    .join('|'),
)
const hasItems = computed(
  () =>
    tasks.value.length + suggestions.value.length + scheduled.value.length + recent.value.length >
    0,
)
const visible = computed(() => {
  if (selectedTask.value) return true
  if (props.floating)
    return needsAttention.value && attentionSignature.value !== dismissedSignature.value
  return hasItems.value || !!error.value
})
watch(needsAttention, (value) => emit('attention-change', value), { immediate: true })
watch(
  () => props.agentId,
  () => {
    clearDetail()
    dismissedSignature.value = ''
    expanded.value = !props.compact && !props.floating
  },
)
const statusLabels: Record<string, string> = {
  get waiting() {
    return __t('ui.taskCenter', '等待条件')
  },
  get blocked() {
    return __t('ui.taskCenter', '需要处理')
  },
  get queued() {
    return __t('ui.taskCenter', '排队中')
  },
  get running() {
    return __t('ui.taskCenter', '执行中')
  },
  get paused() {
    return __t('ui.taskCenter', '已暂停')
  },
  get waiting_input() {
    return __t('ui.taskCenter', '等待确认')
  },
}
function timeText(value: string): string {
  return new Date(value).toLocaleString(getDisplayLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
async function openTask(task: BackgroundTaskInfo): Promise<void> {
  void openDetail(task)
  if (['completed', 'failed', 'cancelled'].includes(task.status) && !task.readAt) {
    await perform(() => backgroundTasksApi.markRead(task.id))
  }
}
function closeTask(): void {
  clearDetail()
  void refresh()
}
function dismiss(): void {
  dismissedSignature.value = attentionSignature.value
  clearDetail()
  expanded.value = false
}
</script>

<template>
  <section
    v-if="visible"
    class="companion-activity task-pixel-surface"
    :class="{ 'is-floating': floating, 'is-compact': compact, 'needs-attention': needsAttention }"
    :aria-label="__t('ui.taskCenter', '角色工作状态')"
  >
    <header class="activity-head">
      <button
        class="activity-summary"
        type="button"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span class="activity-mark">
          <PixelIcon :name="needsAttention ? 'bell' : 'activity'" size="xs" />
        </span>
        <span class="activity-heading">
          <strong v-if="!floating">
            {{
              attentionOnly ? __t('ui.taskCenter', '需要留意') : __t('ui.taskCenter', '角色动态')
            }}
          </strong>
          <span :title="summary">{{ summary }}</span>
        </span>
        <PixelIcon
          class="activity-chevron"
          :name="expanded ? 'chevron-up' : 'chevron-down'"
          size="xs"
        />
      </button>
      <button
        v-if="floating"
        class="activity-dismiss"
        type="button"
        :title="__t('ui.taskCenter', '暂时收起，相同事项不再弹出')"
        :aria-label="__t('ui.taskCenter', '收起工作提示')"
        @click="dismiss"
      >
        <PixelIcon name="close" size="xs" />
      </button>
    </header>
    <div v-if="expanded" class="activity-body">
      <div v-if="error" role="alert" class="activity-error">
        <PixelIcon name="alert" size="xs" />
        <span>{{ error }}</span>
        <button type="button" @click="refresh">{{ __t('ui.taskCenter', '重试') }}</button>
      </div>
      <article v-for="task in tasks" :key="task.id" class="activity-item">
        <div class="activity-item-head">
          <PixelIcon
            :name="['waiting_input', 'blocked'].includes(task.status) ? 'shield' : 'activity'"
            size="xs"
          />
          <strong>{{ task.title }}</strong>
          <span class="activity-state">{{ statusLabels[task.status] }}</span>
        </div>
        <p v-if="task.inputQuestion">{{ task.inputQuestion }}</p>
        <p v-else-if="task.currentStage" class="activity-muted">{{ task.currentStage }}</p>
        <div class="activity-actions">
          <button type="button" class="activity-primary" @click="openTask(task)">
            {{
              ['waiting_input', 'blocked'].includes(task.status)
                ? __t('ui.taskCenter', '查看并处理')
                : __t('ui.taskCenter', '查看任务')
            }}
            <PixelIcon name="chevron-right" size="xs" />
          </button>
        </div>
      </article>
      <article v-for="suggestion in suggestions" :key="suggestion.id" class="activity-item">
        <div class="activity-item-head">
          <PixelIcon name="sparkle" size="xs" />
          <strong>{{ suggestion.title }}</strong>
          <span class="activity-state">{{ __t('ui.taskCenter', '建议') }}</span>
        </div>
        <p class="activity-muted">{{ suggestion.reason }}</p>
        <details class="activity-disclosure">
          <summary>
            {{ __t('ui.taskCenter', '行动内容') }}
            <PixelIcon name="chevron-down" size="xs" />
          </summary>
          <p>{{ suggestion.instruction }}</p>
        </details>
        <span v-if="suggestion.status === 'accepting'" class="activity-muted">
          {{ __t('ui.taskCenter', '正在派发任务…') }}
        </span>
        <div v-else class="activity-actions">
          <button
            type="button"
            class="activity-primary"
            :disabled="busy"
            @click="perform(() => schedulerApi.resolveSuggestion(suggestion.id, agentId, 'accept'))"
          >
            <PixelIcon name="check" size="xs" />
            {{ __t('ui.taskCenter', '采纳并开始') }}
          </button>
          <button
            type="button"
            class="activity-quiet"
            :disabled="busy"
            @click="
              perform(() => schedulerApi.resolveSuggestion(suggestion.id, agentId, 'dismiss'))
            "
          >
            {{ __t('ui.taskCenter', '暂不采纳') }}
          </button>
        </div>
      </article>
      <article v-for="item in scheduled" :key="item.id" class="activity-item">
        <div class="activity-item-head">
          <PixelIcon name="clock" size="xs" />
          <strong>{{ item.reason || item.content }}</strong>
          <span class="activity-state">
            {{
              item.status === 'failed'
                ? __t('ui.taskCenter', '未能派发')
                : item.status === 'dispatching'
                  ? __t('ui.taskCenter', '派发中')
                  : __t('ui.taskCenter', '待触发')
            }}
          </span>
        </div>
        <p class="activity-muted">
          {{
            item.type === 'follow_up' ? __t('ui.taskCenter', '跟进') : __t('ui.taskCenter', '计划')
          }}
          · {{ timeText(item.time) }}
        </p>
        <details v-if="item.reason" class="activity-disclosure">
          <summary>
            {{ __t('ui.taskCenter', '检查内容') }}
            <PixelIcon name="chevron-down" size="xs" />
          </summary>
          <p>{{ item.content }}</p>
        </details>
        <p v-if="item.lastError" class="activity-error-text">{{ item.lastError }}</p>
        <div class="activity-actions">
          <button
            v-if="item.status === 'failed'"
            type="button"
            class="activity-primary"
            :disabled="busy"
            @click="perform(() => schedulerApi.retryReminder(item.id, agentId))"
          >
            <PixelIcon name="refresh" size="xs" />
            {{ __t('ui.taskCenter', '重试派发') }}
          </button>
          <button
            v-if="item.status !== 'dispatching'"
            type="button"
            class="activity-quiet"
            :disabled="busy"
            @click="perform(() => schedulerApi.cancelReminder(item.id, agentId))"
          >
            {{ __t('ui.taskCenter', '取消计划') }}
          </button>
        </div>
      </article>
      <details v-if="recent.length" class="activity-results" :open="focused || undefined">
        <summary>
          {{ __t('ui.taskCenter', '近期结果') }}
          <span>{{ recent.length }}</span>
          <PixelIcon name="chevron-down" size="xs" />
        </summary>
        <article v-for="task in recent" :key="task.id" class="activity-item">
          <div class="activity-item-head">
            <PixelIcon :name="task.status === 'failed' ? 'alert' : 'check'" size="xs" />
            <strong>{{ task.title }}</strong>
            <span class="activity-state">
              {{
                task.status === 'completed'
                  ? __t('ui.taskCenter', '已完成')
                  : task.status === 'failed'
                    ? __t('ui.taskCenter', '遇到问题')
                    : __t('ui.taskCenter', '已取消')
              }}
            </span>
          </div>
          <p v-if="task.errorMessage" class="activity-error-text">{{ task.errorMessage }}</p>
          <p v-else-if="task.result" class="activity-result-preview">{{ task.result }}</p>
          <div class="activity-actions">
            <button type="button" @click="openTask(task)">
              {{ __t('ui.taskCenter', '查看结果') }}
              <PixelIcon name="chevron-right" size="xs" />
            </button>
            <button
              v-if="task.status === 'failed' && task.errorMessage?.includes('服务重启')"
              type="button"
              class="activity-primary"
              :disabled="busy"
              @click="perform(() => backgroundTasksApi.resumeInterrupted(task.id))"
            >
              {{ __t('ui.taskCenter', '继续任务') }}
            </button>
          </div>
        </article>
      </details>
    </div>
    <TaskDetailModal
      v-if="selectedTask"
      :task="selectedTask"
      :refresh-error="detailError"
      @open-task="openDetail"
      @updated="
        () => {
          refreshDetail()
          refresh()
        }
      "
      @close="closeTask"
    />
  </section>
</template>

<style scoped>
.companion-activity {
  --activity-bg: var(--task-face);
  --activity-text: var(--ui-text-primary);
  --activity-muted: var(--ui-text-tertiary);
  --activity-line: var(--ui-border-subtle);
  --activity-hover: var(--ui-bg-hover);
  --activity-accent: var(--ui-accent-purple);
  --activity-accent-soft: var(--ui-accent-purple-soft);
  --activity-danger: var(--ui-danger);
  color: var(--activity-text);
  background: var(--task-fill);
  border: 1px solid var(--activity-line);
  border-radius: 0;
  overflow: hidden;
  font-family: var(--ui-font-pixel);
  box-shadow: var(--task-raised);
}
.activity-head {
  display: flex;
  align-items: center;
}
.activity-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.activity-summary:hover {
  background: var(--activity-hover);
}
.activity-mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border: 1px solid var(--activity-line);
  border-radius: 0;
  color: var(--activity-accent);
  background: var(--activity-accent-soft);
  box-shadow: var(--task-control);
}
.activity-heading {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.activity-heading strong {
  font-size: 12px;
  font-weight: 600;
}
.activity-heading > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--activity-muted);
  font-size: 11px;
}
.activity-chevron {
  color: var(--activity-muted);
  flex-shrink: 0;
}
.activity-dismiss {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-right: 7px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--activity-muted);
  cursor: pointer;
}
.activity-dismiss:hover {
  color: var(--activity-text);
  background: var(--activity-hover);
}
.activity-body {
  display: grid;
  gap: 0;
  max-height: 360px;
  overflow: auto;
  padding: 0 14px 4px;
}
.activity-item {
  display: grid;
  gap: 8px;
  padding: 13px 0;
  border-top: 1px solid var(--activity-line);
  overflow-wrap: anywhere;
}
.activity-item-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.activity-item-head > .pixel-icon {
  color: var(--activity-accent);
  flex-shrink: 0;
}
.activity-item-head strong {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.6;
}
.activity-state {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--activity-muted);
}
.activity-item p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.activity-muted {
  color: var(--activity-muted);
  font-size: 11px;
}
.activity-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.activity-actions button,
.activity-error button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 27px;
  padding: 4px 9px;
  border: 1px solid var(--activity-line);
  border-radius: 0;
  background: transparent;
  color: var(--activity-text);
  cursor: pointer;
  font: 11px/1.4 var(--ui-font-pixel);
  box-shadow: var(--task-control);
}
.activity-actions button:hover {
  background: var(--activity-hover);
}
.activity-actions button.activity-primary {
  background: var(--activity-accent-soft);
  color: var(--activity-accent);
  border-color: color-mix(in srgb, var(--activity-accent) 25%, transparent);
}
.activity-actions button.activity-quiet {
  color: var(--activity-muted);
  border-color: transparent;
}
.activity-actions button:active {
  transform: translateY(1px);
}
.activity-body button:disabled {
  opacity: 0.5;
  cursor: wait;
}
.activity-error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 0;
  color: var(--activity-danger);
  font-size: 11px;
}
.activity-error > span {
  flex: 1;
}
.activity-error-text {
  color: var(--activity-danger);
  font-size: 11px !important;
}
.activity-disclosure summary,
.activity-results > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  list-style: none;
  cursor: pointer;
  color: var(--activity-muted);
  font-size: 11px;
}
summary::-webkit-details-marker {
  display: none;
}
.activity-disclosure p {
  margin-top: 8px;
  padding: 8px 10px;
  border-left: 2px solid var(--activity-line);
  background: var(--activity-hover);
  color: var(--activity-muted);
}
.activity-results > summary {
  padding: 10px 0;
}
.activity-results > summary span {
  font-size: 10px;
}
.activity-result-preview {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--activity-muted);
}
.is-floating {
  --activity-bg: var(--task-face);
  --activity-text: var(--ui-text-primary);
  --activity-muted: var(--ui-text-tertiary);
  --activity-line: var(--ui-border-default);
  --activity-hover: var(--ui-bg-hover);
  --activity-accent: var(--ui-accent-purple);
  --activity-accent-soft: var(--ui-accent-purple-soft);
  --activity-danger: var(--ui-danger);
  border-radius: 0;
  box-shadow: var(--task-raised);
  backdrop-filter: blur(12px);
  background: var(--task-fill);
}
.is-floating .activity-summary {
  gap: 7px;
  padding: 8px 9px;
}
.is-floating .activity-mark {
  width: 18px;
  height: 18px;
  background: transparent;
  border: 0;
}
.is-floating .activity-heading > span {
  color: var(--activity-text);
  font-size: 11px;
}
.is-floating .activity-body {
  max-height: min(260px, calc(100vh - 220px));
  padding: 0 11px 3px;
}
.is-floating .activity-state {
  display: none;
}
.is-floating .activity-item p {
  font-size: 11px;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--activity-accent);
  outline-offset: -2px;
}
.activity-actions button:active:not(:disabled) {
  box-shadow: var(--task-inset);
}
</style>
