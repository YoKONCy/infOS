<template>
  <section id="together" ref="root" class="together">
    <img class="room" :src="art('bg-stronghold.webp')" alt="" loading="lazy" />
    <div class="shade" aria-hidden="true"></div>
    <WaveEdge flip />
    <BgFx tone="dark" />
    <!-- 顶部一串摇晃的小彩灯 -->
    <div class="garland" aria-hidden="true">
      <i v-for="n in 16" :key="n" :style="{ '--n': n }"></i>
    </div>
    <div class="inner">
      <header class="head" data-reveal>
        <span class="eyebrow">{{ t('STRONGHOLD · 据点') }}</span>
        <h2>{{ t('大家住进同一个据点') }}</h2>
        <p>{{ t('几位伙伴可以在同一个房间里群聊、互相接话。想听谁说，就 @ 谁。') }}</p>
      </header>

      <div class="window-bar" aria-hidden="true">
        <span class="room-name">{{ t('♥ 我的据点 · 客厅') }}</span>
        <span class="online">
          <i></i>
          {{ t('{0} 位伙伴在场', [4]) }}
        </span>
      </div>
      <div class="chat" aria-live="off">
        <TransitionGroup name="msg">
          <div
            v-for="m in visible"
            :key="m.key"
            class="msg"
            :class="{ right: m.key % 2 === 1 }"
            :style="{ '--mc': localizedById[m.who].color, '--ms': localizedById[m.who].soft }"
          >
            <img :src="art(`${m.who}-peek.webp`)" alt="" class="avatar" />
            <div class="say">
              <span class="name">{{ localizedById[m.who].name }}</span>
              {{ t(m.text) }}
            </div>
          </div>
        </TransitionGroup>
      </div>

      <div class="row" data-reveal>
        <img
          v-for="(c, i) in localized"
          :key="c.id"
          class="mini"
          :src="art(`${c.id}-chibi.webp`)"
          :alt="c.name"
          loading="lazy"
          :style="{ '--i': i }"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import BgFx from './BgFx.vue'
import WaveEdge from './WaveEdge.vue'
import { useCharacters, type CharId } from '../characters'
import { art } from '../assets'
import { useReveal } from '../composables/motion'
import { t } from '../i18n'

/** 据点群聊：进入视口后四人依次接话，循环播放 */
const props = defineProps<{ reduced: boolean }>()
const { localized, localizedById } = useCharacters()

const root = ref<HTMLElement | null>(null)
useReveal(() => root.value)

const SCRIPT: { who: CharId; text: string }[] = [
  { who: 'pero', text: '锵锵！今天的据点也热热闹闹哒~ 大家都到齐了吗？' },
  { who: 'nana', text: '哼，Nana 早就到了，是你们太慢了。' },
  { who: 'tsukinaga', text: '小爱刚占卜过，今晚的运势是「派对」！要不要一起变个魔术？' },
  { who: 'penora', text: '嘿嘿，诺菈带了小点心，大家边吃边聊吧。' },
  { who: 'nana', text: '……那、那 Nana 就勉强吃一块好了。' },
  { who: 'pero', text: '欢迎回来！你想先听谁说话呀？@ 一下就好~' },
]

const visible = ref<{ key: number; who: CharId; text: string }[]>([])
let idx = 0
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined
let io: IntersectionObserver | null = null

function step() {
  const line = SCRIPT[idx % SCRIPT.length]!
  idx++
  visible.value = [...visible.value, { key: seq++, ...line }].slice(-4)
  timer = setTimeout(step, 2400)
}

onMounted(() => {
  if (props.reduced) {
    visible.value = SCRIPT.slice(0, 4).map((l, i) => ({ key: i, ...l }))
    return
  }
  io = new IntersectionObserver(
    ([e]) => {
      clearTimeout(timer)
      if (e?.isIntersecting) step()
    },
    { threshold: 0.3 },
  )
  if (root.value) io.observe(root.value)
})

onUnmounted(() => {
  clearTimeout(timer)
  io?.disconnect()
})
</script>

<style scoped>
.together {
  position: relative;
  padding: 110px 24px 80px;
  overflow: hidden;
  isolation: isolate;
  color: #fff;
}

