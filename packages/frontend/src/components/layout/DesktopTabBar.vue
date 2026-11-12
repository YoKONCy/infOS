<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useSelectionIndicator } from '../../composables/ui/useSelectionIndicator'
import type { DesktopTab } from '@infos/shared'
import { PixelIcon } from '../pixel'
import { invoke, listen } from '../../utils/ipcAdapter'
import InfosLogo from '../brands/InfosLogo.vue'

const props = defineProps<{ tabs: DesktopTab[]; activeTabId: string; theme: 'light' | 'dark' }>()
const emit = defineEmits<{
  activate: [id: string]
  close: [id: string]
  create: []
  theme: []
  update: []
}>()
const maximized = ref(false)
const strip = ref<HTMLElement | null>(null)
const selection = useSelectionIndicator(
  strip,
  computed(() => props.activeTabId),
)
let disposed = false
let unlisten: (() => void) | undefined

async function toggleMaximize(): Promise<void> {
  maximized.value = Boolean(await invoke('window-maximize'))
}

function onTabKey(event: KeyboardEvent, index: number): void {
  let target: number | undefined
  if (event.key === 'ArrowRight') target = (index + 1) % props.tabs.length
  else if (event.key === 'ArrowLeft') target = (index + props.tabs.length - 1) % props.tabs.length
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = props.tabs.length - 1
  if (target === undefined) return
  event.preventDefault()
  const tab = props.tabs[target]
  if (tab) emit('activate', tab.id)
  strip.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus()
}

watch(
  () => props.activeTabId,
  async () => {
    await nextTick()
    strip.value
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
)

onMounted(async () => {
  try {
    maximized.value = Boolean(await invoke('window-is-maximized'))
    const stop = await listen('window-maximized-state-changed', (value) => {
      maximized.value = Boolean(value)
    })
    if (disposed) stop()
    else unlisten = stop
  } catch {
    /* 窗口关闭或重载时无需展示错误。 */
  }
})
onUnmounted(() => {
  disposed = true
  unlisten?.()
})
</script>

<template>
  <header class="desktop-tabbar" :aria-label="__t('ui.layout', '应用标签栏')">
    <div
      ref="strip"
      class="desktop-tab-strip"
      role="tablist"
      :aria-label="__t('ui.layout', '已打开的应用')"
    >
      <div
        class="desktop-tab-selection"
        :class="{ 'is-ready': selection.ready.value }"
        :style="selection.style.value"
        aria-hidden="true"
      />
      <div
        v-for="(tab, index) in tabs"
        :key="tab.id"
        :data-motion-item="tab.id"
        class="desktop-tab"
        :class="{ 'is-active': tab.id === activeTabId, 'is-home': tab.kind === 'home' }"
        @auxclick.middle.prevent="tab.kind !== 'home' && emit('close', tab.id)"
      >
        <button
          :id="`desktop-tab-${tab.id}`"
          class="desktop-tab-label"
          type="button"
          role="tab"
          :aria-selected="tab.id === activeTabId"
          :aria-controls="
            tab.kind === 'home'
              ? 'desktop-home-panel'
              : tab.kind === 'tarot'
                ? 'desktop-tarot-panel'
                : 'desktop-app-panel'
          "
          :tabindex="tab.id === activeTabId ? 0 : -1"
          :title="tab.title"
          @click="emit('activate', tab.id)"
          @keydown="onTabKey($event, index)"
        >
          <InfosLogo
            v-if="tab.kind === 'home'"
            variant="mark"
            class="desktop-brand-icon"
            aria-hidden="true"
          />
          <PixelIcon
            v-else
            :name="tab.loading ? 'refresh' : tab.icon"
            size="sm"
            :animation="tab.loading ? 'spin' : ''"
          />
          <InfosLogo v-if="tab.kind === 'home'" variant="wordmark" class="desktop-brand-wordmark" />
          <span v-else class="desktop-tab-title">{{ tab.title }}</span>
          <span
            v-if="tab.locked"
            class="desktop-tab-busy"
            :title="__t('ui.layout', 'Agent 操作中')"
            :aria-label="__t('ui.layout', 'Agent 操作中')"
          />
          <span
            v-else-if="tab.dirty"
            class="desktop-tab-dirty"
            :title="__t('ui.layout', '有未提交的草稿')"
            :aria-label="__t('ui.layout', '有未提交的草稿')"
          />
        </button>
        <button
          v-if="tab.kind !== 'home'"
          class="desktop-tab-close"
          type="button"
          :aria-label="__t('ui.layout', '关闭 {0}', [tab.title])"
          @click="emit('close', tab.id)"
        >
          <PixelIcon name="close" size="xs" />
        </button>
      </div>
    </div>
    <button
      class="desktop-bar-button desktop-new-tab"
      type="button"
      :title="__t('ui.layout', '新标签页（Ctrl+T）')"
      :aria-label="__t('ui.layout', '新建标签页')"
      @click="emit('create')"
    >
      <PixelIcon name="plus" size="sm" />
    </button>
    <div class="desktop-drag-space" />
    <div class="desktop-global-actions">
      <button
        class="desktop-bar-button"
        type="button"
        :title="theme === 'light' ? __t('ui.layout', '切换到深色') : __t('ui.layout', '切换到浅色')"
        :aria-label="__t('ui.layout', '切换深浅主题')"
        @click="emit('theme')"
      >
        <PixelIcon :name="theme === 'light' ? 'moon' : 'sun'" size="sm" />
      </button>
      <button
        class="desktop-bar-button"
        type="button"
        :title="__t('ui.layout', '应用更新中心')"
        :aria-label="__t('ui.layout', '打开应用更新中心')"
        @click="emit('update')"
      >
        <PixelIcon name="download" size="sm" />
      </button>
      <span class="desktop-controls-divider" />
      <button
        class="desktop-bar-button desktop-window-button"
        type="button"
        :title="__t('ui.layout', '最小化')"
        :aria-label="__t('ui.layout', '最小化窗口')"
        @click="invoke('window-minimize')"
      >
        <PixelIcon name="minus" size="sm" />
      </button>
      <button
        class="desktop-bar-button desktop-window-button"
        type="button"
        :title="maximized ? __t('ui.layout', '还原') : __t('ui.layout', '最大化')"
        :aria-label="maximized ? __t('ui.layout', '还原窗口') : __t('ui.layout', '最大化窗口')"
        @click="toggleMaximize"
      >
        <PixelIcon :name="maximized ? 'copy' : 'square'" size="sm" />
      </button>
      <button
        class="desktop-bar-button desktop-window-button desktop-window-close"
        type="button"
        :title="__t('ui.layout', '关闭窗口')"
        :aria-label="__t('ui.layout', '关闭窗口')"
        @click="invoke('window-close')"
      >
        <PixelIcon name="close" size="sm" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.desktop-tabbar {
  height: 44px;
  flex: 0 0 44px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0 4px 8px;
  box-sizing: border-box;
  color: var(--ui-text-secondary);
  background: var(--ui-bg-surface);
  border-bottom: 1px solid var(--ui-border-default);
  user-select: none;
  -webkit-app-region: drag;
}
.desktop-tab-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-app-region: no-drag;
}
.desktop-tab-strip::-webkit-scrollbar {
  display: none;
}
.desktop-tab {
  display: flex;
  align-items: center;
  flex: 0 1 200px;
  min-width: 104px;
  height: 34px;
  border: 1px solid transparent;
  border-radius: 9px;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.desktop-tab:hover {
  background: color-mix(in srgb, var(--ui-text-primary) 4%, transparent);
}
.desktop-tab.is-active {
  background: var(--ui-bg-canvas);
  color: var(--ui-text-primary);
  border-color: color-mix(in srgb, var(--ui-accent-purple) 24%, var(--ui-border-default));
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--ui-accent-purple) 58%, transparent);
}
.desktop-tab.is-home {
  flex-shrink: 0;
  min-width: 160px;
}
.desktop-tab-label {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 9px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}
.desktop-tab-label :deep(.pixel-icon) {
  flex-shrink: 0;
}
.desktop-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desktop-brand-icon {
  width: 21px;
  height: 21px;
  object-fit: contain;
}

