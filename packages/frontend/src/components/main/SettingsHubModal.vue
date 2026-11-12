<script setup lang="ts">
import {
  computed,
  onErrorCaptured,
  onUnmounted,
  ref,
  watch,
  type Component,
} from 'vue'
import { t as __t } from '../../i18n/index'
import {
  useMainNav,
  type SettingsNavGroup,
  type SettingsNavItem,
  type SettingsSectionId,
} from '../../composables/main/useMainNav'
import { getResolvedTab, preloadTab } from '../../composables/main/tabRegistry'
import { useDetachedPanels } from '../../composables/shell/useDetachedPanels'
import NavDetachMenu from '../shell/NavDetachMenu.vue'
import MainTabLoading from './MainTabLoading.vue'
import { PixelIcon } from '../pixel'

/**
 * SettingsHubModal — 居中模态设置中心（挂载于主首页工作面内部）
 *
 * 将原本塞在主侧栏里的 11 个低频配置页收拢为「左侧 4 组扁平导航 + 搜索过滤 + 右侧单页舞台」：
 * - 挂载在 `#desktop-home-panel` 内，天然避开顶部 DesktopTabBar（含实时浅/深色切换按钮与窗口控制按钮）
 * - 使用纯净不模糊遮罩，避免与自定义壁纸二次叠加模糊导致画面发糊发脏
 * - 首帧优先绘制弹窗外壳与导航高亮，次帧挂载重型表单舞台；打开期间通过有界 KeepAlive 瞬切已访问分区，关闭模态框时仍通过外层 v-if 彻底销毁释放内存
 * - 独立定义浅色/深色实体面板令牌，彻底隔离主舞台壁纸半透明材质，保证表单与文字清晰锐利
 */
defineOptions({ name: 'SettingsHubModal' })

// 内部自带全高布局与独立滚动容器的设置分区
const FULL_HEIGHT_SECTIONS = new Set<SettingsSectionId>([
  'user_settings',
  'model_config',
  'voice_config',
  'mcp_config',
  'social',
  'terminal',
])

const {
  settingsOpen,
  activeSettingsSection,
  pendingSettingsSection,
  settingsGroups,
  openSettings,
  closeSettings,
  prefetchTab,
} = useMainNav()
const shell = useDetachedPanels()

const detachMenu = ref<InstanceType<typeof NavDetachMenu> | null>(null)
const dialogRef = ref<HTMLElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchQuery = ref('')

// 双帧挂载调度：第 1 帧先让弹窗框架、侧边栏选中态与顶部面包屑立即上屏，下一帧再挂载/切换重型设置页 DOM
const stageMounted = ref(false)
const renderedSection = ref<SettingsSectionId>(activeSettingsSection.value)
const resolvedRevision = ref(0)
const stageError = ref('')
const stageRetryKey = ref(0)
let openFrame = 0
let switchFrame = 0

function cancelScheduledFrames(): void {
  if (openFrame) {
    cancelAnimationFrame(openFrame)
    openFrame = 0
  }
  if (switchFrame) {
    cancelAnimationFrame(switchFrame)
    switchFrame = 0
  }
}

// 预加载目标分区模块并驱动真实组件直挂 KeepAlive，避免 KeepAlive 嵌套异步组件包装器引发渲染异常
function ensureSectionLoaded(id: SettingsSectionId): void {
  stageError.value = ''
  if (getResolvedTab(id)) return
  void preloadTab(id)
    .then(() => {
      resolvedRevision.value++
    })
    .catch((err: unknown) => {
      if (renderedSection.value === id) {
        stageError.value =
          err instanceof Error ? err.message : __t('ui.navigation', '这个页面暂时无法打开')
      }
    })
}

const isCurrentSectionModuleReady = computed(() => {
  void resolvedRevision.value
  return Boolean(getResolvedTab(renderedSection.value))
})

const activeSectionComponent = computed<Component | null>(() => {
  void resolvedRevision.value
  if (!stageMounted.value) return null
  return getResolvedTab(renderedSection.value)
})
const isFullHeightSection = computed(() =>
  FULL_HEIGHT_SECTIONS.has(renderedSection.value),
)

function retryCurrentSection(): void {
  stageError.value = ''
  stageRetryKey.value++
  ensureSectionLoaded(renderedSection.value)
}

