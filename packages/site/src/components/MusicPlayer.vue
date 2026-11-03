<template>
  <aside class="music-player" :class="{ reduced, playing }" :aria-label="t('背景音乐播放器')">
    <audio
      ref="audio"
      :src="`${base}music/pocket-sized-sun.mp3`"
      preload="auto"
      loop
      @play="playing = true"
      @pause="playing = false"
      @timeupdate="updateTime"
      @loadedmetadata="updateTime"
      @durationchange="updateTime"
      @error="onError"
    ></audio>

    <Transition name="player">
      <div v-if="open" id="music-controls" class="panel">
        <div class="heading">
          <div class="turntable cover" aria-hidden="true">
            <span class="ear ear-left"></span><span class="ear ear-right"></span>
            <span class="vinyl"><span class="vinyl-label">♥</span></span>
            <span class="tonearm"></span><span class="sparkle">✦</span>
          </div>
          <div class="track">
            <span class="caption">{{ t('正在播放的音乐') }}</span>
            <strong>Pocket-Sized Sun</strong>
          </div>
          <button class="close" type="button" :aria-label="t('收起播放器')" @click="open = false">×</button>
        </div>

        <div class="timeline">
          <span>{{ formatTime(position) }}</span>
          <input
            type="range"
            min="0"
            :max="duration || 0"
            step="0.1"
            :value="position"
            :disabled="!duration"
            :aria-label="t('播放进度')"
            @input="seek"
          />
          <span>{{ formatTime(duration) }}</span>
        </div>

        <div class="controls">
          <button class="play" type="button" :aria-label="t(playing ? '暂停音乐' : '播放音乐')" @click="togglePlay">
            <svg v-if="playing" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15L19 12z" /></svg>
          </button>
          <label class="volume">
            <span aria-hidden="true">♫</span>
            <span class="sr-only">{{ t('音乐音量') }}</span>
            <input type="range" min="0" max="1" step="0.01" :value="volume" @input="setVolume" />
          </label>
          <span class="loop" :title="t('单曲循环')" :aria-label="t('单曲循环')">↻</span>
        </div>
        <p v-if="error" class="error" role="status">{{ t('音乐播放失败，请重试。') }}</p>
      </div>
    </Transition>

    <div class="dock" :class="{ playing, expanded: open }">
      <button class="launcher" type="button" :aria-label="t('背景音乐播放器')" :aria-expanded="open" aria-controls="music-controls" @click="togglePanel">
        <span class="turntable" aria-hidden="true">
          <span class="ear ear-left"></span><span class="ear ear-right"></span>
          <span class="vinyl"><span class="vinyl-label">♥</span></span>
          <span class="tonearm"></span><span class="sparkle">✦</span>
        </span>
        <span class="dock-copy">
          <span class="dock-caption">{{ t(blocked ? '点击播放音乐' : '背景音乐') }}</span>
          <span class="dock-title">Pocket-Sized Sun</span>
        </span>
        <span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
      </button>
      <button class="dock-play" type="button" :aria-label="t(playing ? '暂停音乐' : '播放音乐')" @click="togglePlay">
        <svg v-if="playing" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
        <svg v-else viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15L19 12z" /></svg>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { t } from '../i18n'

defineProps<{ reduced: boolean }>()

const base = import.meta.env.BASE_URL
const audio = ref<HTMLAudioElement | null>(null)
const open = ref(false)
const playing = ref(false)
const error = ref(false)
const blocked = ref(false)
let userPaused = false
const position = ref(0)
const duration = ref(0)
const volume = ref(0.35)

function updateTime() {
  const player = audio.value
  if (!player) return
  position.value = Number.isFinite(player.currentTime) ? player.currentTime : 0
  duration.value = Number.isFinite(player.duration) ? player.duration : 0
}

async function attemptPlay() {
  const player = audio.value
  if (!player) return
  error.value = false
  try {
    if (player.error) player.load()
    await player.play()
    blocked.value = false
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotAllowedError') blocked.value = true
    else if (cause instanceof DOMException && cause.name === 'AbortError' && userPaused) return
    else error.value = true
  }
}

function togglePlay() {
  const player = audio.value
  if (!player) return
  if (!player.paused) {
    userPaused = true
    blocked.value = false
    player.pause()
  } else {
    userPaused = false
    void attemptPlay()
  }
}

function togglePanel() {
  open.value = !open.value
  if (blocked.value && !userPaused) void attemptPlay()
}

function retryOnInteraction(event: Event) {
  if (!blocked.value || userPaused || !audio.value?.paused) return
  if (event.target instanceof Element && event.target.closest('.music-player')) return
  void attemptPlay()
}

