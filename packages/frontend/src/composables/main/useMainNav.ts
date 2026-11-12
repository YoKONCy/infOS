import { t as __t } from '../../i18n/index'
/**
 * useMainNav — MainView 导航与设置中心状态管理
 *
 * 采用「常驻紧凑图标轨 + 居中模态设置中心」双层架构：
 * - 左侧常驻一级主舞台入口（对话、据点、工作区、伙伴、记忆馆、任务，Electron 下另有桌面卡片）
 * - 底部固定「设置」入口，弹出居中模态窗口（SettingsHubModal），关闭即卸载释放内存
 * - 完整兼容全部历史 pageId 跳转与桌面独立面板摘出重定向
 *
 * @module packages/frontend/src/composables/main/useMainNav
 */

import { ref, computed, watch, type Ref } from 'vue'
import { invoke, isElectron } from '../../utils/ipcAdapter'
import { isTabReady, preloadTab } from './tabRegistry'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { detachedPageIds, redirectTabRequest } from '../shell/useDetachedPanels'
import { takePerceptionReveal } from '../usePerception'

// ── 常量 ──

const LS_THEME = 'infos.theme'
const desktopCardsAvailable = typeof isElectron === 'function' && isElectron()

/** 一级主舞台 Tab 集合 */
export const PRIMARY_TAB_IDS = new Set([
  'chat',
  'stronghold',
  'workspace',
  'companions',
  'memory_hub',
  'tasks',
  'cards',
])

/** 交互类 Tab（保持向后兼容导出） */
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
  /** 右键摘出对应的底层页面 ID（存在时支持摘成独立桌面面板） */
  detachPageId?: string
  /** 环境光配色 */
  ambient?: { primary: string; secondary: string }
}

/** 导航分组 */
export interface MainNavGroup {
  id: string
  title: string | null
  items: MainNavItem[]
  collapsible?: boolean
}

/** 二级聚合页子视图类型 */
export type CompanionsSubTab = 'overview' | 'space' | 'agent_config'
export type MemorySubTab = 'memories' | 'knowledge' | 'logs'
export type ScheduleSubTab = 'tasks' | 'cards'

/** 设置中心分区 ID */
export type SettingsSectionId =
  | 'user_settings'
  | 'perception_pet'
  | 'model_config'
  | 'voice_config'
  | 'social'
  | 'desktop_security'
  | 'mcp_config'
  | 'prompts'
  | 'distributed'
  | 'backups'
  | 'terminal'

/** 设置中心导航项 */
export interface SettingsNavItem {
  id: SettingsSectionId
  label: string
  hint: string
  icon: string
  /** 搜索匹配关键词 */
  keywords: string[]
  /** 对应可摘出到桌面的底层 pageId */
  detachPageId?: string
}

/** 设置中心分组 */
export interface SettingsNavGroup {
  id: string
  title: string
  items: SettingsNavItem[]
}

/** 主题模式 */
export type ThemeMode = 'light' | 'dark'

// ── 状态 ──

const currentTab = ref<string>('chat')
const pendingTab = ref<string>('')
const stagedTab = ref<string>('')
const tabDirection = ref(1)
const activeNavTab = computed(() => stagedTab.value || pendingTab.value || currentTab.value)
const isNavPinned = ref<boolean>(false)
const expandedGroups = ref<Set<string>>(new Set())
const theme = ref<ThemeMode>('light')

// 二级聚合台当前子视图
const companionsSubTab = ref<CompanionsSubTab>('overview')
const memorySubTab = ref<MemorySubTab>('memories')
const scheduleSubTab = ref<ScheduleSubTab>('tasks')

// 设置中心模态框状态（关闭时完全卸载组件释放内存）
const settingsOpen = ref<boolean>(false)
const activeSettingsSection = ref<SettingsSectionId>('user_settings')
const pendingSettingsSection = ref<SettingsSectionId | ''>('')
const expandDangerReset = ref<boolean>(false)

// ── 计算属性 ──

const isInteractionTab = computed(() => INTERACTION_TAB_IDS.has(currentTab.value))

/** 桌面端常驻紧凑图标轨，不再因切换页面跳动宽度 */
const isNavCollapsed = computed(() => true)