onErrorCaptured((err) => {
  stageError.value =
    err instanceof Error ? err.message : __t('ui.navigation', '这个页面暂时无法打开')
  // 拦截子设置页异常，防止外层舞台 inert 锁定时中断设置中心自身的导航与关闭交互
  return false
})

// 当前激活分区所属分组与条目元信息（供顶部 HUD 路径条展示）
const activeMeta = computed<{ groupTitle: string; item: SettingsNavItem | null }>(() => {
  for (const group of settingsGroups) {
    const found = group.items.find((entry) => entry.id === activeSettingsSection.value)
    if (found) {
      return { groupTitle: group.title, item: found }
    }
  }
  return { groupTitle: '', item: null }
})

const filteredGroups = computed<SettingsNavGroup[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return settingsGroups
  return settingsGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (item.label.toLowerCase().includes(q)) return true
        if (item.hint.toLowerCase().includes(q)) return true
        return item.keywords.some((kw) => kw.toLowerCase().includes(q))
      }),
    }))
    .filter((group) => group.items.length > 0)
})

function hasOpenChildOverlay(): boolean {
  return Boolean(
    document.querySelector(
      '.p-dialog-overlay, .p-drawer-backdrop, .p-select-dropdown, .rz-overlay, .context-menu',
    ),
  )
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !settingsOpen.value) return
  if (hasOpenChildOverlay()) return
  event.preventDefault()
  void closeSettings()
}

watch(
  settingsOpen,
  (open) => {
    cancelScheduledFrames()
    stageError.value = ''
    if (open) {
      // 若焦点仍停留在即将进入 inert 锁定的主舞台或底部状态栏中，先主动释放焦点避免焦点死锁
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null
      if (
        activeEl instanceof HTMLElement &&
        activeEl !== document.body &&
        !dialogRef.value?.contains(activeEl)
      ) {
        activeEl.blur()
      }
      window.addEventListener('keydown', handleKeydown)
      renderedSection.value = activeSettingsSection.value
      ensureSectionLoaded(activeSettingsSection.value)
      if (getResolvedTab(activeSettingsSection.value)) {
        stageMounted.value = true
      } else {
        stageMounted.value = false
        // 先在当前帧完成模态框外壳与侧边栏绘制，下一动画帧再挂载重型设置面板
        openFrame = requestAnimationFrame(() => {
          openFrame = 0
          if (settingsOpen.value) stageMounted.value = true
        })
      }
    } else {
      window.removeEventListener('keydown', handleKeydown)
      stageMounted.value = false
      searchQuery.value = ''
    }
  },
  { immediate: true },
)

watch(activeSettingsSection, (nextSection) => {
  stageError.value = ''
  ensureSectionLoaded(nextSection)
  if (!settingsOpen.value) {
    renderedSection.value = nextSection
    return
  }
  if (renderedSection.value === nextSection) return
  if (switchFrame) cancelAnimationFrame(switchFrame)
  // 让左侧导航高亮与顶部路径条在点击当帧立即绘制，下一帧切入目标设置页（连续快点自动合并）
  switchFrame = requestAnimationFrame(() => {
    switchFrame = 0
    renderedSection.value = nextSection
  })
})

onUnmounted(() => {
  cancelScheduledFrames()
  window.removeEventListener('keydown', handleKeydown)
})

function handleBackdropMousedown(): void {
  void closeSettings()
}

function selectSection(id: SettingsSectionId): void {
  void openSettings(id)
}
</script>