function onError() {
  playing.value = false
  error.value = true
}

function seek(event: Event) {
  if (audio.value) audio.value.currentTime = Number((event.target as HTMLInputElement).value)
}

function setVolume(event: Event) {
  volume.value = Number((event.target as HTMLInputElement).value)
  if (audio.value) audio.value.volume = volume.value
}

function formatTime(seconds: number) {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

onMounted(() => {
  if (audio.value) audio.value.volume = volume.value
  document.addEventListener('pointerdown', retryOnInteraction)
  document.addEventListener('keydown', retryOnInteraction)
  void attemptPlay()
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', retryOnInteraction)
  document.removeEventListener('keydown', retryOnInteraction)
})
</script>

<style scoped>
.music-player {
  position: fixed;
  top: max(84px, calc(env(safe-area-inset-top) + 72px));
  right: max(20px, env(safe-area-inset-right));
  z-index: 55;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  color: var(--ink);
}
.dock {
  order: 0;
  display: flex;
  align-items: center;
  width: max-content;
  max-width: calc(100vw - 40px);
  gap: 0;
  padding: 6px;
  border: 2px solid rgba(255, 255, 255, 0.92);
  border-radius: 22px;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.96), color-mix(in srgb, var(--c-soft) 32%, #fff));
  box-shadow: 0 12px 32px rgba(32, 20, 80, 0.2), 0 3px 0 color-mix(in srgb, var(--c) 25%, #fff), inset 0 1px #fff;
  backdrop-filter: blur(16px);
}
.launcher { display: flex; align-items: center; gap: 0; text-align: left; transition: gap 0.25s ease; }
.turntable {
  --deck-size: 60px;
  position: relative;
  display: grid;
  place-items: center;
  flex: none;
  width: var(--deck-size);
  height: var(--deck-size);
  border: 2px solid #fff;
  border-radius: 16px;
  background: linear-gradient(145deg, var(--c-soft), #ffdeed);
  box-shadow: 0 4px 10px color-mix(in srgb, var(--c) 25%, transparent), inset 0 -3px 0 rgba(255, 255, 255, 0.45);
}
.ear {
  position: absolute;
  top: -7px;
  width: 14px;
  height: 14px;
  border: 2px solid #fff;
  border-radius: 3px 9px 3px 3px;
  background: #f5b7d2;
}
.ear-left { left: 3px; transform: rotate(-15deg); }
.ear-right { right: 3px; transform: rotate(15deg) scaleX(-1); }
.vinyl {
  position: relative;
  display: grid;
  place-items: center;
  width: 80%;
  height: 80%;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 50%;
  background: repeating-radial-gradient(circle, #3c345d 0 2px, #50466b 2px 3px, #3c345d 3px 5px);
  box-shadow: 0 2px 5px rgba(40, 24, 70, 0.28);
  animation: record-spin 2.8s linear infinite paused;
}
.playing .vinyl { animation-play-state: running; }
.vinyl::before {
  content: '';
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  background: conic-gradient(from 20deg, rgba(255, 255, 255, 0.46), transparent 42deg, transparent 360deg);
  pointer-events: none;
}
.vinyl::after {
  content: '✦';
  position: absolute;
  top: 3px;
  left: 50%;
  color: #ffe6a8;
  font-size: 11px;
  line-height: 1;
  transform: translateX(-50%);
  text-shadow: 0 1px 2px #3c345d;
}
.vinyl-label {
  position: relative;
  display: grid;
  place-items: center;
  width: 42%;
  height: 42%;
  color: #fff;
  border: 2px solid #fff8fc;
  border-radius: 50%;
  background: #f199bf;
  font-size: 7px;
  line-height: 1;
}
.tonearm {
  position: absolute;
  z-index: 1;
  top: 5px;
  right: 5px;
  width: 3px;
  height: 24px;
  border-radius: 3px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(40, 24, 70, 0.3);
  transform: rotate(16deg);
  transform-origin: 50% 2px;
  transition: transform 0.45s ease;
}
.tonearm::before, .tonearm::after { content: ''; position: absolute; left: 50%; transform: translateX(-50%); }
.tonearm::before { top: -2px; width: 7px; height: 7px; border-radius: 50%; background: var(--c-deep); }
.tonearm::after { bottom: -2px; width: 6px; height: 7px; border-radius: 2px; background: var(--c-deep); }
.playing .tonearm { transform: rotate(34deg); }
.sparkle { position: absolute; right: -5px; bottom: -5px; color: #f69ac4; font-size: 14px; text-shadow: 0 1px #fff; }
@keyframes record-spin { to { transform: rotate(360deg); } }
.reduced .vinyl { animation: none; }
.dock-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  visibility: hidden;
  transition: max-width 0.25s ease, opacity 0.2s ease, visibility 0.25s;
}
.dock-caption { color: var(--c-deep); font-size: 10px; font-weight: 800; letter-spacing: 0.04em; }
.dock-title { color: var(--ink); font-size: 12px; font-weight: 800; white-space: nowrap; }
.dock-play { display: grid; place-items: center; width: 0; height: 34px; overflow: hidden; opacity: 0; visibility: hidden; color: var(--c-deep); border: 0 solid #fff; border-radius: 50%; background: color-mix(in srgb, var(--c-soft) 65%, #fff); transition: width 0.25s ease, margin 0.25s ease, opacity 0.2s ease, visibility 0.25s; }
.dock-play:hover { background: var(--c-soft); }
.dock-play svg { width: 14px; height: 14px; }
.bars { display: flex; align-items: center; gap: 2px; height: 15px; max-width: 0; overflow: hidden; opacity: 0; visibility: hidden; transition: max-width 0.25s ease, opacity 0.2s ease, visibility 0.25s; }
.dock:is(:hover, :focus-within, .expanded) { gap: 7px; }
.dock:is(:hover, :focus-within, .expanded) .launcher { gap: 12px; }
.dock:is(:hover, :focus-within, .expanded) .dock-copy { max-width: 150px; opacity: 1; visibility: visible; }
.dock:is(:hover, :focus-within, .expanded) .bars { max-width: 16px; opacity: 1; visibility: visible; }
.dock:is(:hover, :focus-within, .expanded) .dock-play { width: 34px; margin-left: 3px; border-width: 1px; opacity: 1; visibility: visible; }
.bars i { width: 2px; height: 4px; border-radius: 3px; background: var(--c); }
.playing .bars i { animation: equalize 0.7s ease-in-out infinite alternate; }
.playing .bars i:nth-child(2) { animation-delay: -0.4s; }
.playing .bars i:nth-child(3) { animation-delay: -0.2s; }
.reduced .bars i { animation: none; }
@keyframes equalize { to { height: 14px; } }
.panel {
  order: 1;
  width: min(310px, calc(100vw - 40px));
  margin-top: 12px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.95);
  border-radius: 20px;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.98), color-mix(in srgb, var(--c-soft) 24%, #fff));
  box-shadow: 0 18px 45px rgba(27, 17, 77, 0.24);
  transform-origin: top right;
}
.heading, .controls, .timeline { display: flex; align-items: center; }
.heading { gap: 12px; }
.cover { --deck-size: 76px; }
.cover .tonearm { height: 30px; right: 7px; }
.cover .vinyl-label { font-size: 9px; }
.track { min-width: 0; flex: 1; }
.track strong { display: block; font-size: 14px; line-height: 1.35; }
.caption { display: block; margin-bottom: 4px; color: var(--c-deep); font-size: 11px; font-weight: 800; }
.close { align-self: flex-start; color: var(--c-deep); font-size: 24px; line-height: 1; }
.timeline { gap: 8px; margin: 16px 0 12px; color: var(--ink-2); font-size: 11px; font-variant-numeric: tabular-nums; }
input[type='range'] { min-width: 0; accent-color: var(--c); cursor: pointer; }
.timeline input { flex: 1; }
.controls { gap: 14px; }
.play { display: grid; place-items: center; flex: none; width: 40px; height: 40px; color: #fff; border-radius: 50%; background: linear-gradient(145deg, var(--c), var(--c-deep)); box-shadow: 0 4px 10px color-mix(in srgb, var(--c) 40%, transparent); }
.play svg { width: 18px; height: 18px; }
.volume { display: flex; align-items: center; gap: 8px; flex: 1; color: var(--c-deep); font-size: 18px; }
.volume input { flex: 1; width: 100%; }
.loop { color: var(--c-deep); font-size: 22px; font-weight: 800; }
.error { margin: 12px 0 0; color: #9b3058; font-size: 12px; }
.player-enter-active, .player-leave-active { transition: opacity 0.2s, transform 0.2s; }
.player-enter-from, .player-leave-to { opacity: 0; transform: translateY(-8px) scale(0.97); }
@media (max-width: 480px) { .music-player { top: max(76px, calc(env(safe-area-inset-top) + 64px)); right: max(12px, env(safe-area-inset-right)); } }
</style>
