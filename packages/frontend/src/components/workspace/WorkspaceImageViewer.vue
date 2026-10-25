<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WorkspacePreviewState } from './workspacePreview'
import './workspace-file-preview.css'
const props = withDefaults(
  defineProps<{
    src: string
    name: string
    state: WorkspacePreviewState
    active: boolean
    allowExpand?: boolean
  }>(),
  { allowExpand: true },
)
const emit = defineEmits<{
  error: [message: string]
  state: [patch: Partial<WorkspacePreviewState>]
}>()
const stage = ref<HTMLElement | null>(null)
const root = ref<HTMLElement | null>(null)
const width = ref(0),
  height = ref(0),
  areaWidth = ref(0),
  areaHeight = ref(0)
const checker = ref(true)
const dragging = ref(false)
const loaded = ref(false)
const expanded = ref(false)
const zoomLevel = ref(props.state.zoom)
const panX = ref(props.state.panX ?? 0)
const panY = ref(props.state.panY ?? 0)
const fitScale = computed(() =>
  Math.min(
    1,
    Math.max(1, areaWidth.value - 48) / Math.max(1, width.value),
    Math.max(1, areaHeight.value - 48) / Math.max(1, height.value),
  ),
)
const scale = computed(() => zoomLevel.value || fitScale.value)
const imageStyle = computed(() => ({
  width: `${width.value * scale.value}px`,
  height: `${height.value * scale.value}px`,
  transform: `translate(-50%, -50%) translate(${panX.value}px, ${panY.value}px)`,
}))
let observer: ResizeObserver | undefined
let frame: number | undefined
let drag: { id: number; x: number; y: number; panX: number; panY: number } | undefined
const pointers = new Map<number, { x: number; y: number }>()
let pinch:
  | { distance: number; scale: number; x: number; y: number; panX: number; panY: number }
  | undefined

