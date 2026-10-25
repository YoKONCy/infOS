<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import '@infos/shared/i18n/catalogs/mediaPlayer'
import { t } from '../../i18n'
import { PixelIcon } from '../pixel'
import { useMediaPlayer } from '../../composables/resources/useMediaPlayer'
import ResourceMediaControls from './ResourceMediaControls.vue'

const props = withDefaults(
  defineProps<{ src: string; name?: string; active?: boolean; compact?: boolean }>(),
  {
    name: '',
    active: true,
  },
)
const audio = ref<HTMLAudioElement | null>(null)
const controller = useMediaPlayer(
  audio,
  () => props.src,
  () => props.active,
  { background: true },
)
let detachAudio: (() => void) | undefined
onMounted(() => {
  // 播放源独立于 DOM，切换标签或 KeepAlive 缓存页面不影响音乐。
  const element = new Audio()
  element.preload = 'metadata'
  audio.value = element
  for (const [name, handler] of Object.entries(controller.events))
    element.addEventListener(name, handler)
  detachAudio = () => {
    for (const [name, handler] of Object.entries(controller.events))
      element.removeEventListener(name, handler)
  }
  element.src = props.src
})
watch(
  () => props.src,
  (value) => {
    if (audio.value) audio.value.src = value
  },
)
onBeforeUnmount(() => {
  detachAudio?.()
  if (audio.value) {
    audio.value.removeAttribute('src')
    audio.value.load()
  }
})
const { state } = controller
const tr = (source: string) => t('ui.media-player', source)
const title = computed(() => props.name.replace(/\.[a-z0-9]{1,7}$/i, '') || tr('音频'))
const format = computed(() => props.name.match(/\.([a-z0-9]{1,7})$/i)?.[1]?.toUpperCase())
const status = computed(() =>
  tr(
    state.error
      ? '暂时无法播放'
      : state.waiting
        ? '缓冲中…'
        : state.playing
          ? '播放中'
          : state.position
            ? '已暂停'
            : '待播放',
  ),
)
</script>
<template>
  <section
    class="resource-audio resource-media"
    :class="{
      'is-playing': state.playing && !state.waiting,
      'has-error': state.error,
      'is-compact': compact,
    }"
    tabindex="0"
    :aria-label="name || tr('音频')"
    :aria-description="tr('播放快捷键：空格播放或暂停，方向键快进或后退，M静音')"
    @keydown="controller.keyboard"
  >
    <div class="resource-audio__head">
      <div class="resource-audio__art" aria-hidden="true">
        <span class="resource-audio__spark resource-audio__spark--one">✦</span>
        <span class="resource-audio__spark resource-audio__spark--two">✧</span>
        <div class="resource-audio__record">
          <span><PixelIcon name="heart" size="sm" /></span>
        </div>
        <span class="resource-audio__arm" />
        <span class="resource-audio__art-corner" />
      </div>
      <div class="resource-audio__info">
        <div class="resource-audio__eyebrow">
          <PixelIcon name="headphones" size="xs" />
          <span>{{ tr('音频') }}</span>
          <small v-if="format">{{ format }}</small>
        </div>
        <strong class="resource-audio__title" :title="name">{{ title }}</strong>
        <div class="resource-audio__status">
          <span class="resource-audio__equalizer" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>{{ status }}</span>
        </div>
      </div>
    </div>
    <ResourceMediaControls :controller="controller" :active="active" />
  </section>
