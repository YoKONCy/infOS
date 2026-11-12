<script setup lang="ts">
import { nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { t } from '../../i18n'
import PixelIcon from '../pixel/PixelIcon.vue'
import { focusFoldoutOption, isReachableFoldoutButton } from './inputFoldoutFocus'

const props = withDefaults(
  defineProps<{
    label: string
    title: string
    icon: string
    summary?: string
    badge?: string
    accent?: string
    busy?: boolean
    disabled?: boolean
    compact?: boolean
    width?: number
    scopeKey: string
    /** text 为紧凑文字入口，由 trigger 插槽提供内容。 */
    variant?: 'block' | 'text'
    /** 覆盖入口默认拼接的悬停提示。 */
    hint?: string
    /** 面板内使用滑块或分段控件时关闭上下方向键的按钮轮转。 */
    arrowNavigation?: boolean
  }>(),
  {
    width: 320,
    accent: 'var(--ui-accent-primary)',
    variant: 'block',
    summary: undefined,
    badge: undefined,
    hint: undefined,
    arrowNavigation: true,
  },
)
const emit = defineEmits<{ open: []; close: [] }>()
const id = `input-foldout-${useId()}`
const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const position = ref<CSSProperties>({ visibility: 'hidden' })
const material = ref<CSSProperties>({})

function close(restoreFocus = false): void {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

/** Teleport 会离开自定义壁纸作用域，把当前输入台的材质变量带到浮层。 */
function place(): void {
  if (!open.value || !trigger.value || !panel.value) return
  const style = getComputedStyle(trigger.value)
  const variables: Record<string, string> = {}
  for (const name of [
    '--app-panel-fill',
    '--app-soft-fill',
    '--app-reading-fill',
    '--app-material-blur',
    '--app-material-saturate',
  ]) {
    const value = style.getPropertyValue(name).trim()
    if (value) variables[name] = value
  }
  material.value = variables
  const rect = trigger.value.getBoundingClientRect()
  const margin = 12
  const gap = 9
  const width = Math.max(0, Math.min(props.width, window.innerWidth - margin * 2))
  const above = Math.max(0, rect.top - margin - gap)
  const below = Math.max(0, window.innerHeight - rect.bottom - margin - gap)
  const upwards = above >= Math.min(panel.value.scrollHeight, 360) || above >= below
  position.value = {
    left: `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`,
    width: `${width}px`,
    maxHeight: `${upwards ? above : below}px`,
    ...(upwards
      ? { bottom: `${window.innerHeight - rect.top + gap}px` }
      : { top: `${rect.bottom + gap}px` }),
    transformOrigin: upwards ? 'left bottom' : 'left top',
    visibility: 'visible',
  }
}

function buttons(): HTMLButtonElement[] {
  return Array.from(
    panel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
  ).filter(isReachableFoldoutButton)
}

async function expand(last = false): Promise<void> {
  if (props.disabled) return
  open.value = true
  emit('open')
  await nextTick()
  if (!open.value || !trigger.value) return
  place()
  // 定位会把首次打开的面板从 visibility:hidden 改为可见，等样式落地后再选焦点。
  await nextTick()
  if (!open.value || !trigger.value) return
  focusFoldoutOption(buttons(), last, panel.value)
}

function toggle(): void {
  if (open.value) close()
  else void expand()
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  void expand(event.key === 'ArrowUp')
}

function onKeydown(event: KeyboardEvent): void {
  if (!open.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
    return
  }
  if (
    !props.arrowNavigation ||
    !panel.value?.contains(event.target as Node) ||
    !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
  )
    return
  const items = buttons()
  if (!items.length) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

function outside(event: Event): void {
  if (!open.value || !(event.target instanceof Node)) return
  if (!trigger.value?.contains(event.target) && !panel.value?.contains(event.target)) close()
}

function scroll(event: Event): void {
  if (event.target instanceof Node && panel.value?.contains(event.target)) return
  close()
}

function otherOpened(event: Event): void {
  if ((event as CustomEvent<string>).detail !== id) close()
}

watch(open, (value) => {
  if (value) window.dispatchEvent(new CustomEvent('infos:input-foldout-open', { detail: id }))
  else emit('close')
})
watch(
  () => props.scopeKey,
  () => close(),
)
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close()
  },
)
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('focusin', outside)
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', place)
  window.addEventListener('infos:input-foldout-open', otherOpened)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('focusin', outside)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', place)
  window.removeEventListener('infos:input-foldout-open', otherOpened)
})
onDeactivated(() => close())
defineExpose({ close })
</script>

