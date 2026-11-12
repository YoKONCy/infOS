<script setup lang="ts">
import { ref, watch } from 'vue'
import type { WallpaperToneMetrics } from '../../composables/ui/useAppBackground'

const DEFAULT_METRICS: WallpaperToneMetrics = {
  tone: 'balanced',
  luma: 0.52,
  contrast: 0.2,
}

const props = defineProps<{ src: string }>()
const emit = defineEmits<{
  ready: [src: string]
  error: [src: string]
  tone: [metrics: WallpaperToneMetrics]
}>()
const ready = ref(false)
const metrics = ref<WallpaperToneMetrics>({ ...DEFAULT_METRICS })

watch(
  () => props.src,
  () => {
    ready.value = false
    metrics.value = { ...DEFAULT_METRICS }
  },
  { flush: 'sync' },
)

/** 在极小离屏画布上做单次亮度采样，为浅色/深色壁纸叠加智能测光保护纱提供光学参数。 */
function sampleWallpaperTone(image: HTMLImageElement): WallpaperToneMetrics {
  try {
    const size = 24
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return { ...DEFAULT_METRICS }
    context.drawImage(image, 0, 0, size, size)
    const { data } = context.getImageData(0, 0, size, size)
    let sum = 0
    let sumSq = 0
    let count = 0
    for (let index = 0; index < data.length; index += 4) {
      const alpha = (data[index + 3] ?? 255) / 255
      if (alpha < 0.05) continue
      const r = data[index] ?? 128
      const g = data[index + 1] ?? 128
      const b = data[index + 2] ?? 128
      const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      sum += y
      sumSq += y * y
      count++
    }
    if (count === 0) return { ...DEFAULT_METRICS }
    const luma = sum / count
    const variance = Math.max(0, sumSq / count - luma * luma)
    const contrast = Math.sqrt(variance)
    const tone = luma < 0.38 ? 'dark' : luma > 0.76 ? 'bright' : 'balanced'
    return { tone, luma: Number(luma.toFixed(3)), contrast: Number(contrast.toFixed(3)) }
  } catch {
    return { ...DEFAULT_METRICS }
  }
}

function handleLoad(event: Event): void {
  const target = event.target as HTMLImageElement
  if (target.getAttribute('src') !== props.src) return
  const sampled = sampleWallpaperTone(target)
  metrics.value = sampled
  ready.value = true
  emit('tone', sampled)
  emit('ready', props.src)
}

function handleError(event: Event): void {
  if ((event.target as HTMLImageElement).getAttribute('src') !== props.src) return
  ready.value = false
  metrics.value = { ...DEFAULT_METRICS }
  emit('error', props.src)
}
</script>

<template>
  <div
    class="app-wallpaper"
    :class="{ 'app-wallpaper--ready': ready }"
    :data-tone="metrics.tone"
    aria-hidden="true"
  >
    <img :key="src" :src="src" alt="" draggable="false" @load="handleLoad" @error="handleError" />
    <div class="app-wallpaper__scrim" :data-tone="metrics.tone" />
    <div class="app-wallpaper__veil" />
  </div>
</template>

<style scoped>
.app-wallpaper {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  isolation: isolate;
  pointer-events: none;
  user-select: none;
  visibility: hidden;
}
.app-wallpaper--ready {
  visibility: visible;
}
.app-wallpaper img {
  position: absolute;
  inset: calc(var(--app-image-blur, 0px) * -2);
  width: calc(100% + var(--app-image-blur, 0px) * 4);
  height: calc(100% + var(--app-image-blur, 0px) * 4);
  max-width: none;
  object-fit: var(--app-image-fit, cover);
  object-position: var(--app-image-position, 50% 50%);
  opacity: var(--app-image-opacity, 1);
  filter: blur(var(--app-image-blur, 0px)) brightness(var(--app-image-brightness, 1))
    saturate(var(--app-image-saturation, 1)) contrast(var(--app-image-contrast, 1));
}
/* 智能测光保护纱：浅色下柔化深色插画防脏灰、拉开极亮插画边界；深色下压暗刺眼亮图护眼。 */
.app-wallpaper__scrim {
  position: absolute;
  inset: 0;
  background: rgb(246 249 255 / 7%);
}
.app-wallpaper__scrim[data-tone='dark'] {
  background: linear-gradient(180deg, rgb(246 249 255 / 18%) 0%, rgb(238 244 255 / 26%) 100%);
}
.app-wallpaper__scrim[data-tone='bright'] {
  background: linear-gradient(180deg, rgb(224 232 245 / 11%) 0%, rgb(212 222 238 / 17%) 100%);
}
:global([data-theme='dark']) .app-wallpaper__scrim {
  background: rgb(8 10 18 / 10%);
}
:global([data-theme='dark']) .app-wallpaper__scrim[data-tone='dark'] {
  background: transparent;
}
:global([data-theme='dark']) .app-wallpaper__scrim[data-tone='bright'] {
  background: linear-gradient(180deg, rgb(8 10 18 / 28%) 0%, rgb(8 10 18 / 36%) 100%);
}
.app-wallpaper__veil {
  position: absolute;
  inset: 0;
  background: color-mix(
    in oklab,
    var(--ui-bg-canvas) calc(var(--app-image-overlay, 0.18) * 100%),
    transparent
  );
}
</style>
