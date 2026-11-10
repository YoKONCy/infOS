<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * MainNav — MainView 左侧主导航
 *
 * 极简品牌 + 像素光轨导航:
 * - 顶部: 品牌 Logo + 版本号(可点击收起)
 * - 中间: 三层分组导航(交互/工作台/设置/高级)
 * - 底部: 主题切换
 *
 * 设计语言: Arc 空间层级 + 像素萌系品牌细节
 * - 浅色: 柔和粉蓝渐变背景, 细边框, 低饱和阴影
 * - 深色: 深紫蓝夜空背景, 微发光边框, 霓虹点缀
 *
 * @see .docs/S06_UI_UX_DESIGN_SPEC.md §3.2, §11.4, §14
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
  currentTab,
  pendingTab,
  isNavCollapsed: collapsed,
  isNavPinned,
  navGroups,
  setTab,
  prefetchTab,
  toggleNavPin,
  toggleGroup,
  isGroupExpanded,
  theme,
  toggleTheme,
} = useMainNav()
const isNavCollapsed = computed(() => !props.expanded && !props.tutorial && collapsed.value)
const approvalStore = useApprovalStore()
// 桌面外壳：右键摘出到桌面，已摘出的页面显示标记（仅 Electron）
const shell = useDetachedPanels()
const detachMenu = ref<InstanceType<typeof NavDetachMenu> | null>(null)
const navigationRoot = ref<HTMLElement | null>(null)
const selection = useSelectionIndicator(
  navigationRoot,
  computed(() => pendingTab.value || currentTab.value),
)

// ── 导航项样式 ──

function navigateTab(id: MainNavItem['id']) {
  setTab(id)
  emit('navigate')
}

function itemClasses(item: MainNavItem): string[] {
  const isActive = currentTab.value === item.id
  const classes = ['main-nav-item']
  if (isActive) classes.push('main-nav-item--active')
  if (pendingTab.value === item.id) classes.push('main-nav-item--pending')
  if (item.disabled) classes.push('main-nav-item--disabled')
  return classes
}
</script>

