<template>
  <section id="day" ref="root" class="day">
    <BgFx :ribbon="t('A DAY WITH {0}', [char.name])" :ribbon-tilt="false" />
    <!-- 中轴时间线：随滚动从上往下填色 -->
    <div class="timeline" aria-hidden="true">
      <span class="fill" :style="{ transform: `scaleY(${progress})` }"></span>
    </div>
    <header class="head" data-reveal>
      <span class="eyebrow">{{ t('A DAY WITH {0}', [char.name]) }}</span>
      <h2>{{ t('和{0}的一天', [char.name]) }}</h2>
    </header>

    <article v-for="(s, i) in scenes" :key="s.key" class="scene" :class="{ flip: i % 2 === 1 }">
      <span class="dot" aria-hidden="true"></span>
      <div class="frame" data-reveal>
        <span class="tape" aria-hidden="true"></span>
        <div class="window">
          <img
            class="bg"
            :src="art(s.bg)"
            :alt="t(s.alt)"
            loading="lazy"
            decoding="async"
            :style="
              reduced ? undefined : { transform: `translateY(${shift[i] ?? 0}px) scale(1.12)` }
            "
          />
          <span class="sheen" aria-hidden="true"></span>
        </div>
        <span class="time">{{ s.time }}</span>
        <img
          class="chibi"
          :src="art(`${char.id}-chibi.webp`)"
          alt=""
          loading="lazy"
          :style="{ '--tilt': i % 2 ? '6deg' : '-6deg' }"
        />
      </div>
      <div class="copy" :data-reveal="i % 2 ? 'left' : 'right'">
        <span class="tag">{{ t(s.tag) }}</span>
        <h3>{{ t(s.title) }}</h3>
        <p>{{ t(s.desc) }}</p>
        <div class="bubble">
          <span class="who">{{ char.name }}</span>
          {{ char.scenes[s.key] }}
        </div>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import BgFx from './BgFx.vue'
import type { Character } from '../characters'
import { art } from '../assets'
import { useReveal } from '../composables/motion'
import { t } from '../i18n'

/** 「她的一天」：四幕插画 + 功能说明 + 当前角色的一句话；插画随滚动轻微视差 */
const props = defineProps<{ char: Character; reduced: boolean }>()

const root = ref<HTMLElement | null>(null)
useReveal(() => root.value)

const progress = ref(0)
const shift = ref<number[]>([])
let raf = 0

function measure() {
  raf = 0
  const el = root.value
  if (!el || props.reduced) return
  const vh = window.innerHeight
  const box = el.getBoundingClientRect()
  progress.value = Math.min(1, Math.max(0, (vh * 0.6 - box.top) / box.height))
  // 每幅插画按自身离视口中心的距离上下错位，最多 ±28px
  shift.value = [...el.querySelectorAll<HTMLElement>('.window')].map((w) => {
    const r = w.getBoundingClientRect()
    const d = (r.top + r.height / 2 - vh / 2) / vh
    return Math.max(-28, Math.min(28, d * -40))
  })
}

function onScroll() {
  if (!raf) raf = requestAnimationFrame(measure)
}

onMounted(() => {
  measure()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
})
onUnmounted(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onScroll)
})

const scenes = [
  {
    key: 'morning',
    time: '08:00',
    tag: '桌面陪伴',
    bg: 'bg-morning.webp',
    alt: '清晨洒满阳光的房间与书桌',
    title: '她就住在你的桌面上',
    desc: 'Steam 版和桌面版可以召唤桌宠。点她会有反应，按住能拖着走，还能直接在她身边聊天、按住说话。',
  },
  {
    key: 'memory',
    time: '13:00',
    tag: '长期记忆',
    bg: 'bg-memory.webp',
    alt: '贴满照片的软木板和摊开的日记本',
    title: '她记得你们的故事',
    desc: '值得保留的经历会整理成长期记忆，聊天时按话题自动想起。记住了什么，你都可以查看、修改和归档。',
  },
  {
    key: 'work',
    time: '15:30',
    tag: '帮你做事',
    bg: 'bg-work.webp',
    alt: '书桌上方飘着半透明的应用窗口',
    title: '交给她，也由你做主',
    desc: '读写文件、查资料、操作网页、跑后台任务，都在你开放的范围里进行；需要确认的操作，会先等你点头。',
  },
  {
    key: 'night',
    time: '22:00',
    tag: '一直都在',
    bg: 'bg-night.webp',
    alt: '星空下的山坡与远处的城市灯火',
    title: '明天见，她还会记得',
    desc: '数据保存在你自己的设备或服务器上。换台电脑、用手机接入，伙伴也还是那位伙伴。',
  },
] as const
</script>

<style scoped>
.day {
  position: relative;
  padding: 100px 24px 140px;
  overflow: hidden;
  isolation: isolate;
  background:
    radial-gradient(color-mix(in srgb, var(--c) 14%, transparent) 1.5px, transparent 2px) 0 0 / 26px
      26px,
    radial-gradient(
      40% 30% at 85% 10%,
      color-mix(in srgb, var(--c-soft) 70%, transparent),
      transparent
    ),
    var(--paper);
  transition: background 0.6s;
}