.room {
  position: absolute;
  inset: 0;
  z-index: -2;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.shade {
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(180deg, rgba(40, 24, 80, 0.35), rgba(30, 20, 70, 0.72));
}

.inner {
  position: relative;
  z-index: 2;
  max-width: 980px;
  margin: 0 auto;
}

.head {
  text-align: center;
  text-shadow: 0 3px 10px rgba(20, 10, 50, 0.5);
}

.eyebrow {
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.32em;
  color: #ffd6f0;
}

.head h2 {
  margin: 10px 0 8px;
  font-size: clamp(30px, 4.4vw, 50px);
  font-weight: 900;
}

.head p {
  margin: 0;
  font-size: 17px;
  opacity: 0.92;
}

/* 毛玻璃聊天窗：标题栏 + 消息区连成一体 */
.window-bar,
.chat {
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
  background: rgba(255, 255, 255, 0.12);
  border: 2px solid rgba(255, 255, 255, 0.35);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  backdrop-filter: blur(14px) saturate(140%);
}

.window-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 40px;
  padding: 12px 22px;
  font-size: 14px;
  font-weight: 800;
  border-bottom: 0;
  border-radius: 24px 24px 0 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--c) 55%, transparent),
    rgba(255, 159, 210, 0.45)
  );
}

.online {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.online i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #6dffb0;
  box-shadow: 0 0 10px #6dffb0;
  animation: blink-soft 1.6s ease-in-out infinite;
}

.chat {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 400px;
  padding: 22px;
  justify-content: flex-end;
  border-radius: 0 0 24px 24px;
  box-shadow: 0 24px 60px rgba(10, 5, 40, 0.35);
}

.garland {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1;
  height: 70px;
  display: flex;
  justify-content: space-around;
  pointer-events: none;
}

/* 灯绳用一条下垂的曲线，灯泡挂在曲线上 */
.garland::before {
  content: '';
  position: absolute;
  left: -2%;
  right: -2%;
  top: -40px;
  height: 80px;
  border-bottom: 2px solid rgba(255, 255, 255, 0.4);
  border-radius: 0 0 50% 50%;
}

.garland i {
  position: relative;
  top: calc(28px - (var(--n) - 8.5) * (var(--n) - 8.5) * 0.36px);
  width: 12px;
  height: 16px;
  border-radius: 50% 50% 50% 50% / 60% 60% 40% 40%;
  background: hsl(calc(var(--n) * 47deg) 95% 75%);
  box-shadow: 0 0 14px hsl(calc(var(--n) * 47deg) 95% 70%);
  transform-origin: top center;
  animation:
    sway 3s ease-in-out infinite,
    blink-soft 2.2s ease-in-out infinite;
  animation-delay: calc(var(--n) * -0.3s);
}

@keyframes sway {
  0%,
  100% {
    rotate: -8deg;
  }
  50% {
    rotate: 8deg;
  }
}

.msg {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

/* 左右按消息序号固定，旧消息移出时不会整体换边 */
.msg.right {
  flex-direction: row-reverse;
}

.avatar {
  flex-shrink: 0;
  width: 74px;
  height: 74px;
  object-fit: cover;
  object-position: 50% 20%;
  border-radius: 50%;
  background: var(--ms);
  border: 3px solid #fff;
}

.say {
  max-width: 74%;
  padding: 12px 18px;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.75;
  color: var(--ink);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.94);
  border: 3px solid var(--mc);
  box-shadow: 0 10px 24px rgba(10, 5, 40, 0.3);
}

.name {
  display: block;
  font-size: 13px;
  font-weight: 900;
  color: var(--mc);
}

.row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: clamp(6px, 3vw, 40px);
  max-width: 860px;
  margin: 40px auto 0;
}

.mini {
  width: 100%;
  height: clamp(90px, 22vw, 220px);
  object-fit: contain;
  object-position: center bottom;
  filter: drop-shadow(0 12px 14px rgba(10, 5, 40, 0.45));
  animation: bounce 1.2s cubic-bezier(0.3, 1.6, 0.5, 1) infinite alternate;
  animation-delay: calc(var(--i) * 0.18s);
}

.msg-enter-active {
  transition:
    opacity 0.35s,
    transform 0.45s cubic-bezier(0.3, 1.7, 0.5, 1);
}

.msg-leave-active {
  transition: opacity 0.25s;
}

.msg-move {
  transition: transform 0.4s ease;
}

.msg-enter-from {
  opacity: 0;
  transform: translateY(24px) scale(0.85);
}

.msg-leave-to {
  opacity: 0;
}

@keyframes bounce {
  to {
    transform: translateY(-16px);
  }
}
</style>