<template>
  <aside class="main-nav" :class="{ 'main-nav--collapsed': isNavCollapsed }">
    <!-- 像素纹理背景层 -->
    <div class="main-nav-pixel-bg" />

    <!-- 品牌标识 + 固定按钮 -->
    <div class="main-nav-brand">
      <div class="main-nav-logo">
        <InfosLogo variant="mark" />
      </div>
      <div v-if="!isNavCollapsed" class="main-nav-brand-text motion-enter-fade">
        <InfosLogo class="main-nav-wordmark" variant="wordmark" />
        <span class="main-nav-brand-sub">PeroperoChat</span>
      </div>
      <!-- 固定/收起切换 -->
      <button
        v-if="!isNavCollapsed"
        type="button"
        class="main-nav-pin"
        :class="{ 'main-nav-pin--pinned': isNavPinned }"
        :title="isNavPinned ? __t('ui.navigation', '取消固定') : __t('ui.navigation', '固定展开')"
        :aria-label="
          isNavPinned ? __t('ui.navigation', '取消固定侧栏') : __t('ui.navigation', '固定展开侧栏')
        "
        :aria-pressed="isNavPinned"
        @click="toggleNavPin"
      >
        <svg
          class="main-nav-pin-glyph"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="miter"
        >
          <path class="main-nav-pin-frame" d="M4 4h16v16H4z M9 4v16" />
          <path
            class="main-nav-pin-arrow"
            d="M16 9l-3 3 3 3"
            :transform="isNavPinned ? undefined : 'translate(29 0) scale(-1 1)'"
          />
        </svg>
      </button>
    </div>

    <!-- 收起态固定按钮 (单独一行) -->
    <div v-if="isNavCollapsed" class="main-nav-pin-row">
      <button
        type="button"
        class="main-nav-pin main-nav-pin--collapsed"
        :class="{ 'main-nav-pin--pinned': isNavPinned }"
        :title="isNavPinned ? __t('ui.navigation', '取消固定') : __t('ui.navigation', '固定展开')"
        :aria-label="
          isNavPinned ? __t('ui.navigation', '取消固定侧栏') : __t('ui.navigation', '固定展开侧栏')
        "
        :aria-pressed="isNavPinned"
        @click="toggleNavPin"
      >
        <svg
          class="main-nav-pin-glyph"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="miter"
        >
          <path class="main-nav-pin-frame" d="M4 4h16v16H4z M9 4v16" />
          <path
            class="main-nav-pin-arrow"
            d="M16 9l-3 3 3 3"
            :transform="isNavPinned ? undefined : 'translate(29 0) scale(-1 1)'"
          />
        </svg>
      </button>
    </div>

    <!-- 导航分组 -->
    <nav ref="navigationRoot" class="main-nav-list main-nav-list--motion">
      <div
        class="main-nav-selection"
        :class="{ 'is-ready': selection.ready.value }"
        :style="selection.style.value"
        aria-hidden="true"
      />
      <div v-for="group in navGroups" :key="group.id" class="main-nav-group">
        <!-- 分组标题 -->
        <button
          v-if="group.title"
          class="main-nav-group-title"
          :class="{ 'main-nav-group-title--expanded': tutorial || isGroupExpanded(group.id) }"
          @click="group.collapsible && toggleGroup(group.id)"
        >
          <span v-if="!isNavCollapsed" class="main-nav-group-label motion-enter-fade">
            {{ group.title }}
          </span>
          <PixelIcon
            v-if="group.collapsible"
            :name="tutorial || isGroupExpanded(group.id) ? 'chevron-up' : 'chevron-down'"
            size="xs"
            class="main-nav-group-chevron"
          />
        </button>

        <!-- 导航项 -->
        <template v-if="tutorial || !group.collapsible || isGroupExpanded(group.id)">
          <button
            v-for="item in group.items"
            :key="item.id"
            :data-motion-item="item.id"
            class="motion-enter-fade"
            :data-onboarding-nav="item.id"
            :class="itemClasses(item)"
            :disabled="item.disabled"
            :aria-current="currentTab === item.id ? 'page' : undefined"
            :aria-busy="pendingTab === item.id"
            @pointerenter="prefetchTab(item.id)"
            @focus="prefetchTab(item.id)"
            @click="navigateTab(item.id)"
            @contextmenu="detachMenu?.open($event, item.id)"
          >
            <PixelIcon :name="item.icon" size="sm" class="main-nav-item-icon" />

            <span v-if="!isNavCollapsed" class="main-nav-item-label motion-enter-fade">
              {{ item.label }}
            </span>
            <!-- 全局审批角标：在任意 Tab 都可见，不归属于工作区。 -->
            <span
              v-if="approvalStore.pendingCount && item.id === 'chat'"
              class="main-nav-approval-badge"
              :class="{ 'main-nav-approval-badge--collapsed': isNavCollapsed }"
            >
              {{ approvalStore.pendingCount }}
            </span>

            <PixelIcon
              v-if="shell.isDetached(item.id)"
              name="external-link"
              size="xs"
              class="main-nav-detached"
              :class="{ 'main-nav-detached--collapsed': isNavCollapsed }"
              :title="__t('ui.desktop-shell', '已摘出到桌面')"
            />

            <!-- 收起态 Tooltip -->
            <span v-if="isNavCollapsed" class="main-nav-tooltip">{{ item.label }}</span>
          </button>
        </template>
      </div>
    </nav>

    <!-- 底部区域 -->
    <div v-if="showThemeToggle" class="main-nav-footer">
      <button
        class="main-nav-theme-btn"
        :title="
          theme === 'light'
            ? __t('ui.navigation', '切换到深色')
            : __t('ui.navigation', '切换到浅色')
        "
        @click="toggleTheme"
      >
        <PixelIcon :name="theme === 'light' ? 'moon' : 'sun'" size="sm" />
        <span v-if="!isNavCollapsed" class="main-nav-item-label motion-enter-fade">
          {{
            theme === 'light' ? __t('ui.navigation', '深色模式') : __t('ui.navigation', '浅色模式')
          }}
        </span>
      </button>
    </div>
    <NavDetachMenu ref="detachMenu" />
  </aside>
</template>

<style scoped>
.main-nav-detached {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
}

.main-nav-detached--collapsed {
  position: absolute;
  right: 3px;
  bottom: 3px;
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

.main-nav-approval-badge--collapsed {
  top: 2px;
  right: 2px;
}

/* ═══════════════════════════════════════════════════════════════
 * 导航容器
 * ═══════════════════════════════════════════════════════════════ */

.main-nav {
  display: flex;
  flex-direction: column;
  height: 100%;
  flex-shrink: 0;
  position: relative;
  z-index: 20;
  overflow: hidden;
  width: var(--ui-nav-width);

  /* 宽度不做过渡：它会让右侧复杂页面在每一帧重新布局。 */
  background: linear-gradient(180deg, rgba(254, 242, 248, 0.9) 0%, rgba(240, 249, 255, 0.92) 100%);
  border-right: 1px solid var(--ui-border-subtle);
  backdrop-filter: blur(20px) saturate(1.1);
}

/* 深色: 深紫蓝夜空 */
[data-theme='dark'] .main-nav {
  background: linear-gradient(180deg, rgba(26, 21, 38, 0.95) 0%, rgba(15, 16, 26, 0.97) 100%);
  border-right: 1px solid rgba(139, 92, 246, 0.15);
}

/* 像素噪点纹理(极轻) */
.main-nav-pixel-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.03;
  background-image: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    currentColor 2px,
    currentColor 3px
  );
  color: var(--ui-accent-primary);
  z-index: 0;
}