const navWidth = computed(() => 'var(--ui-nav-collapsed-width)')

// ── 一级主导航定义（6 项常驻紧凑轨） ──

const primaryNavItems: MainNavItem[] = [
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
    id: 'stronghold',
    get label() {
      return __t('ui.navigation', '据点')
    },
    labelEn: 'Stronghold',
    icon: 'users',
    detachPageId: 'stronghold',
    ambient: {
      primary: 'rgba(167, 139, 250, 0.10)',
      secondary: 'rgba(125, 211, 252, 0.06)',
    },
  },
  {
    id: 'workspace',
    get label() {
      return __t('ui.navigation', '工作区')
    },
    labelEn: 'Workspace',
    icon: 'code',
    detachPageId: 'workspace',
    ambient: {
      primary: 'rgba(14, 165, 233, 0.12)',
      secondary: 'rgba(139, 92, 246, 0.08)',
    },
  },
  {
    id: 'companions',
    get label() {
      return __t('ui.navigation', '伙伴')
    },
    labelEn: 'Companions',
    icon: 'paw',
    ambient: {
      primary: 'rgba(125, 211, 252, 0.12)',
      secondary: 'rgba(153, 246, 228, 0.08)',
    },
  },
  {
    id: 'memory_hub',
    get label() {
      return __t('ui.navigation', '记忆馆')
    },
    labelEn: 'Memory',
    icon: 'brain',
    ambient: {
      primary: 'rgba(192, 132, 252, 0.12)',
      secondary: 'rgba(240, 171, 252, 0.08)',
    },
  },
  {
    id: 'tasks',
    get label() {
      return __t('ui.navigation', '任务')
    },
    labelEn: 'Tasks',
    icon: 'bell',
    detachPageId: 'tasks',
    ambient: {
      primary: 'rgba(253, 224, 71, 0.10)',
      secondary: 'rgba(252, 165, 228, 0.06)',
    },
  },
  ...(desktopCardsAvailable
    ? [
        {
          id: 'cards',
          get label() {
            return __t('ui.navigation', '卡片')
          },
          labelEn: 'Cards',
          icon: 'layout',
          detachPageId: 'cards',
          ambient: {
            primary: 'rgba(236, 72, 153, 0.10)',
            secondary: 'rgba(167, 139, 250, 0.08)',
          },
        } satisfies MainNavItem,
      ]
    : []),
]

const navGroups: MainNavGroup[] = [
  {
    id: 'primary',
    title: null,
    items: primaryNavItems,
  },
]

// ── 设置中心分组定义（4 大扁平分组） ──