<template>
  <Transition name="motion-fade">
    <div
      v-if="settingsOpen"
      class="settings-hub-backdrop"
      @mousedown.self="handleBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="settings-hub-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-hub-title"
      >
        <!-- 左侧扁平分组导航 -->
        <aside class="settings-hub-sidebar">
          <div class="settings-hub-sidebar__head">
            <div class="settings-hub-title-row">
              <span class="settings-hub-title-mark" aria-hidden="true">
                <PixelIcon name="settings" size="sm" />
              </span>
              <h2 id="settings-hub-title" class="settings-hub-title">
                {{ __t('ui.navigation', '设置') }}
              </h2>
              <button
                type="button"
                class="settings-hub-close settings-hub-close--mobile"
                :aria-label="__t('ui.navigation', '关闭设置')"
                @click="closeSettings()"
              >
                <PixelIcon name="close" size="xs" />
              </button>
            </div>

            <search class="settings-hub-search">
              <PixelIcon name="search" size="xs" class="settings-hub-search__icon" />
              <input
                ref="searchInputRef"
                v-model="searchQuery"
                type="search"
                class="settings-hub-search__input"
                :placeholder="__t('ui.navigation', '搜索设置项…')"
                :aria-label="__t('ui.navigation', '搜索设置项…')"
              />
              <button
                v-if="searchQuery"
                type="button"
                class="settings-hub-search__clear"
                :aria-label="__t('ui.navigation', '清空搜索')"
                @click="searchQuery = ''"
              >
                <PixelIcon name="close" size="xs" />
              </button>
            </search>
          </div>

          <nav
            class="settings-hub-nav settings-scrollbar"
            :aria-label="__t('ui.navigation', '设置分区')"
          >
            <p v-if="!filteredGroups.length" class="settings-hub-empty">
              {{ __t('ui.navigation', '没有找到匹配的设置项') }}
            </p>

            <section
              v-for="group in filteredGroups"
              :key="group.id"
              class="settings-hub-group"
            >
              <h3 class="settings-hub-group__title">{{ group.title }}</h3>
              <div class="settings-hub-group__items">
                <button
                  v-for="item in group.items"
                  :key="item.id"
                  type="button"
                  class="settings-hub-item"
                  :class="{
                    'is-active': activeSettingsSection === item.id,
                    'is-pending': pendingSettingsSection === item.id,
                  }"
                  :aria-current="activeSettingsSection === item.id ? 'page' : undefined"
                  :data-onboarding-nav="item.id"
                  :title="item.hint"
                  @mouseenter="prefetchTab(item.id)"
                  @focus="prefetchTab(item.id)"
                  @click="selectSection(item.id)"
                  @contextmenu="item.detachPageId && detachMenu?.open($event, item.detachPageId)"
                >
                  <PixelIcon :name="item.icon" size="sm" class="settings-hub-item__icon" />
                  <span class="settings-hub-item__label">{{ item.label }}</span>
                  <PixelIcon
                    v-if="item.detachPageId && shell.isDetached(item.detachPageId)"
                    name="external-link"
                    size="xs"
                    class="settings-hub-item__detached"
                    :title="__t('ui.desktop-shell', '已摘出到桌面')"
                  />
                </button>
              </div>
            </section>
          </nav>
        </aside>

        <!-- 右侧内容舞台 -->
        <div class="settings-hub-main">
          <!-- 顶部 HUD 状态导轨：展示当前路径，并将关闭按钮与各分区右上角操作栏彻底错开 -->
          <header class="settings-hub-topbar">
            <div class="settings-hub-crumb">
              <span v-if="activeMeta.groupTitle" class="settings-hub-crumb__group">
                {{ activeMeta.groupTitle }}
              </span>
              <span
                v-if="activeMeta.groupTitle && activeMeta.item"
                class="settings-hub-crumb__sep"
                aria-hidden="true"
              >
                /
              </span>
              <strong v-if="activeMeta.item" class="settings-hub-crumb__current">
                {{ activeMeta.item.label }}
              </strong>
              <span v-if="activeMeta.item?.hint" class="settings-hub-crumb__hint">
                {{ activeMeta.item.hint }}
              </span>
            </div>

            <div class="settings-hub-topbar__actions">
              <kbd class="settings-hub-esc" aria-hidden="true">ESC</kbd>
              <button
                type="button"
                class="settings-hub-close settings-hub-close--bar"
                :title="`${__t('ui.navigation', '关闭设置')} (Esc)`"
                :aria-label="__t('ui.navigation', '关闭设置')"
                @click="closeSettings()"
              >
                <PixelIcon name="close" size="xs" />
              </button>
            </div>
          </header>

          <div
            class="settings-hub-stage dashboard-tab-content settings-scrollbar"
            :class="{ 'settings-hub-stage--full': isFullHeightSection }"
            data-dashboard-scope=""
            :data-onboarding-tab="renderedSection"
          >
            <div v-if="stageError" class="settings-hub-error" role="alert">
              <PixelIcon name="alert" size="md" class="settings-hub-error__icon" />
              <strong class="settings-hub-error__title">
                {{ __t('ui.navigation', '这个页面暂时无法打开') }}
              </strong>
              <p class="settings-hub-error__detail">{{ stageError }}</p>
              <button type="button" class="settings-hub-error__retry" @click="retryCurrentSection">
                <PixelIcon name="refresh" size="xs" />
                <span>{{ __t('ui.navigation', '重新加载') }}</span>
              </button>
            </div>
            <KeepAlive v-else-if="stageMounted && activeSectionComponent" :max="5">
              <component
                :is="activeSectionComponent"
                :key="`${renderedSection}-${stageRetryKey}`"
                :class="{ 'settings-hub-stage__fill': isFullHeightSection }"
              />
            </KeepAlive>
            <MainTabLoading v-else-if="!isCurrentSectionModuleReady" />
          </div>
        </div>
      </div>

      <NavDetachMenu ref="detachMenu" />
    </div>
  </Transition>
