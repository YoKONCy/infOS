/**
 * 桌面收纳框（预制件 fence）— 状态结构、限制、归一化与纯函数操作
 *
 * 收纳框把桌面上的程序、文件、文件夹以「引用」的方式收在一个半透明框里：
 * 只记下路径，不移动、不复制、不删除用户的文件。内容有两种来源：
 * - 登记的项目（`items`）：用户拖进来或 Agent 加进来的路径；
 * - 映射的文件夹（`folder`）：框里显示该文件夹的直接子项，随文件夹变化。
 *
 * 本模块只含纯数据与纯函数，主进程、preload 与后端工具共用。
 *
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

export const FENCE_ICON_SIZES = ['small', 'medium', 'large'] as const
export type FenceIconSize = (typeof FENCE_ICON_SIZES)[number]

/** 排序方式：手动（登记顺序，可拖动调整）、按名称、按类型（再按名称）。 */
export const FENCE_SORTS = ['manual', 'name', 'type'] as const
export type FenceSort = (typeof FENCE_SORTS)[number]

/** 多个框排成一组时的布局：竖排、横排、网格。 */
export const FENCE_LAYOUTS = ['column', 'row', 'grid'] as const
export type FenceLayout = (typeof FENCE_LAYOUTS)[number]

export const FENCE_LIMITS = {
  /** 每个框登记的项目数。 */
  items: 200,
  /** 路径长度（字符）。 */
  path: 1024,
  /** 映射文件夹时最多显示的子项数。 */
  folderEntries: 300,
  /** 每个框每分钟可启动的次数（防止误触连发）。 */
  launchesPerMinute: 20,
  /** 每个框每分钟可发起的系统拖拽次数（框内排序也算一次）。 */
  dragsPerMinute: 60,
} as const

/** 折叠后只剩的标题栏高度（逻辑像素）。 */
export const FENCE_TITLE_BAR_HEIGHT = 30
/** 展开时的最小高度。 */
export const FENCE_EXPANDED_MIN_HEIGHT = 80
export const FENCE_MIN_WIDTH = 140
export const FENCE_DEFAULT_SIZE = { width: 300, height: 220 } as const

/**
 * 页面内的窗口手势：`move` 移动；其余为缩放方向（上下左右与四角）。
 * 主进程记下开始时的窗口位置，每次用「起始值 + 累计增量」算新位置，混合 DPI 下尺寸不会越拖越偏。
 */
