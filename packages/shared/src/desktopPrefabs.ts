/**
 * 桌面预制件 — 注册表、能力声明、版本号与通道
 *
 * 预制件是 infOS 自己写好的「受信任的内置卡片」：沿用卡片的窗口管理（置顶、贴到桌面、
 * Ctrl+W 关闭、卡片页管理），页面由宿主提供、没有页面脚本，
 * 界面由预制件 preload 绘制；按注册表声明的能力获得受控的主进程接口。
 * 普通卡片（角色写的 HTML）仍在原沙箱里，拿不到这些能力。
 *
 * 新增预制件：在 `DESKTOP_PREFAB_KINDS` 加种类、在 `DESKTOP_PREFABS` 写定义（版本、能力、尺寸、
 * 状态归一化与迁移），再在主进程预制件模块与 preload 视图注册表各加一项。
 *
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type { ShellMinSize } from './desktopShell'
import {
  FENCE_DEFAULT_SIZE,
  FENCE_MIN_WIDTH,
  FENCE_TITLE_BAR_HEIGHT,
  normalizeFenceState,
} from './desktopFence'

export const DESKTOP_PREFAB_KINDS = ['fence'] as const
export type DesktopPrefabKind = (typeof DESKTOP_PREFAB_KINDS)[number]

/**
 * 预制件可声明的能力：
 * - `launch-registered`：启动本预制件登记过的项目（只按项目 ID，页面不能传路径）；
 * - `file-icons`：读取登记项目的系统图标（主进程读取并缓存）；
 * - `folder-watch`：映射文件夹，内容变化时刷新；
 * - `drop-reference`：用户拖进来的文件登记为引用；
 * - `collapse`：折叠为只剩标题栏；
 * - `fullscreen-yield`：前台有全屏程序时暂时隐藏；
 * - `window-gesture`：页面内拖动来移动、缩放自己的窗口（只作用于发送者自己）；
 * - `drag-out`：把本预制件里的项目作为系统文件拖出去（只按项目 ID，页面不能传路径）。
 */
export const DESKTOP_PREFAB_CAPABILITIES = [
  'launch-registered',
  'file-icons',
  'folder-watch',
  'drop-reference',
  'collapse',
  'fullscreen-yield',
  'window-gesture',
  'drag-out',
] as const
export type DesktopPrefabCapability = (typeof DESKTOP_PREFAB_CAPABILITIES)[number]

export interface DesktopPrefabDefinition {
  kind: DesktopPrefabKind
  /** 状态结构版本；读取旧版本时由 normalizeState 迁移。 */
  version: number
  capabilities: readonly DesktopPrefabCapability[]
  defaultSize: { width: number; height: number }
  /** 窗口最小尺寸（折叠类预制件的高度可小于普通卡片）。 */
  minSize: ShellMinSize
  /** 是否计入卡片总数上限（收纳框不计，数量不限）。 */
  countsTowardCardLimit: boolean
  /** 读取并迁移持久化状态；fromVersion 为文件中记录的版本。 */
  normalizeState(value: unknown, fromVersion: number): Record<string, unknown>
}

export const DESKTOP_PREFABS: Record<DesktopPrefabKind, DesktopPrefabDefinition> = {
  fence: {
    kind: 'fence',
    version: 2,
    capabilities: [
      'launch-registered',
      'file-icons',
      'folder-watch',
      'drop-reference',
      'collapse',
      'fullscreen-yield',
      'window-gesture',
      'drag-out',
    ],
    defaultSize: FENCE_DEFAULT_SIZE,
    minSize: { width: FENCE_MIN_WIDTH, height: FENCE_TITLE_BAR_HEIGHT },
    countsTowardCardLimit: false,
    // 版本 2 增加 backgroundOpacity：旧数据没有这个字段，归一化时按默认值补上，其余结构不变。
    normalizeState: (value) => ({ ...normalizeFenceState(value) }),
  },
}

/** 保存在 card.json 中的预制件信息。 */
export interface DesktopPrefabMeta {
  kind: DesktopPrefabKind
  version: number
  state: Record<string, unknown>
}

