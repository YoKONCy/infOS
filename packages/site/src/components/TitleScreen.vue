<template>
  <section class="title" :class="{ started }" @pointermove="onMove">
    <div class="sky" :style="layer(10)">
      <img :src="art('bg-title.webp')" alt="" />
    </div>
    <div class="glow" aria-hidden="true"></div>
    <!-- 天光：从顶部斜射下来的几道光柱 -->
    <div class="beams" aria-hidden="true" :style="layer(16)">
      <i v-for="n in 5" :key="n" :style="{ '--n': n }"></i>
    </div>
    <!-- 偶尔划过的流星 -->
    <div class="meteors" aria-hidden="true">
      <i v-for="n in 4" :key="n" :style="{ '--n': n }"></i>
    </div>
    <!-- 合照身后缓缓转动的光环 -->
    <div class="burst" aria-hidden="true" :style="layer(-10)"></div>
    <div class="cast" :style="layer(-26)">
      <img :src="art('group.webp')" :alt="t('Pero、佩诺菈、Nana 和月永爱站在一起向你挥手')" />
    </div>
    <div class="front" :style="layer(-40)">
      <div class="logo-wrap">
        <img class="logo" :src="art('logo.webp')" :alt="t('萌动链接：PeroperoChat！')" />
        <!-- 字标上周期性扫过的高光，用字标自身作遮罩 -->
        <span
          class="logo-shine"
          aria-hidden="true"
          :style="{ '--logo': `url(${art('logo.webp')})` }"
        ></span>
      </div>
      <p class="tagline">{{ t('住在你桌面上的 AI 伙伴，陪你聊天，也记得你们的每一天。') }}</p>
      <button v-if="!started" type="button" class="press" @click="emit('start')">
        <span>{{ t('点击开始') }}</span>
        <small>{{ t('PRESS TO START') }}</small>
      </button>
      <div v-else class="cta">
        <a class="btn" :href="LINKS.steam" target="_blank" rel="noopener noreferrer">
          {{ t('在 Steam 查看') }}
        </a>
        <a class="btn ghost" href="#choose">{{ t('先认识大家') }}</a>
      </div>
    </div>
    <WaveEdge style="--wave: #fff6fd" />
    <a v-if="started" class="scroll-hint" href="#choose" :aria-label="t('向下滚动')">
      <span></span>
    </a>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import WaveEdge from './WaveEdge.vue'
import { LINKS, art } from '../assets'
import { t } from '../i18n'

/** 标题画面：背景、合照、字标三层视差，点击开始后露出主按钮 */
const props = defineProps<{ started: boolean; reduced: boolean }>()
const emit = defineEmits<{ start: [] }>()

const mx = ref(0)
const my = ref(0)

function onMove(e: PointerEvent) {
  if (props.reduced || e.pointerType !== 'mouse') return
  mx.value = e.clientX / window.innerWidth - 0.5
  my.value = e.clientY / window.innerHeight - 0.5
}

function layer(depth: number) {
  return { transform: `translate3d(${mx.value * depth}px, ${my.value * depth}px, 0)` }
}
</script>

<style scoped>
.title {
  position: relative;
  height: 100svh;
  min-height: 620px;
  overflow: hidden;
  isolation: isolate;
}

.sky,
.cast {
  position: absolute;
  inset: -40px;
  transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.3, 1);
}

.sky img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  animation: sky-breathe 18s ease-in-out infinite alternate;
}

.glow {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(60% 50% at 50% 100%, rgba(255, 180, 230, 0.55), transparent 70%),
    linear-gradient(180deg, transparent 55%, rgba(26, 22, 64, 0.55));
}

.beams {
  position: absolute;
  inset: -10% -10% 30%;
  transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.3, 1);
  mix-blend-mode: screen;
}

.beams i {
  position: absolute;
  top: -10%;
  left: calc(var(--n) * 17% - 6%);
  width: calc(60px + var(--n) * 14px);
  height: 130%;
  background: linear-gradient(180deg, rgba(255, 245, 220, 0.55), transparent 75%);
  filter: blur(8px);
  transform: rotate(18deg);
  transform-origin: top center;
  animation: beam 7s ease-in-out infinite;
  animation-delay: calc(var(--n) * -1.4s);
}

.meteors i {
  position: absolute;
  top: calc(var(--n) * 7% - 4%);
  left: calc(var(--n) * 21% + 8%);
  width: 140px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, #fff, transparent);
  box-shadow: 0 0 8px #fff;
  transform: rotate(-32deg);
  opacity: 0;
  animation: meteor 9s linear infinite;
  animation-delay: calc(var(--n) * 2.3s);
}

