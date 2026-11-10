<script setup lang="ts">
/**
 * SessionSlider — 会话设置面板的分档细滑块。
 *
 * 原生 range 接收鼠标、触屏与键盘输入，拖动时预览，结束后提交；档位文字也可直接选择。
 * 原生手柄中心、可见刻度和档位文字共用同一组坐标。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

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
const dragIndex = ref<number | null>(null)

const last = computed(() => Math.max(0, props.options.length - 1))
const shown = computed(() => dragIndex.value ?? Math.max(0, Math.min(props.modelValue, last.value)))
const blocked = computed(() => props.disabled || !props.options.length)

/** 填充、刻度与手柄统一使用内部轨道的坐标。 */
function position(index: number): string {
  const ratio = last.value > 0 ? index / last.value : 0
  return `${ratio * 100}%`
}

function setDrag(index: number | null): void {
  if (dragIndex.value === index) return
  dragIndex.value = index
  emit('preview', index)
}

function onInput(event: Event): void {
  if (blocked.value) return
  setDrag((event.target as HTMLInputElement).valueAsNumber)
}

function commit(index: number): void {
  if (blocked.value) return
  // 先把选中意图交给父组件，再结束预览，保持保存期间的视觉连续性。
  emit('update:modelValue', index)
  cancelDrag()
}

function cancelDrag(): void {
  setDrag(null)
  if (input.value) input.value.value = String(shown.value)
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
      @input="onInput"
      @change="commit(($event.target as HTMLInputElement).valueAsNumber)"
      @pointercancel="cancelDrag"
      @blur="cancelDrag"
    />
    <span class="session-slider__track" aria-hidden="true">
      <i class="session-slider__rail" />
      <i class="session-slider__fill" :style="{ width: position(shown) }" />
      <i
        v-for="(_, index) in options"
        :key="index"
        class="session-slider__tick"
        :class="{ 'is-passed': index < shown }"
        :style="{ left: position(index) }"
      />
      <i class="session-slider__thumb" :style="{ left: position(shown) }" />
    </span>
    <span class="session-slider__labels">
      <button
        v-for="(option, index) in options"
        :key="index"
        type="button"
        tabindex="-1"
        data-foldout-skip
        :class="{ 'is-selected': index === shown }"
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
  touch-action: none;
  user-select: none;
}
/* 输入轨道比可见轨道两侧各多半个手柄，原生手柄中心与首尾刻度重合。 */
.session-slider__input {
  position: absolute;
  z-index: 1;
  top: 2px;
  left: calc(50% / var(--slider-count) - 7px);
  width: calc(100% - 100% / var(--slider-count) + 14px);
  height: 20px;
  margin: 0;
  padding: 0;
  appearance: none;
  border: 0;
  border-radius: 0;
  outline: none;
  background: transparent;
  cursor: inherit;
  touch-action: none;
}
.session-slider__input::-webkit-slider-runnable-track {
  height: 20px;
  background: transparent;
}
.session-slider__input::-webkit-slider-thumb {
  width: 14px;
  height: 20px;
  appearance: none;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.session-slider__input::-moz-range-track,
.session-slider__input::-moz-range-progress {
  height: 20px;
  border: 0;
  background: transparent;
}
.session-slider__input::-moz-range-thumb {
  width: 14px;
  height: 20px;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.session-slider__track {
  position: relative;
  display: block;
  height: 20px;
  margin: 0 calc(50% / var(--slider-count));
  pointer-events: none;
}
.session-slider__rail,
.session-slider__fill {
  position: absolute;
  top: 8px;
  left: 0;
  height: 3px;
}
.session-slider__rail {
  right: 0;
  background: color-mix(in srgb, var(--slider-accent) 14%, transparent);
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
  width: 4px;
  height: 5px;
  margin-left: -2px;
  background-color: var(--ui-border-strong);
  transition: background-color 180ms ease;
}
.session-slider__tick.is-passed {
  background-color: var(--slider-accent);
}
.session-slider__thumb {
  position: absolute;
  top: 3px;
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
.session-slider__labels > button:hover:not(:disabled) {
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
:global([data-motion='off']) .session-slider__fill,
:global([data-motion='off']) .session-slider__thumb,
:global([data-motion='off']) .session-slider__tick,
:global([data-motion='off']) .session-slider__labels > button,
:global([data-motion='reduced']) .session-slider__fill,
:global([data-motion='reduced']) .session-slider__thumb,
:global([data-motion='reduced']) .session-slider__tick,
:global([data-motion='reduced']) .session-slider__labels > button {
  transition: none;
}
</style>