export function isDesktopPrefabKind(value: unknown): value is DesktopPrefabKind {
  return typeof value === 'string' && (DESKTOP_PREFAB_KINDS as readonly string[]).includes(value)
}

/** 预制件是否声明了某项能力；未声明的能力主进程一律拒绝。 */
export function desktopPrefabHas(
  meta: Pick<DesktopPrefabMeta, 'kind'> | undefined,
  capability: DesktopPrefabCapability,
): boolean {
  return !!meta && DESKTOP_PREFABS[meta.kind].capabilities.includes(capability)
}

/**
 * 读取 card.json 的 prefab 字段：未知种类返回 undefined（该卡片没有 index.html，读取时会被跳过）；
 * 状态按定义迁移到当前版本。
 */
export function normalizeDesktopPrefabMeta(value: unknown): DesktopPrefabMeta | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (!isDesktopPrefabKind(item.kind)) return undefined
  const definition = DESKTOP_PREFABS[item.kind]
  const version =
    typeof item.version === 'number' && Number.isInteger(item.version) && item.version > 0
      ? item.version
      : 1
  return {
    kind: item.kind,
    version: definition.version,
    state: definition.normalizeState(item.state, version),
  }
}

/** 新建预制件时的元数据。 */
export function createDesktopPrefabMeta(
  kind: DesktopPrefabKind,
  state: unknown,
): DesktopPrefabMeta {
  const definition = DESKTOP_PREFABS[kind]
  return {
    kind,
    version: definition.version,
    state: definition.normalizeState(state, definition.version),
  }
}

/**
 * 预制件页面的内容安全策略：页面不运行任何脚本（界面由 preload 绘制），样式内联，图片只用 data URI。
 */
export const DESKTOP_PREFAB_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** 预制件 preload 与主进程之间的通道；只接受对应种类的预制件窗口。 */
export const DESKTOP_PREFAB_CHANNELS = {
  /** 读取当前视图（不含路径） */
  state: 'desktop-prefab:state',
  /** 读取项目图标（按项目 ID） */
  icon: 'desktop-prefab:icon',
  /** 预制件动作（`(action, payload?)`，按种类的动作枚举校验） */
  action: 'desktop-prefab:action',
  /** 页面内的窗口手势（`(phase, payload)`，phase 为 begin / update / end），只作用于发送者自己的窗口 */
  gesture: 'desktop-prefab:gesture',
  /** 把项目作为系统文件拖出去（`(itemId)`）；Windows 上拖拽结束才返回，只作用于发送者自己的框 */
  dragOut: 'desktop-prefab:drag-out',
  /** 主进程推送：视图变化 */
  changed: 'desktop-prefab:changed',
  /**
   * 卡片管理改了名称或置顶时推送的卡片信息通道，与 `DESKTOP_CARD_CHANNELS.changed` 相同。
   * 在这里重复一份，是为了让预制件 preload 不导入 desktopCards：两个沙箱 preload 共用模块时
   * 打包会拆出公共 chunk，而沙箱 preload 不能 require 相对路径的文件。
   */
  cardChanged: 'desktop-card:changed',
} as const

/** 卡片页与预制件相关的管理通道；只接受主窗口与桌面面板。 */
export const DESKTOP_PREFAB_ADMIN_CHANNELS = {
  /** 新建收纳框：`{ folder?: boolean }`，folder 为真时先让用户选文件夹 */
  createFence: 'desktop-prefab-admin:create-fence',
  /** 读取「隐藏桌面原图标」状态 */
  desktopIcons: 'desktop-prefab-admin:desktop-icons',
  /** 切换「隐藏桌面原图标」：`{ hidden: boolean }` */
  setDesktopIcons: 'desktop-prefab-admin:set-desktop-icons',
} as const

/** 「隐藏桌面原图标」的状态。 */
export interface DesktopIconsState {
  /** 当前系统能否切换（仅 Windows，且找到了桌面图标窗口）。 */
  supported: boolean
  /** 桌面图标当前是否隐藏。 */
  hidden: boolean
  /** 是否由 infOS 隐藏（恢复时只撤销自己的改动）。 */
  hiddenByInfos: boolean
}
