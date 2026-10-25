<script lang="ts">
let drawerCount = 0
let previousOverflow = ''
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { t } from '../../i18n'
import PixelIcon from './PixelIcon.vue'

defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
const titleId = useId()
const panel = ref<HTMLElement>()
const closeButton = ref<HTMLButtonElement>()
let previousFocus: HTMLElement | null = null

function onKeydown(event: KeyboardEvent): void {
  const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
  if (dialogs[dialogs.length - 1] !== panel.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  }
  if (event.key !== 'Tab') return
  const items = [
    ...(panel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
    ) ?? []),
  ].filter((element) => element.getClientRects().length > 0)
  const first = items[0] ?? panel.value
  const last = items.at(-1) ?? panel.value
  if (
    event.shiftKey &&
    (document.activeElement === first || !panel.value?.contains(document.activeElement))
  ) {
    event.preventDefault()
    last?.focus()
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || !panel.value?.contains(document.activeElement))
  ) {
    event.preventDefault()
    first?.focus()
  }
}
onMounted(async () => {
  if (drawerCount++ === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.addEventListener('keydown', onKeydown)
  await nextTick()
  closeButton.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  if (--drawerCount === 0) document.body.style.overflow = previousOverflow
  document.removeEventListener('keydown', onKeydown)
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <Transition name="p-drawer" appear>
      <div
        class="p-drawer-overlay"
        @click.self="emit('close')"
        @wheel.self.prevent
        @touchmove.self.prevent
      >
        <aside
          ref="panel"
          class="p-drawer"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <header class="p-drawer__header">
            <span :id="titleId" class="p-drawer__title">{{ title }}</span>
            <button
              ref="closeButton"
              class="p-drawer__close"
              type="button"
              :aria-label="t('ui.taskCenter', '关闭')"
              @click="emit('close')"
            >
              <PixelIcon name="close" size="sm" />
            </button>
          </header>
          <div class="p-drawer__body"><slot /></div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.p-drawer-overlay {
  position: fixed;
  inset: 32px 0 22px;
  z-index: 1100;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--ui-text-primary) 18%, transparent);
  overscroll-behavior: contain;
}
.p-drawer {
  width: min(720px, 100%);
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ui-bg-surface);
  color: var(--ui-text-primary);
  border-left: 1px solid var(--ui-border-default);
  box-shadow: -12px 0 40px #00000012;
  font-family: var(--ui-font-sans);
  outline: none;
}
.p-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  padding: 15px 24px;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.p-drawer__title {
  font: 12px var(--ui-font-pixel);
  color: var(--ui-text-secondary);
}
.p-drawer__close {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--ui-radius-xs);
  color: var(--ui-text-secondary);
  background: transparent;
  cursor: pointer;
}
.p-drawer__close:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}
.p-drawer__close:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
}
.p-drawer__body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  flex: 1;
}
.p-drawer-enter-active,
.p-drawer-leave-active {
  transition: background 180ms ease;
}
.p-drawer-enter-active .p-drawer,
.p-drawer-leave-active .p-drawer {
  transition: transform 220ms ease;
}
.p-drawer-enter-from,
.p-drawer-leave-to {
  background: transparent;
}
.p-drawer-enter-from .p-drawer,
.p-drawer-leave-to .p-drawer {
  transform: translateX(100%);
}
@media (max-width: 640px) {
  .p-drawer-overlay {
    inset: 0;
  }
  .p-drawer__header {
    padding-inline: 18px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .p-drawer-enter-active,
  .p-drawer-leave-active,
  .p-drawer-enter-active .p-drawer,
  .p-drawer-leave-active .p-drawer {
    transition: none;
  }
}
</style>
