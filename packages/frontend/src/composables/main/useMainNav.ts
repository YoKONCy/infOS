import { t as __t } from '../../i18n/index'
/**
 * useMainNav — MainView 导航状态管理
 *
 * 管理左侧主导航的状态:
 * - 当前激活 Tab
 * - 导航栏收起/展开(对话 Tab 自动收起)
 * - 手动固定(用户偏好持久化到 localStorage)
 * - 设置/高级分组的展开收起
 * - 浅色/深色主题切换
 *
 * @module packages/frontend/src/composables/main/useMainNav
 */

import { ref, computed, watch, type Ref } from 'vue'
import { invoke } from '../../utils/ipcAdapter'
import { preloadTab } from './tabRegistry'
import { useNotificationStore } from '../../stores/useNotificationStore'

// ── 常量 ──

const LS_NAV_PINNED = 'infos.mainNav.pinned'
const LS_THEME = 'infos.theme'

/** 交互类 Tab — 未固定导航时统一收起，为沉浸式交互释放空间。 */
export const INTERACTION_TAB_IDS = new Set(['chat', 'workspace', 'stronghold'])

// ── 类型 ──

/** 导航项 */
export interface MainNavItem {
  id: string
  label: string
  labelEn?: string
  icon: string
  /** 是否默认禁用 */
  disabled?: boolean
  /** 环境光配色 */
  ambient?: { primary: string; secondary: string }
}

/** 导航分组 */
export interface MainNavGroup {
  id: string
  title: string | null
  items: MainNavItem[]
  /** 是否可折叠(设置/高级分组) */
  collapsible?: boolean
}

/** 主题模式 */
export type ThemeMode = 'light' | 'dark'

// ── 状态 ──

const currentTab = ref<string>('chat')
const pendingTab = ref<string>('')
const tabDirection = ref(1)
const isNavPinned = ref<boolean>(false)
const expandedGroups = ref<Set<string>>(new Set(['settings', 'advanced']))
const theme = ref<ThemeMode>('light')

// ── 计算属性 ──

/** 是否处于需要沉浸显示的交互类 Tab。 */
const isInteractionTab = computed(() => INTERACTION_TAB_IDS.has(currentTab.value))

/** 导航是否收起（交互类 Tab 且未固定时收起）。 */
const isNavCollapsed = computed(() => isInteractionTab.value && !isNavPinned.value)

/** 导航实际宽度 */
const navWidth = computed(() => {
  return isNavCollapsed.value ? 'var(--ui-nav-collapsed-width)' : 'var(--ui-nav-width)'
})

// ── 导航定义 ──

