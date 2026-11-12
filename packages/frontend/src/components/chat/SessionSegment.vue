<script setup lang="ts">
/**
 * SessionSegment — 会话设置面板的等宽分段选择。
 *
 * 各段等宽，选中指示条用百分比定位，面板以 v-show 隐藏时也无需重新测量。
 * 键盘遵循 radiogroup 约定：左右方向键在可用项之间移动并直接选中。
 */
import { computed, ref } from 'vue'
import PixelIcon from '../pixel/PixelIcon.vue'

export interface SessionSegmentOption {
  value: string
  label: string
  icon?: string
  title?: string
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    options: SessionSegmentOption[]
    modelValue: string
    label: string
    accent?: string
    disabled?: boolean
  }>(),
  { accent: 'var(--ui-accent-purple)', disabled: false },
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const root = ref<HTMLElement | null>(null)

const index = computed(() => props.options.findIndex((item) => item.value === props.modelValue))

function select(option: SessionSegmentOption): void {
  if (props.disabled || option.disabled || option.value === props.modelValue) return
  emit('update:modelValue', option.value)
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  const step =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0
  if (!step && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  const enabled = props.options.filter((option) => !option.disabled)
  if (!enabled.length) return
  const current = enabled.findIndex((option) => option.value === props.modelValue)
  const target =
    event.key === 'Home'
      ? enabled[0]!
      : event.key === 'End'
        ? enabled.at(-1)!
        : enabled[(Math.max(current, 0) + step + enabled.length) % enabled.length]!
  select(target)
  root.value?.querySelector<HTMLButtonElement>(`[data-segment-value="${target.value}"]`)?.focus()
}
</script>

<template>
  <div
    ref="root"
    class="session-segment"
    :class="{ 'is-disabled': disabled }"
    :style="{
      '--segment-accent': accent,
      '--segment-count': options.length,
      '--segment-index': Math.max(index, 0),
    }"
    role="radiogroup"
    :aria-label="label"
    :aria-disabled="disabled || undefined"
    @keydown="onKeydown"
  >
    <i v-if="index >= 0" class="session-segment__fill" aria-hidden="true" />
    <i v-if="index >= 0" class="session-segment__bar" aria-hidden="true" />
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      class="session-segment__option"
      :class="{ 'is-selected': option.value === modelValue, 'is-unavailable': option.disabled }"
      :data-segment-value="option.value"
      :aria-checked="option.value === modelValue"
      :tabindex="option.value === modelValue || (index < 0 && option === options[0]) ? 0 : -1"
      :title="option.title"
      :disabled="disabled || option.disabled"
      @click="select(option)"
    >
      <PixelIcon
        v-if="option.icon"
        :name="option.icon"
        size="xs"
        aria-hidden="true"
      />
      <span>{{ option.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.session-segment {
  position: relative;
  display: flex;
  border: 1px solid var(--ui-border-subtle);
  background: var(--app-soft-fill, var(--ui-bg-surface-soft));
}
.session-segment__fill,
.session-segment__bar {
  position: absolute;
  left: 0;
  width: calc(100% / var(--segment-count));
  pointer-events: none;
  transform: translateX(calc(100% * var(--segment-index)));
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.session-segment__fill {
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--segment-accent) 10%, transparent);
}
.session-segment__bar {
  bottom: 0;
  height: 2px;
  background: var(--segment-accent);
  box-shadow: 0 0 6px var(--segment-accent);
}
.session-segment__option {
  position: relative;
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 7px 2px 6px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  font: 11px/1 var(--ui-font-pixel);
  white-space: nowrap;
  transition: color 150ms ease;
}
.session-segment__option > span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-segment__option:hover:not(:disabled) {
  color: var(--ui-text-primary);
}
.session-segment__option.is-selected {
  color: var(--segment-accent);
}
.session-segment__option:disabled {
  cursor: not-allowed;
}
.session-segment__option.is-unavailable {
  opacity: 0.35;
}
.session-segment__option:focus-visible {
  outline: 2px solid var(--segment-accent);
  outline-offset: -2px;
}
@media (prefers-reduced-motion: reduce) {
  .session-segment__fill,
  .session-segment__bar {
    transition: none;
  }
}
[data-motion='off'] .session-segment__fill,
[data-motion='off'] .session-segment__bar,
[data-motion='reduced'] .session-segment__fill,
[data-motion='reduced'] .session-segment__bar {
  transition: none;
}
</style>