/* ═══════════════════════════════════════════════════════════════
 * 品牌区
 * ═══════════════════════════════════════════════════════════════ */

.main-nav-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 16px 16px;
  position: relative;
  z-index: 1;
}

.main-nav-logo {
  width: 36px;
  height: 36px;
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

.main-nav-brand-sub {
  font-size: 9px;
  font-weight: 700;
  color: var(--ui-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.main-nav-wordmark {
  width: 90px;
  height: 29px;
}

/* ═══════════════════════════════════════════════════════════════
 * 固定按钮
 * ═══════════════════════════════════════════════════════════════ */

.main-nav-pin {
  --pin-accent: var(--ui-accent-primary);
  --pin-soft: var(--ui-accent-primary-soft);
  position: relative;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-secondary);
  cursor: pointer;
  border-radius: 0;
  border: 1px solid var(--ui-border-default);
  box-shadow:
    inset 0 1px 0 var(--ui-bg-surface),
    1px 1px 0 var(--ui-border-subtle);
  transition:
    background-color 120ms steps(3),
    border-color 120ms steps(3),
    color 120ms steps(3),
    box-shadow 120ms steps(3);
  flex-shrink: 0;
}

.main-nav-pin:hover {
  color: var(--pin-accent);
  border-color: var(--pin-accent);
  background: var(--pin-soft);
  box-shadow:
    inset 0 1px 0 var(--ui-bg-surface),
    1px 1px 0 color-mix(in srgb, var(--pin-accent) 20%, transparent);
}

.main-nav-pin:active {
  transform: translateY(1px);
  box-shadow: inset 0 1px 2px var(--ui-border-default);
}

.main-nav-pin:focus-visible {
  outline: 2px solid var(--pin-accent);
  outline-offset: 4px;
}

.main-nav-pin-glyph {
  width: 20px;
  height: 20px;
}

.main-nav-pin-frame {
  opacity: 0.65;
}
.main-nav-pin-arrow {
  stroke: currentColor;
}
.main-nav-pin:hover .main-nav-pin-frame {
  opacity: 1;
}

.main-nav-pin--pinned {
  color: var(--pin-accent);
  background: var(--pin-soft);
  border-color: color-mix(in srgb, var(--pin-accent) 45%, var(--ui-border-default));
}

[data-theme='dark'] .main-nav-pin {
  --pin-accent: var(--ui-accent-purple);
  --pin-soft: var(--ui-accent-purple-soft);
}

/* 收起态: 单独一行居中 */
.main-nav-pin-row {
  display: flex;
  justify-content: center;
  padding: 0 0 8px;
  position: relative;
  z-index: 1;
}

.main-nav-pin--collapsed {
  width: 32px;
  height: 28px;
  color: var(--pin-accent);
}

@media (prefers-reduced-motion: reduce) {
  .main-nav-pin {
    transition: none;
  }
}

[data-motion='off'] .main-nav-pin,
[data-motion='reduced'] .main-nav-pin {
  transition: none;
}

/* ═══════════════════════════════════════════════════════════════
 * 导航列表
 * ═══════════════════════════════════════════════════════════════ */

.main-nav-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 4px 10px 12px;
  position: relative;
  z-index: 1;
}

/* ═══════════════════════════════════════════════════════════════
 * 分组
 * ═══════════════════════════════════════════════════════════════ */

.main-nav-group {
  margin-bottom: 10px;
}

.main-nav-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 8px 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--ui-radius-xs);
  transition: background-color var(--ui-duration-fast) var(--ui-ease-standard);
}

.main-nav-group-title:hover {
  background: var(--ui-bg-hover);
}

.main-nav-group-label {
  font-size: 9px;
  font-weight: 800;
  color: var(--ui-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.18em;
}

.main-nav-group-chevron {
  color: var(--ui-text-tertiary);
  transition: transform var(--ui-duration-fast);
}

.main-nav-group-title--expanded .main-nav-group-chevron {
  transform: rotate(180deg);
}

/* ═══════════════════════════════════════════════════════════════
 * 导航项
 * ═══════════════════════════════════════════════════════════════ */

.main-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
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
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
  margin-bottom: 1px;
  text-align: left;
}

.main-nav-item:hover:not(:disabled):not(.main-nav-item--disabled) {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
  transform: translateX(var(--ui-motion-distance-sm));
}

.main-nav-item:active:not(:disabled):not(.main-nav-item--disabled) {
  transform: translateX(var(--ui-motion-distance-sm)) scale(var(--ui-motion-scale-press));
}

/* 首次加载时旧页面保持可见，仅目标项显示低成本状态反馈。 */
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

