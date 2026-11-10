<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * RunPulse.vue — 界面组件
 *
 * 负责组织该界面的响应式状态、用户交互与领域数据展示。
 * 副作用在组件生命周期内建立并清理，避免跨页面残留监听器或异步状态。
 */
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'

type RunPulseState =
  | 'thinking'
  | 'assembling'
  | 'generating'
  | 'calling'
  | 'waiting'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'failed'

const props = withDefaults(
  defineProps<{
    state?: RunPulseState
    label?: string
    name?: string
    elapsedMs?: number
    live?: boolean
    compact?: boolean
    showTime?: boolean
  }>(),
  {
    state: 'thinking',
    label: '',
    name: '助手',
    elapsedMs: undefined,
    live: true,
    compact: false,
    showTime: true,
  },
)

const initialNow = Date.now()
const accumulatedMs = ref(props.elapsedMs ?? 0)
const resumedAt = ref(initialNow)
const now = ref(initialNow)
// 主界面被隐藏或被应用标签覆盖时只停止刷新显示，计时基准不变，恢复后读数仍连续。
const surfaceVisible = inject<Readonly<Ref<boolean>>>(
  'infos:main-surface-visible',
  shallowRef(true),
)
let running = false
let timer: ReturnType<typeof setTimeout> | undefined

/** 10 秒内按 0.1s 显示，之后读数只到整秒，按秒边界刷新以减少重渲染。 */
function scheduleTick(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!running || !surfaceVisible.value) return
  const elapsed = accumulatedMs.value + Math.max(0, Date.now() - resumedAt.value)
  const delay = elapsed < 10_000 ? 100 : 1000 - (elapsed % 1000)
  timer = setTimeout(() => {
    timer = undefined
    now.value = Date.now()
    scheduleTick()
  }, delay)
}

function startTimer(): void {
  if (running || props.elapsedMs !== undefined || !props.live) return
  running = true
  resumedAt.value = Date.now()
  now.value = resumedAt.value
  scheduleTick()
}

function stopTimer(): void {
  if (running) accumulatedMs.value += Math.max(0, Date.now() - resumedAt.value)
  running = false
  if (timer) clearTimeout(timer)
  timer = undefined
}

watch(surfaceVisible, () => {
  if (!running) return
  now.value = Date.now()
  scheduleTick()
})

watch(
  () => [props.live, props.elapsedMs] as const,
  () => {
    stopTimer()
    if (props.elapsedMs !== undefined) accumulatedMs.value = props.elapsedMs
    startTimer()
  },
  { immediate: true },
)

onBeforeUnmount(stopTimer)

const text = computed(() => {
  if (props.label) return props.label
  const labels: Record<RunPulseState, string> = {
    get thinking() {
      return __t('ui.chat', '正在思考……')
    },
    get assembling() {
      return __t('ui.chat', '正在生成工具调用……')
    },
    get generating() {
      return __t('ui.chat', '正在打字……')
    },
    get calling() {
      return __t('ui.chat', '正在等待工具回传……')
    },
    get waiting() {
      return __t('ui.chat', '正在等待你的回应……')
    },
    get paused() {
      return __t('ui.chat', '任务已暂停')
    },
    get cancelled() {
      return __t('ui.chat', '已终止')
    },
    get completed() {
      return __t('ui.chat', '回复完成')
    },
    get failed() {
      return __t('ui.chat', '运行遇到问题')
    },
  }
  return labels[props.state]
})

const duration = computed(
  () =>
    props.elapsedMs ??
    accumulatedMs.value + (props.live ? Math.max(0, now.value - resumedAt.value) : 0),
)
const durationText = computed(() => {
  const milliseconds = duration.value
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
})
</script>

<template>
  <div
    class="run-pulse"
    :class="[
      `run-pulse--${state}`,
      { 'run-pulse--live': live, 'run-pulse--compact': compact, 'run-pulse--no-time': !showTime },
    ]"
    role="status"
    aria-live="polite"
  >
    <span class="run-pulse__motion" aria-hidden="true">
      <i class="run-pulse__orbit" />
      <i class="run-pulse__shadow" />
      <i class="run-pulse__cube"><i /></i>
      <i class="run-pulse__spark run-pulse__spark--one" />
      <i class="run-pulse__spark run-pulse__spark--two" />
    </span>
    <span :key="text" class="run-pulse__label">{{ text }}</span>
    <span v-if="showTime" class="run-pulse__divider" aria-hidden="true" />
    <time v-if="showTime" class="run-pulse__time" :datetime="`PT${Math.max(0, duration / 1000)}S`">
      <small>TIME</small>
      <b>{{ durationText }}</b>
    </time>
  </div>
</template>