const settingsGroups: SettingsNavGroup[] = [
  {
    id: 'general',
    get title() {
      return __t('ui.navigation', '常规与陪伴')
    },
    items: [
      {
        id: 'user_settings',
        get label() {
          return __t('ui.navigation', '个人与外观')
        },
        get hint() {
          return __t('ui.navigation', '称呼人设、深浅主题、壁纸与音效动效')
        },
        icon: 'palette',
        detachPageId: 'user_settings',
        keywords: [
          '系统设定',
          '个人',
          '外观',
          '主题',
          '深色',
          '浅色',
          '壁纸',
          '背景',
          '语言',
          '人设',
          '音效',
          '动效',
          '天气',
          '开机',
          'theme',
          'wallpaper',
        ],
      },
      {
        id: 'perception_pet',
        get label() {
          return __t('ui.navigation', '感知与桌宠')
        },
        get hint() {
          return __t('ui.navigation', '桌宠语音快捷键、看屏幕、听声音与陪看')
        },
        icon: 'eye',
        detachPageId: 'desktop_home',
        keywords: [
          '桌面与家',
          '感知',
          '桌宠',
          '看屏幕',
          '听声音',
          '耳朵',
          '陪看',
          '主动开口',
          '快捷键',
          '麦克风',
          '字幕',
          'pet',
          'perception',
        ],
      },
    ],
  },
  {
    id: 'services',
    get title() {
      return __t('ui.navigation', '连接与服务')
    },
    items: [
      {
        id: 'model_config',
        get label() {
          return __t('ui.navigation', '模型服务')
        },
        get hint() {
          return __t('ui.navigation', '对话模型、供应商密钥与向量检索模型')
        },
        icon: 'cpu',
        detachPageId: 'model_config',
        keywords: [
          '模型配置',
          'LLM',
          'API',
          'Key',
          '密钥',
          '向量',
          'Embedding',
          'Reranker',
          'OpenAI',
          'Claude',
          'Gemini',
          'DeepSeek',
        ],
      },
      {
        id: 'voice_config',
        get label() {
          return __t('ui.navigation', '语音服务')
        },
        get hint() {
          return __t('ui.navigation', '语音合成 TTS 与语音转写 ASR 接口')
        },
        icon: 'mic',
        detachPageId: 'voice_config',
        keywords: ['语音功能', 'TTS', 'ASR', '朗读', '音色', '语音识别', '转写', 'voice'],
      },
      {
        id: 'social',
        get label() {
          return __t('ui.navigation', '社交渠道')
        },
        get hint() {
          return __t('ui.navigation', '连接 QQ 等外部聊天平台与表情包管理')
        },
        icon: 'globe',
        detachPageId: 'social',
        keywords: ['社交配置', 'QQ', 'NapCat', '机器人', '群聊', '贴纸', '表情包', 'social'],
      },
    ],
  },
  {
    id: 'capabilities',
    get title() {
      return __t('ui.navigation', '能力与安全')
    },
    items: [
      {
        id: 'desktop_security',
        get label() {
          return __t('ui.navigation', '桌面权限与安全')
        },
        get hint() {
          return __t('ui.navigation', '桌面操作开关、程序名单、文件保护与授权记录')
        },
        icon: 'shield',
        detachPageId: 'desktop_home',
        keywords: [
          '桌面操作',
          '安全',
          '权限',
          '保护设置',
          '信任名单',
          '禁区',
          '授权',
          '记录',
          '回收区',
          '停止快捷键',
        ],
      },
      {
        id: 'mcp_config',
        get label() {
          return __t('ui.navigation', '技能与扩展')
        },
        get hint() {
          return __t('ui.navigation', '管理插件、MCP 服务、技能与联网解析扩展')
        },
        icon: 'puzzle',
        detachPageId: 'mcp_config',
        keywords: ['工具与扩展', 'MCP', '插件', '技能', 'Skills', '搜索', 'PDF', '扩展'],
      },
    ],
  },
  {
    id: 'geek',
    get title() {
      return __t('ui.navigation', '极客与维护')
    },
    items: [
      {
        id: 'prompts',
        get label() {
          return __t('ui.navigation', '提示词与策略')
        },
        get hint() {
          return __t('ui.navigation', '提示词框架、预设导入、表达调教与回复预填充')
        },
        icon: 'edit',
        detachPageId: 'prompts',
        keywords: [
          '提示词',
          '框架',
          '酒馆',
          'SillyTavern',
          '预设',
          '表达调教',
          '预填充',
          '动态填充深度',
          'prompt',
        ],
      },
      {
        id: 'distributed',
        get label() {
          return __t('ui.navigation', '多端协同')
        },
        get hint() {
          return __t('ui.navigation', '跨设备连接、远程服务器切换与数据同步')
        },
        icon: 'network',
        detachPageId: 'distributed',
        keywords: ['分布式', '多端', '远程', '服务器', '同步', '设备', 'distributed'],
      },
      {
        id: 'backups',
        get label() {
          return __t('ui.navigation', '数据与重置')
        },
        get hint() {
          return __t('ui.navigation', '导出与恢复备份、隐私清理及危险重置操作')
        },
        icon: 'database',
        detachPageId: 'backups',
        keywords: [
          '数据与备份',
          '备份',
          '导出',
          '导入',
          '恢复',
          '危险区域',
          '重置',
          '清空对话',
          '恢复出厂',
          'backup',
          'reset',
        ],
      },
      {
        id: 'terminal',
        get label() {
          return __t('ui.navigation', '运行终端')
        },
        get hint() {
          return __t('ui.navigation', '查看实时运行日志与排障输出')
        },
        icon: 'terminal',
        detachPageId: 'terminal',
        keywords: ['系统终端', '日志', '控制台', '排障', '报错', 'terminal', 'console'],
      },
    ],
  },
]

