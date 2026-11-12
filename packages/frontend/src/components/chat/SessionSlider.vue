<script setup lang="ts">
/**
 * SessionSlider — 会话设置面板的分档细滑块。
 *
 * 上方刻度轨道区统一接收点击与拖动指针输入（点击任意刻度直接切换，拖动实时预览、松手提交），
 * 下方档位文字也可直接点击选择，隐藏的原生 range 保留键盘方向键与读屏器支持。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 按顺序排列的档位名称。 */
    options: string[]
    /** 当前档位下标。 */
    modelValue: number
    label: string
    /** 读屏器读出的当前档位名称。 */
    valueText?: string
    accent?: string
    disabled?: boolean
    /** 等待确认的暂存档位。 */
    pending?: boolean
  }>(),
  { valueText: undefined, accent: 'var(--ui-accent-sky)', disabled: false, pending: false },
)
const emit = defineEmits<{
  'update:modelValue': [index: number]
  /** 拖动过程中的预览档位；结束拖动时发出 null。 */
  preview: [index: number | null]
}>()

const input = ref<HTMLInputElement | null>(null)
const hitArea = ref<HTMLElement | null>(null)
const dragIndex = ref<number | null>(null)
const hoverIndex = ref<number | null>(null)
const activePointerId = ref<number | null>(null)
let pointerCommitted = false

const last = computed(() => Math.max(0, props.options.length - 1))
const shown = computed(() => dragIndex.value ?? Math.max(0, Math.min(props.modelValue, last.value)))
const blocked = computed(() => props.disabled || !props.options.length)

/** 填充、刻度与手柄统一使用内部轨道的坐标。 */
function position(index: number): string {
  const ratio = last.value > 0 ? index / last.value : 0
  return `${ratio * 100}%`
}

/** 将指针横坐标映射为最近刻度下标（与下方 N 等分列宽严格对齐）。 */
function resolveIndexFromClientX(clientX: number): number {
  const el = hitArea.value
  const count = props.options.length
  if (!el || count <= 1) return 0
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return 0
  const ratio = (clientX - rect.left) / rect.width
  return Math.min(last.value, Math.max(0, Math.floor(ratio * count)))
}

function setDrag(index: number | null): void {
  if (dragIndex.value === index) return
  dragIndex.value = index
  emit('preview', index)
}

function onRangeInput(event: Event): void {
  if (blocked.value) return
  setDrag((event.target as HTMLInputElement).valueAsNumber)
}

function commit(index: number): void {
  if (blocked.value) return
  const clamped = Math.min(last.value, Math.max(0, index))
  // 先把选中意图交给父组件，再结束预览，保持保存期间的视觉连续性。
  emit('update:modelValue', clamped)
  setDrag(null)
  void nextTick(() => {
    if (input.value) input.value.value = String(shown.value)
  })
}

function cancelDrag(): void {
  activePointerId.value = null
  setDrag(null)
  if (input.value) input.value.value = String(shown.value)
}

function onTrackPointerDown(event: PointerEvent): void {
  if (blocked.value) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  pointerCommitted = false
  input.value?.focus({ preventScroll: true })
  activePointerId.value = event.pointerId
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
  const index = resolveIndexFromClientX(event.clientX)
  hoverIndex.value = index
  setDrag(index)
}

function onTrackPointerMove(event: PointerEvent): void {
  if (blocked.value) {
    hoverIndex.value = null
    return
  }
  const index = resolveIndexFromClientX(event.clientX)
  hoverIndex.value = index
  if (activePointerId.value === event.pointerId) {
    setDrag(index)
  }
}

function onTrackPointerUp(event: PointerEvent): void {
  if (activePointerId.value !== event.pointerId) return
  ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId)
  activePointerId.value = null
  if (blocked.value) {
    cancelDrag()
    return
  }
  const index = resolveIndexFromClientX(event.clientX)
  pointerCommitted = true
  window.setTimeout(() => {
    pointerCommitted = false
  }, 0)
  commit(index)
}

function onTrackPointerLeave(): void {
  if (activePointerId.value === null) {
    hoverIndex.value = null
  }
}

function onTrackClick(event: MouseEvent): void {
  if (pointerCommitted) {
    pointerCommitted = false
    return
  }
  if (blocked.value) return
  commit(resolveIndexFromClientX(event.clientX))
}

watch(() => [blocked.value, props.options.length], cancelDrag)
onBeforeUnmount(cancelDrag)
defineExpose({ cancel: cancelDrag })
</script>

