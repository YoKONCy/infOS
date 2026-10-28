<script setup lang="ts">
import {
  computed,
  inject,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue'
import type { BrowserObserverFrame, BrowserObserverSession } from '@infos/shared'
import { browserObserverApi } from '../../api/modules/browserObserverApi'
import { getWebServerOrigin } from '../../api/transport'
import { t } from '../../i18n'

const props = withDefaults(
  defineProps<{
    agentId: string
    threadId: string
    agentName?: string
    active?: boolean
    embedded?: boolean
  }>(),
  { active: true, embedded: false, agentName: '' },
)
const activated = ref(true)
const foreground = ref(typeof document !== 'undefined' && !document.hidden)
const mainVisible = inject('infos:main-surface-visible', ref(true))
const sessions = ref<BrowserObserverSession[]>([])
const selectedId = ref('')
const selectedManually = ref(false)
const visibilityStorageKey = 'infos.browserObserver.visibility'
function savedVisibility(): Map<string, boolean> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(visibilityStorageKey) ?? '[]')
    if (Array.isArray(value))
      return new Map(
        value
          .filter(
            (entry): entry is [string, boolean] =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'boolean',
          )
          .slice(-128),
      )
  } catch {
    /* 存储不可用时只保留窗口内状态。 */
  }
  return new Map()
}
const manualVisibility = reactive(savedVisibility())
const visibilityKey = (session: BrowserObserverSession) =>
  JSON.stringify([getWebServerOrigin(), session.agentId, session.threadId, session.taskId ?? null])
const selected = computed(
  () => sessions.value.find((item) => item.id === selectedId.value) ?? sessions.value[0],
)
const visible = computed(
  () =>
    !!selected.value &&
    (manualVisibility.get(visibilityKey(selected.value)) ?? selected.value.requestedVisible),
)
const running = computed(
  () =>
    activated.value &&
    foreground.value &&
    mainVisible.value &&
    props.active !== false &&
    !!props.threadId,
)
const frame = ref<BrowserObserverFrame>({ state: 'waiting' })
const image = ref('')
const rect = reactive({ x: 0, y: 0, width: 440, height: 320 })
const viewport = reactive({ width: 1024, height: 768 })
let positioned = false
let stopDiscovery: (() => void) | undefined
let stopFrames: (() => void) | undefined
let stopGesture: (() => void) | undefined

const status = computed(() => {
  if (!selected.value?.available || frame.value.state === 'paused')
    return t('ui.browser-observer', '画面已暂停，正在重连')
  if (frame.value.state === 'closed') return t('ui.browser-observer', '浏览器页面已关闭')
  if (frame.value.state === 'waiting') return t('ui.browser-observer', '等待浏览器画面')
  return t('ui.browser-observer', '只读实时画面')
})

function clampRect() {
  const maxWidth = Math.max(1, viewport.width - 16)
  const maxHeight = Math.max(1, viewport.height - 16)
  rect.width = Math.min(maxWidth, Math.max(Math.min(280, maxWidth), rect.width))
  rect.height = Math.min(maxHeight, Math.max(Math.min(200, maxHeight), rect.height))
  rect.x = Math.max(8, Math.min(rect.x, viewport.width - rect.width - 8))
  rect.y = Math.max(8, Math.min(rect.y, viewport.height - rect.height - 8))
}
function resizeViewport() {
  viewport.width = window.innerWidth
  viewport.height = window.innerHeight
  if (!positioned) {
    rect.x = viewport.width - rect.width - 24
    rect.y = Math.min(96, viewport.height / 5)
    positioned = true
  }
  clampRect()
}
function scale(factor: number) {
  rect.width *= factor
  rect.height *= factor
  clampRect()
}
function setVisible(value: boolean) {
  if (!selected.value) return
  const key = visibilityKey(selected.value)
  manualVisibility.delete(key)
  manualVisibility.set(key, value)
  while (manualVisibility.size > 128) manualVisibility.delete(manualVisibility.keys().next().value!)
  try {
    sessionStorage.setItem(visibilityStorageKey, JSON.stringify([...manualVisibility]))
  } catch {
    /* 存储不可用时只保留窗口内状态。 */
  }
}

