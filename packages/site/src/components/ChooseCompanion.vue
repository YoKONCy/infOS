<template>
  <section id="choose" ref="root" class="choose">
    <BgFx rings :ribbon="t('CHOOSE YOUR COMPANION')" />
    <WaveEdge />
    <!-- 背景大号英文名：跟随角色切换，做出杂志排版的层次 -->
    <Transition name="ghost" mode="out-in">
      <span :key="current.id" class="ghost-name" aria-hidden="true">{{ current.en }}</span>
    </Transition>
    <header class="head" data-reveal>
      <span class="eyebrow">{{ t('CHOOSE YOUR COMPANION') }}</span>
      <h2>{{ t('今天，想和谁在一起？') }}</h2>
      <p>{{ t('选一位伙伴，整个网站都会换成她的颜色。点点她，她会回应你。') }}</p>
    </header>

    <div class="stage" data-reveal>
      <div class="figure">
        <div class="halo" aria-hidden="true"></div>
        <span class="orbit" aria-hidden="true">
          <i v-for="n in 6" :key="n" :style="{ '--n': n }"></i>
        </span>
        <button
          type="button"
          class="sprite-btn"
          :aria-label="t('戳一下 {0}', [current.name])"
          @click="poke"
        >
          <Transition name="swap" mode="out-in">
            <CharSprite
              :key="current.id"
              :char="current"
              :talking="talking"
              :reduced="reduced"
              :alt="t('{0} 的立绘', [current.name])"
            />
          </Transition>
        </button>
        <span class="floor" aria-hidden="true"></span>
      </div>

      <div class="info">
        <Transition name="card" mode="out-in">
          <div :key="current.id" class="profile">
            <span class="en">{{ current.en }}</span>
            <h3>{{ current.name }}</h3>
            <span class="role">{{ current.title }}</span>
            <p>{{ current.intro }}</p>
          </div>
        </Transition>
        <DialogBox
          :name="current.name"
          :text="line"
          :reduced="reduced"
          @typing="talking = $event"
        />
      </div>
    </div>

    <div class="cards" role="group" :aria-label="t('选择伙伴')">
      <button
        v-for="(c, i) in localized"
        :key="c.id"
        type="button"
        :aria-pressed="c.id === current.id"
        class="card"
        :class="{ active: c.id === current.id }"
        :style="{ '--cc': c.color, '--cs': c.soft, '--d': `${i * 0.08}s` }"
        data-reveal
        @click="emit('select', c.id)"
      >
        <img :src="art(`${c.id}-chibi.webp`)" alt="" loading="lazy" />
        <span class="card-name">{{ c.name }}</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import CharSprite from './CharSprite.vue'
import DialogBox from './DialogBox.vue'
import BgFx from './BgFx.vue'
import WaveEdge from './WaveEdge.vue'
import { useCharacters, pick, type CharId } from '../characters'
import { art } from '../assets'
import { useReveal } from '../composables/motion'
import { t } from '../i18n'

/** 角色选择：大立绘 + 档案 + 对话框，下方四张 Q 版卡片 */
const props = defineProps<{ selected: CharId; reduced: boolean }>()
const emit = defineEmits<{ select: [CharId]; poke: [] }>()

const root = ref<HTMLElement | null>(null)
useReveal(() => root.value)

const { localized, localizedById } = useCharacters()
const current = computed(() => localizedById.value[props.selected])
const lineIndex = ref<number | null>(null)
const line = computed(() =>
  lineIndex.value === null
    ? current.value.greet
    : (current.value.pokes[lineIndex.value] ?? current.value.greet),
)
const talking = ref(false)

watch(
  () => props.selected,
  () => (lineIndex.value = null),
)

function poke() {
  lineIndex.value = pick(
    current.value.pokes.map((_, index) => index),
    lineIndex.value ?? undefined,
  )
  emit('poke')
}
</script>