export const FENCE_GESTURES = ['move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
export type FenceGesture = (typeof FENCE_GESTURES)[number]
/** 手势的累计增量上限（逻辑像素）；超出视为无效请求。 */
export const FENCE_GESTURE_MAX_DELTA = 100_000

/**
 * 背景透明度（百分比）：0 全透明，100 不透明。只影响框的背景和标题栏，图标和文字保持清晰。
 * 默认值就是原设计的半透明观感。
 */
export const FENCE_BACKGROUND_OPACITY = { min: 0, max: 100, default: 42 } as const

/** 项目格子里图标的显示边长（像素）。 */
export const FENCE_ICON_PIXELS: Record<FenceIconSize, number> = {
  small: 24,
  medium: 36,
  large: 48,
}

/** 谁建的框：用户在界面上建，或 Agent 经工具建（身份由宿主注入，模型不能自报）。 */
export type FenceCreator = { kind: 'user' } | { kind: 'agent'; agentId: string; sessionId: string }

/** 登记的项目：只有路径引用。 */
export interface FenceItem {
  id: string
  path: string
  addedAt: string
}

export interface FenceState {
  collapsed: boolean
  iconSize: FenceIconSize
  sort: FenceSort
  /** 背景透明度（0–100），见 FENCE_BACKGROUND_OPACITY。 */
  backgroundOpacity: number
  items: FenceItem[]
  /** 映射的文件夹；设置后框里另外显示该文件夹的直接子项。 */
  folder?: string
  createdBy?: FenceCreator
}

/** 页面看到的项目：没有路径，只有宿主分配的 ID、显示名与类型。 */
export interface FenceViewItem {
  id: string
  name: string
  kind: 'app' | 'link' | 'folder' | 'file'
  /** 引用的路径已不存在。 */
  missing: boolean
  /** 来自映射文件夹（不能手动排序或移出）。 */
  fromFolder: boolean
  /** 文件的版本（修改时间与大小）；变了页面就重新要图标。不含路径。 */
  iconVersion: string
  /** 是图片，可以向主进程要缩略图。 */
  thumbnail: boolean
  /** 可以拖出框外（文件存在，且不是隐藏或受保护文件）。主进程发起拖拽时还会再查一次。 */
  dragOut: boolean
}

export interface FenceView {
  kind: 'fence'
  title: string
  collapsed: boolean
  alwaysOnTop: boolean
  desktopLayer: boolean
  iconSize: FenceIconSize
  sort: FenceSort
  backgroundOpacity: number
  /** 映射文件夹的名称（不含完整路径）。 */
  folderName?: string
  items: FenceViewItem[]
  labels: Record<string, string>
}

/** 收纳框页面可发起的动作；主进程按枚举校验，未知动作一律拒绝。 */
export const FENCE_PAGE_ACTIONS = [
  'launch',
  'collapse',
  'pin',
  'layer',
  'iconSize',
  'sort',
  'backgroundOpacity',
  'rename',
  'remove',
  'reorder',
  'drop',
  'close',
] as const
export type FencePageAction = (typeof FENCE_PAGE_ACTIONS)[number]

export const DEFAULT_FENCE_STATE: FenceState = {
  collapsed: false,
  iconSize: 'medium',
  sort: 'manual',
  backgroundOpacity: FENCE_BACKGROUND_OPACITY.default,
  items: [],
}

/** 背景透明度的合法取值：0–100 的整数。 */
export function isFenceBackgroundOpacity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= FENCE_BACKGROUND_OPACITY.min &&
    value <= FENCE_BACKGROUND_OPACITY.max
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

// eslint-disable-next-line no-control-regex -- 路径中的控制字符一律拒绝。
const CONTROL = /[\x00-\x1f\x7f]/

/**
 * 收纳框接受的路径：本机绝对路径（`C:\…`，非 Windows 开发环境另接受 `/…`）。
 * 拒绝网络路径（`\\server\share`）与设备路径（`\\?\`、`\\.\`），避免读取图标时连到外部主机。
 * 斜杠统一为反斜杠（盘符路径），去掉末尾多余的分隔符。不合格时返回 undefined。
 */
export function normalizeFencePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.length > FENCE_LIMITS.path || CONTROL.test(text)) return undefined
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    const normalized = text.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
    if (/[<>"|?*]/.test(normalized.slice(2))) return undefined
    if (normalized.split('\\').some((part) => part === '..')) return undefined
    return normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized
  }
  if (text.startsWith('/') && !text.startsWith('//')) {
    if (text.split('/').some((part) => part === '..')) return undefined
    return text.length > 1 ? text.replace(/\/+$/, '') : text
  }
  return undefined
}

/** 比较路径用的键：Windows 路径不区分大小写。 */
export function fencePathKey(path: string): string {
  return /^[A-Za-z]:\\/.test(path) ? path.toLowerCase() : path
}

/** 路径最后一段（文件或文件夹名）。 */
export function fenceBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

/** 项目 ID：主进程生成，`i-` 为登记项，`f-` 为映射文件夹的子项。 */
export function isFenceItemId(value: unknown): value is string {
  return typeof value === 'string' && /^[if]-[a-z0-9]{6,24}$/.test(value)
}

function normalizeCreator(value: unknown): FenceCreator | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'user') return { kind: 'user' }
  if (
    value.kind === 'agent' &&
    typeof value.agentId === 'string' &&
    value.agentId &&
    typeof value.sessionId === 'string' &&
    value.sessionId
  )
    return { kind: 'agent', agentId: value.agentId, sessionId: value.sessionId }
  return undefined
}