const navGroups: MainNavGroup[] = [
  {
    id: 'interaction',
    get title() {
      return __t('ui.navigation', '交互')
    },
    items: [
      {
        id: 'chat',
        get label() {
          return __t('ui.navigation', '对话')
        },
        labelEn: 'Chat',
        icon: 'chat',
        ambient: {
          primary: 'rgba(236, 72, 153, 0.08)',
          secondary: 'rgba(14, 165, 233, 0.06)',
        },
      },
      {
        id: 'workspace',
        get label() {
          return __t('ui.navigation', '工作区')
        },
        labelEn: 'Workspace',
        icon: 'code',
        ambient: {
          primary: 'rgba(14, 165, 233, 0.12)',
          secondary: 'rgba(139, 92, 246, 0.08)',
        },
      },
      {
        id: 'stronghold',
        get label() {
          return __t('ui.navigation', '据点')
        },
        labelEn: 'Stronghold',
        icon: 'users',
        ambient: {
          primary: 'rgba(167, 139, 250, 0.10)',
          secondary: 'rgba(125, 211, 252, 0.06)',
        },
      },
    ],
  },
  {
    id: 'daily',
    get title() {
      return __t('ui.navigation', '工作台')
    },
    items: [
      {
        id: 'overview',
        get label() {
          return __t('ui.navigation', '总览')
        },
        labelEn: 'Overview',
        icon: 'desktop',
        ambient: {
          primary: 'rgba(125, 211, 252, 0.12)',
          secondary: 'rgba(153, 246, 228, 0.08)',
        },
      },
      {
        id: 'logs',
        get label() {
          return __t('ui.navigation', '对话日志')
        },
        labelEn: 'Logs',
        icon: 'chat',
        ambient: {
          primary: 'rgba(125, 211, 252, 0.08)',
          secondary: 'rgba(125, 211, 252, 0.05)',
        },
      },
      {
        id: 'memories',
        get label() {
          return __t('ui.navigation', '核心记忆')
        },
        labelEn: 'Memories',
        icon: 'brain',
        ambient: {
          primary: 'rgba(192, 132, 252, 0.12)',
          secondary: 'rgba(240, 171, 252, 0.08)',
        },
      },
      {
        id: 'knowledge',
        get label() {
          return __t('ui.navigation', '知识库')
        },
        labelEn: 'Knowledge',
        icon: 'database',
        ambient: {
          primary: 'rgba(45, 212, 191, 0.11)',
          secondary: 'rgba(125, 211, 252, 0.08)',
        },
      },
      {
        id: 'tasks',
        get label() {
          return __t('ui.navigation', '任务中心')
        },
        labelEn: 'Tasks',
        icon: 'bell',
        ambient: {
          primary: 'rgba(253, 224, 71, 0.10)',
          secondary: 'rgba(252, 165, 165, 0.06)',
        },
      },
    ],
  },
  {
    id: 'settings',
    get title() {
      return __t('ui.navigation', '设置')
    },
    collapsible: true,
    items: [
      {
        id: 'agent_config',
        get label() {
          return __t('ui.navigation', '角色管理')
        },
        icon: 'users',
      },
      {
        id: 'user_settings',
        get label() {
          return __t('ui.navigation', '系统设定')
        },
        icon: 'settings',
      },
      {
        id: 'model_config',
        get label() {
          return __t('ui.navigation', '模型配置')
        },
        icon: 'cpu',
      },
      {
        id: 'prompts',
        get label() {
          return __t('ui.navigation', '提示词')
        },
        icon: 'edit',
      },
      {
        id: 'voice_config',
        get label() {
          return __t('ui.navigation', '语音功能')
        },
        icon: 'mic',
      },
      {
        id: 'mcp_config',
        get label() {
          return __t('ui.navigation', '工具与扩展')
        },
        icon: 'terminal',
      },
      {
        id: 'distributed',
        get label() {
          return __t('ui.navigation', '分布式')
        },
        icon: 'network',
      },
      {
        id: 'social',
        get label() {
          return __t('ui.navigation', '社交配置')
        },
        icon: 'chat',
      },
    ],
  },
  {
    id: 'advanced',
    get title() {
      return __t('ui.navigation', '高级')
    },
    collapsible: true,
    items: [
      {
        id: 'terminal',
        get label() {
          return __t('ui.navigation', '系统终端')
        },
        icon: 'desktop',
      },
      {
        id: 'system_reset',
        get label() {
          return __t('ui.navigation', '危险区域')
        },
        icon: 'alert',
      },
    ],
  },
]

// ── 方法 ──

/** 离开当前页面前的确认；返回 false 时取消切换（例如有未保存修改且用户选择留下）。 */
export type TabLeaveGuard = () => boolean | Promise<boolean>
const tabLeaveGuards = new Set<TabLeaveGuard>()

/** 页面挂载时注册、卸载时调用返回的函数注销。 */
export function registerTabLeaveGuard(guard: TabLeaveGuard): () => void {
  tabLeaveGuards.add(guard)
  return () => tabLeaveGuards.delete(guard)
}

/** 切换 Tab：首次进入先完成模块下载和解析，再原子提交，旧页面始终保持可见。 */
let tabRequestSequence = 0
async function setTab(id: string): Promise<void> {
  const item = navGroups.flatMap((g) => g.items).find((i) => i.id === id)
  if (item?.disabled) return
  if (currentTab.value === id) {
    tabRequestSequence++
    pendingTab.value = ''
    return
  }
  const sequence = ++tabRequestSequence
  for (const guard of [...tabLeaveGuards]) {
    if (!(await guard())) return
    // 确认期间又发起了新的切换时，以最后一次为准。
    if (sequence !== tabRequestSequence) return
  }
  const order = navGroups.flatMap((group) => group.items).map((entry) => entry.id)
  tabDirection.value = order.indexOf(id) >= order.indexOf(currentTab.value) ? 1 : -1
  pendingTab.value = id
  try {
    await preloadTab(id)
    if (sequence === tabRequestSequence) currentTab.value = id
  } catch (error) {
    if (sequence === tabRequestSequence)
      useNotificationStore().toast(
        error instanceof Error ? error.message : __t('ui.navigation', '页面加载失败'),
        {
          type: 'error',
        },
      )
  } finally {
    if (sequence === tabRequestSequence) pendingTab.value = ''
  }
}