<template>
  <div
    class="session-slider"
    :class="{
      'is-dragging': dragIndex !== null,
      'is-pending': pending && dragIndex === null,
      'is-disabled': blocked,
    }"
    :style="{ '--slider-accent': accent, '--slider-count': Math.max(options.length, 1) }"
  >
    <input
      ref="input"
      class="session-slider__input"
      type="range"
      min="0"
      :max="last"
      step="1"
      :value="shown"
      :disabled="blocked"
      :aria-label="label"
      :aria-valuetext="valueText || options[shown]"
      @input="onRangeInput"
      @change="commit(($event.target as HTMLInputElement).valueAsNumber)"
      @blur="cancelDrag"
    />
    <!-- 刻度轨道交互层：支持直接点击任意刻度切换，或按住轨道滑动预览 -->
    <span
      ref="hitArea"
      class="session-slider__hit"
      :title="!blocked && hoverIndex !== null ? options[hoverIndex] : undefined"
      @pointerdown="onTrackPointerDown"
      @pointermove="onTrackPointerMove"
      @pointerup="onTrackPointerUp"
      @pointercancel="cancelDrag"
      @pointerleave="onTrackPointerLeave"
      @click="onTrackClick"
    >
      <span class="session-slider__track" aria-hidden="true">
        <i class="session-slider__rail" />
        <i class="session-slider__fill" :style="{ width: position(shown) }" />
        <i
          v-for="(_, index) in options"
          :key="index"
          class="session-slider__tick"
          :class="{
            'is-passed': index < shown,
            'is-active': index === shown,
            'is-hovered': hoverIndex === index && index !== shown,
          }"
          :style="{ left: position(index) }"
        />
        <i class="session-slider__thumb" :style="{ left: position(shown) }" />
      </span>
    </span>
    <span class="session-slider__labels">
      <button
        v-for="(option, index) in options"
        :key="index"
        type="button"
        tabindex="-1"
        data-foldout-skip
        :class="{ 'is-selected': index === shown, 'is-hovered': hoverIndex === index && index !== shown }"
        :aria-pressed="index === shown"
        :disabled="blocked"
        :title="option"
        @click="commit(index)"
      >{{ option }}</button>
    </span>
  </div>
</template>

<style scoped>
.session-slider {
  position: relative;
  padding-top: 2px;
  cursor: pointer;
  outline: none;
  user-select: none;
}
/* 原生 range 仅承担键盘焦点与无障碍语义，指针点击与拖动交由刻度轨道层精准接管。 */
.session-slider__input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  pointer-events: none;
}
.session-slider__hit {
  position: relative;
  display: block;
  width: 100%;
  height: 22px;
  cursor: inherit;
  touch-action: none;
}
.session-slider__track {
  position: relative;
  display: block;
  height: 22px;
  margin: 0 calc(50% / var(--slider-count));
  pointer-events: none;
}
.session-slider__rail,
.session-slider__fill {
  position: absolute;
  top: 9px;
  left: 0;
  height: 3px;
}
.session-slider__rail {
  right: 0;
  background: color-mix(in srgb, var(--slider-accent) 16%, transparent);
}
.session-slider__fill {
  background-color: var(--slider-accent);
  transition:
    width 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    background-color 180ms ease,
    opacity 180ms ease;
}
.session-slider__tick {
  position: absolute;
  top: 7px;
  width: 5px;
  height: 7px;
  margin-left: -2.5px;
  background-color: var(--ui-border-strong);
  transition:
    background-color 150ms ease,
    transform 150ms ease,
    box-shadow 150ms ease;
}
.session-slider__tick.is-passed {
  background-color: var(--slider-accent);
}
.session-slider__tick.is-hovered {
  background-color: var(--slider-accent);
  transform: scale(1.32);
  box-shadow: 0 0 6px color-mix(in srgb, var(--slider-accent) 45%, transparent);
}
.session-slider__thumb {
  position: absolute;
  top: 4px;
  width: 14px;
  height: 14px;
  margin-left: -7px;
  background-color: var(--slider-accent);
  box-shadow:
    2px 2px 0 color-mix(in srgb, var(--slider-accent) 30%, transparent),
    0 0 7px color-mix(in srgb, var(--slider-accent) 45%, transparent);
  transition:
    left 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    transform 120ms ease,
    opacity 180ms ease,
    background-color 180ms ease,
    box-shadow 180ms ease;
}
.session-slider__thumb::after {
  content: '';
  position: absolute;
  inset: 3px;
  background: var(--ui-bg-surface);
  opacity: 0.9;
}
.session-slider.is-dragging .session-slider__fill,
.session-slider.is-dragging .session-slider__thumb {
  transition-duration: 90ms;
}
.session-slider.is-dragging .session-slider__thumb {
  transform: scale(1.15);
}
.session-slider.is-pending .session-slider__thumb {
  opacity: 0.65;
  outline: 1px dashed var(--slider-accent);
  outline-offset: 2px;
}
.session-slider.is-pending .session-slider__fill {
  opacity: 0.5;
}
.session-slider__labels {
  display: grid;
  grid-template-columns: repeat(var(--slider-count), minmax(0, 1fr));
  margin-top: 2px;
  font: 10px/1.4 var(--ui-font-sans);
  text-align: center;
}
.session-slider__labels > button {
  min-width: 0;
  margin: 0;
  padding: 3px 2px;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-tertiary);
  font: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: inherit;
  transition: color 180ms ease;
}
.session-slider__labels > button:hover:not(:disabled),
.session-slider__labels > button.is-hovered:not(:disabled) {
  color: var(--ui-text-primary);
}
.session-slider__labels > .is-selected {
  color: var(--slider-accent);
}
.session-slider:has(.session-slider__input:focus-visible),
.session-slider__labels > button:focus-visible {
  outline: 2px solid var(--slider-accent);
  outline-offset: 3px;
}
.session-slider.is-disabled {
  cursor: not-allowed;
}
@media (prefers-reduced-motion: reduce) {
  .session-slider__fill,
  .session-slider__thumb,
  .session-slider__tick,
  .session-slider__labels > button {
    transition: none;
  }
}
[data-motion='off'] .session-slider__fill,
[data-motion='off'] .session-slider__thumb,
[data-motion='off'] .session-slider__tick,
[data-motion='off'] .session-slider__labels > button,
[data-motion='reduced'] .session-slider__fill,
[data-motion='reduced'] .session-slider__thumb,
[data-motion='reduced'] .session-slider__tick,
[data-motion='reduced'] .session-slider__labels > button {
  transition: none;
}
</style>
