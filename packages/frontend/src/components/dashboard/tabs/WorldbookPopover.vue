<script setup lang="ts">
/**
 * 世界书浮动菜单 — 锚定在触发元素下方并传送到 body，
 * 避免被条目表格的横向滚动容器裁剪；点击外部、滚动或按 Esc 时关闭。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    anchor: HTMLElement | null
    /** 菜单最小宽度；默认与触发元素同宽。 */
    minWidth?: number
  }>(),
  { minWidth: 0 },
)
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
const style = ref<Record<string, string>>({})

function place() {
  if (!props.anchor) return
  const rect = props.anchor.getBoundingClientRect()
  const width = Math.min(Math.max(rect.width, props.minWidth), window.innerWidth - 16)
  const viewport = window.visualViewport?.height || window.innerHeight
  const below = viewport - rect.bottom - 12
  const above = rect.top - 12
  const up = below < 220 && above > below
  style.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(140, Math.min(360, up ? above : below))}px`,
    ...(up
      ? { bottom: `${window.innerHeight - rect.top + 4}px` }
      : { top: `${rect.bottom + 4}px` }),
  }
}
function onPointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (panel.value?.contains(target) || props.anchor?.contains(target)) return
  emit('close')
}
function onScroll(event: Event) {
  // 菜单内部滚动列表时不关闭。
  if (panel.value?.contains(event.target as Node)) return
  emit('close')
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}
function bind(active: boolean) {
  if (active) {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeydown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
  } else {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', place)
  }
}
watch(
  () => props.open,
  async (open) => {
    bind(open)
    if (!open) return
    place()
    await nextTick()
    panel.value?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  },
  { immediate: true },
)
onBeforeUnmount(() => bind(false))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="wb-popover" :style="style" role="menu">
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.wb-popover {
  position: fixed;
  z-index: 10020;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dash-panel-elevated, var(--ui-bg-elevated));
  border: 2px solid var(--ui-border-strong);
  box-shadow: var(--ui-shadow-md);
  color: var(--ui-text-primary);
  font-size: 13px;
}
</style>
