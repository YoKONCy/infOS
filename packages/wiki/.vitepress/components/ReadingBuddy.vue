<template>
  <div v-if="mounted && enabled" class="reading-buddy" :class="`is-${companion.id}`">
    <div v-if="open" class="wk-bubble tail-down buddy-bubble">
      <span class="wk-bubble-name">
        {{ companion.name }}
        <PixelIcon name="heart" :size="9" />
      </span>
      <p :key="line" class="buddy-line">{{ line }}</p>
      <button type="button" class="buddy-close" aria-label="收起陪读气泡" @click="setOpen(false)">
        ×
      </button>
    </div>
    <button
      type="button"
      class="buddy-avatar"
      :class="{ hop }"
      :aria-label="open ? `戳一下 ${companion.name}` : `叫 ${companion.name} 回来陪读`"
      @click="poke"
    >
      <span class="wk-portrait">
        <img :src="withBase(companion.avatar)" alt="" width="44" height="44" />
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'
import PixelIcon from './PixelIcon.vue'
import { companions, pickLine, type CompanionId } from '../theme/characters'

/**
 * 文档右侧大纲底部的陪读小伙伴：随阅读进度换一句话，点头像会有回应。
 * 页面 frontmatter 可用 `buddy: penora` 换人，`buddy: false` 关闭。
 */
const STORAGE_KEY = 'wiki-reading-buddy-open'
type Stage = 'start' | 'middle' | 'end'

const { frontmatter } = useData()
const route = useRoute()

const mounted = ref(false)
const open = ref(true)
const line = ref('')
const hop = ref(false)
let stage: Stage = 'start'
let frame = 0
let hopTimer: ReturnType<typeof setTimeout> | undefined

const enabled = computed(() => frontmatter.value.buddy !== false)
const companion = computed(
  () => companions[frontmatter.value.buddy as CompanionId] ?? companions.pero,
)

function currentStage(): Stage {
  const max = document.documentElement.scrollHeight - window.innerHeight
  // 页面不足一屏半时不区分进度，直接视为已读完
  if (max < window.innerHeight * 0.5) return 'end'
  const ratio = window.scrollY / max
  if (ratio > 0.92) return 'end'
  if (ratio > 0.35) return 'middle'
  return 'start'
}

function say(next: Stage) {
  stage = next
  line.value = pickLine(companion.value.reading[next], line.value)
}

function onScroll() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const next = currentStage()
    if (next !== stage) say(next)
  })
}

function setOpen(value: boolean) {
  open.value = value
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // 隐私模式等环境下无法写入时忽略，只影响下次是否记住
  }
}

function poke() {
  if (!open.value) {
    setOpen(true)
    say(currentStage())
    return
  }
  line.value = pickLine(companion.value.pokes, line.value)
  hop.value = true
  clearTimeout(hopTimer)
  hopTimer = setTimeout(() => (hop.value = false), 360)
}

watch(
  () => route.path,
  () => {
    stage = 'start'
    // 等新页面渲染完成后再判断进度
    requestAnimationFrame(() => say(currentStage()))
  },
)
watch(companion, () => say(stage))

onMounted(() => {
  try {
    open.value = localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    open.value = true
  }
  say(currentStage())
  mounted.value = true
  window.addEventListener('scroll', onScroll, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  if (frame) cancelAnimationFrame(frame)
  clearTimeout(hopTimer)
})
</script>

<style scoped>
.reading-buddy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  /* 下边距避开侧栏底部的渐隐遮罩，头像保持可点 */
  margin: 24px 0 16px;
  padding-top: 16px;
  border-top: 1px dashed var(--vp-c-divider);
}

.buddy-bubble {
  /* 尾巴对准下方头像中心：头像左边距 12px + 半宽 22px - 尾巴半宽 6px */
  --wk-tail-x: 28px;
  width: 100%;
  padding-right: 28px;
}

.buddy-line {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--vp-c-text-1);
  animation: wk-pop 0.24s steps(3, end);
}

.buddy-close {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 20px;
  height: 20px;
  font-size: 14px;
  line-height: 20px;
  color: var(--vp-c-text-3);
  border-radius: 4px;
}

.buddy-close:hover {
  color: var(--wk-pink-text);
  background: var(--vp-c-default-soft);
}

.buddy-avatar {
  margin-left: 12px;
  border-radius: 6px;
  cursor: pointer;
}

.buddy-avatar.hop {
  animation: wk-hop 0.36s steps(4, end);
}
</style>