/** 读取持久化的收纳框状态：无效字段用默认值，无效或重复的项目丢弃。 */
export function normalizeFenceState(value: unknown): FenceState {
  const item = isRecord(value) ? value : {}
  const seen = new Set<string>()
  const items: FenceItem[] = []
  for (const raw of Array.isArray(item.items) ? item.items : []) {
    if (!isRecord(raw) || !isFenceItemId(raw.id) || !raw.id.startsWith('i-')) continue
    const path = normalizeFencePath(raw.path)
    if (!path || seen.has(fencePathKey(path)) || items.length >= FENCE_LIMITS.items) continue
    seen.add(fencePathKey(path))
    const addedAt =
      typeof raw.addedAt === 'string' && !Number.isNaN(Date.parse(raw.addedAt))
        ? raw.addedAt
        : new Date(0).toISOString()
    items.push({ id: raw.id, path, addedAt })
  }
  const folder = normalizeFencePath(item.folder)
  const createdBy = normalizeCreator(item.createdBy)
  return {
    collapsed: item.collapsed === true,
    iconSize: (FENCE_ICON_SIZES as readonly unknown[]).includes(item.iconSize)
      ? (item.iconSize as FenceIconSize)
      : DEFAULT_FENCE_STATE.iconSize,
    sort: (FENCE_SORTS as readonly unknown[]).includes(item.sort)
      ? (item.sort as FenceSort)
      : DEFAULT_FENCE_STATE.sort,
    // 版本 1 的旧数据没有这个字段，按默认值（与原来的外观相同）。
    backgroundOpacity: isFenceBackgroundOpacity(item.backgroundOpacity)
      ? item.backgroundOpacity
      : DEFAULT_FENCE_STATE.backgroundOpacity,
    items,
    ...(folder ? { folder } : {}),
    ...(createdBy ? { createdBy } : {}),
  }
}

export interface FenceAddResult {
  state: FenceState
  added: FenceItem[]
  skipped: { path: string; reason: 'invalid' | 'duplicate' | 'limit' }[]
}

/** 登记项目（只记路径）；重复的、无效的与超出上限的跳过并说明原因。 */
export function addFenceItems(
  state: FenceState,
  paths: readonly unknown[],
  makeId: () => string,
  now: string,
): FenceAddResult {
  const items = [...state.items]
  const seen = new Set(items.map((entry) => fencePathKey(entry.path)))
  const added: FenceItem[] = []
  const skipped: FenceAddResult['skipped'] = []
  for (const raw of paths) {
    const path = normalizeFencePath(raw)
    if (!path) skipped.push({ path: String(raw ?? ''), reason: 'invalid' })
    else if (seen.has(fencePathKey(path))) skipped.push({ path, reason: 'duplicate' })
    else if (items.length >= FENCE_LIMITS.items) skipped.push({ path, reason: 'limit' })
    else {
      const entry = { id: makeId(), path, addedAt: now }
      seen.add(fencePathKey(path))
      items.push(entry)
      added.push(entry)
    }
  }
  return { state: { ...state, items }, added, skipped }
}

/** 移出登记项（按 ID 或路径）；只改登记表，不碰文件本身。 */
export function removeFenceItems(
  state: FenceState,
  refs: readonly string[],
): { state: FenceState; removed: FenceItem[] } {
  const keys = new Set(refs.map((ref) => (isFenceItemId(ref) ? ref : fencePathKey(ref))))
  const removed = state.items.filter(
    (entry) => keys.has(entry.id) || keys.has(fencePathKey(entry.path)),
  )
  const left = state.items.filter((entry) => !removed.includes(entry))
  return { state: { ...state, items: left }, removed }
}

/**
 * 按给定顺序重排登记项（按 ID 或路径）；没提到的项目保持原有相对顺序排在后面。
 * 重排意味着手动排序，`sort` 改为 manual。
 */
export function reorderFenceItems(state: FenceState, order: readonly string[]): FenceState {
  const rank = new Map<string, number>()
  order.forEach((ref, index) => {
    const key = isFenceItemId(ref) ? ref : fencePathKey(ref)
    if (!rank.has(key)) rank.set(key, index)
  })
  const position = (entry: FenceItem) =>
    rank.get(entry.id) ?? rank.get(fencePathKey(entry.path)) ?? Number.POSITIVE_INFINITY
  const items = state.items
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => position(left.entry) - position(right.entry) || left.index - right.index)
    .map(({ entry }) => entry)
  return { ...state, items, sort: 'manual' }
}

const KIND_RANK: Record<FenceViewItem['kind'], number> = { folder: 0, app: 1, link: 2, file: 3 }

/** 显示顺序：手动保持原顺序；名称按本地化比较；类型先文件夹、程序、快捷方式、文件，再按名称。 */
export function sortFenceView<T extends Pick<FenceViewItem, 'name' | 'kind'>>(
  items: readonly T[],
  sort: FenceSort,
): T[] {
  if (sort === 'manual') return [...items]
  const byName = (left: T, right: T) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  return [...items].sort((left, right) =>
    sort === 'type'
      ? KIND_RANK[left.kind] - KIND_RANK[right.kind] || byName(left, right)
      : byName(left, right),
  )
}

