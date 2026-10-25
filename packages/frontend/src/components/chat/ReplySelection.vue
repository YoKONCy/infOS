<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { copyClientText } from '../../lib/clientPlatform'

import { nextTick, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import PixelIcon from '../pixel/PixelIcon.vue'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { useSelectionSpeech } from '../../composables/chat/useSelectionSpeech'

const props = defineProps<{ streaming: boolean; identity: string; agentId?: string }>()
const root = ref<HTMLElement | null>(null),
  menu = ref<HTMLElement | null>(null)
const selection = ref(''),
  open = ref(false),
  position = ref({ left: '0px', top: '0px' })
const notifications = useNotificationStore()
const speech = useSelectionSpeech(() => props.agentId)
const close = () => {
  open.value = false
}
async function contextMenu(event: MouseEvent) {
  if (props.streaming) return
  const current = window.getSelection()
  if (!current || current.isCollapsed || !current.rangeCount || !root.value) return
  const range = current.getRangeAt(0)
  if (!root.value.contains(range.startContainer) || !root.value.contains(range.endContainer)) return
  const text = current.toString()
  if (!text.trim()) return
  event.preventDefault()
  selection.value = text
  position.value = {
    left: `${Math.max(8, Math.min(event.clientX, window.innerWidth - 188))}px`,
    top: `${Math.max(8, Math.min(event.clientY, window.innerHeight - 112))}px`,
  }
  open.value = true
  await nextTick()
  menu.value?.focus({ preventScroll: true })
}
async function copy() {
  close()
  try {
    await copyClientText(selection.value)
    notifications.toast(__t('ui.chat', '已复制'), 'success')
  } catch {
    notifications.toast(__t('ui.chat', '复制失败，请重试'), 'error')
  }
}
async function read() {
  close()
  try {
    await speech.speak(selection.value)
  } catch (error) {
    if ((error as Error).name !== 'AbortError')
      notifications.toast(
        error instanceof Error ? error.message : __t('ui.chat', '朗读失败'),
        'error',
      )
  }
}
function outside(event: PointerEvent) {
  if (!menu.value?.contains(event.target as Node)) close()
}
function key(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    close()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
watch(
  () => [props.streaming, props.identity],
  () => {
    close()
    speech.stop()
    const current = window.getSelection()
    if (props.streaming && current?.anchorNode && root.value?.contains(current.anchorNode))
      current.removeAllRanges()
  },
)
function detach() {
  document.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('scroll', close, true)
  window.removeEventListener('resize', close)
}
watch(
  open,
  (value) => {
    detach()
    if (!value) return
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
  },
  { flush: 'sync' },
)
onBeforeUnmount(detach)
onDeactivated(close)
</script>

<template>
  <div
    ref="root"
    class="reply-selection"
    :class="{ 'is-streaming': streaming }"
    @contextmenu="contextMenu"
  >
    <slot />
    <button v-if="speech.busy.value" type="button" class="selection-stop" @click="speech.stop">
      <PixelIcon name="square" size="xs" />
      {{ __t('ui.chat', '停止朗读') }}
    </button>
    <Teleport to="body">
      <Transition name="reply-menu">
        <div
          v-if="open"
          ref="menu"
          class="reply-selection-menu"
          :style="position"
          role="menu"
          :aria-label="__t('ui.chat', '选中文字')"
          tabindex="-1"
          @pointerdown.prevent
          @keydown="key"
        >
          <button type="button" role="menuitem" @click="copy">
            <PixelIcon name="copy" size="xs" />
            {{ __t('ui.chat', '复制') }}
          </button>
          <button type="button" role="menuitem" @click="read">
            <PixelIcon name="volume-2" size="xs" />
            {{ __t('ui.chat', '朗读') }}
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.reply-selection {
  user-select: text;
}
.reply-selection.is-streaming,
.reply-selection.is-streaming :deep(*) {
  user-select: none !important;
  -webkit-user-select: none !important;
}
.reply-selection-menu {
  position: fixed;
  z-index: 12000;
  width: 180px;
  padding: 5px;
  border: 1px solid var(--ui-border-default);
  border-radius: 10px;
  background: var(--ui-bg-surface);
  color: var(--ui-text-primary);
  box-shadow: 0 12px 38px #0003;
  outline: none;
}
.reply-selection-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font: 13px var(--ui-font-sans);
}
.reply-selection-menu button:hover,
.reply-selection-menu button:focus-visible {
  outline: none;
  color: var(--ui-accent-purple);
  background: var(--ui-bg-hover);
}
.selection-stop {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 10px;
  padding: 5px 9px;
  border: 1px solid var(--ui-border-default);
  border-radius: 6px;
  color: var(--ui-text-secondary);
  background: var(--ui-bg-surface);
  cursor: pointer;
  user-select: none;
}
.reply-menu-enter-active,
.reply-menu-leave-active {
  transition:
    opacity 0.12s,
    transform 0.16s ease;
}
.reply-menu-enter-from,
.reply-menu-leave-to {
  opacity: 0;
  transform: translateY(3px);
}
@media (prefers-reduced-motion: reduce) {
  .reply-menu-enter-active,
  .reply-menu-leave-active {
    transition: none;
  }
}
</style>