.head,
.scene {
  position: relative;
  z-index: 1;
}

.head {
  max-width: 1160px;
  margin: 0 auto 30px;
  text-align: center;
}

.timeline {
  position: absolute;
  top: 220px;
  bottom: 160px;
  left: 50%;
  z-index: 1;
  width: 4px;
  margin-left: -2px;
  border-radius: 4px;
  background: repeating-linear-gradient(
    180deg,
    color-mix(in srgb, var(--c) 25%, transparent) 0 8px,
    transparent 8px 16px
  );
}

.fill {
  position: absolute;
  inset: 0;
  border-radius: 4px;
  background: linear-gradient(180deg, var(--c), #ff9fd2);
  transform-origin: top;
  transition: transform 0.15s linear;
}

.dot {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  width: 22px;
  height: 22px;
  margin: -11px;
  border-radius: 50%;
  background: #fff;
  border: 5px solid var(--c);
  box-shadow: 0 0 0 6px color-mix(in srgb, var(--c) 20%, transparent);
}

.eyebrow {
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.32em;
  color: var(--c);
}

.head h2 {
  margin: 10px 0 0;
  font-size: clamp(30px, 4.4vw, 50px);
  font-weight: 900;
}

/* 两栏等宽，中缝正好落在时间线上，节点不会压到插画 */
.scene {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: 88px;
  max-width: 1160px;
  margin: 0 auto;
  padding: 50px 0;
}

.scene.flip .frame {
  order: 2;
}

/* 插画装在一个微微倾斜的拍立得框里，框内图片做视差 */
.frame {
  position: relative;
  rotate: -1.5deg;
  transition: rotate 0.5s cubic-bezier(0.3, 1.6, 0.5, 1);
}

.flip .frame {
  rotate: 1.5deg;
}

.frame:hover {
  rotate: 0deg;
}

.window {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 28px;
  border: 8px solid #fff;
  box-shadow:
    0 0 0 3px var(--c-soft),
    12px 14px 0 color-mix(in srgb, var(--c) 30%, transparent),
    0 26px 50px rgba(40, 30, 100, 0.2);
}

.bg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(1.12);
  transition: transform 0.2s linear;
}

.sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    115deg,
    transparent 40%,
    rgba(255, 255, 255, 0.45) 50%,
    transparent 60%
  );
  background-size: 250% 100%;
  background-position: 120% 0;
  transition: background-position 0.9s ease;
}

.frame:hover .sheen {
  background-position: -20% 0;
}

.tape {
  position: absolute;
  top: -14px;
  right: 18%;
  z-index: 2;
  width: 110px;
  height: 30px;
  background: repeating-linear-gradient(
    45deg,
    color-mix(in srgb, var(--c) 45%, #fff) 0 8px,
    rgba(255, 255, 255, 0.75) 8px 16px
  );
  opacity: 0.85;
  rotate: 4deg;
  box-shadow: 0 2px 6px rgba(40, 30, 100, 0.12);
}

.time {
  position: absolute;
  top: -16px;
  left: 26px;
  padding: 6px 16px;
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.08em;
  color: #fff;
  border-radius: 14px;
  background: var(--c);
  box-shadow: 0 5px 0 var(--c-deep);
  transform: rotate(-4deg);
}

.chibi {
  position: absolute;
  right: -18px;
  bottom: -30px;
  width: 30%;
  filter: drop-shadow(0 10px 14px rgba(40, 30, 100, 0.3));
  /* 用独立的 rotate 属性，不和浮动动画的 transform 冲突 */
  rotate: var(--tilt);
  animation: float-y 3.4s ease-in-out infinite;
}

.flip .chibi {
  right: auto;
  left: -18px;
}

.tag {
  display: inline-block;
  padding: 4px 14px;
  font-size: 14px;
  font-weight: 900;
  color: var(--c-deep);
  border-radius: 999px;
  background: var(--c-soft);
}

.copy h3 {
  margin: 14px 0 12px;
  font-size: clamp(26px, 3vw, 36px);
  font-weight: 900;
  line-height: 1.3;
}

.copy p {
  margin: 0 0 22px;
  font-size: 17px;
  line-height: 1.9;
  color: var(--ink-2);
}

.bubble {
  position: relative;
  padding: 16px 20px;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.8;
  border-radius: 20px 20px 20px 6px;
  background: #fff;
  border: 3px solid var(--c-soft);
  box-shadow: 0 10px 24px rgba(40, 30, 100, 0.1);
}

.who {
  display: block;
  margin-bottom: 2px;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.1em;
  color: var(--c);
}

@media (max-width: 900px) {
  .scene,
  .scene.flip {
    grid-template-columns: 1fr;
    gap: 40px;
  }
  .scene.flip .frame {
    order: 0;
  }
  /* 单栏布局下时间线和节点会压在插画上，收起 */
  .timeline,
  .dot {
    display: none;
  }
}
</style>
