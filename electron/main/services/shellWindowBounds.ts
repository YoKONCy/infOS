/**
 * @file 外壳窗口的移动、缩放与复位：先把窗口恢复为普通状态，应用后读回实际位置核对。
 * @description 全屏或最大化的窗口直接 setBounds 不会生效，结果却会被当成成功；
 *              这里统一退出全屏、取消最大化与最小化，再应用位置，最后读回实际 bounds，
 *              偏差超出容差时抛出带原因的错误，避免角色对用户说错话。
 * @platform ELECTRON
 */

import type { BrowserWindow } from 'electron'
import { CARD_DEFAULT_SIZE } from '../../../packages/shared/src/desktopCards'
import {
  clampRectToArea,
  defaultPanelSize,
  type MainPageId,
  type ShellRect,
} from '../../../packages/shared/src/desktopShell'
import { fail, sameRect } from './shellCapabilityModel'

/** 把位置修正到工作区内后应用到窗口（撤回时用）；位置没变时返回 false。 */
export function placeWindow(
  win: BrowserWindow,
  rect: ShellRect,
  workAreaNear: (rect: ShellRect) => ShellRect,
): boolean {
  const bounds = clampRectToArea(rect, workAreaNear(rect))
  if (sameRect(win.getBounds(), bounds)) return false
  if (win.isMinimized()) win.restore()
  if (win.isMaximized()) win.unmaximize()
  win.setBounds(bounds)
  return true
}

/** 读回位置允许的偏差（像素）：DPI 缩放换算会产生 1px 左右的取整误差。 */
export const BOUNDS_TOLERANCE = 2
/** 等待退出全屏的上限（毫秒）；部分平台的全屏切换是异步的。 */
const LEAVE_FULLSCREEN_TIMEOUT = 1000
/** 主窗口复位时的默认大小，与 manager.ts 中综合面板的初始大小一致。 */
const MAIN_DEFAULT_SIZE = { width: 1280, height: 800 }

/** 窗口在移动前所处的特殊状态。 */
export type WindowStateFlag = 'fullscreen' | 'maximized' | 'minimized'

type StatefulWindow = Pick<
  BrowserWindow,
  | 'isFullScreen'
  | 'setFullScreen'
  | 'isMaximized'
  | 'unmaximize'
  | 'isMinimized'
  | 'restore'
  | 'once'
  | 'removeListener'
>

function waitLeaveFullScreen(win: StatefulWindow): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      win.removeListener('leave-full-screen', done)
      resolve()
    }
    const timer = setTimeout(done, LEAVE_FULLSCREEN_TIMEOUT)
    win.once('leave-full-screen', done)
  })
}

/** 把窗口恢复为普通状态（退出全屏、取消最大化、取消最小化），返回原先所处的状态。 */
export async function restoreNormalState(win: StatefulWindow): Promise<WindowStateFlag[]> {
  const flags: WindowStateFlag[] = []
  if (win.isFullScreen?.()) {
    flags.push('fullscreen')
    const left = waitLeaveFullScreen(win)
    win.setFullScreen(false)
    if (win.isFullScreen()) await left
  }
  if (win.isMinimized()) {
    flags.push('minimized')
    win.restore()
  }
  if (win.isMaximized()) {
    flags.push('maximized')
    win.unmaximize()
  }
  return flags
}

/** 两个矩形在容差内是否一致。 */
export function boundsMatch(actual: ShellRect, expected: ShellRect): boolean {
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(actual[key] - expected[key]) <= BOUNDS_TOLERANCE,
  )
}

/**
 * 操作后回读验证的通用结果：请求的值、实际读回的值、是否生效与没生效的原因。
 * 以后鼠标、键盘等注入操作的回读验证沿用同一结构。
 */
export interface AppliedCheck<T> {
  requested: T
  actual: T
  applied: boolean
  /** 没生效的原因（稳定代号），生效时省略。 */
  reason?: 'still-fullscreen-or-maximized' | 'constrained'
}

/** 回读窗口位置并与请求比较，不抛错。 */
export function checkAppliedBounds(
  win: Pick<BrowserWindow, 'getBounds' | 'isFullScreen' | 'isMaximized'>,
  requested: ShellRect,
): AppliedCheck<ShellRect> {
  const actual = win.getBounds()
  if (boundsMatch(actual, requested)) return { requested, actual, applied: true }
  return {
    requested,
    actual,
    applied: false,
    reason:
      win.isFullScreen?.() || win.isMaximized() ? 'still-fullscreen-or-maximized' : 'constrained',
  }
}

/** 读回实际位置；与期望不符时以稳定错误码和可行动的说明抛错，符合时返回回读结果。 */
export function verifyAppliedBounds(
  win: Pick<BrowserWindow, 'getBounds' | 'isFullScreen' | 'isMaximized'>,
  expected: ShellRect,
): AppliedCheck<ShellRect> {
  const check = checkAppliedBounds(win, expected)
  if (check.applied) return check
  const describe = (rect: ShellRect) => `${rect.x},${rect.y} ${rect.width}x${rect.height}`
  if (check.reason === 'still-fullscreen-or-maximized')
    fail(
      'DESKTOP_SHELL_BOUNDS_NOT_APPLIED',
      '窗口仍处于全屏或最大化状态，位置没有生效：期望 {0}，实际 {1}。请用 recover 复位后再试',
      [describe(expected), describe(check.actual)],
    )
  fail(
    'DESKTOP_SHELL_BOUNDS_NOT_APPLIED',
    '窗口位置没有生效：期望 {0}，实际 {1}。可能受最小尺寸或系统限制，请按实际位置向用户说明',
    [describe(expected), describe(check.actual)],
  )
}

/** 复位用的默认大小：卡片、面板与主窗口各按自己的初始大小。 */
export function defaultWindowSize(target: { page?: MainPageId; card?: string }): {
  width: number
  height: number
} {
  if (target.card) return { ...CARD_DEFAULT_SIZE }
  if (target.page) return defaultPanelSize(target.page)
  return { ...MAIN_DEFAULT_SIZE }
}

/** 复位位置：默认大小、在工作区内居中（超出工作区时收缩到工作区大小）。 */
export function centeredRect(size: { width: number; height: number }, area: ShellRect): ShellRect {
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}