const SETTINGS_SECTION_SET = new Set<string>(
  settingsGroups.flatMap((group) => group.items.map((item) => item.id)),
)

/** 根据任意新旧页面 ID 返回本地化页面名称（供独立面板标题栏与移动端顶栏使用） */
export function getPageLabel(id: string): string {
  if (id === 'tasks') return __t('ui.navigation', '任务中心')
  if (id === 'cards') return __t('ui.navigation', '桌面卡片')
  const primary = primaryNavItems.find((item) => item.id === id)
  if (primary) return primary.label
  const setting = settingsGroups.flatMap((g) => g.items).find((entry) => entry.id === id)
  if (setting) return setting.label
  switch (id) {
    case 'overview':
      return __t('ui.navigation', '状态总览')
    case 'companions_space':
      return __t('ui.desktop', '共享空间')
    case 'agent_config':
      return __t('ui.navigation', '伙伴设定')
    case 'memories':
      return __t('ui.navigation', '核心记忆')
    case 'knowledge':
      return __t('ui.navigation', '知识库')
    case 'logs':
      return __t('ui.navigation', '对话日志')
    case 'schedule_hub':
      return __t('ui.navigation', '任务中心')
    case 'desktop_home':
      return __t('ui.desktop', '桌面与家')
    case 'system_reset':
      return __t('ui.navigation', '危险区域')
    default:
      return 'infOS'
  }
}

// ── 离开确认守卫 ──

/** 离开当前页面前的确认；返回 false 时取消切换（例如有未保存修改且用户选择留下）。 */
export type TabLeaveGuard = () => boolean | Promise<boolean>
const tabLeaveGuards = new Set<TabLeaveGuard>()

/** 页面挂载时注册、卸载时调用返回的函数注销。 */
export function registerTabLeaveGuard(guard: TabLeaveGuard): () => void {
  tabLeaveGuards.add(guard)
  return () => tabLeaveGuards.delete(guard)
}

/** 依次执行离开确认（例如合回或关闭桌面面板、关闭设置中心前）；任一确认选择留下时返回 false。 */
export async function confirmTabLeave(): Promise<boolean> {
  for (const guard of [...tabLeaveGuards]) if (!(await guard())) return false
  return true
}

// ── 导航与设置中心切换动作 ──

let tabRequestSequence = 0
let tabCommitFrame = 0

function cancelTabCommitFrame(): void {
  if (tabCommitFrame) {
    cancelAnimationFrame(tabCommitFrame)
    tabCommitFrame = 0
  }
}

/** 打开设置中心模态框并定位到指定分区 */
async function openSettings(
  sectionId: SettingsSectionId = activeSettingsSection.value,
  options?: { expandReset?: boolean },
): Promise<void> {
  const item = settingsGroups.flatMap((g) => g.items).find((entry) => entry.id === sectionId)
  const redirectId = options?.expandReset ? 'system_reset' : (item?.detachPageId ?? sectionId)
  if (redirectTabRequest(redirectId)) return

  if (settingsOpen.value && activeSettingsSection.value === sectionId) {
    if (options?.expandReset) expandDangerReset.value = true
    return
  }

  const sequence = ++tabRequestSequence
  if (settingsOpen.value) {
    for (const guard of [...tabLeaveGuards]) {
      if (!(await guard())) return
      if (sequence !== tabRequestSequence) return
    }
  }

  // 立即打开弹窗外壳并更新导航选中态，不让模块下载/解析阻塞首次弹框与侧边栏点击反馈
  expandDangerReset.value = Boolean(options?.expandReset)
  activeSettingsSection.value = sectionId
  settingsOpen.value = true

  if (isTabReady(sectionId)) {
    pendingSettingsSection.value = ''
    return
  }

  pendingSettingsSection.value = sectionId
  try {
    await preloadTab(sectionId)
  } catch (error) {
    if (sequence === tabRequestSequence) {
      useNotificationStore().toast(
        error instanceof Error ? error.message : __t('ui.navigation', '页面加载失败'),
        { type: 'error' },
      )
    }
  } finally {
    if (sequence === tabRequestSequence) pendingSettingsSection.value = ''
  }
}

