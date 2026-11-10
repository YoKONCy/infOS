/**
 * @file 卡片窗口的事件接线：位置保存、关闭、Ctrl/Cmd+W、加载后截缩略图、控制台错误。
 *       从 desktopCardManager 拆出，普通卡片与预制件共用。
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 */

import type { BrowserWindow } from 'electron'
import { isDesktopCardCloseShortcut } from '../../../packages/shared/src/desktopCards'

/** 卡片控制台中保留的最近错误条数（供角色调试）。 */
export const CARD_CONSOLE_LIMIT = 20
/** 卡片页面加载完成后等这么久再截缩略图，让脚本先把内容画出来。 */
const THUMBNAIL_DELAY_MS = 1200

export interface CardWindowEvents {
  /** 这个窗口是否仍是该卡片的当前窗口（卡片未删除）。 */
  isCurrent(): boolean
  /** 移动或缩放后记下位置。 */
  moved(): void
  /** 窗口真正关闭。 */
  closed(): void
  /** 用户按了 Ctrl/Cmd+W。 */
  closeShortcut(): void
  /** 页面加载完成后截缩略图。 */
  thumbnail(): void
  /** 收到一条控制台警告或错误。 */
  console(line: string): void
}

export function wireCardWindow(win: BrowserWindow, events: CardWindowEvents): void {
  const capture = () => {
    if (!win.isDestroyed() && events.isCurrent()) events.moved()
  }
  win.on('move', capture)
  win.on('resize', capture)
  win.on('closed', () => events.closed())
  // 不依赖卡片页面的关闭方式：主进程在页面收到按键前拦截 Ctrl/Cmd+W，卡片脚本无法阻止。
  win.webContents.on('before-input-event', (event, input) => {
    if (!isDesktopCardCloseShortcut(input)) return
    event.preventDefault()
    if (events.isCurrent()) events.closeShortcut()
  })
  // 页面加载（含 update 后重新加载）完成后截一张缩略图，供卡片页显示。
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => events.thumbnail(), THUMBNAIL_DELAY_MS)
  })
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'error' && details.level !== 'warning') return
    events.console(`[${details.level}] ${String(details.message).slice(0, 500)}`)
  })
}
