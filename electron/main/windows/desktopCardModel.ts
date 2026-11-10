/**
 * @file 桌面卡片的宿主接口、输入结构与窗口位置计算。
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 */

import { t as __t } from '../utils/i18n'
import type { HomeCardBinding } from '../../../packages/shared/src/homeCardChannel'
import { screen, type BrowserWindow } from 'electron'
import {
  CARD_DEFAULT_SIZE,
  CARD_MIN_SIZE,
  DESKTOP_CARD_LIMITS,
  DESKTOP_PREFABS,
  isDesktopCardHtml,
  type DesktopCardMeta,
  type DesktopPrefabMeta,
} from '../../../packages/shared/src/desktopCards'
import {
  clampRectToArea,
  correctOffscreenBounds,
  normalizeOpacity,
  normalizeShellRect,
  placeNewPanel,
  type MainPageId,
  type ShellRect,
} from '../../../packages/shared/src/desktopShell'

/** 由 WindowManager / 外壳宿主注入的能力。 */
export interface DesktopCardsHost {
  /** 创建卡片沙箱窗口并加载 `infos-card://<ID>/`；不抢焦点地显示。 */
  createWindow(card: DesktopCardMeta, bounds: ShellRect): BrowserWindow
  mainWindow(): BrowserWindow | null
  /** 在主窗口打开页面，或聚焦已摘出的面板。 */
  openPage(pageId: MainPageId): void
  themeMode(): 'light' | 'dark'
  readCustomTheme(): Promise<string | null>
  /** 阶段 5：贴到桌面底层（仅 Windows）；返回是否成功。 */
  desktopLayer?: { set(win: BrowserWindow, enabled: boolean): boolean }
}

/**
 * 预制件的窗口钩子（实现见 electron/main/prefabs）；普通卡片不经过这些钩子。
 * 卡片管理只负责通用的窗口生命周期，预制件特有的尺寸、监视与页面由钩子决定。
 */
export interface DesktopCardPrefabHooks {
  /** 预制件页面（宿主内置，不含脚本）。 */
  document(card: DesktopCardMeta): string
  /** 窗口创建后：最小尺寸、折叠、全屏让开、文件夹监视等。 */
  opened(card: DesktopCardMeta, win: BrowserWindow): void
  /** 窗口关闭（removed 为 false）或卡片删除（removed 为 true）后释放监视；不碰引用的文件。 */
  released(id: string, removed: boolean): void
  /** 窗口实际位置 → 要保存的位置（例如折叠时保留展开高度）。 */
  persistBounds(card: DesktopCardMeta, rect: ShellRect): ShellRect
  /** 保存的位置 → 窗口位置（例如折叠时只留标题栏）。 */
  windowBounds(card: DesktopCardMeta, rect: ShellRect): ShellRect
}

export interface DesktopCardDisplays {
  workAreas(): ShellRect[]
  primaryWorkArea(): ShellRect
  workAreaNear(rect: ShellRect): ShellRect
}

export const electronDisplays: DesktopCardDisplays = {
  workAreas: () => screen.getAllDisplays().map((display) => ({ ...display.workArea })),
  primaryWorkArea: () => ({ ...screen.getPrimaryDisplay().workArea }),
  workAreaNear: (rect) => ({ ...screen.getDisplayMatching(rect).workArea }),
}

/** 卡片错误：稳定错误码 + 本地化说明，能力通道按“错误码: 说明”拆分。 */
export function fail(code: string, message: string, args?: unknown[]): never {
  throw new Error(`${code}: ${__t('electron.ui.desktopShell', message, args)}`)
}

export interface DesktopCardInput {
  homeBinding?: HomeCardBinding
  /** 预制件：由主进程预制件模块构造，不接受角色或页面传入。 */
  prefab?: DesktopPrefabMeta
  name?: unknown
  html?: unknown
  bounds?: unknown
  alwaysOnTop?: unknown
  opacity?: unknown
}

type CardSize = { width: number; height: number }

/** 新卡片的位置：靠近主窗口，按已打开的卡片数错开，并限制在工作区内。 */
export function placeNewCard(
  size: CardSize,
  displays: DesktopCardDisplays,
  main: BrowserWindow | null | undefined,
  openCount: number,
): ShellRect {
  const mainBounds = main && !main.isDestroyed() ? main.getBounds() : undefined
  const workArea = mainBounds ? displays.workAreaNear(mainBounds) : displays.primaryWorkArea()
  return clampRectToArea(
    placeNewPanel(size, mainBounds, workArea, openCount, CARD_MIN_SIZE),
    workArea,
    CARD_MIN_SIZE,
  )
}

/** 打开卡片时的位置：已保存的位置修正到可见区域，没有则按新卡片放置。 */
export function resolveCardBounds(
  card: DesktopCardMeta,
  displays: DesktopCardDisplays,
  placeNew: (size: CardSize) => ShellRect,
): ShellRect {
  if (card.bounds)
    return correctOffscreenBounds(
      card.bounds,
      displays.workAreas(),
      displays.primaryWorkArea(),
      CARD_MIN_SIZE,
    )
  return placeNew(CARD_DEFAULT_SIZE)
}

/** 解析角色给出的位置或大小；只给大小时按新卡片放置。 */
export function readCardBounds(
  value: unknown,
  displays: DesktopCardDisplays,
  placeNew: (size: CardSize) => ShellRect,
): ShellRect | undefined {
  if (value === undefined) return undefined
  const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const rect = item ? normalizeShellRect({ ...CARD_DEFAULT_SIZE, ...item }, CARD_MIN_SIZE) : null
  if (item && !rect && item.x === undefined && item.y === undefined) {
    const size = normalizeShellRect({ x: 0, y: 0, ...CARD_DEFAULT_SIZE, ...item }, CARD_MIN_SIZE)
    if (size) return placeNew(size)
  }
  if (!rect) fail('DESKTOP_CARD_INVALID_BOUNDS', '卡片位置或大小无效')
  return clampRectToArea(rect, displays.workAreaNear(rect), CARD_MIN_SIZE)
}

/** 角色写的卡片 HTML：为空或超过上限时报错。 */
export function requireCardHtml(value: unknown): string {
  if (!isDesktopCardHtml(value))
    fail('DESKTOP_CARD_INVALID_HTML', '卡片 HTML 为空或超过 {0}KB', [
      DESKTOP_CARD_LIMITS.html / 1024,
    ])
  return value
}

/** 是否计入卡片总数上限：普通卡片计入，预制件按注册表声明（收纳框不计）。 */
export function countsTowardCardLimit(card: { prefab?: DesktopPrefabMeta }): boolean {
  return !card.prefab || DESKTOP_PREFABS[card.prefab.kind].countsTowardCardLimit
}

/** 新卡片的元数据；预制件是有意摆上桌面的，直接收藏，不进「最近关闭」。 */
export function newCardMeta(
  id: string,
  name: string,
  input: DesktopCardInput,
  bounds: ShellRect | undefined,
  time: string,
): DesktopCardMeta {
  return {
    id,
    ...(input.homeBinding ? { homeBinding: input.homeBinding } : {}),
    name,
    ...(bounds ? { bounds } : {}),
    alwaysOnTop: input.alwaysOnTop === true,
    opacity: input.opacity === undefined ? 1 : normalizeOpacity(input.opacity),
    saved: input.prefab !== undefined,
    open: true,
    desktopLayer: false,
    autoOpen: false,
    ...(input.prefab ? { prefab: input.prefab } : {}),
    createdAt: time,
    updatedAt: time,
  }
}
