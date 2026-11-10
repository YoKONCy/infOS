/**
 * 桌面外壳 — 可摘出页面、面板布局结构与归一化、IPC 通道名
 *
 * 主界面的功能页可以“摘”成独立的桌面面板窗口（仅 Electron）。本模块只包含纯数据与纯函数，
 * 主进程（窗口创建、布局保存）与前端（导航、面板页面）共用，便于单独测试。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 1
 */

/** 主界面全部功能页（与 tabRegistry 一致）；用于校验“打开页面”的请求。 */
export const MAIN_PAGE_IDS = [
  'chat',
  'workspace',
  'stronghold',
  'overview',
  'logs',
  'memories',
  'knowledge',
  'tasks',
  'agent_config',
  'user_settings',
  'desktop_home',
  'model_config',
  'prompts',
  'voice_config',
  'mcp_config',
  'distributed',
  'social',
  'terminal',
  'system_reset',
  'cards',
] as const

export type MainPageId = (typeof MAIN_PAGE_IDS)[number]

/** 不允许摘出的页面：对话主窗口不拆分，危险区域只在主窗口操作。 */
const NOT_DETACHABLE = new Set<string>(['chat', 'system_reset'])

/** 可以摘成桌面面板的页面。 */
export const DETACHABLE_PAGE_IDS = MAIN_PAGE_IDS.filter(
  (id) => !NOT_DETACHABLE.has(id),
) as readonly MainPageId[]

const MAIN_PAGES = new Set<string>(MAIN_PAGE_IDS)
const DETACHABLE_PAGES = new Set<string>(DETACHABLE_PAGE_IDS)

export function isMainPageId(value: unknown): value is MainPageId {
  return typeof value === 'string' && MAIN_PAGES.has(value)
}

export function isDetachablePage(value: unknown): value is MainPageId {
  return typeof value === 'string' && DETACHABLE_PAGES.has(value)
}

/** 主进程与渲染进程之间的通道名。 */
export const DESKTOP_SHELL_CHANNELS = {
  /** 读取当前已摘出的页面 */
  panels: 'desktop-shell:panels',
  /** 摘出页面（可带初始位置） */
  detach: 'desktop-shell:detach',
  /** 合回：关闭面板并在主窗口切到该页 */
  attach: 'desktop-shell:attach',
  /** 关闭面板（不切换主窗口） */
  close: 'desktop-shell:close',
  /** 聚焦已摘出页面的面板；未摘出时在主窗口打开该页 */
  focus: 'desktop-shell:focus',
  /** 置顶、透明度 */
  set: 'desktop-shell:set',
  /** 恢复默认布局 */
  reset: 'desktop-shell:reset',
  /** 主进程广播：已摘出页面列表变化 */
  changed: 'desktop-shell:changed',
  /** 主进程广播：角色切换了自定义主题（空字符串表示默认外观），各窗口自行应用 */
  customTheme: 'desktop-shell:custom-theme',
} as const

/** 阶段 3：Electron `desktop.shell` 能力提供的操作；后端能力定义与主进程分派共用。 */
export const DESKTOP_SHELL_OPERATIONS = [
  'layout',
  'detach',
  'attach',
  'setWindow',
  'reset',
  'undo',
  'applyTheme',
  /** 阶段 4：卡片的创建、更新、列出、读取、收藏、打开、关闭与删除（`input.action` 区分）。 */
  'card',
  /** 预制件（收纳框等）：`input.kind` 区分种类，`input.action` 区分操作。 */
  'prefab',
] as const

export type DesktopShellOperation = (typeof DESKTOP_SHELL_OPERATIONS)[number]

export const DESKTOP_SHELL_LAYOUT_VERSION = 1
export const DESKTOP_SHELL_LAYOUT_FILE = 'desktop-shell.json'
/** 移动、缩放停止后多久写盘。 */
export const DESKTOP_SHELL_SAVE_DELAY_MS = 500

