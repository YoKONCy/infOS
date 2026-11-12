<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * MainNav — MainView 左侧常驻紧凑主导航
 *
 * - 顶部: infOS 品牌图形 + 字标 + PEROPEROCHAT 英文副标
 * - 中间: 常驻核心入口（对话、据点、工作区、伙伴、记忆馆、任务，桌面端含卡片）
 * - 底部: 固定「设置」入口（打开居中模态设置中心）+ 主题切换（Web）
 *
 * 桌面端保持常驻紧凑宽度（--ui-nav-collapsed-width），切换页面时永不跳动宽度；
 * 移动端抽屉打开（expanded=true）时自动切为横向完整布局。
 */
import { PixelIcon } from '../pixel'
import { computed, ref } from 'vue'
import { useSelectionIndicator } from '../../composables/ui/useSelectionIndicator'
import { useMainNav, type MainNavItem } from '../../composables/main/useMainNav'
import { useApprovalStore } from '../../stores'
import InfosLogo from '../brands/InfosLogo.vue'
import NavDetachMenu from '../shell/NavDetachMenu.vue'
import { useDetachedPanels } from '../../composables/shell/useDetachedPanels'

const props = withDefaults(
  defineProps<{ showThemeToggle?: boolean; expanded?: boolean; tutorial?: boolean }>(),
  {
    showThemeToggle: true,
    expanded: false,
    tutorial: false,
  },
)
const emit = defineEmits<{ navigate: [] }>()

const {
  activeNavTab,
  pendingTab,
  settingsOpen,
  activeSettingsSection,
  primaryNavItems,
  setTab,
  openSettings,
  prefetchTab,
  theme,
  toggleTheme,
} = useMainNav()

/** 桌面端常驻紧凑轨；仅移动端抽屉（expanded=true）使用宽横向模式 */
const isRailCompact = computed(() => !props.expanded)
const approvalStore = useApprovalStore()
const shell = useDetachedPanels()
const detachMenu = ref<InstanceType<typeof NavDetachMenu> | null>(null)
const navigationRoot = ref<HTMLElement | null>(null)
const selection = useSelectionIndicator(
  navigationRoot,
  computed(() => (settingsOpen.value ? '' : activeNavTab.value)),
)

function navigateTab(id: MainNavItem['id']) {
  void setTab(id)
  emit('navigate')
}

function prefetchSettings() {
  prefetchTab(activeSettingsSection.value)
}

function handleOpenSettings() {
  void openSettings()
  emit('navigate')
}

function itemClasses(item: MainNavItem): string[] {
  const isActive = !settingsOpen.value && activeNavTab.value === item.id
  const classes = ['main-nav-item']
  if (isActive) classes.push('main-nav-item--active')
  if (pendingTab.value === item.id) classes.push('main-nav-item--pending')
  if (item.disabled) classes.push('main-nav-item--disabled')
  return classes
}
</script>

