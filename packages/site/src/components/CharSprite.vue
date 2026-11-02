<template>
  <div class="char-sprite" :class="{ talking, hop }" :style="{ '--r': String(char.face.ratio) }">
    <img class="body" :src="art(`${char.id}-sprite.webp`)" :alt="alt" draggable="false" />
    <!-- 表情帧：叠在脸上的小补丁，切换即可眨眼、开合嘴 -->
    <img
      v-for="f in FRAMES"
      :key="f"
      class="face"
      :class="{ on: face === f }"
      :src="art(`${char.id}-face-${f}.webp`)"
      alt=""
      draggable="false"
      :style="faceStyle"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Character } from '../characters'
import { art } from '../assets'

/**
 * 角色立绘：底图是张嘴笑，叠加「闭嘴」「眨眼」两帧补丁。
 * talking 时嘴巴开合，平时每隔几秒眨一次眼。
 */
const props = defineProps<{ char: Character; talking?: boolean; reduced?: boolean; alt?: string }>()

const FRAMES = ['closed', 'blink'] as const
type Frame = (typeof FRAMES)[number] | 'open'

const face = ref<Frame>('closed')
const hop = ref(false)
let blinkTimer: ReturnType<typeof setTimeout> | undefined
let talkTimer: ReturnType<typeof setInterval> | undefined
let hopTimer: ReturnType<typeof setTimeout> | undefined

const faceStyle = computed(() => ({
  left: `${props.char.face.x * 100}%`,
  top: `${props.char.face.y * 100}%`,
  width: `${props.char.face.w * 100}%`,
  height: `${props.char.face.h * 100}%`,
}))

function rest(): Frame {
  return props.talking ? 'open' : 'closed'
}

function scheduleBlink() {
  clearTimeout(blinkTimer)
  if (props.reduced) return
  blinkTimer = setTimeout(
    () => {
      face.value = 'blink'
      setTimeout(() => (face.value = rest()), 130)
      scheduleBlink()
    },
    2200 + Math.random() * 2600,
  )
}

watch(
  () => props.talking,
  (on) => {
    clearInterval(talkTimer)
    face.value = on ? 'open' : 'closed'
    if (!on || props.reduced) return
    // 说话时嘴巴不规则地开合
    talkTimer = setInterval(() => {
      if (face.value === 'blink') return
      face.value = face.value === 'open' && Math.random() > 0.25 ? 'closed' : 'open'
    }, 120)
  },
)

watch(
  () => props.char.id,
  () => {
    hop.value = false
    requestAnimationFrame(() => (hop.value = true))
    clearTimeout(hopTimer)
    hopTimer = setTimeout(() => (hop.value = false), 520)
  },
)

onMounted(scheduleBlink)
onUnmounted(() => {
  clearTimeout(blinkTimer)
  clearInterval(talkTimer)
  clearTimeout(hopTimer)
})
</script>

<style scoped>
/*
 * 按父容器（需 container-type: size）的宽高取较小者等比缩放，
 * 宽立绘不会越出自己那一栏去遮挡旁边的文字。
 */
.char-sprite {
  position: relative;
  width: 100%;
  width: min(100cqw, calc(100cqh * var(--r)));
  max-height: 100%;
  aspect-ratio: var(--r);
  flex-shrink: 0;
  user-select: none;
  transform-origin: 50% 100%;
}

.char-sprite.hop {
  animation: sprite-hop 0.52s cubic-bezier(0.3, 1.6, 0.5, 1);
}

.body,
.face {
  position: absolute;
  display: block;
}

.body {
  inset: 0;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 18px 30px rgba(20, 16, 60, 0.3));
}

.face {
  opacity: 0;
}

.face.on {
  opacity: 1;
}

@keyframes sprite-hop {
  0% {
    transform: translateY(0) scale(1, 1);
  }
  30% {
    transform: translateY(-4%) scale(0.97, 1.04);
  }
  60% {
    transform: translateY(0) scale(1.03, 0.97);
  }
  100% {
    transform: translateY(0) scale(1, 1);
  }
}
</style>