<template>
  <span
    class="input-foldout"
    :class="{ 'is-compact': compact, 'input-foldout--text': variant === 'text' }"
    :style="{ '--foldout-accent': accent }"
  >
    <button
      ref="trigger"
      type="button"
      class="input-foldout__trigger"
      :class="{
        'is-open': open,
        'has-badge': badge,
        'input-foldout__trigger--text': variant === 'text',
        'input-tool-trigger': variant === 'text',
      }"
      :title="hint || [title, label, summary, badge].filter(Boolean).join(' · ')"
      :aria-label="title"
      :aria-controls="id"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-busy="busy"
      :disabled="disabled"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <slot name="trigger" :open="open">
        <span class="input-foldout__emblem" aria-hidden="true">
          <PixelIcon v-if="busy" name="refresh" size="xs" animation="spin" />
          <slot v-else name="icon"><PixelIcon :name="icon" size="xs" /></slot>
        </span>
        <span class="input-foldout__label">{{ label }}</span>
        <span v-if="summary" class="input-foldout__summary">{{ summary }}</span>
        <span v-if="badge" class="input-foldout__badge">{{ badge }}</span>
        <PixelIcon name="chevron-up" size="xs" class="input-foldout__chevron" aria-hidden="true" />
      </slot>
    </button>
    <Teleport to="body">
      <Transition name="input-foldout">
        <section
          v-show="open"
          :id="id"
          ref="panel"
          class="input-foldout-panel"
          role="dialog"
          tabindex="-1"
          :aria-label="title"
          :style="[material, position, { '--foldout-accent': accent }]"
        >
          <header class="input-foldout-panel__head">
            <span>
              <PixelIcon :name="icon" size="xs" />
              <strong>{{ title }}</strong>
            </span>
            <slot name="head-actions">
              <button
                type="button"
                data-foldout-close
                :aria-label="t('ui.input-controls', '收起选项')"
                @click="close(true)"
              >
                <PixelIcon name="close" size="xs" />
              </button>
            </slot>
          </header>
          <div class="input-foldout-panel__body"><slot /></div>
        </section>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.input-foldout {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 2px 2px 3px 0;
}
.input-foldout__trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  margin: 0;
  padding: 0 7px 0 0;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  cursor: pointer;
  background: var(--app-soft-fill, var(--ui-bg-surface));
  color: var(--ui-text-secondary);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ui-text-primary) 5%, transparent),
    2px 2px 0 var(--ui-border-subtle);
  font: 11px/1 var(--ui-font-pixel);
  white-space: nowrap;
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    color 140ms ease;
}
.input-foldout__emblem {
  display: grid;
  place-items: center;
  width: 29px;
  align-self: stretch;
  border-right: 1px solid var(--ui-border-subtle);
  color: var(--foldout-accent);
  background: color-mix(in srgb, var(--foldout-accent) 6%, transparent);
}
.input-foldout__summary {
  font: 10px/1 var(--ui-font-sans);
  color: var(--ui-text-tertiary);
  padding-left: 6px;
  border-left: 1px solid var(--ui-border-subtle);
}
.input-foldout__badge {
  padding: 3px 4px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 32%, transparent);
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
  font-size: 9px;
}
.input-foldout__chevron {
  color: var(--ui-text-tertiary);
  transition: transform 140ms ease;
}
.input-foldout__trigger.is-open .input-foldout__chevron {
  transform: rotate(180deg);
}
.input-foldout__trigger:hover:not(:disabled),
.input-foldout__trigger.is-open {
  border-color: var(--foldout-accent);
  color: var(--foldout-accent);
  background: color-mix(
    in srgb,
    var(--foldout-accent) 7%,
    var(--app-soft-fill, var(--ui-bg-surface))
  );
}
.input-foldout__trigger:active:not(:disabled) {
  translate: 1px 1px;
  box-shadow: inset 1px 1px 0 var(--ui-border-subtle);
}
.input-foldout__trigger:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.input-foldout__trigger:focus-visible {
  outline: 2px solid var(--foldout-accent);
  outline-offset: 2px;
}
.input-foldout.is-compact .input-foldout__summary {
  display: none;
}
.input-foldout-panel {
  position: fixed;
  z-index: 1000;
  -webkit-app-region: no-drag;
  box-sizing: border-box;
  overflow-y: auto;
  scrollbar-gutter: stable;
  overflow-anchor: none;
  overscroll-behavior: contain;
  border: 1px solid var(--ui-border-strong);
  border-radius: 2px;
  background: color-mix(in oklab, var(--ui-bg-surface) 95%, transparent);
  color: var(--ui-text-primary);
  backdrop-filter: blur(max(18px, var(--app-material-blur, 16px)))
    saturate(var(--app-material-saturate, 172%));
  box-shadow:
    var(--ui-crystal-highlight, inset 0 1px 0 rgba(255, 255, 255, 0.9)),
    4px 4px 0 var(--ui-border-subtle),
    0 14px 32px rgb(15 23 42 / 16%);
}
.input-foldout-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 11px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--app-soft-fill, var(--ui-bg-surface-soft));
  box-shadow: inset 24px 2px 0 -1px var(--foldout-accent);
}
.input-foldout-panel__head > span {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--foldout-accent);
}
.input-foldout-panel__head strong {
  color: var(--ui-text-primary);
  font: 12px/1.5 var(--ui-font-pixel);
}
.input-foldout-panel__head > button,
.input-foldout-panel__head :slotted(button) {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 0;
  color: var(--ui-text-tertiary);
  background: transparent;
  cursor: pointer;
}
.input-foldout-panel__head > button:hover,
.input-foldout-panel__head :slotted(button:hover:not(:disabled)) {
  border-color: var(--ui-border-default);
  color: var(--ui-text-primary);
  background: var(--ui-bg-hover);
}
.input-foldout-panel__head > button:focus-visible,
.input-foldout-panel__head :slotted(button:focus-visible) {
  outline: 2px solid var(--foldout-accent);
  outline-offset: -2px;
}
.input-foldout-panel__body {
  padding: 7px;
}
.input-foldout-enter-active,
.input-foldout-leave-active {
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}
.input-foldout-enter-from,
.input-foldout-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.99);
}
@media (max-width: 640px) {
  .input-foldout__summary {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .input-foldout-enter-active,
  .input-foldout-leave-active,
  .input-foldout__chevron {
    transition: none;
  }
}
[data-motion='off'] .input-foldout__chevron,
[data-motion='reduced'] .input-foldout__chevron {
  transition: none;
}
[data-motion='off'] .input-foldout-panel,
[data-motion='reduced'] .input-foldout-panel {
  transition: none;
}
</style>

<style scoped src="./input-foldout-text.css"></style>