<template>
  <aside class="main-nav" :class="{ 'main-nav--rail': isRailCompact }">
    <!-- 像素纹理背景层 -->
    <div class="main-nav-pixel-bg" />

    <!-- 品牌标识：常驻保留 infOS 字标与 PEROPEROCHAT 英文副标 -->
    <div class="main-nav-brand">
      <div class="main-nav-logo">
        <InfosLogo variant="mark" />
      </div>
      <div class="main-nav-brand-text">
        <InfosLogo class="main-nav-wordmark" variant="wordmark" />
        <span class="main-nav-brand-sub">PEROPEROCHAT</span>
      </div>
    </div>

    <!-- 6 个一级常驻主导航项 -->
    <nav
      ref="navigationRoot"
      class="main-nav-list main-nav-list--motion"
      :aria-label="__t('ui.navigation', '主导航')"
    >
      <div
        class="main-nav-selection"
        :class="{ 'is-ready': selection.ready.value }"
        :style="selection.style.value"
        aria-hidden="true"
      />
      <button
        v-for="item in primaryNavItems"
        :key="item.id"
        type="button"
        :data-motion-item="item.id"
        :data-onboarding-nav="item.id"
        :class="itemClasses(item)"
        :disabled="item.disabled"
        :aria-current="!settingsOpen && activeNavTab === item.id ? 'page' : undefined"
        :aria-busy="pendingTab === item.id"
        @pointerenter="prefetchTab(item.id)"
        @focus="prefetchTab(item.id)"
        @click="navigateTab(item.id)"
        @contextmenu="item.detachPageId && detachMenu?.open($event, item.detachPageId)"
      >
        <PixelIcon :name="item.icon" size="sm" class="main-nav-item-icon" />
        <span class="main-nav-item-label">{{ item.label }}</span>

        <!-- 全局审批角标：在任意页面都可见 -->
        <span
          v-if="approvalStore.pendingCount && item.id === 'chat'"
          class="main-nav-approval-badge"
          :class="{ 'main-nav-approval-badge--rail': isRailCompact }"
        >
          {{ approvalStore.pendingCount }}
        </span>

        <PixelIcon
          v-if="item.detachPageId && shell.isDetached(item.detachPageId)"
          name="external-link"
          size="xs"
          class="main-nav-detached"
          :class="{ 'main-nav-detached--rail': isRailCompact }"
          :title="__t('ui.desktop-shell', '已摘出到桌面')"
        />
      </button>
    </nav>

    <!-- 底部固定入口：设置中心 + 主题切换 -->
    <div class="main-nav-footer">
      <button
        type="button"
        class="main-nav-item main-nav-settings-btn"
        :class="{ 'main-nav-item--active': settingsOpen }"
        data-onboarding-nav="settings"
        aria-haspopup="dialog"
        :aria-expanded="settingsOpen"
        @pointerenter="prefetchSettings"
        @focus="prefetchSettings"
        @click="handleOpenSettings"
      >
        <PixelIcon name="settings" size="sm" class="main-nav-item-icon" />
        <span class="main-nav-item-label">{{ __t('ui.navigation', '设置') }}</span>
      </button>

      <button
        v-if="showThemeToggle"
        type="button"
        class="main-nav-item main-nav-theme-btn"
        :title="
          theme === 'light'
            ? __t('ui.navigation', '切换到深色')
            : __t('ui.navigation', '切换到浅色')
        "
        @click="toggleTheme"
      >
        <PixelIcon :name="theme === 'light' ? 'moon' : 'sun'" size="sm" class="main-nav-item-icon" />
        <span class="main-nav-item-label">
          {{
            isRailCompact
              ? theme === 'light'
                ? __t('ui.navigation', '深色')
                : __t('ui.navigation', '浅色')
              : theme === 'light'
                ? __t('ui.navigation', '深色模式')
                : __t('ui.navigation', '浅色模式')
          }}
        </span>
      </button>
    </div>

    <NavDetachMenu ref="detachMenu" />
  </aside>
</template>

<style scoped>
.main-nav {
  display: flex;
  flex-direction: column;
  height: 100%;
  flex-shrink: 0;
  position: relative;
  z-index: 20;
  overflow: hidden;
  width: var(--ui-nav-width);
  background: linear-gradient(180deg, rgba(238, 242, 250, 0.96) 0%, rgba(230, 236, 248, 0.98) 100%);
  border-right: 1px solid var(--ui-border-default);
  box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.76);
  backdrop-filter: blur(20px) saturate(1.45);
}

.main-nav--rail {
  width: var(--ui-nav-collapsed-width);
}

[data-theme='dark'] .main-nav {
  background: linear-gradient(180deg, rgba(26, 21, 38, 0.95) 0%, rgba(15, 16, 26, 0.97) 100%);
  border-right: 1px solid rgba(139, 92, 246, 0.15);
  box-shadow: none;
}

.main-nav-pixel-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.014;
  background-image: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    currentColor 2px,
    currentColor 3px
  );
  color: var(--ui-text-secondary);
  z-index: 0;
}

[data-theme='dark'] .main-nav-pixel-bg {
  opacity: 0.03;
  color: var(--ui-accent-primary);
}

/* ── 品牌区 ── */
.main-nav-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 16px 14px;
  position: relative;
  z-index: 1;
  border-bottom: 1px solid var(--ui-border-subtle);
}

[data-theme='dark'] .main-nav-brand {
  border-bottom-color: rgba(139, 92, 246, 0.12);
}

.main-nav-logo {
  width: 34px;
  height: 34px;
  overflow: hidden;
  flex-shrink: 0;
}

.main-nav-logo .infos-logo {
  width: 100%;
  height: 100%;
}

.main-nav-brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.main-nav-wordmark {
  width: 84px;
  height: 26px;
}

.main-nav-brand-sub {
  font-size: 8.5px;
  font-weight: 700;
  color: var(--ui-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  line-height: 1.2;
}

/* 紧凑轨下的纵向品牌排版 */
.main-nav--rail .main-nav-brand {
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 12px 4px 10px;
  text-align: center;
}

.main-nav--rail .main-nav-logo {
  width: 28px;
  height: 28px;
}

.main-nav--rail .main-nav-brand-text {
  align-items: center;
  flex: none;
  width: 100%;
}

.main-nav--rail .main-nav-wordmark {
  width: 52px;
  height: 16px;
}

.main-nav--rail .main-nav-brand-sub {
  margin-top: 2px;
  font-size: 6.5px;
  letter-spacing: 0.03em;
  white-space: nowrap;
  opacity: 0.82;
}

/* ── 导航列表 ── */
.main-nav-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 10px 8px;
  position: relative;
  z-index: 1;
}