watch(
  () => [props.state.zoom, props.state.panX, props.state.panY],
  () => {
    zoomLevel.value = props.state.zoom
    panX.value = props.state.panX ?? 0
    panY.value = props.state.panY ?? 0
  },
)
watch(
  () => props.src,
  () => {
    stopPan()
    loaded.value = false
    width.value = 0
    height.value = 0
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  },
)
watch(expanded, () => {
  stopPan()
  void nextTick(() => stage.value?.focus({ preventScroll: true }))
})
watch(
  () => props.active,
  (active) => {
    if (active) return
    stopPan()
    expanded.value = false
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  },
)
function publishCamera() {
  if (frame !== undefined) return
  // 连续滚轮与指针事件合并到一帧，避免把高频拖动逐次传遍工作区组件树。
  frame = requestAnimationFrame(() => {
    frame = undefined
    emit('state', { zoom: zoomLevel.value, panX: panX.value, panY: panY.value })
  })
}
function imageLoaded(event: Event) {
  const image = event.target as HTMLImageElement
  width.value = image.naturalWidth
  height.value = image.naturalHeight
  loaded.value = true
}
function zoomAt(value: number, clientX?: number, clientY?: number) {
  if (!loaded.value || !props.active || !stage.value) return
  stopPan()
  const bounds = stage.value.getBoundingClientRect()
  const x = clientX === undefined ? 0 : clientX - bounds.left - areaWidth.value / 2
  const y = clientY === undefined ? 0 : clientY - bounds.top - areaHeight.value / 2
  const next = Math.min(32, Math.max(0.01, value))
  const ratio = next / scale.value
  // 维持鼠标下的图片位置，不以左上角为基准把观察区域甩出视野。
  panX.value = x - (x - panX.value) * ratio
  panY.value = y - (y - panY.value) * ratio
  zoomLevel.value = next
  publishCamera()
}
function wheel(event: WheelEvent) {
  if (!event.deltaY) return
  const pixels =
    event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? areaHeight.value : 1)
  zoomAt(
    scale.value * Math.exp(-Math.max(-120, Math.min(120, pixels)) * 0.002),
    event.clientX,
    event.clientY,
  )
}
function reset(actualSize = false) {
  stopPan()
  zoomLevel.value = actualSize ? 1 : 0
  panX.value = 0
  panY.value = 0
  publishCamera()
}
function pan(event: PointerEvent) {
  if (![0, 1].includes(event.button) || !loaded.value || !props.active || !stage.value) return
  event.preventDefault()
  if (!pointers.size) stopPan()
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  stage.value.focus({ preventScroll: true })
  stage.value.setPointerCapture(event.pointerId)
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const bounds = stage.value.getBoundingClientRect()
    pinch = {
      distance: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)),
      scale: scale.value,
      x: (a!.x + b!.x) / 2 - bounds.left - areaWidth.value / 2,
      y: (a!.y + b!.y) / 2 - bounds.top - areaHeight.value / 2,
      panX: panX.value,
      panY: panY.value,
    }
    drag = undefined
    dragging.value = true
    return
  }
  if (pointers.size > 2) return
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panX: panX.value,
    panY: panY.value,
  }
  dragging.value = true
}
function move(event: PointerEvent) {
  if (pointers.has(event.pointerId))
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pinch && stage.value && pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    const bounds = stage.value.getBoundingClientRect()
    const next = Math.min(
      32,
      Math.max(0.01, (pinch.scale * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.distance),
    )
    const ratio = next / pinch.scale
    panX.value =
      (a!.x + b!.x) / 2 - bounds.left - areaWidth.value / 2 - (pinch.x - pinch.panX) * ratio
    panY.value =
      (a!.y + b!.y) / 2 - bounds.top - areaHeight.value / 2 - (pinch.y - pinch.panY) * ratio
    zoomLevel.value = next
    publishCamera()
    return
  }
  if (!drag || event.pointerId !== drag.id) return
  panX.value = drag.panX + event.clientX - drag.x
  panY.value = drag.panY + event.clientY - drag.y
  publishCamera()
}
function stopPan(event?: PointerEvent) {
  if (event && !pointers.has(event.pointerId)) return
  const ids = event ? [event.pointerId] : [...pointers.keys()]
  for (const id of ids) pointers.delete(id)
  pinch = undefined
  drag = undefined
  dragging.value = false
  for (const id of ids)
    if (stage.value?.hasPointerCapture(id)) stage.value.releasePointerCapture(id)
  const first = [...pointers.entries()][0]
  if (first) {
    drag = { id: first[0], x: first[1].x, y: first[1].y, panX: panX.value, panY: panY.value }
    dragging.value = true
  }
}
function keyboard(event: KeyboardEvent) {
  if (!loaded.value || !props.active) return
  if (event.key === '+' || event.key === '=') zoomAt(scale.value * 1.2)
  else if (event.key === '-') zoomAt(scale.value / 1.2)
  else if (event.key === '0') reset()
  else if (event.key === '1') reset(true)
  else if (event.key.startsWith('Arrow')) {
    if (event.key === 'ArrowLeft') panX.value += 48
    if (event.key === 'ArrowRight') panX.value -= 48
    if (event.key === 'ArrowUp') panY.value += 48
    if (event.key === 'ArrowDown') panY.value -= 48
    publishCamera()
  } else return
  event.preventDefault()
  event.stopPropagation()
}
function leaveExpanded(event: KeyboardEvent) {
  if (!expanded.value) return
  if (event.key === 'Tab') {
    const controls = root.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [tabindex="0"]',
    )
    const first = controls?.[0]
    const last = controls?.[controls.length - 1]
    if (
      first &&
      last &&
      (event.shiftKey ? document.activeElement === first : document.activeElement === last)
    ) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
    return
  }
  if (event.key !== 'Escape') return
  // 优先退出全屏观察，再次按 Esc 才关闭外层图片弹窗。
  expanded.value = false
  event.preventDefault()
  event.stopImmediatePropagation()
}
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) {
      areaWidth.value = entry.contentRect.width
      areaHeight.value = entry.contentRect.height
    }
  })
  if (stage.value) observer.observe(stage.value)
  window.addEventListener('keydown', leaveExpanded, true)
})
onBeforeUnmount(() => {
  stopPan()
  if (frame !== undefined) cancelAnimationFrame(frame)
  observer?.disconnect()
  window.removeEventListener('keydown', leaveExpanded, true)
})
</script>
<template>
  <Teleport to="body" :disabled="!expanded">
    <div
      ref="root"
      class="workspace-image"
      :class="{ 'workspace-image--expanded': expanded }"
      :role="expanded ? 'dialog' : undefined"
      :aria-modal="expanded ? true : undefined"
      :aria-label="expanded ? name : undefined"
    >
      <div class="file-view-controls">
        <div class="file-view-control-group">
          <button
            type="button"
            :title="__t('ui.workspace', '缩小')"
            :aria-label="__t('ui.workspace', '缩小')"
            :disabled="!loaded"
            @click="zoomAt(scale / 1.2)"
          >
            −
          </button>
          <span>{{ Math.round(scale * 100) }}%</span>
          <button
            type="button"
            :title="__t('ui.workspace', '放大')"
            :aria-label="__t('ui.workspace', '放大')"
            :disabled="!loaded"
            @click="zoomAt(scale * 1.2)"
          >
            ＋
          </button>
        </div>
        <button type="button" :class="{ selected: !zoomLevel }" @click="reset()">
          {{ __t('ui.workspace', '适应窗口') }}
        </button>
        <button type="button" :class="{ selected: zoomLevel === 1 }" @click="reset(true)">
          1:1
        </button>
        <button type="button" :aria-pressed="checker" @click="checker = !checker">
          {{ __t('ui.workspace', '透明底') }}
        </button>
        <button type="button" @click="reset()">{{ __t('ui.workspace', '复位') }}</button>
        <button
          v-if="allowExpand !== false"
          type="button"
          :aria-pressed="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? __t('ui.workspace', '退出全屏') : __t('ui.workspace', '全屏观察') }}
        </button>
        <span class="file-view-spacer" />
        <small v-if="loaded">{{ width }} × {{ height }}</small>
      </div>
      <div
        ref="stage"
        class="workspace-image__stage"
        :class="{ checker, dragging }"
        tabindex="0"
        role="region"
        :aria-label="__t('ui.workspace', '{0}，双指或滚轮缩放，拖动平移，双击切换原始尺寸', [name])"
        @pointerdown="pan"
        @pointermove="move"
        @pointerup="stopPan"
        @pointercancel="stopPan"
        @lostpointercapture="stopPan"
        @wheel.prevent.stop="wheel"
        @dblclick.prevent="reset(zoomLevel !== 1)"
        @keydown="keyboard"
      >
        <img
          v-if="active"
          :src="src"
          :alt="name"
          draggable="false"
          :style="imageStyle"
          @load="imageLoaded"
          @error="emit('error', __t('ui.workspace', '图片无法显示，请重新载入或用系统应用打开'))"
        />
      </div>
      <div class="workspace-image__hint">
        {{ __t('ui.workspace', '双指或滚轮缩放 · 拖动平移 · 双击 1:1 / 适应 · 0 复位') }}
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
.workspace-image {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
.workspace-image--expanded {
  position: fixed;
  inset: 0;
  z-index: 10020;
  background: var(--ui-bg-surface);
}
.workspace-image__stage {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  overscroll-behavior: contain;
  background: var(--ui-bg-surface-soft);
  touch-action: none;
  cursor: grab;
}
.workspace-image__stage.dragging {
  cursor: grabbing;
}
.workspace-image__stage.checker {
  background-image: conic-gradient(
    var(--ui-border-subtle) 25%,
    transparent 0 50%,
    var(--ui-border-subtle) 0 75%,
    transparent 0
  );
  background-size: 16px 16px;
}
.workspace-image__stage:focus-visible {
  outline: 1px solid var(--ui-accent-sky);
  outline-offset: -2px;
}
.workspace-image__stage img {
  position: absolute;
  left: 50%;
  top: 50%;
  display: block;
  max-width: none;
  max-height: none;
  user-select: none;
  pointer-events: none;
  box-shadow: 1px 2px 0 color-mix(in srgb, var(--ui-text-primary) 12%, transparent);
}
.workspace-image__hint {
  flex-shrink: 0;
  padding: 6px 10px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
  border-top: 1px solid var(--ui-border-subtle);
}
</style>