export const PANEL_MIN_WIDTH = 420
export const PANEL_MIN_HEIGHT = 320
/** 防止异常数值创建超大窗口。 */
const PANEL_MAX_SIZE = 16_384
/** 坐标的合理范围（多显示器虚拟桌面）。 */
const COORDINATE_LIMIT = 100_000
export const PANEL_OPACITY_MIN = 0.4
export const PANEL_OPACITY_MAX = 1

/** 窗口最小尺寸；面板与卡片各有一组。 */
export interface ShellMinSize {
  width: number
  height: number
}

export const PANEL_MIN_SIZE: ShellMinSize = { width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT }

export interface ShellRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DetachedPanelLayout {
  /** 窗口位置与大小；缺失时按默认位置放置。 */
  bounds?: ShellRect
  alwaysOnTop: boolean
  opacity: number
}

export interface DesktopShellLayout {
  version: typeof DESKTOP_SHELL_LAYOUT_VERSION
  /** 出现在这里即表示已摘出。 */
  panels: Partial<Record<MainPageId, DetachedPanelLayout>>
}

/** 渲染进程看到的面板状态。 */
export interface DetachedPanelState {
  pageId: MainPageId
  alwaysOnTop: boolean
  opacity: number
}

export interface DetachedPanelPatch {
  alwaysOnTop?: boolean
  opacity?: number
}

export interface DetachRequest {
  pageId: MainPageId
  bounds?: ShellRect
}

export function createEmptyLayout(): DesktopShellLayout {
  return { version: DESKTOP_SHELL_LAYOUT_VERSION, panels: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 透明度收敛到 0.4–1，保留两位小数；无效值视为不透明。 */
export function normalizeOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PANEL_OPACITY_MAX
  const clamped = Math.min(PANEL_OPACITY_MAX, Math.max(PANEL_OPACITY_MIN, value))
  return Math.round(clamped * 100) / 100
}

/** 窗口矩形：取整、限制最小尺寸与坐标范围；结构无效时返回 undefined。 */
export function normalizeShellRect(
  value: unknown,
  min: ShellMinSize = PANEL_MIN_SIZE,
): ShellRect | undefined {
  if (!isRecord(value)) return undefined
  const { x, y, width, height } = value
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item)))
    return undefined
  const clampCoordinate = (item: number) =>
    Math.round(Math.min(COORDINATE_LIMIT, Math.max(-COORDINATE_LIMIT, item)))
  return {
    x: clampCoordinate(x as number),
    y: clampCoordinate(y as number),
    width: Math.round(Math.min(PANEL_MAX_SIZE, Math.max(min.width, width as number))),
    height: Math.round(Math.min(PANEL_MAX_SIZE, Math.max(min.height, height as number))),
  }
}

export function normalizePanelLayout(value: unknown): DetachedPanelLayout {
  const item = isRecord(value) ? value : {}
  const bounds = normalizeShellRect(item.bounds)
  return {
    ...(bounds ? { bounds } : {}),
    alwaysOnTop: item.alwaysOnTop === true,
    opacity: normalizeOpacity(item.opacity),
  }
}

/** 读取保存的布局：未知页面、不可摘出页面和无效字段一律丢弃，其他版本视为空布局。 */
export function normalizeDesktopShellLayout(value: unknown): DesktopShellLayout {
  const layout = createEmptyLayout()
  if (!isRecord(value) || value.version !== DESKTOP_SHELL_LAYOUT_VERSION) return layout
  if (!isRecord(value.panels)) return layout
  for (const [pageId, panel] of Object.entries(value.panels)) {
    if (isDetachablePage(pageId)) layout.panels[pageId] = normalizePanelLayout(panel)
  }
  return layout
}

/** 面板设置的增量修改；没有任何有效字段时返回 null。 */
export function normalizePanelPatch(value: unknown): DetachedPanelPatch | null {
  if (!isRecord(value)) return null
  const patch: DetachedPanelPatch = {}
  if (typeof value.alwaysOnTop === 'boolean') patch.alwaysOnTop = value.alwaysOnTop
  if (typeof value.opacity === 'number' && Number.isFinite(value.opacity))
    patch.opacity = normalizeOpacity(value.opacity)
  return Object.keys(patch).length ? patch : null
}

