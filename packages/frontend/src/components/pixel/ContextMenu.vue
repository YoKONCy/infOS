<script setup lang="ts">
/**
 * ContextMenu — 像素风右键菜单
 *
 */
import { computed, ref, watch } from 'vue'
import { useEventListener } from '../../composables'
import { clampMenuPoint } from '../../lib/floatingPlacement'

export interface ContextMenuItem {
  label?: string
  action?: () => void
  type?: 'item' | 'separator'
  disabled?: boolean
  shortcut?: string
}

interface Props {
  visible: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  action: [item: ContextMenuItem]
}>()

const menuRef = ref<HTMLElement | null>(null)
const position = ref({ x: props.x, y: props.y })
const menuStyle = computed(() => ({ top: `${position.value.y}px`, left: `${position.value.x}px` }))

// 贴近窗口右下角右键时，把菜单推回视口内；用布局尺寸，不受入场缩放动画影响。
watch(
  () => [props.visible, props.x, props.y, props.items],
  () => {
    position.value = { x: props.x, y: props.y }
    if (!props.visible || !menuRef.value) return
    position.value = clampMenuPoint({
      x: props.x,
      y: props.y,
      width: menuRef.value.offsetWidth,
      height: menuRef.value.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
  },
  { flush: 'post', immediate: true },
)

function handleClick(item: ContextMenuItem) {
  if (item.disabled) return
  item.action?.()
  emit('close')
}

function close() {
  emit('close')
}

// 点击/右键/Esc 关闭
useEventListener(window, 'click', close)
useEventListener(window, 'contextmenu', close)
useEventListener(window, 'keydown', ((e: KeyboardEvent) => {
  if (e.key === 'Escape') close()
}) as (e: Event) => void)
</script>

<template>
  <Teleport to="body">
    <Transition name="ctx-menu">
      <div
        v-if="visible"
        ref="menuRef"
        class="p-context-menu"
        :style="menuStyle"
        @click.stop
        @contextmenu.prevent
      >
        <template v-for="(item, idx) in items" :key="idx">
          <div v-if="item.type === 'separator'" class="p-ctx-separator" />
          <button
            v-else
            :class="['p-ctx-item', { 'p-ctx-item-disabled': item.disabled }]"
            :disabled="item.disabled"
            @click="handleClick(item)"
          >
            <span>{{ item.label }}</span>
            <span v-if="item.shortcut" class="p-ctx-shortcut">{{ item.shortcut }}</span>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.p-context-menu {
  --ui-focus-color: var(--ui-accent-sky);
  position: fixed;
  z-index: 9999;
  min-width: 160px;
  max-width: min(360px, calc(100vw - 20px));
  transform-origin: top left;
  background: var(--dash-panel-elevated);
  border: 2px solid var(--ui-border-strong);
  box-shadow: var(--ui-shadow-md);
  padding: 4px 0;
}

.p-ctx-separator {
  height: 2px;
  background: var(--ui-border-default);
  margin: 4px 8px;
}

.p-ctx-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 700;
  background: none;
  border: none;
  color: var(--ui-text-primary);
  cursor: pointer;
  text-align: left;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard);
}
.p-ctx-item:focus-visible {
  outline-offset: -2px;
}
.p-ctx-item > span:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.p-ctx-item:hover:not(:disabled) {
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
}
.p-ctx-item-disabled {
  color: var(--ui-text-disabled);
  cursor: not-allowed;
}

.p-ctx-shortcut {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 10px;
  font-family: var(--ui-font-pixel);
  color: var(--ui-text-tertiary);
  margin-left: 16px;
}
.p-ctx-item:hover:not(:disabled) .p-ctx-shortcut {
  color: var(--ui-accent-sky);
}

/* 动画 */
.ctx-menu-enter-active {
  transition:
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}
.ctx-menu-leave-active {
  transition:
    opacity var(--ui-duration-instant) var(--ui-ease-standard),
    transform var(--ui-duration-instant) var(--ui-ease-standard);
}
.ctx-menu-enter-from,
.ctx-menu-leave-to {
  opacity: 0;
  transform: scale(0.98);
}
</style>