.main-nav--rail .main-nav-list {
  padding: 10px 6px;
}

/* ── 导航项 ── */
.main-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border-radius: var(--ui-radius-sm);
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
  text-align: left;
}

/* 紧凑轨：上图标 + 下短标签，直观清晰无需悬停猜测 */
.main-nav--rail .main-nav-item {
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 8px 4px 7px;
  text-align: center;
}

.main-nav-item:hover:not(:disabled):not(.main-nav-item--disabled) {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}

.main-nav-item--pending:not(.main-nav-item--active) {
  color: var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
  box-shadow: inset 2px 0 0 var(--ui-accent-sky);
}

.main-nav-item--pending .main-nav-item-icon {
  animation: nav-pending 0.55s steps(2) infinite;
}

@keyframes nav-pending {
  50% {
    opacity: 0.45;
  }
}

[data-motion='reduced'] .main-nav-item--pending .main-nav-item-icon,
[data-motion='off'] .main-nav-item--pending .main-nav-item-icon {
  animation: none;
}

.main-nav-item--active {
  background: var(--ui-bg-active);
  color: var(--ui-accent-primary);
  font-weight: 600;
  box-shadow:
    inset 3px 0 0 0 var(--ui-accent-primary),
    var(--ui-glow-pink);
}

[data-theme='dark'] .main-nav-item--active {
  background: rgba(139, 92, 246, 0.15);
  color: var(--ui-accent-purple);
  box-shadow:
    inset 3px 0 0 0 var(--ui-accent-purple),
    var(--ui-glow-purple);
}

.main-nav-item--disabled {
  color: var(--ui-text-disabled);
  cursor: not-allowed;
}

.main-nav-item-icon {
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
  transition: color var(--ui-duration-fast);
}

.main-nav-item:hover:not(:disabled) .main-nav-item-icon {
  color: var(--ui-text-primary);
}

.main-nav-item--active .main-nav-item-icon {
  color: var(--ui-accent-primary);
}

[data-theme='dark'] .main-nav-item--active .main-nav-item-icon {
  color: var(--ui-accent-purple);
}

.main-nav-item-label {
  font-family: var(--font-pixel);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.main-nav--rail .main-nav-item-label {
  font-size: 10px;
  letter-spacing: 0.02em;
  line-height: 1.2;
}

/* ── 角标与已摘出标识 ── */
.main-nav-detached {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
}

.main-nav-detached--rail {
  position: absolute;
  right: 3px;
  top: 4px;
  margin-left: 0;
}

.main-nav-approval-badge {
  position: absolute;
  top: 4px;
  right: 7px;
  z-index: 2;
  display: grid;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  place-items: center;
  border: 2px solid var(--ui-bg-surface, #fff);
  border-radius: 9px;
  background: #f43f5e;
  color: white;
  font-size: 8px;
  font-weight: 800;
  line-height: 1;
  box-shadow: 0 2px 6px rgba(244, 63, 94, 0.32);
  pointer-events: none;
}

.main-nav-approval-badge--rail {
  top: 3px;
  right: 6px;
}

/* ── 底部固定设置与主题区 ── */
.main-nav-footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-top: 1px solid var(--ui-border-subtle);
  position: relative;
  z-index: 1;
}

.main-nav--rail .main-nav-footer {
  padding: 8px 6px;
}

[data-theme='dark'] .main-nav-footer {
  border-top-color: rgba(139, 92, 246, 0.15);
}

/* ── 选中滑块动效 ── */
.main-nav-selection {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-active);
  box-shadow:
    inset 3px 0 0 var(--ui-accent-primary),
    inset 0 1px 0 color-mix(in srgb, var(--ui-text-primary) 5%, transparent);
}

[data-theme='dark'] .main-nav-selection {
  background: rgba(139, 92, 246, 0.15);
  box-shadow:
    inset 3px 0 0 var(--ui-accent-purple),
    var(--ui-glow-purple);
}

.main-nav-selection.is-ready {
  transition:
    transform 320ms cubic-bezier(0.16, 1, 0.3, 1),
    width 220ms ease,
    height 220ms ease,
    opacity 140ms ease;
}

.main-nav-list--motion .main-nav-item--active,
.main-nav-list--motion .main-nav-item--pending {
  background: transparent;
  box-shadow: none;
}

.main-nav-list--motion .main-nav-item--pending .main-nav-item-icon {
  animation: none;
}

@media (prefers-reduced-motion: reduce) {
  .main-nav,
  .main-nav-selection.is-ready {
    transition: none;
  }
}

[data-motion='reduced'] .main-nav-selection.is-ready {
  transition: opacity 100ms ease;
}

[data-motion='off'] .main-nav-selection.is-ready {
  transition: none;
}
</style>
