<template>
  <div class="bgfx" :class="[`tone-${tone}`]" aria-hidden="true">
    <!-- 远景：缓慢漂移的大光团 -->
    <span v-for="i in 3" :key="`o${i}`" class="orb" :class="`o${i}`"></span>
    <!-- 中景：缓缓转动的同心虚线圈 -->
    <svg v-if="rings" class="rings" viewBox="0 0 600 600">
      <circle cx="300" cy="300" r="290" />
      <circle cx="300" cy="300" r="230" />
      <circle cx="300" cy="300" r="170" />
    </svg>
    <!-- 近景：闪烁的小星星，位置固定以免每次渲染跳动 -->
    <span
      v-for="(s, i) in STARS"
      :key="`s${i}`"
      class="twinkle"
      :style="{ left: `${s[0]}%`, top: `${s[1]}%`, '--z': s[2], '--t': `${s[3]}s` }"
    ></span>
    <!-- 横穿区块的滚动字带 -->
    <div v-if="ribbon" class="ribbon" :class="{ tilt: ribbonTilt }">
      <div class="track">
        <span v-for="n in 2" :key="n">{{ ribbonText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/**
 * 区块背景特效层：光团、虚线圈、星星、滚动字带。
 * 只用 CSS 动画，放在区块内 z-index:0，正文放在其上。
 */
const props = withDefaults(
  defineProps<{
    tone?: 'light' | 'dark'
    rings?: boolean
    ribbon?: string
    ribbonTilt?: boolean
  }>(),
  { tone: 'light', rings: false, ribbon: '', ribbonTilt: true },
)

const ribbonText = computed(() => `${props.ribbon} ✦ `.repeat(8))

// [left%, top%, 缩放, 周期秒]
const STARS: [number, number, number, number][] = [
  [6, 18, 1, 2.6],
  [14, 72, 0.7, 3.4],
  [27, 34, 0.5, 2.2],
  [41, 86, 0.8, 3.8],
  [58, 12, 0.6, 2.9],
  [66, 58, 1.1, 3.1],
  [79, 26, 0.7, 2.4],
  [88, 78, 0.9, 3.6],
  [94, 44, 0.5, 2.7],
  [50, 48, 0.4, 4.2],
]
</script>

<style scoped>
.bgfx {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}

.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(40px);
  opacity: 0.6;
  mix-blend-mode: multiply;
  animation: drift 22s ease-in-out infinite alternate;
}

.tone-dark .orb {
  mix-blend-mode: screen;
  opacity: 0.45;
}

.o1 {
  left: -8%;
  top: 4%;
  width: 42vw;
  height: 42vw;
  background: radial-gradient(circle, var(--c-soft), transparent 70%);
}

.o2 {
  right: -10%;
  top: 30%;
  width: 36vw;
  height: 36vw;
  background: radial-gradient(circle, #ffd3ec, transparent 70%);
  animation-duration: 28s;
  animation-delay: -6s;
}

.o3 {
  left: 30%;
  bottom: -18%;
  width: 40vw;
  height: 40vw;
  background: radial-gradient(circle, #fff1b8, transparent 70%);
  animation-duration: 32s;
  animation-delay: -12s;
}

.tone-dark .o3 {
  background: radial-gradient(circle, var(--c), transparent 70%);
}

.rings {
  position: absolute;
  right: -12%;
  top: -14%;
  width: min(62vw, 720px);
  fill: none;
  stroke: var(--c);
  stroke-width: 1.5;
  stroke-dasharray: 2 14;
  stroke-linecap: round;
  opacity: 0.35;
  animation: spin 80s linear infinite;
}

.rings circle:nth-child(2) {
  stroke-dasharray: 18 10;
  opacity: 0.6;
}

.twinkle {
  position: absolute;
  width: 18px;
  height: 18px;
  background: var(--c);
  clip-path: polygon(50% 0, 60% 40%, 100% 50%, 60% 60%, 50% 100%, 40% 60%, 0 50%, 40% 40%);
  transform: scale(var(--z));
  animation: twinkle var(--t) ease-in-out infinite;
}

.tone-dark .twinkle {
  background: #fff6c8;
}

.ribbon {
  position: absolute;
  left: -5%;
  right: -5%;
  bottom: 6%;
  padding: 10px 0;
  overflow: hidden;
  background: linear-gradient(90deg, var(--c), color-mix(in srgb, var(--c) 60%, #ff9fd2));
  box-shadow: 0 10px 30px color-mix(in srgb, var(--c) 35%, transparent);
  opacity: 0.9;
}

.ribbon.tilt {
  transform: rotate(-3deg);
}

.track {
  display: flex;
  width: max-content;
  animation: marquee 40s linear infinite;
}

.track span {
  padding-right: 24px;
  font-size: 15px;
  font-weight: 900;
  letter-spacing: 0.3em;
  white-space: nowrap;
  color: #fff;
}

@keyframes drift {
  to {
    transform: translate(6vw, -4vw) scale(1.15);
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes twinkle {
  0%,
  100% {
    opacity: 0.15;
    transform: scale(calc(var(--z) * 0.6)) rotate(0deg);
  }
  50% {
    opacity: 0.9;
    transform: scale(var(--z)) rotate(45deg);
  }
}

@keyframes marquee {
  to {
    transform: translateX(-50%);
  }
}
</style>