/** 摘出请求：页面必须可摘出，初始位置可选。接受页面 ID 字符串或 `{ pageId, bounds }`。 */
export function parseDetachRequest(value: unknown): DetachRequest | null {
  if (isDetachablePage(value)) return { pageId: value }
  if (!isRecord(value) || !isDetachablePage(value.pageId)) return null
  const bounds = normalizeShellRect(value.bounds)
  return { pageId: value.pageId, ...(bounds ? { bounds } : {}) }
}

/** 从 `pageId` 字符串或 `{ pageId }` 中取出页面 ID。 */
export function readPageId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.pageId === 'string') return value.pageId
  return undefined
}

/** 设置类页面窄而高，列表与工作类页面宽一些。 */
const SETTINGS_PAGES = new Set<string>([
  'agent_config',
  'user_settings',
  'desktop_home',
  'model_config',
  'voice_config',
  'mcp_config',
  'distributed',
  'social',
])

export function defaultPanelSize(pageId: string): { width: number; height: number } {
  return SETTINGS_PAGES.has(pageId) ? { width: 720, height: 800 } : { width: 900, height: 700 }
}

export function panelStates(layout: DesktopShellLayout): DetachedPanelState[] {
  return DETACHABLE_PAGE_IDS.flatMap((pageId) => {
    const panel = layout.panels[pageId]
    return panel ? [{ pageId, alwaysOnTop: panel.alwaysOnTop, opacity: panel.opacity }] : []
  })
}

function intersectionArea(a: ShellRect, b: ShellRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/** 把窗口限制在工作区内：尺寸不超过工作区，位置尽量保持原样。 */
export function clampRectToArea(
  rect: ShellRect,
  area: ShellRect,
  min: ShellMinSize = PANEL_MIN_SIZE,
): ShellRect {
  const width = Math.max(Math.min(rect.width, area.width), Math.min(min.width, area.width))
  const height = Math.max(Math.min(rect.height, area.height), Math.min(min.height, area.height))
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height)
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * 屏幕外修正：窗口在所有显示器工作区内可见的面积不足一半时（拔掉显示器、改分辨率），
 * 移回主显示器工作区内；否则保持原样。
 */
export function correctOffscreenBounds(
  bounds: ShellRect,
  workAreas: readonly ShellRect[],
  primary: ShellRect,
  min: ShellMinSize = PANEL_MIN_SIZE,
): ShellRect {
  const area = bounds.width * bounds.height
  const visible = workAreas.reduce((sum, workArea) => sum + intersectionArea(bounds, workArea), 0)
  if (area > 0 && visible * 2 >= area) return bounds
  return clampRectToArea(bounds, primary, min)
}

/**
 * 新摘出窗口的位置：优先放在主窗口右侧，放不下时放左侧，再放不下时贴工作区右边缘；
 * 多个新面板依次错开，最终保证完整落在工作区内。`min` 为窗口的最小尺寸（卡片比面板小得多）。
 */
export function placeNewPanel(
  size: { width: number; height: number },
  main: ShellRect | undefined,
  workArea: ShellRect,
  index = 0,
  min: ShellMinSize = PANEL_MIN_SIZE,
): ShellRect {
  const gap = 12
  const offset = (index % 8) * 28
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  const right = workArea.x + workArea.width
  let x: number
  let y: number
  if (main) {
    const besideRight = main.x + main.width + gap
    const besideLeft = main.x - gap - width
    if (besideRight + width <= right) x = besideRight
    else if (besideLeft >= workArea.x) x = besideLeft
    else x = right - width - gap
    y = main.y + offset
    x += x === besideLeft ? -offset : offset
  } else {
    x = workArea.x + Math.round((workArea.width - width) / 2) + offset
    y = workArea.y + Math.round((workArea.height - height) / 2) + offset
  }
  return clampRectToArea({ x, y, width, height }, workArea, min)
}