<style scoped>
.run-pulse {
  --pulse-accent: var(--ui-accent-purple);
  --pulse-soft: var(--ui-accent-purple-soft);
  position: relative;
  isolation: isolate;
  display: inline-grid;
  min-width: 224px;
  height: 34px;
  grid-template-columns: 24px minmax(0, 1fr) 1px 52px;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  padding: 0 10px 0 8px;
  border: 1px solid color-mix(in srgb, var(--pulse-accent) 26%, var(--ui-border-default));
  border-radius: 10px;
  background: color-mix(in srgb, var(--pulse-soft) 62%, var(--ui-bg-elevated));
  box-shadow:
    0 6px 18px color-mix(in srgb, var(--pulse-accent) 11%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--ui-text-inverse) 24%, transparent);
  color: var(--ui-text-primary);
}

.run-pulse--compact {
  min-width: 0;
  height: 30px;
  grid-template-columns: 22px minmax(0, auto) 1px 50px;
  padding-right: 8px;
  border-radius: 9px;
}
.run-pulse--no-time {
  grid-template-columns: 22px minmax(0, auto);
}
.run-pulse--compact .run-pulse__label {
  font-size: 11px;
}
.run-pulse::before {
  position: absolute;
  z-index: -1;
  width: 46%;
  height: 180%;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--pulse-accent) 15%, transparent),
    transparent
  );
  content: '';
  transform: translateX(-180%) skewX(-20deg);
  animation: pulse-sheen 2.2s ease-in-out infinite;
}

.run-pulse--generating {
  --pulse-accent: var(--ui-accent-sky);
  --pulse-soft: var(--ui-accent-sky-soft);
}
.run-pulse--calling,
.run-pulse--waiting {
  --pulse-accent: var(--ui-warning);
  --pulse-soft: color-mix(in srgb, var(--ui-warning) 12%, transparent);
}
.run-pulse--paused {
  --pulse-accent: var(--ui-text-muted);
  --pulse-soft: var(--ui-bg-hover);
}
.run-pulse--cancelled {
  --pulse-accent: color-mix(in srgb, var(--ui-danger) 44%, var(--ui-text-secondary));
  --pulse-soft: color-mix(in srgb, var(--ui-text-muted) 7%, var(--ui-bg-elevated));
  min-width: 188px;
  border-color: color-mix(in srgb, var(--pulse-accent) 22%, var(--ui-border-subtle));
  border-radius: 9px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--pulse-accent) 7%, var(--ui-bg-elevated)),
    var(--ui-bg-elevated) 62%
  );
  box-shadow:
    0 3px 10px color-mix(in srgb, var(--ui-text-primary) 7%, transparent),
    inset 3px 0 0 color-mix(in srgb, var(--pulse-accent) 62%, transparent);
  color: var(--ui-text-secondary);
}
.run-pulse--cancelled::before {
  display: none;
}
.run-pulse--cancelled::after {
  position: absolute;
  right: 10px;
  bottom: 4px;
  left: 40px;
  height: 1px;
  background: linear-gradient(90deg, var(--pulse-accent), transparent 78%);
  content: '';
  opacity: 0.28;
}
.run-pulse--completed {
  --pulse-accent: var(--ui-success);
  --pulse-soft: color-mix(in srgb, var(--ui-success) 12%, transparent);
}
.run-pulse--failed {
  --pulse-accent: var(--ui-danger);
  --pulse-soft: color-mix(in srgb, var(--ui-danger) 12%, transparent);
}