/** 提前下载并解析目标 Tab，不改变当前页面。 */
function prefetchTab(id: string): void {
  void preloadTab(id).catch(() => {})
}

/** 切换导航固定状态 */
function toggleNavPin(): void {
  isNavPinned.value = !isNavPinned.value
}

/** 切换分组展开 */
function toggleGroup(groupId: string): void {
  if (expandedGroups.value.has(groupId)) {
    expandedGroups.value.delete(groupId)
  } else {
    expandedGroups.value.add(groupId)
  }
}

/** 判断分组是否展开 */
function isGroupExpanded(groupId: string): boolean {
  return expandedGroups.value.has(groupId)
}

/** 设置主题 */
function setTheme(mode: ThemeMode): void {
  theme.value = mode
}

/** 切换主题 */
function toggleTheme(): void {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
}

/** 初始化: 从 localStorage 恢复偏好 */
function init(): void {
  try {
    const pinned = localStorage.getItem(LS_NAV_PINNED)
    if (pinned !== null) {
      isNavPinned.value = pinned === 'true'
    }
    const savedTheme = localStorage.getItem(LS_THEME)
    if (savedTheme === 'light' || savedTheme === 'dark') {
      theme.value = savedTheme
    }
  } catch {
    // localStorage 不可用时忽略
  }
  applyTheme()
}

/** 应用主题到 document，并同步 Electron 原生主题 */
function applyTheme(): void {
  document.documentElement.setAttribute('data-theme', theme.value)
  // 原生滚动条/表单控件按主题渲染
  document.documentElement.style.colorScheme = theme.value
  // Electron 窗口原生标题栏/菜单等跟随深浅色（非 Electron 环境自动忽略）
  invoke('set-native-theme', theme.value).catch(() => {})
}

// 监听状态变化,持久化偏好
watch(isNavPinned, (val) => {
  try {
    localStorage.setItem(LS_NAV_PINNED, String(val))
  } catch {
    /* ignore */
  }
})

watch(theme, () => {
  applyTheme()
  try {
    localStorage.setItem(LS_THEME, theme.value)
  } catch {
    /* ignore */
  }
})

// 初始化
init()

// 接收桌宠等其他窗口修改的主题，复用现有应用与持久化逻辑。
function syncThemeFromStorage(event: StorageEvent): void {
  if (event.key === LS_THEME && (event.newValue === 'light' || event.newValue === 'dark')) {
    setTheme(event.newValue)
  }
}
window.addEventListener('storage', syncThemeFromStorage)
import.meta.hot?.dispose(() => window.removeEventListener('storage', syncThemeFromStorage))

/** 当前激活 Tab 的环境光配色 */
const currentAmbient = computed(() => {
  const item = navGroups.flatMap((g) => g.items).find((i) => i.id === currentTab.value)
  return item?.ambient ?? null
})

/** 所有可点击的 Tab ID(用于 Tab 组件映射) */
const allTabIds = computed(() => navGroups.flatMap((g) => g.items.map((i) => i.id)))

export function useMainNav() {
  return {
    // 状态
    currentTab: currentTab as Ref<string>,
    pendingTab: pendingTab as Ref<string>,
    tabDirection,
    isNavPinned: isNavPinned as Ref<boolean>,
    theme: theme as Ref<ThemeMode>,
    expandedGroups: expandedGroups as Ref<Set<string>>,

    // 计算
    isInteractionTab,
    isNavCollapsed,
    navWidth,
    currentAmbient,
    allTabIds,

    // 数据
    navGroups,

    // 方法
    setTab,
    prefetchTab,
    toggleNavPin,
    toggleGroup,
    isGroupExpanded,
    setTheme,
    toggleTheme,
  }
}