/** 拖动与缩放只更新观看端矩形，没有向浏览器发送尺寸或输入的入口。 */
function startGesture(event: PointerEvent, direction = '') {
  if (event.button !== 0 || (!direction && (event.target as HTMLElement).closest('button, select')))
    return
  event.preventDefault()
  stopGesture?.()
  const start = { ...rect, xPointer: event.clientX, yPointer: event.clientY }
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return
    const dx = next.clientX - start.xPointer
    const dy = next.clientY - start.yPointer
    if (!direction) {
      rect.x = start.x + dx
      rect.y = start.y + dy
    } else {
      rect.width = start.width + (direction.includes('w') ? -dx : direction.includes('e') ? dx : 0)
      rect.height =
        start.height + (direction.includes('n') ? -dy : direction.includes('s') ? dy : 0)
      clampRect()
      if (direction.includes('w')) rect.x = start.x + start.width - rect.width
      if (direction.includes('n')) rect.y = start.y + start.height - rect.height
    }
    clampRect()
  }
  const end = (next: PointerEvent) => {
    if (next.pointerId === event.pointerId) stopGesture?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  stopGesture = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    stopGesture = undefined
  }
}

watch(
  [running, () => props.agentId, () => props.threadId],
  ([enabled]) => {
    stopDiscovery?.()
    sessions.value = []
    selectedId.value = ''
    selectedManually.value = false
    if (!enabled) return
    const agentId = props.agentId
    const threadId = props.threadId
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    stopDiscovery = () => {
      controller.abort()
      clearTimeout(timer)
    }
    const poll = async () => {
      try {
        const response = await browserObserverApi.sessions(
          agentId,
          threadId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(7_000)]),
        )
        if (controller.signal.aborted) return
        sessions.value = response.data ?? []
        if (!selectedManually.value || !sessions.value.some((item) => item.id === selectedId.value))
          selectedId.value = sessions.value[0]?.id ?? ''
      } catch {
        if (!controller.signal.aborted) {
          sessions.value = sessions.value.map((item) => ({ ...item, available: false }))
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1_500)
      }
    }
    void poll()
  },
  { immediate: true },
)

watch(
  [running, visible, () => selected.value?.id, () => selected.value?.available],
  () => {
    stopFrames?.()
    const session = selected.value
    image.value = ''
    frame.value = { state: 'waiting' }
    if (!running.value || !visible.value || !session?.available) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    stopFrames = () => {
      controller.abort()
      clearTimeout(timer)
    }
    const poll = async () => {
      try {
        const response = await browserObserverApi.frame(
          session.id,
          session.agentId,
          session.threadId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(7_000)]),
        )
        if (controller.signal.aborted) return
        frame.value = response.data ?? { state: 'paused' }
        if (frame.value.state === 'live' && frame.value.dataUri) image.value = frame.value.dataUri
        if (frame.value.state === 'closed') image.value = ''
      } catch {
        if (!controller.signal.aborted) frame.value = { state: 'paused' }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 750)
      }
    }
    void poll()
  },
  { immediate: true },
)