<style scoped>
.choose {
  position: relative;
  padding: 110px 24px 150px;
  overflow: hidden;
  background:
    radial-gradient(
      50% 40% at 15% 20%,
      color-mix(in srgb, var(--c-soft) 80%, transparent),
      transparent
    ),
    radial-gradient(40% 40% at 90% 70%, rgba(255, 210, 240, 0.7), transparent),
    linear-gradient(180deg, #fff6fd, var(--paper));
  transition: background 0.6s;
}

/* 斜向流动的条纹，Galgame 选人界面的感觉 */
.choose::before {
  content: '';
  position: absolute;
  z-index: 0;
  inset: -50%;
  background: repeating-linear-gradient(
    -35deg,
    transparent 0 40px,
    color-mix(in srgb, var(--c-soft) 45%, transparent) 40px 80px
  );
  opacity: 0.45;
  animation: stripes 30s linear infinite;
}

.head,
.stage,
.cards {
  position: relative;
  z-index: 1;
  max-width: 1160px;
  margin: 0 auto;
}

/* 背景大字：描边空心字，跟随主题色 */
.ghost-name {
  position: absolute;
  top: 160px;
  right: -2vw;
  z-index: 0;
  font-size: clamp(90px, 17vw, 260px);
  font-weight: 900;
  line-height: 1;
  letter-spacing: -0.02em;
  color: transparent;
  -webkit-text-stroke: 2px color-mix(in srgb, var(--c) 35%, transparent);
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

.ghost-enter-active,
.ghost-leave-active {
  transition:
    opacity 0.4s,
    transform 0.5s cubic-bezier(0.3, 1.4, 0.5, 1);
}

.ghost-enter-from {
  opacity: 0;
  transform: translateX(80px);
}

.ghost-leave-to {
  opacity: 0;
  transform: translateX(-80px);
}

.head {
  text-align: center;
}

.eyebrow {
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.32em;
  color: var(--c);
}

.head h2 {
  margin: 10px 0 8px;
  font-size: clamp(30px, 4.4vw, 50px);
  font-weight: 900;
  color: var(--ink);
}

.head p {
  margin: 0;
  color: var(--ink-2);
  font-size: 16px;
}

.stage {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
  align-items: center;
  gap: 32px;
  margin-top: 40px;
}

/* 立绘栏：光环、环绕的小星、地面光斑都限定在这一栏内 */
.figure {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: end center;
  height: min(78vh, 720px);
  min-width: 0;
}

.halo {
  position: absolute;
  left: 50%;
  top: 46%;
  width: min(92%, 560px);
  aspect-ratio: 1;
  margin: calc(min(92%, 560px) / -2) 0 0 calc(min(92%, 560px) / -2);
  border-radius: 50%;
  background:
    radial-gradient(circle, rgba(255, 255, 255, 0.95) 0 38%, transparent 39%),
    repeating-conic-gradient(from 0deg, var(--c-soft) 0 10deg, #ffe3f3 10deg 20deg);
  -webkit-mask-image: radial-gradient(circle, #000 55%, transparent 71%);
  mask-image: radial-gradient(circle, #000 55%, transparent 71%);
  opacity: 0.9;
  animation: spin 40s linear infinite;
}

.orbit {
  position: absolute;
  left: 50%;
  top: 46%;
  width: 0;
  height: 0;
  animation: spin 18s linear infinite;
}

.orbit i {
  position: absolute;
  width: 22px;
  height: 22px;
  margin: -11px;
  background: var(--c);
  clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%);
  transform: rotate(calc(var(--n) * 60deg)) translateX(min(19vw, 250px))
    scale(calc(0.5 + var(--n) * 0.1));
  opacity: 0.75;
}

.orbit i:nth-child(even) {
  background: #ffb3da;
}

.floor {
  position: absolute;
  bottom: 2%;
  left: 50%;
  width: 66%;
  height: 34px;
  margin-left: -33%;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--c) 45%, transparent),
    transparent
  );
  animation: floor-pulse 3.2s ease-in-out infinite;
}

.sprite-btn {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  width: 100%;
  height: 100%;
  container-type: size;
  border-radius: 30px;
}

.info {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 34px;
  min-width: 0;
}

@keyframes floor-pulse {
  50% {
    transform: scaleX(0.85);
    opacity: 0.6;
  }
}

.profile .en {
  font-size: 15px;
  font-weight: 900;
  letter-spacing: 0.4em;
  color: var(--c);
}

.profile h3 {
  margin: 4px 0 8px;
  font-size: clamp(44px, 6vw, 76px);
  font-weight: 900;
  line-height: 1;
  color: var(--c-deep);
  text-shadow:
    4px 4px 0 #fff,
    7px 7px 0 var(--c-soft);
}

.role {
  display: inline-block;
  padding: 4px 14px;
  font-size: 14px;
  font-weight: 800;
  color: #fff;
  border-radius: 999px;
  background: var(--c);
}

.profile p {
  margin: 14px 0 0;
  font-size: 17px;
  line-height: 1.85;
  color: var(--ink-2);
}

.cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
  margin-top: 46px;
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px 10px 12px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.82);
  border: 3px solid #fff;
  box-shadow: 0 10px 26px rgba(40, 30, 100, 0.12);
  transition:
    opacity 0.7s ease,
    transform 0.3s cubic-bezier(0.3, 1.8, 0.5, 1),
    box-shadow 0.25s,
    border-color 0.25s;
}