/** 关闭设置中心模态框（先执行离开守卫，关闭后卸载组件释放内存） */
async function closeSettings(): Promise<boolean> {
  if (!settingsOpen.value) return true
  const sequence = ++tabRequestSequence
  for (const guard of [...tabLeaveGuards]) {
    if (!(await guard())) return false
    if (sequence !== tabRequestSequence) return false
  }
  settingsOpen.value = false
  pendingSettingsSection.value = ''
  expandDangerReset.value = false
  return true
}

/** 切换一级主舞台 Tab（已就绪页面采用双帧调度：首帧先反馈导航高亮，次帧提交舞台，消除点击卡顿） */
async function switchPrimaryTab(
  targetTab: string,
  applySubTab?: () => void,
): Promise<void> {
  const item = primaryNavItems.find((i) => i.id === targetTab)
  if (item?.disabled) return

  // 若设置中心正打开，先走离开守卫并关闭模态框
  if (settingsOpen.value) {
    const closed = await closeSettings()
    if (!closed) return
  }

  if (currentTab.value === targetTab && !stagedTab.value && !pendingTab.value) {
    cancelTabCommitFrame()
    tabRequestSequence++
    applySubTab?.()
    return
  }

  cancelTabCommitFrame()
  const sequence = ++tabRequestSequence
  if (tabLeaveGuards.size > 0) {
    for (const guard of [...tabLeaveGuards]) {
      if (!(await guard())) return
      if (sequence !== tabRequestSequence) return
    }
  }

  const order = primaryNavItems.map((entry) => entry.id)
  tabDirection.value = order.indexOf(targetTab) >= order.indexOf(currentTab.value) ? 1 : -1

  if (isTabReady(targetTab)) {
    pendingTab.value = ''
    stagedTab.value = targetTab
    tabCommitFrame = requestAnimationFrame(() => {
      tabCommitFrame = 0
      if (sequence !== tabRequestSequence) return
      applySubTab?.()
      currentTab.value = targetTab
      stagedTab.value = ''
    })
    return
  }

  stagedTab.value = targetTab
  pendingTab.value = targetTab
  try {
    await preloadTab(targetTab)
    if (sequence === tabRequestSequence) {
      applySubTab?.()
      currentTab.value = targetTab
    }
  } catch (error) {
    if (sequence === tabRequestSequence)
      useNotificationStore().toast(
        error instanceof Error ? error.message : __t('ui.navigation', '页面加载失败'),
        { type: 'error' },
      )
  } finally {
    if (sequence === tabRequestSequence) {
      pendingTab.value = ''
      stagedTab.value = ''
    }
  }
}

/**
 * 统一导航入口：同时支持 6 个新一级入口、设置中心分区 ID 以及全部历史旧 ID
 */
async function setTab(id: string): Promise<void> {
  // 已摘成桌面独立面板的页面直接聚焦对应面板窗口
  if (redirectTabRequest(id)) return

  // 1. 一级主舞台入口
  if (PRIMARY_TAB_IDS.has(id)) {
    await switchPrimaryTab(id)
    return
  }

  // 2. 二级聚合页历史 ID 映射
  switch (id) {
    case 'overview':
      await switchPrimaryTab('companions', () => {
        companionsSubTab.value = 'overview'
      })
      return
    case 'companions_space':
      await switchPrimaryTab('companions', () => {
        companionsSubTab.value = 'space'
      })
      return
    case 'agent_config':
      await switchPrimaryTab('companions', () => {
        companionsSubTab.value = 'agent_config'
      })
      return
    case 'memories':
      await switchPrimaryTab('memory_hub', () => {
        memorySubTab.value = 'memories'
      })
      return
    case 'knowledge':
      await switchPrimaryTab('memory_hub', () => {
        memorySubTab.value = 'knowledge'
      })
      return
    case 'logs':
      await switchPrimaryTab('memory_hub', () => {
        memorySubTab.value = 'logs'
      })
      return
    case 'schedule_hub':
      await switchPrimaryTab('tasks')
      return
    // 3. 历史设置页特殊映射
    case 'desktop_home': {
      const targetSection: SettingsSectionId = takePerceptionReveal()
        ? 'perception_pet'
        : 'desktop_security'
      await openSettings(targetSection)
      return
    }
    case 'system_reset':
      await openSettings('backups', { expandReset: true })
      return
  }

  // 4. 设置中心直属分区
  if (SETTINGS_SECTION_SET.has(id)) {
    await openSettings(id as SettingsSectionId)
  }
}