.burst {
  position: absolute;
  left: 50%;
  bottom: -38vw;
  width: 110vw;
  aspect-ratio: 1;
  margin-left: -55vw;
  border-radius: 50%;
  background: repeating-conic-gradient(
    from 0deg,
    rgba(255, 255, 255, 0.22) 0 6deg,
    transparent 6deg 15deg
  );
  -webkit-mask-image: radial-gradient(circle, transparent 18%, #000 30%, transparent 62%);
  mask-image: radial-gradient(circle, transparent 18%, #000 30%, transparent 62%);
  animation: spin 70s linear infinite;
  transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.3, 1);
}

/* 弹出与浮动放在外层，字标和高光一起动，不会错位 */
.logo-wrap {
  position: relative;
  width: min(640px, 86vw);
  animation:
    logo-pop 1.1s cubic-bezier(0.3, 1.7, 0.5, 1) 0.2s both,
    float-y 5s ease-in-out 1.4s infinite;
}

.logo-shine {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    110deg,
    transparent 35%,
    rgba(255, 255, 255, 0.85) 48%,
    transparent 60%
  );
  background-size: 300% 100%;
  -webkit-mask: var(--logo) center / contain no-repeat;
  mask: var(--logo) center / contain no-repeat;
  animation: shine 4.5s ease-in-out 1.6s infinite;
  pointer-events: none;
}

.cast {
  inset: auto -40px -40px;
  display: flex;
  justify-content: center;
}

.cast img {
  width: min(1180px, 112vw);
  max-width: none;
  /* 合照四周渐隐进天空，像站在画面里 */
  -webkit-mask-image: radial-gradient(70% 78% at 50% 62%, #000 60%, transparent 100%);
  mask-image: radial-gradient(70% 78% at 50% 62%, #000 60%, transparent 100%);
  transform-origin: 50% 100%;
  animation: cast-in 1.4s cubic-bezier(0.2, 1.2, 0.3, 1) both;
}

.front {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: clamp(28px, 6vh, 72px);
  text-align: center;
  transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.3, 1);
}

.logo {
  width: 100%;
  filter: drop-shadow(0 10px 22px rgba(40, 20, 100, 0.35));
}

.tagline {
  margin: 10px 16px 0;
  padding: 8px 18px;
  font-size: clamp(14px, 1.6vw, 18px);
  font-weight: 700;
  color: #fff;
  border-radius: 999px;
  background: rgba(40, 30, 100, 0.35);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  text-shadow: 0 2px 6px rgba(40, 20, 90, 0.4);
  animation: fade-up 0.8s ease 0.9s both;
}

.press {
  margin-top: 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 12px 34px;
  color: #fff;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  border: 2px solid rgba(255, 255, 255, 0.75);
  box-shadow: 0 0 30px rgba(255, 200, 240, 0.6);
  animation:
    fade-up 0.8s ease 1.2s both,
    press-pulse 1.6s ease-in-out 2s infinite;
}

.press span {
  font-size: 20px;
  font-weight: 900;
  letter-spacing: 0.3em;
}

.press small {
  font-size: 11px;
  letter-spacing: 0.4em;
  opacity: 0.85;
}

.cta {
  margin-top: 22px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 16px;
  animation: fade-up 0.6s cubic-bezier(0.3, 1.6, 0.5, 1) both;
}

.scroll-hint {
  position: absolute;
  bottom: 78px;
  left: 50%;
  z-index: 4;
  width: 30px;
  height: 48px;
  margin-left: -15px;
  border: 2px solid rgba(255, 255, 255, 0.85);
  border-radius: 999px;
}

.scroll-hint span {
  position: absolute;
  top: 8px;
  left: 50%;
  width: 6px;
  height: 10px;
  margin-left: -3px;
  border-radius: 3px;
  background: #fff;
  animation: wheel 1.6s ease-in-out infinite;
}

@keyframes beam {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 0.85;
  }
}

@keyframes meteor {
  0% {
    opacity: 0;
    translate: 0 0;
  }
  4% {
    opacity: 1;
  }
  12% {
    opacity: 0;
    translate: -320px 200px;
  }
  100% {
    opacity: 0;
    translate: -320px 200px;
  }
}

@keyframes spin {
  to {
    rotate: 360deg;
  }
}

@keyframes shine {
  0% {
    background-position: 100% 0;
  }
  45%,
  100% {
    background-position: -50% 0;
  }
}

@keyframes sky-breathe {
  to {
    transform: scale(1.08);
  }
}

@keyframes cast-in {
  from {
    opacity: 0;
    transform: translateY(80px) scale(0.92);
  }
}

@keyframes logo-pop {
  from {
    opacity: 0;
    transform: scale(0.4) rotate(-8deg);
  }
}

@keyframes fade-up {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
}

@keyframes press-pulse {
  50% {
    box-shadow: 0 0 50px rgba(255, 200, 240, 0.95);
    transform: scale(1.05);
  }
}

@keyframes wheel {
  0% {
    opacity: 0;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(16px);
  }
}
</style>