function visibilityChanged() {
  foreground.value = !document.hidden
}
onMounted(() => {
  resizeViewport()
  window.addEventListener('resize', resizeViewport)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onActivated(() => {
  activated.value = true
})
onDeactivated(() => {
  activated.value = false
  stopGesture?.()
})
onBeforeUnmount(() => {
  stopDiscovery?.()
  stopFrames?.()
  stopGesture?.()
  window.removeEventListener('resize', resizeViewport)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <Teleport to="body" :disabled="embedded">
    <template v-if="running && selected">
      <button
        v-if="!visible"
        type="button"
        class="browser-observer-launcher"
        @click="setVisible(true)"
      >
        {{ t('ui.browser-observer', '查看浏览器') }}
      </button>
      <section
        v-else
        class="browser-observer"
        role="region"
        :aria-label="t('ui.browser-observer', '浏览器旁观小窗')"
        :style="{
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        }"
      >
        <header class="browser-observer-header" @pointerdown="startGesture($event)">
          <strong>{{ t('ui.browser-observer', '浏览器旁观') }}</strong>
          <button
            type="button"
            :title="t('ui.browser-observer', '缩小小窗')"
            :aria-label="t('ui.browser-observer', '缩小小窗')"
            @click="scale(0.8)"
          >
            −
          </button>
          <button
            type="button"
            :title="t('ui.browser-observer', '放大小窗')"
            :aria-label="t('ui.browser-observer', '放大小窗')"
            @click="scale(1.25)"
          >
            +
          </button>
          <button
            type="button"
            :title="t('ui.browser-observer', '收起小窗')"
            :aria-label="t('ui.browser-observer', '收起小窗')"
            @click="setVisible(false)"
          >
            ×
          </button>
        </header>
        <div class="browser-observer-source">
          <span>{{ agentName || agentId }}</span>
          <select
            v-if="sessions.length > 1"
            v-model="selectedId"
            :aria-label="t('ui.browser-observer', '选择浏览器会话')"
            @change="selectedManually = true"
          >
            <option v-for="item in sessions" :key="item.id" :value="item.id">
              {{
                item.taskId
                  ? t('ui.browser-observer', '任务 {0}', [item.taskId])
                  : t('ui.browser-observer', '当前对话')
              }}
            </option>
          </select>
          <span v-else-if="selected.taskId">
            {{ t('ui.browser-observer', '任务 {0}', [selected.taskId]) }}
          </span>
        </div>
        <div
          class="browser-observer-screen"
          :class="{ 'is-paused': frame.state !== 'live' || !selected.available }"
        >
          <img
            v-if="image"
            :src="image"
            :alt="t('ui.browser-observer', 'Agent 浏览器的只读画面')"
            draggable="false"
          />
          <span
            v-if="frame.state !== 'live' || !selected.available"
            class="browser-observer-overlay"
            role="status"
          >
            {{ status }}
          </span>
        </div>
        <footer>
          <span :title="frame.url">{{ frame.title || status }}</span>
          <small>{{ t('ui.browser-observer', '只读') }}</small>
        </footer>
        <span
          v-for="direction in ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']"
          :key="direction"
          class="browser-observer-resize"
          :class="`resize-${direction}`"
          aria-hidden="true"
          @pointerdown="startGesture($event, direction)"
        />
      </section>
    </template>
  </Teleport>
</template>

<style scoped>
.browser-observer,
.browser-observer-launcher {
  position: fixed;
  z-index: 900;
  color: var(--ui-text-primary);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-strong);
  box-shadow: 4px 4px 0 rgb(0 0 0 / 25%);
  font: 12px/1.5 var(--ui-font-pixel);
}
.browser-observer {
  display: flex;
  flex-direction: column;
}
.browser-observer-launcher {
  right: 24px;
  bottom: 96px;
  padding: 8px 12px;
  cursor: pointer;
}
.browser-observer-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  background: var(--ui-bg-surface-soft);
  cursor: move;
  touch-action: none;
  user-select: none;
}
.browser-observer-header strong {
  flex: 1;
}
.browser-observer-header button {
  min-width: 28px;
  min-height: 28px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--ui-border-default);
  cursor: pointer;
}
.browser-observer-header button:hover {
  background: var(--ui-bg-hover);
}
.browser-observer-source {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 28px;
  padding: 0 8px;
}
.browser-observer-source span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-observer-source select {
  min-width: 0;
  flex: 1;
  color: inherit;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
}
.browser-observer-screen {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #111;
}
.browser-observer-screen img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}
.browser-observer-screen.is-paused img {
  opacity: 0.35;
}
.browser-observer-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 12px;
  text-align: center;
  color: #eee;
  background: rgb(0 0 0 / 25%);
}
footer {
  display: flex;
  gap: 8px;
  justify-content: space-between;
  padding: 4px 8px;
}
footer span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
footer small {
  flex-shrink: 0;
  color: var(--ui-text-secondary);
}
.browser-observer-resize {
  position: absolute;
  touch-action: none;
}
.resize-n,
.resize-s {
  left: 8px;
  right: 8px;
  height: 6px;
  cursor: ns-resize;
}
.resize-n {
  top: -3px;
}
.resize-s {
  bottom: -3px;
}
.resize-e,
.resize-w {
  top: 8px;
  bottom: 8px;
  width: 6px;
  cursor: ew-resize;
}
.resize-e {
  right: -3px;
}
.resize-w {
  left: -3px;
}
.resize-ne,
.resize-nw,
.resize-se,
.resize-sw {
  width: 12px;
  height: 12px;
}
.resize-ne {
  right: -3px;
  top: -3px;
  cursor: nesw-resize;
}
.resize-nw {
  left: -3px;
  top: -3px;
  cursor: nwse-resize;
}
.resize-se {
  right: -3px;
  bottom: -3px;
  cursor: nwse-resize;
}
.resize-sw {
  left: -3px;
  bottom: -3px;
  cursor: nesw-resize;
}
</style>
