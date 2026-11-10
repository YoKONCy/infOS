/**
 * @file 外壳能力（desktop.shell）的宿主接口、布局快照结构与入参校验工具。
 * @platform ELECTRON
 */

import { t as __t } from '../utils/i18n'
import type { BrowserWindow } from 'electron'
import {
  isDetachablePage,
  type DetachRequest,
  type DetachedPanelPatch,
  type DetachedPanelState,
  type MainPageId,
  type ShellRect,
} from '../../../packages/shared/src/desktopShell'
import { isDesktopCardId } from '../../../packages/shared/src/desktopCards'
import type { DesktopCards } from '../windows/desktopCards'

/** 外壳能力需要的卡片操作（由 DesktopCards 提供）。 */
export type ShellCards = Pick<
  DesktopCards,
  | 'list'
  | 'windowOf'
  | 'openWindows'
  | 'create'
  | 'update'
  | 'read'
  | 'save'
  | 'show'
  | 'close'
  | 'remove'
  | 'set'
  | 'place'
  | 'setDesktopLayer'
>

/** 阶段 5：贴到桌面底层（仅 Windows，见 windows/desktopLayer.ts）。 */
export interface ShellDesktopLayer {
  isPinned(win: BrowserWindow): boolean
  set(win: BrowserWindow, enabled: boolean): boolean
}

/** 外壳能力需要的面板操作（由 DetachedPanels 提供）。 */
export interface ShellPanels {
  states(): DetachedPanelState[]
  windowOf(pageId: MainPageId): BrowserWindow | undefined
  openWindows(): BrowserWindow[]
  detach(request: DetachRequest): DetachedPanelState[]
  attachGracefully(pageId: MainPageId): Promise<boolean>
  set(pageId: MainPageId, patch: DetachedPanelPatch): DetachedPanelState[]
  focus(pageId: MainPageId): boolean
  reset(): Promise<{ remaining: number }>
}

export interface ShellDisplay {
  id: string
  primary: boolean
  workArea: ShellRect
  scaleFactor: number
}

/** 宿主能力；生产环境由 shellHost.ts 用 Electron 实现。 */
export interface ShellHost {
  mainWindow(): BrowserWindow | null
  panels: ShellPanels
  displays(): ShellDisplay[]
  /** 与矩形重叠最多的显示器工作区。 */
  workAreaNear(rect: ShellRect): ShellRect
  themeMode(): 'light' | 'dark'
  /** 当前自定义主题 ID；空字符串为默认外观，读取失败时为 null。 */
  readCustomTheme(): Promise<string | null>
  /** 阶段 4 桌面卡片。 */
  cards: ShellCards
  /** 阶段 5 贴到桌面底层；未提供时视为不支持。 */
  desktopLayer?: ShellDesktopLayer
  /** 预制件（收纳框等）的 Agent 操作；未提供时视为不支持。 */
  prefabs?: { invoke(args: Record<string, unknown>): Promise<unknown> }
}

export interface ShellWindowInfo {
  id: string
  kind: 'main' | 'panel' | 'card'
  page?: MainPageId
  card?: string
  title: string
  bounds: ShellRect
  focused: boolean
  minimized: boolean
  alwaysOnTop: boolean
  opacity: number
  /** 是否贴在桌面底层（阶段 5）。 */
  desktopLayer: boolean
}

export interface ShellLayout {
  displays: ShellDisplay[]
  windows: ShellWindowInfo[]
  pages: Array<{ id: MainPageId; title: string; detached: boolean }>
  cards: Array<{ id: string; name: string; saved: boolean; open: boolean }>
  theme: { mode: 'light' | 'dark'; custom: string | null }
}

/** 页面名称（中文原文为词条键）。 */
const PAGE_TITLES: Record<MainPageId, string> = {
  chat: '对话',
  workspace: '工作区',
  stronghold: '据点',
  overview: '总览',
  logs: '对话日志',
  memories: '核心记忆',
  knowledge: '知识库',
  tasks: '任务中心',
  agent_config: '角色管理',
  user_settings: '系统设定',
  desktop_home: '桌面与家',
  model_config: '模型配置',
  prompts: '提示词',
  voice_config: '语音功能',
  mcp_config: '工具与扩展',
  distributed: '分布式',
  social: '社交配置',
  terminal: '系统终端',
  system_reset: '危险区域',
  cards: '卡片',
}

