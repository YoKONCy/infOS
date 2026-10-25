<script setup lang="ts">
/** PSwitch — 平涂细轨道、方形滑块与像素小心，保持轻巧的主题反馈。 */

interface Props {
  modelValue: boolean
  label?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}

const props = withDefaults(defineProps<Props>(), {
  label: '',
  disabled: false,
  size: 'md',
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  change: [value: boolean]
}>()

function toggle() {
  if (props.disabled) return
  const newVal = !props.modelValue
  emit('update:modelValue', newVal)
  emit('change', newVal)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    :class="['p-switch-wrapper', `p-switch-${size}`, { 'p-switch-disabled': disabled }]"
    @click="toggle"
  >
    <span :class="['p-switch-track', { 'p-switch-on': modelValue }]" aria-hidden="true">
      <span :class="['p-switch-thumb', { 'p-switch-thumb-on': modelValue }]" />
    </span>
    <span v-if="label" class="p-switch-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.p-switch-wrapper {
  --switch-width: 42px;
  --switch-height: 24px;
  --switch-thumb: 16px;
  --switch-inset: 3px;
  --switch-travel: calc(var(--switch-width) - var(--switch-thumb) - var(--switch-inset) * 2 - 2px);
  --switch-accent: var(--ui-accent-sky);
  --switch-offset: 0px;
  --switch-hover-y: -1px;
  --switch-press-scale: 0.92;
  --switch-duration: 140ms;
  --ui-focus-color: var(--switch-accent);
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  flex-shrink: 0;
  gap: 9px;
  width: fit-content;
  min-height: 32px;
  max-width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: var(--ui-text-secondary);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-align: left;
  vertical-align: middle;
  appearance: none;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.p-switch-sm {
  --switch-width: 34px;
  --switch-height: 20px;
  --switch-thumb: 12px;
  min-height: 28px;
  gap: 7px;
  font-size: 12px;
}
.p-switch-track {
  position: relative;
  box-sizing: border-box;
  display: block;
  flex: 0 0 var(--switch-width);
  width: var(--switch-width);
  height: var(--switch-height);
  border: 1px solid var(--ui-border-strong);
  border-radius: 2px;
  background: var(--ui-bg-surface-soft);
  transition:
    background-color var(--switch-duration) ease,
    border-color var(--switch-duration) ease;
}
.p-switch-track::before {
  position: absolute;
  top: calc(50% - 1px);
  left: calc(var(--switch-inset) + var(--switch-thumb) / 2 - 1px);
  width: 2px;
  height: 2px;
  background: var(--switch-accent);
  opacity: 0;
  transition: opacity var(--switch-duration) ease;
  content: '';
  pointer-events: none;
}
.p-switch-on {
  border-color: color-mix(in srgb, var(--switch-accent) 68%, var(--ui-border-strong));
  background: color-mix(in srgb, var(--switch-accent) 12%, var(--ui-bg-surface-soft));
}
.p-switch-on::before {
  opacity: 1;
}
.p-switch-thumb {
  position: absolute;
  top: var(--switch-inset);
  left: var(--switch-inset);
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: var(--switch-thumb);
  height: var(--switch-thumb);
  border: 1px solid var(--ui-border-strong);
  border-radius: 1px;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-inverse);
  box-shadow: 1px 1px 0 var(--ui-border-subtle);
  transform: translateX(var(--switch-offset));
  transition:
    transform var(--switch-duration) cubic-bezier(0.22, 1, 0.36, 1),
    background-color var(--switch-duration) ease,
    border-color var(--switch-duration) ease;
}
.p-switch-thumb::after {
  width: 8px;
  height: 6px;
  background: currentColor;
  /* 阶梯轮廓保持像素边缘，避免小尺寸图标变成圆润高光。 */
  clip-path: polygon(
    0 1px,
    1px 1px,
    1px 0,
    3px 0,
    3px 1px,
    5px 1px,
    5px 0,
    7px 0,
    7px 1px,
    8px 1px,
    8px 3px,
    7px 3px,
    7px 4px,
    6px 4px,
    6px 5px,
    5px 5px,
    5px 6px,
    3px 6px,
    3px 5px,
    2px 5px,
    2px 4px,
    1px 4px,
    1px 3px,
    0 3px
  );
  opacity: 0;
  transition: opacity var(--switch-duration) ease;
  content: '';
}
.p-switch-thumb-on {
  --switch-offset: var(--switch-travel);
  border-color: var(--switch-accent);
  background: var(--switch-accent);
}
.p-switch-thumb-on::after {
  opacity: 1;
}
.p-switch-label {
  transition: color var(--switch-duration) ease;
}
.p-switch-wrapper:focus-visible {
  outline: none;
}
.p-switch-wrapper:focus-visible .p-switch-track {
  outline: 2px solid var(--switch-accent);
  outline-offset: 3px;
}
@media (hover: hover) {
  .p-switch-wrapper:not(:disabled):hover .p-switch-track {
    border-color: color-mix(in srgb, var(--switch-accent) 55%, var(--ui-border-strong));
  }
  .p-switch-wrapper:not(:disabled):hover .p-switch-label {
    color: var(--ui-text-primary);
  }
  .p-switch-wrapper:not(:disabled):hover .p-switch-thumb {
    border-color: var(--switch-accent);
    transform: translate(var(--switch-offset), var(--switch-hover-y));
  }
}
.p-switch-wrapper:not(:disabled):active .p-switch-thumb {
  transform: translateX(var(--switch-offset)) scale(var(--switch-press-scale));
}
.p-switch-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 减少动效时只切换状态，关闭悬浮上抬和按压缩放。 */
:global([data-motion='reduced'] .p-switch-wrapper),
:global([data-motion='off'] .p-switch-wrapper) {
  --switch-hover-y: 0px;
  --switch-press-scale: 1;
  --switch-duration: 0ms;
}
@media (prefers-reduced-motion: reduce) {
  .p-switch-wrapper {
    --switch-hover-y: 0px;
    --switch-press-scale: 1;
    --switch-duration: 0ms;
  }
}
</style>