/* 选中态: 像素光轨 + 发光 */
.main-nav-item--active {
  background: var(--ui-bg-active);
  color: var(--ui-accent-primary);
  font-weight: 600;
  /* 像素光轨效果 */
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

/* 像素光轨动画 */
.main-nav-item-trail {
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  background: var(--ui-accent-primary);
  border-radius: 0 2px 2px 0;
}

[data-theme='dark'] .main-nav-item-trail {
  background: var(--ui-accent-purple);
  box-shadow: 0 0 8px rgba(167, 139, 250, 0.5);
}

.main-nav-item--disabled {
  color: var(--ui-text-disabled);
  cursor: not-allowed;
}

.main-nav-item--disabled:hover {
  background: transparent;
  color: var(--ui-text-disabled);
}

/* 图标 */
.main-nav-item-icon {
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
  transition: color var(--ui-duration-fast);
}

.main-nav-item--active .main-nav-item-icon {
  color: var(--ui-accent-primary);
}

[data-theme='dark'] .main-nav-item--active .main-nav-item-icon {
  color: var(--ui-accent-purple);
}

/* 标签 */
.main-nav-item-label {
  font-family: var(--font-pixel);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ═══════════════════════════════════════════════════════════════
 * 收起态
 * ═══════════════════════════════════════════════════════════════ */

.main-nav--collapsed {
  width: var(--ui-nav-collapsed-width);
}

.main-nav--collapsed .main-nav-item {
  justify-content: center;
  padding: 10px;
}

/* 收起态: 品牌区只显示 Logo 居中 */
.main-nav--collapsed .main-nav-brand {
  justify-content: center;
  padding: 16px 12px 12px;
}

/* 收起态 Tooltip */
.main-nav-tooltip {
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%);
  padding: 5px 12px;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-sm);
  font-size: 11px;
  font-weight: 600;
  color: var(--ui-text-primary);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--ui-duration-fast),
    transform var(--ui-duration-fast);
  z-index: var(--ui-z-tooltip);
  box-shadow: var(--ui-shadow-md);
}

.main-nav--collapsed .main-nav-item:hover .main-nav-tooltip,
.main-nav--collapsed .main-nav-item:focus-visible .main-nav-tooltip {
  opacity: 1;
  transform: translateY(-50%) translateX(2px);
}

/* ═══════════════════════════════════════════════════════════════
 * 底部区域
 * ═══════════════════════════════════════════════════════════════ */

.main-nav-footer {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px;
  border-top: 1px solid var(--ui-border-subtle);
  position: relative;
  z-index: 1;
}

[data-theme='dark'] .main-nav-footer {
  border-top-color: rgba(139, 92, 246, 0.15);
}

.main-nav-version-btn,
.main-nav-theme-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  border-radius: var(--ui-radius-sm);
  font-size: 12px;
  font-weight: 500;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}

.main-nav-version-btn {
  color: var(--ui-accent-sky, #0ea5e9);
  border: 1px solid color-mix(in srgb, var(--ui-accent-sky, #0ea5e9) 24%, transparent);
  background: color-mix(in srgb, var(--ui-accent-sky, #0ea5e9) 5%, transparent);
}

.main-nav-version-copy {
  min-width: 0;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.main-nav-version-label {
  color: var(--ui-text-secondary);
}

.main-nav-version-value {
  font-size: 8px;
  color: var(--ui-accent-sky, #0ea5e9);
}

.main-nav-version-btn:hover,
.main-nav-theme-btn:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}

.main-nav-version-btn:hover {
  border-color: var(--ui-accent-sky, #0ea5e9);
  box-shadow: 2px 2px 0 color-mix(in srgb, var(--ui-accent-sky, #0ea5e9) 18%, transparent);
}

.main-nav-version-btn:disabled {
  opacity: 0.55;
  cursor: default;
  box-shadow: none;
}

.main-nav--collapsed .main-nav-version-copy {
  display: none;
}

.main-nav--collapsed .main-nav-version-btn:hover .main-nav-tooltip,
.main-nav--collapsed .main-nav-version-btn:focus-visible .main-nav-tooltip {
  opacity: 1;
  transform: translateY(-50%) translateX(2px);
}

/* 减少动画偏好 */
@media (prefers-reduced-motion: reduce) {
  .main-nav {
    transition: none;
  }
}
</style>

<style scoped>
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
.main-nav-selection.is-ready {
  transition:
    transform 360ms cubic-bezier(0.16, 1, 0.3, 1),
    width 260ms ease,
    height 260ms ease,
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
.main-nav-list--motion .main-nav-item:hover,
.main-nav-list--motion .main-nav-item:active {
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .main-nav-selection.is-ready {
    transition: opacity 100ms ease;
  }
}
:global([data-motion='reduced']) .main-nav-selection.is-ready {
  transition: opacity 100ms ease;
}
:global([data-motion='off']) .main-nav-selection.is-ready {
  transition: none;
}
</style>
