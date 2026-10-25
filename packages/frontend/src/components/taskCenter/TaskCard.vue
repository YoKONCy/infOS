<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import './task-pixel.css'
/**
 * TaskCard — 后台任务卡片（任务中心重构版）
 *
 * 布局：单行信息流 ——
 *   [头像+状态块] [标题 + 元信息行 + (进度条)] [状态方块] [icon 操作]
 *
 * 视觉：细边框像素面板 + ui 语义令牌（双主题安全），
 * 状态色统一交给 TaskStatusBadge，不再内联实现。
 *
 * @props task — BackgroundTaskInfo
 * @props avatarUrl / agentName — Agent 展示信息（可选）
 * @emits detail / pause / resume / resumeInterrupted / cancel
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { taskElapsed, taskOriginLabel } from './taskPresentation'
import PixelIcon from '../pixel/PixelIcon.vue'
import TaskStatusBadge from './TaskStatusBadge.vue'
import type { BackgroundTaskInfo } from '../../api/modules/backgroundTasksApi'

const props = defineProps<{
  task: BackgroundTaskInfo
  /** Agent 头像 URL（可选） */
  avatarUrl?: string | null
  /** Agent 显示名（可选） */
  agentName?: string | null
  /** 历史记录卡片是否已读 */
  history?: boolean
  /** 历史记录卡片是否展开删除操作 */
  deleteOpen?: boolean
}>()

const emit = defineEmits<{
  detail: [task: BackgroundTaskInfo]
  pause: [task: BackgroundTaskInfo]
  resume: [task: BackgroundTaskInfo]
  cancel: [task: BackgroundTaskInfo]
  /** M05-篇3-1: 恢复因服务重启中断的任务 */
  resumeInterrupted: [task: BackgroundTaskInfo]
  retry: [task: BackgroundTaskInfo]
  read: [task: BackgroundTaskInfo]
  delete: [task: BackgroundTaskInfo]
}>()

const now = ref(Date.now())
const clock = setInterval(() => {
  now.value = Date.now()
}, 30_000)
onBeforeUnmount(() => clearInterval(clock))
const elapsed = computed(() => taskElapsed(props.task, now.value))
const preview = computed(
  () => props.task.result || props.task.lifecycle?.continuation || props.task.instruction,
)

/** 是否可暂停（排队或运行中） */
const canPause = computed(
  () =>
    props.task.category !== 'resident' &&
    ['queued', 'running', 'waiting', 'waiting_input'].includes(props.task.status),
)
const waitReason = computed(() => {
  const reason = props.task.execution?.waitReason
  if (!reason) return ''
  const labels: Record<string, string> = {
    get scheduler_capacity() {
      return __t('ui.taskCenter', '等待系统容量')
    },
    get class_capacity() {
      return __t('ui.taskCenter', '等待后台任务容量')
    },
    get resource_locked() {
      return __t('ui.taskCenter', '等待Agent资源')
    },
    get backpressure() {
      return __t('ui.taskCenter', '系统负载保护')
    },
    get io() {
      return __t('ui.taskCenter', '等待I/O')
    },
    get approval() {
      return __t('ui.taskCenter', '等待批准')
    },
    get paused() {
      return __t('ui.taskCenter', '已暂停')
    },
  }
  return labels[reason] ?? reason
})
/** 是否可恢复（paused） */
const canResume = computed(
  () =>
    ['paused', 'blocked', 'waiting'].includes(props.task.status) &&
    props.task.category !== 'resident' &&
    !props.task.lifecycle?.pendingEffect,
)
/** 是否可取消（活跃态） */
const canCancel = computed(
  () =>
    props.task.category !== 'resident' &&
    ['queued', 'running', 'paused', 'waiting_input', 'waiting', 'blocked'].includes(
      props.task.status,
    ),
)
/** 是否可断点续跑（failed 且因服务重启中断，checkpoint 仍在） */
const canResumeInterrupted = computed(
  () =>
    props.task.category !== 'resident' &&
    props.task.status === 'failed' &&
    (props.task.errorMessage ?? '').includes('服务重启'),
)
</script>