</template>
<style scoped>
.resource-audio.is-compact {
  padding: 8px 10px 6px;
}
.is-compact .resource-audio__head {
  gap: 9px;
}
.is-compact .resource-audio__art {
  flex-basis: 58px;
  height: 58px;
}
.is-compact .resource-audio__record {
  width: 42px;
  height: 42px;
}
.is-compact .resource-audio__record > span {
  width: 17px;
  height: 17px;
}
.is-compact .resource-audio__arm {
  top: 6px;
  right: 5px;
  height: 25px;
}
.is-compact .resource-audio__title {
  font-size: 12px;
}
.resource-audio {
  position: relative;
  padding: 17px 16px 14px;
  background:
    radial-gradient(
      ellipse at 0 0,
      color-mix(in srgb, var(--media-accent) 11%, transparent),
      transparent 70%
    ),
    linear-gradient(
      145deg,
      transparent 55%,
      color-mix(in srgb, var(--ui-accent-purple) 5%, transparent)
    );
}
.resource-audio__head {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
  margin-bottom: 9px;
}
.resource-audio__art {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 84px;
  height: 84px;
  border: 1px solid color-mix(in srgb, var(--media-accent) 25%, var(--ui-border-subtle));
  border-radius: 10px 10px 3px 10px;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--media-accent) 14%, var(--ui-bg-surface)),
    color-mix(in srgb, var(--ui-accent-purple) 12%, var(--ui-bg-surface))
  );
  box-shadow: 2px 3px 0 color-mix(in srgb, var(--media-accent) 8%, transparent);
}
.resource-audio__record {
  display: grid;
  place-items: center;
  width: 60px;
  height: 60px;
  border: 1px solid color-mix(in srgb, var(--media-accent) 28%, var(--ui-border-strong));
  border-radius: 50%;
  background:
    repeating-radial-gradient(
      circle,
      transparent 0 3px,
      color-mix(in srgb, var(--media-accent) 12%, transparent) 4px 5px
    ),
    conic-gradient(
      from 35deg,
      var(--ui-bg-surface-soft),
      color-mix(in srgb, var(--media-accent) 23%, var(--ui-bg-surface)),
      var(--ui-bg-surface-soft),
      color-mix(in srgb, var(--ui-accent-purple) 17%, var(--ui-bg-surface)),
      var(--ui-bg-surface-soft)
    );
  animation: audio-record 12s linear infinite;
  animation-play-state: paused;
}
.resource-audio__record > span {
  display: grid;
  place-items: center;
  width: 23px;
  height: 23px;
  border: 1px solid color-mix(in srgb, var(--media-accent) 40%, transparent);
  border-radius: 50%;
  color: var(--media-accent);
  background: var(--ui-bg-surface);
}
.resource-audio__arm {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 14px;
  height: 34px;
  border-top: 3px solid var(--ui-text-tertiary);
  border-right: 3px solid var(--ui-text-tertiary);
  border-radius: 0 4px 0 0;
  transform: rotate(-18deg);
  transform-origin: top right;
  transition: transform 300ms ease;
}
.resource-audio__arm::after {
  position: absolute;
  right: -5px;
  bottom: -2px;
  width: 6px;
  height: 9px;
  border-radius: 2px;
  background: var(--media-accent);
  content: '';
}
.resource-audio__art-corner {
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 4px;
  height: 4px;
  background: var(--media-accent);
  box-shadow: -6px 0 color-mix(in srgb, var(--media-accent) 40%, transparent);
}
.resource-audio__spark {
  position: absolute;
  color: var(--media-accent);
  pointer-events: none;
}
.resource-audio__spark--one {
  top: -8px;
  left: -5px;
  font-size: 18px;
}
.resource-audio__spark--two {
  bottom: -7px;
  right: -5px;
  font-size: 15px;
  color: var(--ui-accent-purple);
}
.resource-audio__info {
  display: grid;
  gap: 7px;
  flex: 1;
  min-width: 0;
}
.resource-audio__eyebrow {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--media-accent);
  font-size: 10px;
}
.resource-audio__eyebrow small {
  margin-left: auto;
  padding: 2px 5px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 3px;
  color: var(--ui-text-tertiary);
  font: 9px var(--ui-font-mono);
  letter-spacing: 0.04em;
}
.resource-audio__title {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 600;
}
.resource-audio__status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.resource-audio__equalizer {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 12px;
  color: var(--media-accent);
}
.resource-audio__equalizer i {
  width: 2px;
  height: 4px;
  border-radius: 1px;
  background: currentColor;
  animation: audio-level 700ms ease-in-out infinite alternate;
  animation-play-state: paused;
}
.resource-audio__equalizer i:nth-child(2) {
  height: 10px;
  animation-delay: -350ms;
}
.resource-audio__equalizer i:nth-child(3) {
  height: 7px;
  animation-delay: -150ms;
}
.resource-audio__equalizer i:nth-child(4) {
  height: 5px;
  animation-delay: -500ms;
}
.is-playing .resource-audio__record,
.is-playing .resource-audio__equalizer i {
  animation-play-state: running;
}
.is-playing .resource-audio__arm {
  transform: rotate(7deg);
}
.is-playing .resource-audio__status {
  color: var(--media-accent);
}
.has-error .resource-audio__status {
  color: var(--ui-danger);
}
@keyframes audio-record {
  to {
    transform: rotate(360deg);
  }
}
@keyframes audio-level {
  to {
    transform: scaleY(0.45);
    opacity: 0.6;
  }
}
@container resource-player (max-width: 280px) {
  .resource-audio__head {
    gap: 12px;
  }
  .resource-audio__art {
    flex-basis: 68px;
    height: 68px;
  }
  .resource-audio__record {
    width: 48px;
    height: 48px;
  }
  .resource-audio__arm {
    top: 9px;
    right: 9px;
    height: 28px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .resource-audio__record,
  .resource-audio__equalizer i {
    animation: none;
  }
  .resource-audio__arm {
    transition: none;
  }
}
</style>
