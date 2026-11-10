<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * PToast — 全局 Toast 通知容器
 *
 * 从 useNotificationStore 读取 toasts 队列并逐个渲染。
 * 参考风格:
 * - 标题 + 消息体 + 进度条
 * - 类型色彩 (info/success/warning/error)
 * - 点击关闭 + 自动消失
 *
 * @module packages/frontend/src/components/notification/PToast
 */
import { computed, watch } from 'vue'
import { useNotificationStore } from '../../stores/useNotificationStore'
import type { DesktopToast } from '@infos/shared'
import { lockLeaving } from '../motion/lockLeaving'

const props = defineProps<{
  items?: DesktopToast[]
  onDismiss?: (id: number) => void
  native?: boolean
}>()

const store = useNotificationStore()
const toasts = computed(() => props.items ?? store.toasts)
const dismiss = (id: number) => (props.onDismiss ? props.onDismiss(id) : store.removeToast(id))
const offsets = new Map<number, number>()
function progressStyle(toast: DesktopToast) {
  if (!offsets.has(toast.id)) offsets.set(toast.id, Math.max(0, Date.now() - toast.createdAt))
  return { animationDuration: `${toast.duration}ms`, animationDelay: `-${offsets.get(toast.id)}ms` }
}
watch(
  toasts,
  (items) => {
    const ids = new Set(items.map((item) => item.id))
    for (const id of offsets.keys()) if (!ids.has(id)) offsets.delete(id)
  },
  { deep: true },
)

/** 类型图标映射 */
const iconMap: Record<string, string> = {
  info: '💠',
  success: '✅',
  warning: '⚡',
  error: '🔴',
}

/** 默认标题 */
const defaultTitleMap: Record<string, string> = {
  get info() {
    return __t('ui.notification', '提示')
  },
  get success() {
    return __t('ui.notification', '成功')
  },
  get warning() {
    return __t('ui.notification', '警告')
  },
  get error() {
    return __t('ui.notification', '错误')
  },
}
</script>

<template>
  <Teleport to="body">
    <div
      class="toast-container"
      :style="!native && store.nativeOverlayActive ? { visibility: 'hidden' } : undefined"
      aria-live="polite"
    >
      <TransitionGroup name="toast-list" @before-leave="lockLeaving">
        <div v-for="toast in toasts" :key="toast.id" :class="['toast-item', `toast-${toast.type}`]">
          <!-- 标题栏 -->
          <div class="toast-header">
            <span class="toast-icon">{{ iconMap[toast.type] ?? '💠' }}</span>
            <span class="toast-title">
              {{ toast.title || defaultTitleMap[toast.type] || __t('ui.notification', '提示') }}
            </span>
            <button
              class="toast-close"
              :aria-label="__t('ui.notification', '关闭通知')"
              @click="dismiss(toast.id)"
            >
              ✕
            </button>
          </div>

          <!-- 消息体 -->
          <div class="toast-body">{{ toast.message }}</div>

          <!-- 倒计时进度条 -->
          <div v-if="toast.duration > 0" class="toast-progress">
            <div class="toast-progress-bar" :style="progressStyle(toast)" />
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
/* ═══ 容器 (全局最高通知层，右上角堆叠) ═══ */
.toast-container {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 14px;
  pointer-events: none;
  padding: 24px;
  isolation: isolate;
}

/* ═══ 单条通知 (硬核心像素风) ═══ */
.toast-item {
  flex-shrink: 0;
  pointer-events: auto;
  width: min(420px, calc(100vw - 48px));
  /* 实心背景（不用半透明主题变量，避免文字看不清）；默认深色，浅色主题见下方覆盖 */
  --toast-bg: #1e1e24;
  --toast-line: #0f172a;
  --toast-head: rgba(255, 255, 255, 0.06);
  --toast-title: #fff;
  --toast-text: rgba(255, 255, 255, 0.9);
  --toast-muted: #888;
  --toast-hover: rgba(255, 255, 255, 0.1);
  background: var(--toast-bg);
  border: 2px solid var(--toast-line);
  border-left-width: 6px;
  border-radius: 0;
  overflow: hidden;
  color: var(--toast-text);
  box-shadow: 4px 4px 0px 0px rgba(0, 0, 0, 0.4);
  transition:
    transform 0.15s steps(3),
    box-shadow 0.15s steps(3);
  transform-origin: top right;
}