/** 提前下载并解析目标 Tab，不改变当前页面。 */
function prefetchTab(id: string): void {
  void preloadTab(id).catch(() => {})
}

function toggleNavPin(): void {
  isNavPinned.value = !isNavPinned.value
}

function toggleGroup(groupId: string): void {
  if (expandedGroups.value.has(groupId)) {
    expandedGroups.value.delete(groupId)
  } else {
    expandedGroups.value.add(groupId)
  }
}

function isGroupExpanded(groupId: string): boolean {
  return expandedGroups.value.has(groupId)
}

function setTheme(mode: ThemeMode): void {
  theme.value = mode
}

function toggleTheme(): void {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
}

/** 初始化: 从 localStorage 恢复主题偏好 */
function init(): void {
  try {
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
  document.documentElement.style.colorScheme = theme.value
  invoke('set-native-theme', theme.value).catch(() => {})
}

watch(theme, () => {
  applyTheme()
  try {
    localStorage.setItem(LS_THEME, theme.value)
  } catch {
    /* ignore */
  }
})

init()

// 主窗口当前页面被摘成桌面面板后切回对话；若设置中心对应页被摘出则关闭设置中心
watch(detachedPageIds, (ids) => {
  if (ids.has(currentTab.value) || (stagedTab.value && ids.has(stagedTab.value))) {
    cancelTabCommitFrame()
    tabRequestSequence++
    pendingTab.value = ''
    stagedTab.value = ''
    currentTab.value = 'chat'
  }
  if (settingsOpen.value) {
    const currentSetting = settingsGroups
      .flatMap((g) => g.items)
      .find((item) => item.id === activeSettingsSection.value)
    const detachId = currentSetting?.detachPageId ?? activeSettingsSection.value
    if (ids.has(detachId)) {
      settingsOpen.value = false
      pendingSettingsSection.value = ''
      expandDangerReset.value = false
    }
  }
})

function syncThemeFromStorage(event: StorageEvent): void {
  if (event.key === LS_THEME && (event.newValue === 'light' || event.newValue === 'dark')) {
    setTheme(event.newValue)
  }
}
window.addEventListener('storage', syncThemeFromStorage)
import.meta.hot?.dispose(() => window.removeEventListener('storage', syncThemeFromStorage))

const currentAmbient = computed(() => {
  const item = primaryNavItems.find((i) => i.id === currentTab.value)
  return item?.ambient ?? null
})

const allTabIds = computed(() => primaryNavItems.map((i) => i.id))

export function useMainNav() {
  return {
    // 主导航状态
    currentTab: currentTab as Ref<string>,
    pendingTab: pendingTab as Ref<string>,
    stagedTab: stagedTab as Ref<string>,
    activeNavTab,
    tabDirection,
    isNavPinned: isNavPinned as Ref<boolean>,
    theme: theme as Ref<ThemeMode>,
    expandedGroups: expandedGroups as Ref<Set<string>>,

    // 二级聚合页子视图状态
    companionsSubTab: companionsSubTab as Ref<CompanionsSubTab>,
    memorySubTab: memorySubTab as Ref<MemorySubTab>,
    scheduleSubTab: scheduleSubTab as Ref<ScheduleSubTab>,

    // 设置中心模态框状态
    settingsOpen: settingsOpen as Ref<boolean>,
    activeSettingsSection: activeSettingsSection as Ref<SettingsSectionId>,
    pendingSettingsSection: pendingSettingsSection as Ref<SettingsSectionId | ''>,
    expandDangerReset: expandDangerReset as Ref<boolean>,

    // 计算属性
    isInteractionTab,
    isNavCollapsed,
    navWidth,
    currentAmbient,
    allTabIds,

    // 导航定义数据
    primaryNavItems,
    navGroups,
    settingsGroups,

    // 方法
    setTab,
    openSettings,
    closeSettings,
    getPageLabel,
    prefetchTab,
    toggleNavPin,
    toggleGroup,
    isGroupExpanded,
    setTheme,
    toggleTheme,
  }
}