</template>

<style scoped>
/* ── 遮罩层：严格贴合主工作面，不覆盖顶部窗口标签栏，不叠加 backdrop-filter 模糊 ── */
.settings-hub-backdrop {
  position: absolute;
  inset: 0;
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 22px;
  background: rgba(15, 23, 42, 0.34);
}

.settings-hub-backdrop.motion-fade-leave-active {
  pointer-events: none;
}

[data-theme='dark'] .settings-hub-backdrop {
  background: rgba(5, 7, 13, 0.64);
}

/* ── 浅色模式 HUD 实体令牌作用域（彻底阻断壁纸半透明材质渗透，强化文字与边界对比度） ── */
.settings-hub-dialog {
  --hub-frame-border: rgba(15, 23, 42, 0.24);
  --hub-sidebar-bg: #eef2f8;
  --hub-sidebar-border: rgba(15, 23, 42, 0.12);
  --hub-topbar-bg: #f2f5fa;
  --hub-stage-bg: #f7f9fc;
  --hub-search-bg: #ffffff;
  --hub-item-active-bg: #ffffff;
  --hub-accent: var(--ui-accent-primary);
  --hub-accent-soft: rgba(236, 72, 153, 0.12);

  /* 覆盖内部组件继承的 UI 与 Dashboard 语义令牌，确保浅色清透锐利 */
  --ui-bg-canvas: #f7f9fc;
  --ui-bg-surface: #ffffff;
  --ui-bg-surface-soft: #f1f4f9;
  --ui-bg-elevated: #ffffff;
  --ui-bg-hover: rgba(15, 23, 42, 0.055);
  --ui-text-primary: #141824;
  --ui-text-secondary: #475166;
  --ui-text-tertiary: #6d778e;
  --ui-border-subtle: rgba(15, 23, 42, 0.09);
  --ui-border-default: rgba(15, 23, 42, 0.15);
  --ui-border-strong: rgba(15, 23, 42, 0.26);

  --dash-panel-bg: #ffffff;
  --dash-panel-elevated: #ffffff;
  --dash-panel-soft: #f2f5fa;
  --dash-panel-border: rgba(15, 23, 42, 0.14);
  --dash-panel-shadow: 0 6px 20px rgba(15, 23, 42, 0.055);
  --dash-input-bg: #ffffff;
  --dash-input-border: rgba(15, 23, 42, 0.2);

  /* 阻断外层 data-app-background='active' 的半透明混合填充（背景预览容器自带独立属性不受影响） */
  --app-shell-fill: #f2f5fa;
  --app-panel-fill: #ffffff;
  --app-soft-fill: #f2f5fa;
  --app-reading-fill: #ffffff;
  --app-inset-reading-fill: #ffffff;
  --app-material-blur: 0px;

  display: flex;
  width: min(1460px, 100%);
  height: min(912px, 100%);
  background: var(--hub-stage-bg);
  border: 1px solid var(--hub-frame-border);
  border-radius: 2px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.8),
    0 24px 64px rgba(15, 23, 42, 0.26);
  overflow: hidden;
  color: var(--ui-text-primary);
}