.toast-item:hover {
  transform: translate(-2px, -2px);
  box-shadow: 6px 6px 0px 0px rgba(0, 0, 0, 0.5);
}

/* 浅色主题：浅底深字，像素风的实色描边保留 */
:global([data-theme='light']) .toast-item {
  --toast-bg: #ffffff;
  --toast-line: #0f172a;
  --toast-head: #f1f5f9;
  --toast-title: #0f172a;
  --toast-text: #334155;
  --toast-muted: #64748b;
  --toast-hover: rgba(15, 23, 42, 0.08);
  box-shadow: 4px 4px 0px 0px rgba(15, 23, 42, 0.25);
}

/* ── 类型色彩 (实色边框) ── */
.toast-info {
  border-left-color: var(--color-sky-500, #38bdf8);
}

.toast-success {
  border-left-color: var(--color-emerald-400, #34d399);
}

.toast-warning {
  border-left-color: var(--color-amber-400, #fbbf24);
}

.toast-error {
  border-left-color: var(--color-red-500, #ef4444);
}

/* ── 标题栏 ── */
.toast-header {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  background: var(--toast-head);
  border-bottom: 2px solid var(--toast-line);
  gap: 12px;
}

.toast-icon {
  flex-shrink: 0;
  font-size: 20px;
}

.toast-title {
  flex: 1;
  font-family: var(--font-pixel, monospace);
  font-weight: 700;
  font-size: 16px;
  color: var(--toast-title);
  letter-spacing: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toast-close {
  background: none;
  border: none;
  color: var(--toast-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 4px;
  margin: -4px;
  border-radius: 4px;
  transition: all 0.15s;
}

.toast-close:hover {
  color: var(--toast-title);
  background: var(--toast-hover);
}

/* ── 消息体 ── */
.toast-body {
  padding: 12px 16px;
  line-height: 1.6;
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  color: var(--toast-text);
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

/* ── 进度条 ── */
.toast-progress {
  height: 4px;
  background: var(--toast-line);
  width: 100%;
}

.toast-progress-bar {
  height: 100%;
  width: 100%;
  transform-origin: left;
  animation: toast-countdown linear forwards;
}

/* 按类型着色进度条，实心像素风 */
.toast-info .toast-progress-bar {
  background: var(--color-sky-500, #38bdf8);
}

.toast-success .toast-progress-bar {
  background: var(--color-emerald-400, #34d399);
}

.toast-warning .toast-progress-bar {
  background: var(--color-amber-400, #fbbf24);
}

.toast-error .toast-progress-bar {
  background: var(--color-red-500, #ef4444);
}

@keyframes toast-countdown {
  from {
    transform: scaleX(1);
  }

  to {
    transform: scaleX(0);
  }
}

/* ═══ 列表过渡动画 ═══ */
/* 只过渡 transform 与 opacity；离开项脱离文档流，其余通知平滑补位。 */
.toast-list-enter-active {
  transition:
    opacity var(--motion-duration-medium) var(--motion-ease-out),
    transform var(--motion-duration-slow) var(--motion-ease-spring);
}

.toast-list-leave-active {
  position: absolute;
  transition:
    opacity var(--motion-duration-medium) var(--motion-ease-in),
    transform var(--motion-duration-medium) var(--motion-ease-in);
}

.toast-list-enter-from {
  opacity: 0;
  transform: translate3d(calc(var(--motion-distance-lg) * 3), 0, 0) scale(var(--motion-scale-in));
}

.toast-list-leave-to {
  opacity: 0;
  transform: translate3d(calc(var(--motion-distance-lg) * 3), 0, 0) scale(var(--motion-scale-in));
}

.toast-list-move {
  transition: transform var(--motion-duration-slow) var(--motion-ease-standard);
}
</style>
