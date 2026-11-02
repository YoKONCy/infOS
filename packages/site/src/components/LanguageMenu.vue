<template>
  <div ref="root" class="language-menu" :class="{ solid, open }" @keydown="onKeydown">
    <button
      ref="trigger"
      type="button"
      class="trigger"
      :aria-label="t('选择语言，当前为 {0}', [current.label])"
      aria-haspopup="menu"
      :aria-expanded="open"
      aria-controls="site-language-menu"
      @click="toggle"
    >
      <span class="globe" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="8.25" />
          <path
            d="M3.9 12h16.2M12 3.75c2.3 2.2 3.5 5 3.5 8.25s-1.2 6.05-3.5 8.25C9.7 18.05 8.5 15.25 8.5 12S9.7 5.95 12 3.75Z"
          />
        </svg>
      </span>
      <span class="current">{{ current.label }}</span>
      <svg class="chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m4 6 4 4 4-4" />
      </svg>
    </button>

    <Transition name="menu">
      <div
        v-if="open"
        id="site-language-menu"
        ref="menu"
        class="panel"
        role="menu"
        :aria-label="t('选择语言')"
      >
        <div class="panel-heading" aria-hidden="true">
          <span>{{ t('选择语言') }}</span>
          <span class="heading-star">✦</span>
        </div>
        <button
          v-for="language in languages"
          :key="language.value"
          type="button"
          class="option"
          :class="{ active: locale === language.value }"
          role="menuitemradio"
          tabindex="-1"
          :aria-checked="locale === language.value"
          @click="choose(language.value)"
        >
          <span class="badge" aria-hidden="true">{{ badge[language.value] }}</span>
          <span class="option-label" :lang="language.value">{{ language.label }}</span>
          <svg
            v-if="locale === language.value"
            class="check"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <path d="m5 10 3.2 3.2L15 6.5" />
          </svg>
        </button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { languages, locale, setLocale, t, type SiteLocale } from '../i18n'

defineProps<{ solid: boolean }>()

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const current = computed(
  () => languages.find((language) => language.value === locale.value) ?? languages[0],
)
const badge: Record<SiteLocale, string> = {
  'zh-CN': '简',
  'zh-TW': '繁',
  'en-US': 'EN',
  'ja-JP': '日',
}

function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

async function show() {
  open.value = true
  await nextTick()
  if (open.value) menu.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
}

function toggle() {
  if (open.value) close()
  else void show()
}

function choose(value: SiteLocale) {
  setLocale(value)
  close(true)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    close(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (!open.value) {
    void show()
    return
  }
  const options = [
    ...(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []),
  ]
  if (!options.length) return
  const index = options.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? (index + 1) % options.length
          : index <= 0
            ? options.length - 1
            : index - 1
  options[next]?.focus()
}

function onOutside(event: Event) {
  if (open.value && event.target instanceof Node && !root.value?.contains(event.target)) close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onOutside)
  document.addEventListener('focusin', onOutside)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onOutside)
  document.removeEventListener('focusin', onOutside)
})
</script>

<style scoped>
.language-menu {
  position: relative;
  flex: none;
}

.trigger {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 42px;
  padding: 4px 10px 4px 5px;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.62);
  border-radius: 999px;
  background: rgba(34, 25, 79, 0.36);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.3),
    0 4px 14px rgba(24, 16, 64, 0.12);
  backdrop-filter: blur(10px);
  transition:
    background 0.2s,
    border-color 0.2s,
    transform 0.2s;
}

.trigger:hover,
.open .trigger {
  background: rgba(62, 45, 112, 0.62);
  border-color: #fff;
}

.trigger:active {
  transform: scale(0.97);
}

.solid .trigger {
  color: var(--c-deep);
  border-color: color-mix(in srgb, var(--c) 28%, #fff);
  background: rgba(255, 255, 255, 0.75);
}

.solid .trigger:hover,
.solid.open .trigger {
  background: var(--c-soft);
}

.globe {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--c-deep);
  background: linear-gradient(145deg, #fff, var(--c-soft));
  box-shadow: 0 2px 7px rgba(30, 20, 80, 0.15);
}

.globe svg {
  width: 19px;
  height: 19px;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.current {
  font-size: 13px;
  font-weight: 800;
  white-space: nowrap;
}

.chevron {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.2s;
}

.open .chevron {
  transform: rotate(180deg);
}

.panel {
  position: absolute;
  top: calc(100% + 12px);
  right: 0;
  width: 212px;
  padding: 10px;
  border: 2px solid rgba(255, 255, 255, 0.95);
  border-radius: 22px;
  background: linear-gradient(150deg, #fff, color-mix(in srgb, var(--c-soft) 38%, #fff));
  box-shadow:
    0 18px 45px rgba(27, 17, 77, 0.23),
    0 3px 10px rgba(27, 17, 77, 0.1);
  transform-origin: top right;
}

.panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 9px 8px;
  color: var(--c-deep);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.heading-star {
  color: var(--c);
  font-size: 15px;
}

.option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 9px;
  color: var(--ink);
  text-align: left;
  border-radius: 13px;
  transition:
    background 0.18s,
    color 0.18s;
}

.option:hover,
.option:focus-visible,
.option.active {
  color: var(--c-deep);
  background: color-mix(in srgb, var(--c-soft) 75%, #fff);
}

.badge {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  color: var(--c-deep);
  font-size: 11px;
  font-weight: 900;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 2px 6px rgba(30, 20, 80, 0.08);
}

.option-label {
  flex: 1;
  font-size: 14px;
  font-weight: 800;
}

.check {
  width: 19px;
  height: 19px;
  stroke: var(--c-deep);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.menu-enter-active,
.menu-leave-active {
  transition:
    opacity 0.16s,
    transform 0.2s cubic-bezier(0.2, 1.4, 0.4, 1);
}

.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
}

@media (max-width: 480px) {
  .trigger {
    min-height: 38px;
    gap: 5px;
    padding: 3px 7px 3px 4px;
  }
  .globe {
    width: 27px;
    height: 27px;
  }
  .current {
    font-size: 12px;
  }
  .chevron {
    width: 12px;
    height: 12px;
  }
}
</style>