/* ── 深色模式 HUD 实体令牌作用域（深紫夜空底色层次分明，杜绝侧栏反白与文字发淡） ── */
[data-theme='dark'] .settings-hub-dialog {
  --hub-frame-border: color-mix(in srgb, var(--ui-accent-purple) 36%, rgba(255, 255, 255, 0.22));
  --hub-sidebar-bg: #0f121b;
  --hub-sidebar-border: rgba(255, 255, 255, 0.11);
  --hub-topbar-bg: #121622;
  --hub-stage-bg: #141824;
  --hub-search-bg: #181d2b;
  --hub-item-active-bg: color-mix(in srgb, var(--ui-accent-purple) 16%, #191e2d);
  --hub-accent: var(--ui-accent-purple);
  --hub-accent-soft: rgba(167, 139, 250, 0.16);

  --ui-bg-canvas: #141824;
  --ui-bg-surface: #1b2030;
  --ui-bg-surface-soft: #161b28;
  --ui-bg-elevated: #21273a;
  --ui-bg-hover: rgba(255, 255, 255, 0.07);
  --ui-text-primary: #f4f6fb;
  --ui-text-secondary: #bcc5d6;
  --ui-text-tertiary: #8a95ab;
  --ui-border-subtle: rgba(255, 255, 255, 0.085);
  --ui-border-default: rgba(255, 255, 255, 0.14);
  --ui-border-strong: rgba(255, 255, 255, 0.24);

  --dash-panel-bg: #1b2030;
  --dash-panel-elevated: #21273a;
  --dash-panel-soft: #161b28;
  --dash-panel-border: rgba(255, 255, 255, 0.13);
  --dash-panel-shadow: 0 10px 28px rgba(0, 0, 0, 0.34);
  --dash-input-bg: #111520;
  --dash-input-border: rgba(255, 255, 255, 0.18);

  --app-shell-fill: #121622;
  --app-panel-fill: #1b2030;
  --app-soft-fill: #161b28;
  --app-reading-fill: #111520;
  --app-inset-reading-fill: #161b28;
  --app-material-blur: 0px;

  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ui-accent-purple) 24%, rgba(255, 255, 255, 0.1)),
    0 28px 72px rgba(0, 0, 0, 0.66);
}

/* ── 左侧导航栏 ── */
.settings-hub-sidebar {
  width: 248px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--hub-sidebar-bg);
  border-right: 1px solid var(--hub-sidebar-border);
}

.settings-hub-sidebar__head {
  padding: 16px 14px 13px;
  border-bottom: 1px solid var(--hub-sidebar-border);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.settings-hub-title-row {
  display: flex;
  align-items: center;
  gap: 9px;
}

.settings-hub-title-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: var(--hub-accent-soft);
  color: var(--hub-accent);
  border: 1px solid color-mix(in srgb, var(--hub-accent) 38%, var(--ui-border-default));
  border-left: 2px solid var(--hub-accent);
  border-radius: 2px;
}

.settings-hub-title {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--ui-text-primary);
}

.settings-hub-search {
  position: relative;
  display: flex;
  align-items: center;
}

.settings-hub-search__icon {
  position: absolute;
  left: 9px;
  color: var(--ui-text-tertiary);
  pointer-events: none;
}

.settings-hub-search__input {
  width: 100%;
  height: 34px;
  padding: 0 28px 0 30px;
  font-size: 12px;
  color: var(--ui-text-primary);
  background: var(--hub-search-bg);
  border: 1px solid var(--ui-border-default);
  border-radius: 2px;
  outline: none;
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}

.settings-hub-search__input::placeholder {
  color: var(--ui-text-tertiary);
}

.settings-hub-search__input:focus {
  border-color: var(--hub-accent);
  box-shadow: 0 0 0 2px var(--hub-accent-soft);
}

.settings-hub-search__clear {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
}

.settings-hub-search__clear:hover {
  color: var(--ui-text-primary);
}

.settings-hub-nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 13px 10px 18px;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.settings-hub-empty {
  margin: 18px 8px;
  font-size: 12px;
  color: var(--ui-text-tertiary);
  text-align: center;
}

.settings-hub-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.settings-hub-group__title {
  margin: 0;
  padding: 0 10px 3px;
  font-family: var(--ui-font-pixel);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--ui-text-tertiary);
}

.settings-hub-group__items {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.settings-hub-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 7px 11px;
  border: 1px solid transparent;
  border-left: 2px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-pixel);
  font-size: 12.5px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard);
}

.settings-hub-item:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}