<template>
  <article
    class="task-card task-pixel-surface"
    :class="[
      `task-card--${task.status}`,
      {
        'task-card--history': history,
        'task-card--read': history && task.readAt,
        'task-card--delete-open': deleteOpen,
      },
    ]"
    role="button"
    tabindex="0"
    @click="history ? emit('read', task) : emit('detail', task)"
    @keydown.enter="history ? emit('read', task) : emit('detail', task)"
    @keydown.space.prevent="history ? emit('read', task) : emit('detail', task)"
  >
    <!-- 头像 + 状态点 -->
    <div class="task-card__avatar-wrap">
      <img
        v-if="avatarUrl"
        :src="avatarUrl"
        :alt="agentName ?? task.agentId"
        class="task-card__avatar"
      />
      <div v-else class="task-card__avatar-fallback">
        <PixelIcon name="bot" size="sm" />
      </div>
      <span class="task-card__status-dot" aria-hidden="true" />
    </div>

    <!-- 主体 -->
    <div class="task-card__body">
      <div class="task-card__title-row">
        <h4 class="task-card__title" :title="task.title">{{ task.title }}</h4>
        <TaskStatusBadge :status="task.status" />
      </div>

      <p class="task-card__meta">
        <span class="task-card__origin">{{ taskOriginLabel(task) }}</span>
        <span v-if="agentName" class="task-card__agent">{{ agentName }}</span>
        <span v-if="task.currentStage" class="task-card__stage">{{ task.currentStage }}</span>
        <span v-if="waitReason" class="task-card__stage">{{ waitReason }}</span>
        <span v-if="elapsed">{{ elapsed }}</span>
        <span class="task-card__tools">
          {{ __t('ui.taskCenter', '工具 ×') }}{{ task.toolCallCount }}
        </span>
        <span v-if="history && task.readAt">{{ __t('ui.taskCenter', '已读') }}</span>
      </p>
      <p v-if="preview" class="task-card__preview">{{ preview }}</p>

      <!-- 进度条 -->
      <div v-if="task.progress != null" class="task-card__progress">
        <div class="task-card__progress-track">
          <div class="task-card__progress-bar" :style="{ width: `${task.progress}%` }" />
        </div>
        <span class="task-card__progress-text">{{ task.progress }}%</span>
      </div>

      <!-- 失败提示 -->
      <p v-if="task.status === 'failed' && task.errorMessage" class="task-card__error">
        {{ task.errorMessage }}
      </p>
    </div>

    <!-- 控制操作（阻止冒泡，避免触发详情） -->
    <div class="task-card__actions" @click.stop @keydown.stop>
      <button
        v-if="canPause"
        type="button"
        class="task-card__action"
        :title="__t('ui.taskCenter', '暂停')"
        @click="emit('pause', task)"
      >
        <PixelIcon name="square" size="xs" />
      </button>
      <button
        v-if="canResume"
        type="button"
        class="task-card__action"
        :title="__t('ui.taskCenter', '恢复')"
        @click="emit('resume', task)"
      >
        <PixelIcon name="chevron-right" size="xs" />
      </button>
      <button
        v-if="canResumeInterrupted"
        type="button"
        class="task-card__action"
        :title="__t('ui.taskCenter', '从断点续跑（因服务重启中断）')"
        @click="emit('resumeInterrupted', task)"
      >
        <PixelIcon name="refresh" size="xs" />
      </button>
      <button
        v-if="
          ['completed', 'failed', 'cancelled'].includes(task.status) && task.category !== 'resident'
        "
        type="button"
        class="task-card__action"
        :title="__t('ui.taskCenter', '重新派发')"
        @click="emit('retry', task)"
      >
        <PixelIcon name="refresh" size="xs" />
      </button>
      <button
        v-if="history && task.category !== 'resident'"
        type="button"
        class="task-card__action task-card__action--delete"
        :title="__t('ui.taskCenter', '删除记录')"
        @click.stop="emit('delete', task)"
      >
        <PixelIcon name="trash" size="xs" />
      </button>
      <button
        v-if="canCancel"
        type="button"
        class="task-card__action task-card__action--danger"
        :title="__t('ui.taskCenter', '取消')"
        @click="emit('cancel', task)"
      >
        <PixelIcon name="close" size="xs" />
      </button>
    </div>
  </article>
</template>

<style scoped>
.task-card {
  display: flex;
  align-items: flex-start;
  gap: var(--ui-space-3);
  padding: 12px 14px;
  border-radius: var(--ui-radius-xs);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  box-shadow: none;
  cursor: pointer;
  transition:
    transform var(--ui-duration-fast) steps(3, end),
    box-shadow var(--ui-duration-fast) steps(3, end),
    border-color var(--ui-duration-fast) steps(3, end);
  font-family: var(--ui-font-sans);
}

.task-card:hover {
  transform: none;
  border-color: var(--ui-border-strong);
  box-shadow: 0 3px 12px color-mix(in srgb, var(--ui-text-primary) 4%, transparent);
}

.task-card:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 2px;
}

/* 需要用户处理的任务左侧描边提示 */
.task-card--waiting_input {
  border-left: 2px solid var(--ui-accent-primary);
}
.task-card--failed {
  border-left: 2px solid var(--ui-danger);
}

/* ── 头像 ── */
.task-card__avatar-wrap {
  position: relative;
  flex-shrink: 0;
  padding: 2px;
  border: 1px solid var(--ui-border-default);
  background: var(--task-fill);
  box-shadow: var(--task-control);
}

