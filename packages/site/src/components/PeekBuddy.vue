<template>
  <Transition name="peek">
    <button
      v-if="show"
      type="button"
      class="peek"
      :class="side"
      :aria-label="`${char.name}：${line}`"
      @click="poke"
    >
      <span class="bubble">{{ line }}</span>
      <img :src="art(`${char.id}-peek.webp`)" alt="" draggable="false" />
    </button>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { pick, type Character } from '../characters'
import { art } from '../assets'

/** 从屏幕底边探头的 Q 版伙伴：滚动一阵后冒出来，过一会儿缩回去，点她会说话 */
const props = defineProps<{ char: Character; enabled: boolean }>()

const show = ref(false)
const side = ref<'left' | 'right'>('right')
const lineIndex = ref<number | undefined>()
const line = computed(() =>
  lineIndex.value === undefined ? '' : (props.char.pokes[lineIndex.value] ?? ''),
)
let hideTimer: ReturnType<typeof setTimeout> | undefined
let lastY = 0
let travelled = 0

function appear() {
  side.value = Math.random() > 0.5 ? 'right' : 'left'
  lineIndex.value = pick(
    props.char.pokes.map((_, index) => index),
    lineIndex.value,
  )
  show.value = true
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => (show.value = false), 5200)
}

function poke() {
  lineIndex.value = pick(
    props.char.pokes.map((_, index) => index),
    lineIndex.value,
  )
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => (show.value = false), 4200)
}

function onScroll() {
  if (!props.enabled) return
  const y = window.scrollY
  travelled += Math.abs(y - lastY)
  lastY = y
  // 每滚过约两屏探一次头，首屏不打扰
  if (!show.value && y > window.innerHeight && travelled > window.innerHeight * 2) {
    travelled = 0
    appear()
  }
}

watch(
  () => props.char.id,
  () => (show.value = false),
)

onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }))
onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  clearTimeout(hideTimer)
})
</script>

<style scoped>
.peek {
  position: fixed;
  bottom: 0;
  z-index: 50;
  width: 180px;
}

.peek.right {
  right: 4vw;
}

.peek.left {
  left: 4vw;
}

.peek img {
  width: 100%;
  filter: drop-shadow(0 -4px 12px rgba(40, 30, 100, 0.25));
}

.bubble {
  position: absolute;
  bottom: 92%;
  left: 50%;
  width: max-content;
  max-width: 240px;
  padding: 10px 14px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.6;
  text-align: left;
  color: var(--ink);
  border-radius: 16px;
  background: #fff;
  border: 3px solid var(--c);
  box-shadow: 0 8px 20px rgba(40, 30, 100, 0.2);
  transform: translateX(-50%);
}

.right .bubble {
  left: auto;
  right: 10%;
  transform: none;
}

.left .bubble {
  left: 10%;
  transform: none;
}

.peek-enter-active {
  transition: transform 0.5s cubic-bezier(0.3, 1.6, 0.5, 1);
}

.peek-leave-active {
  transition: transform 0.35s ease-in;
}

.peek-enter-from,
.peek-leave-to {
  transform: translateY(110%);
}

@media (max-width: 640px) {
  .peek {
    width: 120px;
  }
  .bubble {
    max-width: 180px;
    font-size: 13px;
  }
}
</style>