.settings-hub-item.is-active {
  background: var(--hub-item-active-bg);
  color: var(--hub-accent);
  border-color: color-mix(in srgb, var(--hub-accent) 36%, var(--ui-border-default));
  border-left-color: var(--hub-accent);
  box-shadow: 2px 2px 0 color-mix(in srgb, var(--hub-accent) 14%, transparent);
  font-weight: 700;
}

.settings-hub-item.is-pending {
  opacity: 0.72;
}

.settings-hub-item__icon {
  flex-shrink: 0;
}

.settings-hub-item__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-hub-item__detached {
  flex-shrink: 0;
  opacity: 0.65;
}

/* ── 右侧内容舞台与顶部 HUD 导轨 ── */
.settings-hub-main {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--hub-stage-bg);
}

.settings-hub-topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 40px;
  padding: 0 14px 0 22px;
  background: var(--hub-topbar-bg);
  border-bottom: 1px solid var(--hub-sidebar-border);
}

.settings-hub-crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}

.settings-hub-crumb__group {
  flex-shrink: 0;
  font-family: var(--ui-font-pixel);
  color: var(--ui-text-tertiary);
}

.settings-hub-crumb__sep {
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
  opacity: 0.6;
}

.settings-hub-crumb__current {
  flex-shrink: 0;
  font-family: var(--ui-font-pixel);
  font-weight: 700;
  color: var(--ui-text-primary);
}

.settings-hub-crumb__hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 6px;
  border-left: 1px solid var(--ui-border-default);
  color: var(--ui-text-tertiary);
  font-size: 11.5px;
}

.settings-hub-topbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.settings-hub-esc {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  font-family: var(--ui-font-pixel);
  font-size: 10px;
  line-height: 1;
  color: var(--ui-text-tertiary);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  border-radius: 2px;
  user-select: none;
}

.settings-hub-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  background: var(--hub-stage-bg);
}

.settings-hub-stage--full {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.settings-hub-stage__fill {
  flex: 1;
  min-height: 0;
}

.settings-hub-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 260px;
  padding: 32px 24px;
  text-align: center;
}

.settings-hub-error__icon {
  color: var(--ui-danger);
}

.settings-hub-error__title {
  color: var(--ui-text-primary);
  font-family: var(--ui-font-pixel);
  font-size: 13px;
}

.settings-hub-error__detail {
  max-width: 480px;
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.settings-hub-error__retry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 6px 14px;
  border: 1px solid var(--ui-border-strong);
  border-radius: 2px;
  background: var(--ui-bg-surface);
  color: var(--ui-text-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.settings-hub-error__retry:hover {
  border-color: var(--hub-accent);
  color: var(--hub-accent);
}

.settings-hub-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ui-border-default);
  border-radius: 2px;
  background: var(--ui-bg-surface);
  color: var(--ui-text-secondary);
  cursor: pointer;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard);
}

.settings-hub-close:hover {
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 42%, var(--ui-border-strong));
}

.settings-hub-close--bar {
  width: 28px;
  height: 28px;
}

.settings-hub-close--mobile {
  display: none;
  margin-left: auto;
  width: 28px;
  height: 28px;
}

@media (max-width: 820px) {
  .settings-hub-backdrop {
    padding: 0;
  }

  .settings-hub-dialog {
    flex-direction: column;
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 0;
  }

  .settings-hub-sidebar {
    width: 100%;
    max-height: 176px;
    border-right: none;
    border-bottom: 1px solid var(--hub-sidebar-border);
  }

  .settings-hub-nav {
    flex-direction: row;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 8px 12px;
    gap: 8px;
  }

  .settings-hub-group {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .settings-hub-group__title {
    display: none;
  }

  .settings-hub-group__items {
    flex-direction: row;
    gap: 6px;
  }

  .settings-hub-item {
    width: auto;
    white-space: nowrap;
    padding: 6px 10px;
  }

  .settings-hub-topbar {
    display: none;
  }

  .settings-hub-close--mobile {
    display: inline-flex;
  }
}

[data-motion='off'] .settings-hub-item,
[data-motion='reduced'] .settings-hub-item,
[data-motion='off'] .settings-hub-close,
[data-motion='reduced'] .settings-hub-close,
[data-motion='off'] .settings-hub-search__input,
[data-motion='reduced'] .settings-hub-search__input {
  transition: none;
}
</style>