.task-card__avatar,
.task-card__avatar-fallback {
  width: 34px;
  height: 34px;
  border-radius: 0;
  object-fit: cover;
}

.task-card__avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
}

.task-card__status-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  border-radius: 0;
  border: 1px solid var(--ui-bg-surface);
  background: var(--dot-color, var(--ui-text-disabled));
}

/* 状态点配色（与 TaskStatusBadge 同一语义） */
.task-card--queued .task-card__status-dot {
  --dot-color: var(--ui-accent-purple);
}
.task-card--running .task-card__status-dot {
  --dot-color: var(--ui-accent-sky);
  animation: task-dot-pulse 1.6s steps(3, end) infinite;
}
.task-card--paused .task-card__status-dot {
  --dot-color: var(--ui-warning);
}
.task-card--waiting_input .task-card__status-dot {
  --dot-color: var(--ui-accent-primary);
}
.task-card--completed .task-card__status-dot {
  --dot-color: var(--ui-success);
}
.task-card--failed .task-card__status-dot {
  --dot-color: var(--ui-danger);
}
.task-card--cancelled .task-card__status-dot {
  --dot-color: var(--ui-text-disabled);
}

@keyframes task-dot-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ui-accent-sky) 45%, transparent);
  }
  50% {
    box-shadow: 0 0 0 4px transparent;
  }
}

/* ── 主体 ── */
.task-card__body {
  flex: 1;
  min-width: 0;
}
.task-card__preview {
  margin: 9px 0 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.task-card__origin {
  color: var(--ui-text-tertiary);
}

.task-card__title-row {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  justify-content: space-between;
}

.task-card__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.6;
}

.task-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ui-text-tertiary);
}

.task-card__agent {
  color: var(--ui-text-secondary);
  font-weight: 600;
}

.task-card__stage {
  color: var(--ui-accent-sky);
}

.task-card__tools {
  color: var(--ui-text-disabled);
}

/* 进度条 */
.task-card__progress {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  margin-top: 8px;
}

.task-card__progress-track {
  flex: 1;
  height: 6px;
  border-radius: 0;
  background: var(--ui-bg-hover);
  overflow: hidden;
  box-shadow: var(--task-inset);
}

.task-card__progress-bar {
  height: 100%;
  border-radius: 0;
  background: var(--ui-accent-sky);
  transition: width var(--ui-duration-normal) steps(6, end);
  background-image: repeating-linear-gradient(
    90deg,
    transparent 0 6px,
    var(--task-highlight) 6px 8px
  );
}

.task-card--completed .task-card__progress-bar {
  background-color: var(--ui-success);
}
.task-card--failed .task-card__progress-bar {
  background-color: var(--ui-danger);
}

.task-card__progress-text {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  color: var(--ui-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.task-card__error {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ui-danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.6;
}

/* 已读降低背景强调，状态与错误始终保留各自的语义颜色。 */
.task-card--history:not(.task-card--read) {
  border-left: 2px solid var(--ui-accent-primary);
  background:
    linear-gradient(var(--task-sheen), transparent 18px),
    color-mix(in srgb, var(--ui-accent-primary-soft) 20%, var(--task-face));
}
.task-card--history.task-card--read {
  background: var(--ui-bg-surface);
}
.task-card--history.task-card--read.task-card--failed {
  border-left: 2px solid var(--ui-danger);
}
.task-card--history .task-card__action--delete {
  opacity: 0;
  transform: translateX(8px);
  pointer-events: none;
}
.task-card--history.task-card--delete-open .task-card__action--delete {
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}
.task-card--history.task-card--delete-open .task-card__action--delete:hover {
  background: var(--ui-danger);
  color: var(--ui-text-inverse, #fff);
}

/* ── 操作（icon ghost 按钮，悬浮才显眼） ── */
.task-card__actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.task-card__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
  transition:
    background var(--ui-duration-fast) steps(3, end),
    color var(--ui-duration-fast) steps(3, end);
}

.task-card__action:hover {
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  border-color: var(--ui-border-default);
  box-shadow: var(--task-control);
}

.task-card__action--danger:hover {
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
}

.task-card__action:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 1px;
}

/* 减少动画偏好：关闭状态点脉冲 */
@media (prefers-reduced-motion: reduce) {
  .task-card--running .task-card__status-dot {
    animation: none;
  }
}
.task-card:active {
  box-shadow: var(--task-inset);
}
.task-card__action:active {
  box-shadow: var(--task-inset);
}
.task-card--waiting {
  border-left: 2px solid var(--ui-warning);
}
.task-card--blocked {
  border-left: 2px solid var(--ui-accent-primary);
}
</style>
