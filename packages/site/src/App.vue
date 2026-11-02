<template>
  <div class="app" :style="theme">
    <nav class="nav" :class="{ solid: scrolled }" :aria-label="t('主导航')">
      <a class="brand" href="#top" :aria-label="t('回到顶部')">
        <img :src="art('logo.webp')" :alt="t('萌动链接：PeroperoChat！')" />
      </a>
      <div class="links">
        <a href="#choose">{{ t('伙伴') }}</a>
        <a href="#day">{{ t('日常') }}</a>
        <a href="#together">{{ t('据点') }}</a>
        <a :href="LINKS.mobile" target="_blank" rel="noopener noreferrer">{{ t('移动端') }}</a>
        <a :href="LINKS.docs" target="_blank" rel="noopener noreferrer">{{ t('文档') }}</a>
      </div>
      <LanguageMenu class="language" :solid="scrolled" />
      <button
        type="button"
        class="fx"
        :aria-pressed="!fxOff"
        :title="t(fxOff ? '打开特效' : '关闭特效')"
        @click="toggleFx"
      >
        {{ t(fxOff ? '特效：关' : '特效：开') }}
      </button>
      <a class="btn nav-cta" href="#home">{{ t('带她回家') }}</a>
    </nav>

    <main id="top">
      <TitleScreen :started="started" :reduced="reduced" @start="start" />
      <ChooseCompanion
        :selected="selected"
        :reduced="reduced"
        @select="select"
        @poke="burstCenter"
      />
      <DayStory :char="char" :reduced="reduced" />
      <Stronghold :reduced="reduced" />
      <HomeCall :char="char" :reduced="reduced" />
    </main>

    <ParticleField ref="field" :kind="char.particle" :color="char.color" :reduced="reduced" />
    <PeekBuddy :char="char" :enabled="!reduced && started" />

    <Transition name="party">
      <div v-if="party" class="party" aria-live="polite">
        <img :src="art('group.webp')" :alt="t('四位伙伴一起向你挥手')" />
        <p>{{ t('秘籍达成！全员集合~') }}</p>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import TitleScreen from './components/TitleScreen.vue'
import ChooseCompanion from './components/ChooseCompanion.vue'
import DayStory from './components/DayStory.vue'
import Stronghold from './components/Stronghold.vue'
import HomeCall from './components/HomeCall.vue'
import ParticleField from './components/ParticleField.vue'
import PeekBuddy from './components/PeekBuddy.vue'
import LanguageMenu from './components/LanguageMenu.vue'
import { byId, characters, useCharacters, type CharId } from './characters'
import { LINKS, art, preload } from './assets'
import { useReducedMotion } from './composables/motion'
import { locale, t } from './i18n'

const STORE_CHAR = 'pero-site-companion'
const STORE_FX = 'pero-site-fx-off'

const systemReduced = useReducedMotion()
const fxOff = ref(false)
const reduced = computed(() => systemReduced.value || fxOff.value)

const selected = ref<CharId>('pero')
const { localizedById } = useCharacters()
const char = computed(() => localizedById.value[selected.value])
const started = ref(false)
const scrolled = ref(false)
const party = ref(false)
const field = ref<InstanceType<typeof ParticleField> | null>(null)

watchEffect(() => {
  document.documentElement.lang = locale.value
  document.title = t('萌动链接：PeroperoChat！')
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('网站描述'))
  document
    .querySelector('meta[property="og:title"]')
    ?.setAttribute('content', t('萌动链接：PeroperoChat！'))
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', t('分享描述'))
})

// 主题色写成 CSS 变量，配合 @property 平滑过渡
const theme = computed(() => ({
  '--c': char.value.color,
  '--c-soft': char.value.soft,
  '--c-deep': char.value.deep,
}))

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式下写不进去时忽略，只影响下次是否记住
  }
}

function select(id: CharId) {
  selected.value = id
  save(STORE_CHAR, id)
  burstCenter()
}

function start() {
  started.value = true
  burstCenter()
}

function burstCenter() {
  field.value?.burst(window.innerWidth / 2, window.innerHeight / 2, 22)
}

function toggleFx() {
  fxOff.value = !fxOff.value
  save(STORE_FX, fxOff.value ? '1' : '0')
}