.card img {
  height: 150px;
  width: auto;
  transition: transform 0.3s cubic-bezier(0.3, 1.8, 0.5, 1);
}

.card[data-shown]:hover {
  transform: translateY(-8px) rotate(-1.5deg);
}

.card:hover img {
  transform: scale(1.08) rotate(3deg);
}

.card.active {
  border-color: var(--cc);
  background: linear-gradient(180deg, #fff, var(--cs));
  box-shadow:
    0 0 0 5px color-mix(in srgb, var(--cc) 25%, transparent),
    0 16px 34px color-mix(in srgb, var(--cc) 40%, transparent);
}

.card.active::after {
  content: '♥';
  position: absolute;
  top: 8px;
  right: 8px;
  width: 32px;
  height: 32px;
  font-size: 18px;
  line-height: 30px;
  color: #fff;
  border-radius: 50%;
  background: var(--cc);
  box-shadow: 0 4px 10px color-mix(in srgb, var(--cc) 50%, transparent);
}

/* 悬停时一道高光扫过卡片 */
.card {
  overflow: hidden;
}

.card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 -60%;
  width: 40%;
  background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.9), transparent);
  transform: skewX(-20deg);
  transition: left 0.6s ease;
  pointer-events: none;
}

.card:hover::before {
  left: 130%;
}

/* 选中卡片底部的波点 */
.card.active {
  background-image:
    radial-gradient(color-mix(in srgb, var(--cc) 22%, transparent) 2px, transparent 2.5px),
    linear-gradient(180deg, #fff, var(--cs));
  background-size:
    14px 14px,
    100% 100%;
}

.card-name {
  margin-top: 6px;
  font-size: 17px;
  font-weight: 900;
  color: var(--ink);
}

.swap-enter-active,
.swap-leave-active {
  transition:
    opacity 0.28s ease,
    transform 0.36s cubic-bezier(0.3, 1.5, 0.5, 1);
}

.swap-enter-from {
  opacity: 0;
  transform: translateX(-40px) scale(0.94);
}

.swap-leave-to {
  opacity: 0;
  transform: translateX(40px) scale(0.96);
}

.card-enter-active,
.card-leave-active {
  transition:
    opacity 0.25s,
    transform 0.3s;
}

.card-enter-from,
.card-leave-to {
  opacity: 0;
  transform: translateY(14px);
}

@keyframes stripes {
  to {
    /* 条纹周期 80px 沿 -35° 方向，水平周期 = 80 / sin(35°) */
    transform: translate(139.5px, 0);
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .stage {
    grid-template-columns: 1fr;
  }
  .figure {
    height: 56vh;
  }
  .orbit i {
    transform: rotate(calc(var(--n) * 60deg)) translateX(36vw) scale(calc(0.5 + var(--n) * 0.1));
  }
  .ghost-name {
    top: 120px;
  }
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