const CATALOG = 'electron.ui.desktopShell'

/** 撤回快照的保留数量。 */
export const SHELL_UNDO_LIMIT = 20

/** 可恢复的布局：哪些页面已摘出（含位置、置顶、透明度）与主窗口位置。 */
export interface ShellSnapshot {
  main: ShellRect | null
  panels: Array<{
    pageId: MainPageId
    bounds: ShellRect | null
    alwaysOnTop: boolean
    opacity: number
  }>
}

export function sameRect(a: ShellRect, b: ShellRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** 结果是否表示布局确有变化；只聚焦不算（聚焦无法也无需撤回）。 */
export function isLayoutChange(result: unknown): boolean {
  if (!isRecord(result)) return false
  const changed = result.changed
  if (Array.isArray(changed)) return changed.some((item) => item !== 'focus')
  return changed === true
}

export function pageTitle(pageId: MainPageId): string {
  return __t(CATALOG, PAGE_TITLES[pageId])
}

/** 抛出带稳定错误码的异常；能力通道按“错误码: 说明”拆分。 */
export function fail(code: string, message: string, args?: unknown[]): never {
  throw new Error(`${code}: ${__t(CATALOG, message, args)}`)
}

/**
 * 窗口在解析之后、操作之前被关掉时，Electron 抛 `Object has been destroyed` 英文原文；
 * 换成稳定错误码与中文原因。其他错误原样抛出。
 */
export function rethrowClosedWindow(error: unknown): never {
  if (error instanceof Error && /object has been destroyed/i.test(error.message))
    fail(
      'DESKTOP_SHELL_TARGET_CLOSED',
      '目标窗口在操作途中被关闭了，请用 shell_layout 查看当前窗口',
    )
  throw error
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function requirePage(value: unknown): MainPageId {
  if (!isDetachablePage(value))
    fail('DESKTOP_SHELL_INVALID_PAGE', '页面不存在或不能摘出：{0}', [String(value)])
  return value
}

const COORDINATE_FIELDS = ['x', 'y', 'width', 'height'] as const

/** 读取部分矩形；字段可缺省，存在时必须是有限数值。 */
export function readPartialRect(value: unknown): Partial<ShellRect> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('DESKTOP_SHELL_INVALID_BOUNDS', '窗口位置或大小无效')
  const rect: Partial<ShellRect> = {}
  for (const field of COORDINATE_FIELDS) {
    const item = value[field]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item))
      fail('DESKTOP_SHELL_INVALID_BOUNDS', '窗口位置或大小无效')
    rect[field] = item
  }
  return Object.keys(rect).length ? rect : undefined
}

/** 解析后的 infOS 自有窗口：`main`、`panel:<页面 ID>` 或 `card:<卡片 ID>`。 */
export interface ShellTarget {
  id: string
  win: BrowserWindow
  page?: MainPageId
  card?: string
}

/** 把外壳窗口 ID 解析为已打开的窗口；不存在或未打开时抛出 DESKTOP_SHELL_INVALID_TARGET。 */
export function resolveShellTarget(
  host: Pick<ShellHost, 'mainWindow' | 'panels' | 'cards'>,
  value: unknown,
): ShellTarget {
  if (value === 'main') {
    const main = host.mainWindow()
    if (main && !main.isDestroyed()) return { id: 'main', win: main }
  } else if (typeof value === 'string' && value.startsWith('panel:')) {
    const page = value.slice(6)
    if (isDetachablePage(page)) {
      const win = host.panels.windowOf(page)
      if (win) return { id: value, win, page }
    }
  } else if (typeof value === 'string' && value.startsWith('card:')) {
    const card = value.slice(5)
    if (isDesktopCardId(card)) {
      const win = host.cards.windowOf(card)
      if (win) return { id: value, win, card }
    }
  }
  return fail('DESKTOP_SHELL_INVALID_TARGET', '目标窗口不存在或未打开：{0}', [String(value)])
}