.run-pulse__motion {
  position: relative;
  width: 22px;
  height: 24px;
  transform: translateZ(0);
}
.run-pulse__orbit {
  position: absolute;
  inset: 2px 1px;
  border: 1px solid color-mix(in srgb, var(--pulse-accent) 22%, transparent);
  border-radius: 7px;
  opacity: 0.7;
  transform: rotate(-8deg);
}
.run-pulse__cube {
  position: absolute;
  top: 5px;
  left: 5px;
  width: 12px;
  height: 12px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--pulse-accent) 66%, var(--ui-bg-elevated));
  border-radius: 4px;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--pulse-accent) 68%, white),
    var(--pulse-accent) 55%,
    color-mix(in srgb, var(--pulse-accent) 68%, black)
  );
  box-shadow:
    0 2px 5px color-mix(in srgb, var(--pulse-accent) 28%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.45);
  will-change: transform;
}
.run-pulse__cube i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 4px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.7);
}
.run-pulse--live .run-pulse__cube {
  animation: pulse-cube-float 1.2s cubic-bezier(0.37, 0, 0.24, 1) infinite;
}
.run-pulse__spark {
  position: absolute;
  width: 3px;
  height: 3px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--pulse-accent) 78%, white);
  opacity: 0;
}
.run-pulse__spark--one {
  top: 3px;
  right: 0;
}
.run-pulse__spark--two {
  top: 9px;
  left: 0;
}
.run-pulse--live .run-pulse__spark {
  animation: pulse-spark 1.2s ease-out infinite;
}
.run-pulse--live .run-pulse__spark--two {
  animation-delay: 0.22s;
}
.run-pulse__shadow {
  position: absolute;
  bottom: 2px;
  left: 6px;
  width: 10px;
  height: 3px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--pulse-accent) 34%, transparent);
  filter: blur(0.5px);
  animation: pulse-shadow 1.2s ease-in-out infinite;
  will-change: transform, opacity;
}
.run-pulse__label {
  overflow: hidden;
  font-size: 12px;
  font-weight: 750;
  letter-spacing: 0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
  animation: pulse-label-in 0.24s ease-out;
}
.run-pulse__divider {
  width: 1px;
  height: 14px;
  background: color-mix(in srgb, var(--pulse-accent) 24%, var(--ui-border-default));
}
.run-pulse__time {
  display: grid;
  min-width: 52px;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 5px;
  color: var(--ui-text-muted);
  font-family: var(--font-mono), monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.run-pulse__time small {
  color: color-mix(in srgb, var(--pulse-accent) 58%, var(--ui-text-muted));
  font-size: 7px;
  font-weight: 800;
  letter-spacing: 0.08em;
}
.run-pulse__time b {
  color: var(--ui-text-secondary);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.02em;
}

.run-pulse--paused .run-pulse__cube,
.run-pulse--cancelled .run-pulse__cube,
.run-pulse--completed .run-pulse__cube,
.run-pulse--failed .run-pulse__cube {
  animation: none;
  transform: rotate(12deg);
}
.run-pulse--cancelled .run-pulse__cube {
  top: 6px;
  left: 6px;
  width: 11px;
  height: 11px;
  border: 1px solid color-mix(in srgb, var(--pulse-accent) 52%, var(--ui-bg-elevated));
  border-radius: 50%;
  background: transparent;
  box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--pulse-accent) 10%, transparent);
  transform: rotate(0deg) scale(0.9);
}
.run-pulse--cancelled .run-pulse__cube::after {
  position: absolute;
  top: 4px;
  left: 1px;
  width: 7px;
  height: 1px;
  border-radius: 1px;
  background: var(--pulse-accent);
  content: '';
  transform: rotate(-38deg);
}
.run-pulse--cancelled .run-pulse__orbit {
  inset: 3px 2px;
  border-color: color-mix(in srgb, var(--pulse-accent) 18%, transparent);
  border-radius: 50%;
  opacity: 0.55;
  transform: none;
}
.run-pulse--cancelled .run-pulse__label {
  color: var(--ui-text-secondary);
  font-weight: 700;
}
.run-pulse--cancelled .run-pulse__time small {
  color: var(--ui-text-muted);
}
.run-pulse--cancelled .run-pulse__time b {
  color: var(--ui-text-tertiary);
}
.run-pulse--cancelled .run-pulse__cube i,
.run-pulse--cancelled .run-pulse__spark,
.run-pulse--cancelled .run-pulse__shadow {
  display: none;
}
.run-pulse--completed .run-pulse__cube {
  transform: rotate(45deg) scale(0.82);
}

@keyframes pulse-cube-float {
  0%,
  100% {
    transform: translate3d(0, 3px, 0) rotate(-6deg);
  }
  22% {
    transform: translate3d(1px, 0, 0) rotate(12deg);
  }
  52% {
    transform: translate3d(0, -5px, 0) rotate(94deg);
  }
  76% {
    transform: translate3d(-1px, -1px, 0) rotate(176deg);
  }
}
@keyframes pulse-shadow {
  0%,
  100% {
    opacity: 0.58;
    transform: scaleX(1.08);
  }
  52% {
    opacity: 0.2;
    transform: scaleX(0.62);
  }
}
@keyframes pulse-spark {
  0%,
  30% {
    opacity: 0;
    transform: translate3d(0, 2px, 0) scale(0.5) rotate(0deg);
  }
  55% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: translate3d(2px, -4px, 0) scale(1) rotate(90deg);
  }
}
@keyframes pulse-sheen {
  0%,
  38% {
    transform: translateX(-180%) skewX(-20deg);
  }
  72%,
  100% {
    transform: translateX(420%) skewX(-20deg);
  }
}
@keyframes pulse-label-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .run-pulse::before,
  .run-pulse__cube,
  .run-pulse__spark,
  .run-pulse__shadow,
  .run-pulse__label {
    animation: none !important;
  }
  .run-pulse--live .run-pulse__cube {
    animation: pulse-reduced 1.8s ease-in-out infinite !important;
  }
  @keyframes pulse-reduced {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }
}
</style>
