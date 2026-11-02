<template>
  <a
    v-if="stars !== null"
    class="github-stars"
    href="https://github.com/YoKONCy/infOS"
    target="_blank"
    rel="noopener noreferrer"
    :aria-label="`GitHub Stars: ${formattedStars}`"
  >
    <PixelIcon name="star" :size="12" />
    <span>{{ formattedStars }}</span>
  </a>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PixelIcon from './PixelIcon.vue'

const stars = ref<number | null>(null)
const formattedStars = computed(() => stars.value?.toLocaleString('en-US') ?? '')
const cacheKey = 'infos-wiki-github-stars'
const cacheDuration = 60 * 60 * 1000
let request: AbortController | undefined

onMounted(async () => {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) ?? 'null')
    if (
      cached &&
      Number.isSafeInteger(cached.stars) &&
      cached.stars >= 0 &&
      Number.isFinite(cached.savedAt) &&
      cached.savedAt <= Date.now()
    ) {
      stars.value = cached.stars
      if (Date.now() - cached.savedAt < cacheDuration) return
    }
  } catch {
    // 缓存不可用时仍尝试读取公开接口。
  }

  request = new AbortController()
  try {
    const response = await fetch('https://api.github.com/repos/YoKONCy/infOS', {
      credentials: 'omit',
      signal: request.signal,
    })
    if (!response.ok) return
    const data = await response.json()
    if (!Number.isSafeInteger(data.stargazers_count) || data.stargazers_count < 0) return
    stars.value = data.stargazers_count
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ stars: stars.value, savedAt: Date.now() }))
    } catch {
      // 存储不可用时本次仍显示获取到的数量。
    }
  } catch {
    // 网络不可用或接口限流时保留原有 GitHub 入口和已缓存的数量。
  }
})

onUnmounted(() => request?.abort())
</script>

<style scoped>
.github-stars {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 4px;
  padding: 6px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wk-radius-sm);
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  transition: border-color 0.2s, color 0.2s;
}

.github-stars:hover {
  border-color: var(--wk-pink);
  color: var(--wk-pink-text);
}

.github-stars:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
</style>
