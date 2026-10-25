<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WorkspacePreviewState } from './workspacePreview'
import WorkspaceFileGlyph from './WorkspaceFileGlyph.vue'

const props = defineProps<{
  src: string
  name: string
  kind: 'audio' | 'video'
  state: WorkspacePreviewState
  active: boolean
}>()
const emit = defineEmits<{
  error: [message: string]
  state: [patch: Partial<WorkspacePreviewState>]
  fullscreen: []
}>()
const media = ref<HTMLMediaElement | null>(null)
const playing = ref(false),
  waiting = ref(false),
  duration = ref(0),
  ready = ref(false)
const rate = ref(1)
const progress = computed(() =>
  duration.value ? Math.min(100, (props.state.position / duration.value) * 100) : 0,
)
function time(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const hours = Math.floor(seconds / 3600)
  return `${hours ? `${hours}:` : ''}${hours ? String(Math.floor(seconds / 60) % 60).padStart(2, '0') : Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function metadata() {
  const element = media.value
  if (!element) return
  duration.value = Number.isFinite(element.duration) ? element.duration : 0
  element.volume = props.state.volume
  element.muted = props.state.muted
  if (duration.value && props.state.position > 0)
    element.currentTime = Math.min(props.state.position, Math.max(0, duration.value - 0.1))
  ready.value = true
}
async function toggle() {
  if (!media.value || !props.active) return
  if (!media.value.paused) return media.value.pause()
  try {
    await media.value.play()
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError'))
      emit('error', __t('ui.workspace', '无法播放该文件，可用系统应用打开'))
  }
}
function seek(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (media.value && Number.isFinite(value)) {
    media.value.currentTime = value
    emit('state', { position: value })
  }
}
function volume(event: Event) {
  const volume = Number((event.target as HTMLInputElement).value)
  emit('state', { volume, muted: false })
  if (media.value) {
    media.value.volume = volume
    media.value.muted = false
  }
}
function mute() {
  const muted = !props.state.muted
  emit('state', { muted })
  if (media.value) media.value.muted = muted
}
watch(
  () => props.active,
  (active) => {
    // 音频继续在后台播放；只有视频随文件、页面与窗口可见性暂停。
    if (!active && props.kind === 'video') media.value?.pause()
  },
)
watch(rate, () => {
  if (media.value) media.value.playbackRate = rate.value
})
watch(
  () => props.src,
  (source) => {
    if (props.kind !== 'audio' || !media.value) return
    media.value.pause()
    ready.value = false
    waiting.value = false
    duration.value = 0
    media.value.src = source
  },
)
let detachAudio: (() => void) | undefined
onMounted(() => {
  if (props.kind !== 'audio') return
  // 音频不依附页面 DOM，KeepAlive 移走工作区节点时也不会被浏览器中断。
  const audio = new Audio()
  audio.preload = 'metadata'
  media.value = audio
  const handlers: Record<string, EventListener> = {
    loadedmetadata: metadata,
    timeupdate: () => emit('state', { position: audio.currentTime || 0 }),
    play: () => {
      playing.value = true
    },
    pause: () => {
      playing.value = false
    },
    ended: () => {
      playing.value = false
    },
    waiting: () => {
      waiting.value = true
    },
    playing: () => {
      waiting.value = false
    },
    canplay: () => {
      waiting.value = false
    },
    error: () => emit('error', __t('ui.workspace', '当前文件或编码无法播放，可用系统应用打开')),
  }
  for (const [name, handler] of Object.entries(handlers)) audio.addEventListener(name, handler)
  detachAudio = () => {
    for (const [name, handler] of Object.entries(handlers)) audio.removeEventListener(name, handler)
  }
  audio.src = props.src
})
onBeforeUnmount(() => {
  detachAudio?.()
  const element = media.value
  if (element) {
    element.pause()
    element.removeAttribute('src')
    element.load()
  }
})
</script>
<template>
  <div
    class="workspace-media"
    :class="{ 'workspace-media--audio': kind === 'audio', 'workspace-media--inactive': !active }"
  >
    <div class="workspace-media__stage" @dblclick="kind === 'video' && emit('fullscreen')">
      <video
        v-if="kind === 'video'"
        ref="media"
        :src="src"
        preload="metadata"
        playsinline
        :aria-label="name"
        @loadedmetadata="metadata"
        @timeupdate="emit('state', { position: media?.currentTime || 0 })"
        @play="
          () => {
            playing = true
            if (!active) media?.pause()
          }
        "
        @pause="playing = false"
        @ended="playing = false"
        @waiting="waiting = true"
        @playing="waiting = false"
        @canplay="waiting = false"
        @error="emit('error', __t('ui.workspace', '当前文件或编码无法播放，可用系统应用打开'))"
        @click="toggle"
      />
      <div v-if="kind === 'audio'" class="workspace-media__album" :class="{ playing }">
        <div class="workspace-media__emblem"><WorkspaceFileGlyph kind="audio" /></div>
        <strong>{{ name }}</strong>
        <div class="workspace-media__bars" aria-hidden="true">
          <i
            v-for="index in 24"
            :key="index"
            :style="{ '--height': `${12 + ((index * 13) % 30)}px`, '--delay': `${index * 41}ms` }"
          />
        </div>
      </div>
      <span v-if="waiting" class="workspace-media__waiting">
        {{ __t('ui.workspace', '缓冲中…') }}
      </span>
    </div>
    <div class="workspace-media__timeline">
      <span :style="{ width: `${progress}%` }" />
      <input
        type="range"
        min="0"
        :max="duration || 1"
        step="0.1"
        :value="state.position"
        :disabled="!duration"
        :aria-label="__t('ui.workspace', '播放进度')"
        @input="seek"
      />
    </div>
    <div class="file-view-controls">
      <button
        type="button"
        class="workspace-media__play"
        :disabled="!ready || !active"
        :aria-label="playing ? __t('ui.workspace', '暂停') : __t('ui.workspace', '播放')"
        @click="toggle"
      >
        <svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
          <path
            :d="playing ? 'M3 3h3v10H3z M9 3h3v10H9z' : 'M4 2h2v2h2v2h2v4H8v2H6v2H4z'"
            fill="currentColor"
          />
        </svg>
      </button>
      <time>{{ time(state.position) }} / {{ time(duration) }}</time>
      <span class="file-view-spacer" />
      <button
        type="button"
        :aria-label="state.muted ? __t('ui.workspace', '取消静音') : __t('ui.workspace', '静音')"
        @click="mute"
      >
        {{
          state.muted || !state.volume ? __t('ui.workspace', '静音') : __t('ui.workspace', '音量')
        }}
      </button>
      <input
        class="workspace-media__volume"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="state.muted ? 0 : state.volume"
        :aria-label="__t('ui.workspace', '音量')"
        @input="volume"
      />
      <select v-model.number="rate" :aria-label="__t('ui.workspace', '播放速度')">
        <option :value="0.5">0.5×</option>
        <option :value="1">1×</option>
        <option :value="1.5">1.5×</option>
        <option :value="2">2×</option>
      </select>
    </div>
  </div>
</template>
<style scoped>
.workspace-media {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--ui-bg-surface-soft);
}
.workspace-media__stage {
  position: relative;
  display: grid;
  min-height: 0;
  flex: 1;
  place-items: center;
  overflow: hidden;
  background: #080d15;
}
.workspace-media__stage video {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
}
.workspace-media--audio .workspace-media__stage {
  background:
    radial-gradient(ellipse at center, var(--ui-accent-sky-soft), transparent 68%),
    var(--ui-bg-surface-soft);
}
.workspace-media__album {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 20px;
  padding: 24px;
  max-width: 100%;
}
.workspace-media__emblem {
  display: grid;
  width: 88px;
  height: 88px;
  place-items: center;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
  box-shadow:
    inset 2px 2px color-mix(in srgb, white 16%, transparent),
    inset -2px -2px var(--ui-border-subtle),
    3px 4px 0 var(--ui-border-subtle);
}
.workspace-media__emblem :deep(svg) {
  width: 42px;
  height: 42px;
}
.workspace-media__album strong {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-primary);
  font:
    14px var(--font-pixel),
    monospace;
}
.workspace-media__bars {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 42px;
}
.workspace-media__bars i {
  width: 4px;
  height: var(--height);
  background: color-mix(in srgb, var(--ui-accent-sky) 35%, var(--ui-border-subtle));
}
.playing .workspace-media__bars i {
  animation: workspace-wave 950ms steps(4, end) var(--delay) infinite alternate;
}
.workspace-media--inactive .workspace-media__bars i {
  animation-play-state: paused;
}
.workspace-media__waiting {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 5px 9px;
  background: #111c2bcc;
  color: #dcecf8;
  font: 10px var(--ui-font-mono);
}
.workspace-media__timeline {
  position: relative;
  height: 7px;
  flex-shrink: 0;
  background: var(--ui-border-subtle);
}
.workspace-media__timeline > span {
  display: block;
  height: 100%;
  background: var(--ui-accent-sky);
  pointer-events: none;
}
.workspace-media__timeline input {
  position: absolute;
  inset: -4px 0;
  width: 100%;
  height: 15px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.workspace-media__timeline:focus-within {
  outline: 1px solid var(--ui-accent-sky);
  outline-offset: 2px;
}
.workspace-media__play svg {
  display: block;
  width: 16px;
  height: 16px;
}
.workspace-media__volume {
  width: 65px;
}
@keyframes workspace-wave {
  to {
    transform: scaleY(0.4);
    opacity: 0.65;
  }
}
@media (prefers-reduced-motion: reduce) {
  .playing .workspace-media__bars i {
    animation: none;
  }
}
</style>