function onScroll() {
  scrolled.value = window.scrollY > 40
  if (!started.value && window.scrollY > window.innerHeight * 0.3) started.value = true
}

// 彩蛋：↑↑↓↓←→←→BA 召集全员
const KONAMI = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
]
let pos = 0
let partyTimer: ReturnType<typeof setTimeout> | undefined
function onKey(e: KeyboardEvent) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  pos = k === KONAMI[pos] ? pos + 1 : k === KONAMI[0] ? 1 : 0
  if (pos < KONAMI.length) return
  pos = 0
  party.value = true
  for (let i = 0; i < 5; i++) {
    setTimeout(
      () =>
        field.value?.burst(
          Math.random() * window.innerWidth,
          Math.random() * window.innerHeight * 0.7,
          18,
        ),
      i * 180,
    )
  }
  clearTimeout(partyTimer)
  partyTimer = setTimeout(() => (party.value = false), 3200)
}

onMounted(() => {
  try {
    const saved = localStorage.getItem(STORE_CHAR) as CharId | null
    if (saved && saved in byId) selected.value = saved
    fxOff.value = localStorage.getItem(STORE_FX) === '1'
  } catch {
    // 读不到就用默认值
  }
  // 首屏之后再预加载其他角色，切换时不闪白
  preload(
    characters.flatMap((c) => [
      `${c.id}-sprite.webp`,
      `${c.id}-face-closed.webp`,
      `${c.id}-face-blink.webp`,
    ]),
  )
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('keydown', onKey)
  clearTimeout(partyTimer)
})
</script>

<style scoped>
.app {
  transition:
    --c 0.6s,
    --c-soft 0.6s,
    --c-deep 0.6s;
}

.nav {
  position: fixed;
  top: 12px;
  left: 50%;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 18px;
  width: min(1180px, calc(100% - 24px));
  padding: 8px 10px 8px 16px;
  border-radius: 999px;
  transform: translateX(-50%);
  transition:
    background 0.3s,
    box-shadow 0.3s;
}

.nav.solid {
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 10px 30px rgba(30, 20, 80, 0.16);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
}

.brand img {
  height: 40px;
  width: auto;
}

.links {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.links a {
  padding: 8px 14px;
  font-size: 15px;
  font-weight: 800;
  text-decoration: none;
  color: #fff;
  border-radius: 999px;
  text-shadow: 0 2px 6px rgba(30, 20, 80, 0.45);
  transition:
    background 0.2s,
    color 0.2s;
}

.solid .links a {
  color: var(--ink);
  text-shadow: none;
}

.links a:hover {
  color: var(--c-deep);
  background: var(--c-soft);
  text-shadow: none;
}

.fx {
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 800;
  color: #fff;
  border-radius: 999px;
  border: 2px solid rgba(255, 255, 255, 0.7);
}

.solid .fx {
  color: var(--c-deep);
  border-color: var(--c-soft);
}

.nav-cta {
  height: 44px;
  padding: 0 22px;
  font-size: 15px;
}

.party {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: rgba(30, 20, 70, 0.55);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  pointer-events: none;
}

.party img {
  width: min(900px, 92vw);
  border-radius: 28px;
  border: 6px solid #fff;
  box-shadow: 0 30px 60px rgba(10, 5, 40, 0.5);
}

.party p {
  margin: 0;
  font-size: 28px;
  font-weight: 900;
  color: #fff;
  text-shadow: 0 4px 0 var(--c-deep);
}

.party-enter-active {
  transition:
    opacity 0.3s,
    transform 0.5s cubic-bezier(0.3, 1.7, 0.5, 1);
}

.party-leave-active {
  transition: opacity 0.4s;
}

.party-enter-from {
  opacity: 0;
  transform: scale(0.7);
}

.party-leave-to {
  opacity: 0;
}

@media (max-width: 1100px) {
  .links {
    display: none;
  }
  .brand img {
    height: 32px;
  }
  .language {
    margin-left: auto;
  }
}

@media (max-width: 480px) {
  .nav {
    gap: 6px;
    padding-left: 10px;
  }
  .brand img {
    height: 26px;
  }
  .fx {
    padding: 6px;
    font-size: 12px;
  }
  .nav-cta {
    display: none;
  }
}
</style>