.desktop-brand-wordmark {
  width: 64px;
  height: 21px;
}
.desktop-tab-close {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 23px;
  height: 23px;
  margin-right: 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
}
.desktop-tab-close:hover {
  background: color-mix(in srgb, var(--ui-text-primary) 9%, transparent);
  color: var(--ui-text-primary);
}
.desktop-tab-busy {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: var(--ui-accent-purple);
}
.desktop-tab-dirty {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-accent-primary);
}
.desktop-drag-space {
  flex: 1;
  min-width: 24px;
  align-self: stretch;
}
.desktop-global-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  height: 100%;
  -webkit-app-region: no-drag;
}
.desktop-bar-button {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 32px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.desktop-tab-close,
.desktop-bar-button {
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-instant) var(--ui-ease-standard);
}
.desktop-bar-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent-purple) 12%, transparent);
  color: var(--ui-text-primary);
}
.desktop-tab-close:active,
.desktop-bar-button:active:not(:disabled) {
  transform: translateY(1px);
}
.desktop-bar-button:disabled {
  opacity: 0.5;
  cursor: default;
}
.desktop-window-button {
  width: 42px;
  border-radius: 0;
}
.desktop-window-close:hover {
  background: #e05268;
  color: #fff;
}
.desktop-controls-divider {
  width: 1px;
  height: 16px;
  margin: 0 6px;
  background: var(--ui-border-default);
}
button:focus-visible {
  outline: 2px solid var(--ui-accent-purple);
  outline-offset: -2px;
}
@media (prefers-reduced-motion: reduce) {
  .desktop-tab {
    transition: none;
  }
}
</style>

<style scoped>
.desktop-tab-strip {
  position: relative;
}
.desktop-tab {
  position: relative;
  z-index: 1;
}
.desktop-tab-selection {
  position: absolute;
  inset: 0 auto auto 0;
  pointer-events: none;
  border-radius: 9px;
  background: var(--ui-bg-canvas);
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 24%, var(--ui-border-default));
  box-shadow:
    inset 0 -2px 0 color-mix(in srgb, var(--ui-accent-purple) 58%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--ui-text-primary) 5%, transparent);
}
.desktop-tab-selection.is-ready {
  transition:
    transform 360ms cubic-bezier(0.16, 1, 0.3, 1),
    width 280ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 120ms ease;
}
.desktop-tab.is-active {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
@media (prefers-reduced-motion: reduce) {
  .desktop-tab-selection.is-ready {
    transition: opacity 100ms ease;
  }
}
[data-motion='reduced'] .desktop-tab-selection.is-ready {
  transition: opacity 100ms ease;
}
[data-motion='off'] .desktop-tab-selection.is-ready {
  transition: none;
}
</style>