/** 按扩展名判断项目类型（目录由调用方根据文件系统判断）。 */
export function fenceItemKind(path: string, isDirectory: boolean): FenceViewItem['kind'] {
  if (isDirectory) return 'folder'
  const lower = path.toLowerCase()
  if (lower.endsWith('.lnk') || lower.endsWith('.url')) return 'link'
  if (lower.endsWith('.exe') || lower.endsWith('.appref-ms')) return 'app'
  return 'file'
}

/** 显示名：快捷方式与程序去掉扩展名，其余保留完整文件名。 */
export function fenceDisplayName(path: string, isDirectory: boolean): string {
  const name = fenceBaseName(path)
  if (isDirectory) return name
  return /\.(lnk|url|exe|appref-ms)$/i.test(name) ? name.replace(/\.[^.]+$/, '') : name
}

export function isFenceGesture(value: unknown): value is FenceGesture {
  return (FENCE_GESTURES as readonly unknown[]).includes(value)
}

/** 窗口矩形（与 ShellRect 同构；这里不依赖 desktopShell，保持本模块只含收纳框自己的内容）。 */
export interface FenceRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 手势过程中窗口应有的位置：只由开始时的位置和累计增量决定，不在当前值上累加。
 * - 移动：宽高保持开始时的值；
 * - 缩放：拖动的边跟手，对边不动，宽高不小于最小尺寸；
 * - 折叠：窗口只剩标题栏，只能改宽度，高度方向的增量一律忽略。
 */
export function fenceGestureBounds(
  start: FenceRect,
  gesture: FenceGesture,
  dx: number,
  dy: number,
  collapsed: boolean,
): FenceRect {
  if (gesture === 'move')
    return {
      x: Math.round(start.x + dx),
      y: Math.round(start.y + dy),
      width: start.width,
      height: start.height,
    }
  let { x, y, width, height } = start
  if (gesture.includes('e')) width = Math.max(FENCE_MIN_WIDTH, start.width + dx)
  if (gesture.includes('w')) {
    width = Math.max(FENCE_MIN_WIDTH, start.width - dx)
    x = start.x + start.width - width
  }
  if (!collapsed && gesture.includes('s'))
    height = Math.max(FENCE_EXPANDED_MIN_HEIGHT, start.height + dy)
  if (!collapsed && gesture.includes('n')) {
    height = Math.max(FENCE_EXPANDED_MIN_HEIGHT, start.height - dy)
    y = start.y + start.height - height
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/** 保存的位置 → 窗口位置：折叠时只留标题栏；窗口不再有原生最小尺寸，这里统一钳到最小值。 */
export function fenceWindowRect(rect: FenceRect, collapsed: boolean): FenceRect {
  return {
    ...rect,
    width: Math.max(rect.width, FENCE_MIN_WIDTH),
    height: collapsed ? FENCE_TITLE_BAR_HEIGHT : Math.max(rect.height, FENCE_EXPANDED_MIN_HEIGHT),
  }
}

export interface FenceArrangeInput {
  id: string
  width: number
  height: number
}

/**
 * 把多个框排成一组：从 origin 开始按顺序竖排、横排或按列数排成网格，间距 gap。
 * 只计算左上角，宽高不变；网格每行高度取该行最高的框，每列宽度取该列最宽的框。
 */
export function arrangeFences(
  fences: readonly FenceArrangeInput[],
  layout: FenceLayout,
  origin: { x: number; y: number },
  gap = 12,
  columns = 2,
): { id: string; x: number; y: number }[] {
  const perRow =
    layout === 'column' ? 1 : layout === 'row' ? fences.length : Math.max(1, Math.floor(columns))
  const columnWidths: number[] = []
  const rowHeights: number[] = []
  fences.forEach((fence, index) => {
    const column = index % perRow
    const row = Math.floor(index / perRow)
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, fence.width)
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, fence.height)
  })
  const offset = (sizes: number[], count: number) =>
    sizes.slice(0, count).reduce((total, size) => total + size + gap, 0)
  return fences.map((fence, index) => ({
    id: fence.id,
    x: Math.round(origin.x + offset(columnWidths, index % perRow)),
    y: Math.round(origin.y + offset(rowHeights, Math.floor(index / perRow))),
  }))
}
