/**
 * @file 全屏让开：前台窗口铺满某块显示器（游戏、全屏视频、演示）时，暂时隐藏该显示器上的预制件窗口，
 *       退出全屏后不抢焦点地显示回来。贴在桌面底层的窗口本来就在最下面，不需要让开。
 *
 *       思路参考 Lively Wallpaper 的「前台全屏时暂停」：比较前台窗口矩形与它所在显示器的完整范围；
 *       Lively 使用 GPL，这里只借鉴思路，代码为自行编写。桌面本身（Progman / WorkerW）与任务栏不算全屏。
 *       只在有需要让开的窗口时轮询（默认 1.5 秒一次）。
 *
 * @platform ELECTRON (Windows)
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type { BrowserWindow } from 'electron'
import type { ShellRect } from '../../../packages/shared/src/desktopShell'
import { isZeroHandle, type PrefabNative } from './prefabNative'

export const FULLSCREEN_POLL_MS = 1500
/** 前台窗口超出显示器边缘这么多以内仍算铺满（无边框全屏常有几像素误差）。 */
const TOLERANCE = 2
/** 桌面与任务栏：铺满屏幕但不是全屏程序。 */
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])

export interface FullscreenScreens {
  /** 物理像素矩形 → 逻辑像素（Electron `screen.screenToDipRect`）。 */
  toDip(rect: ShellRect): ShellRect
  /** 全部显示器的完整范围（逻辑像素，含任务栏区域）。 */
  displays(): ShellRect[]
}

const covers = (outer: ShellRect, inner: ShellRect) =>
  outer.x <= inner.x + TOLERANCE &&
  outer.y <= inner.y + TOLERANCE &&
  outer.x + outer.width >= inner.x + inner.width - TOLERANCE &&
  outer.y + outer.height >= inner.y + inner.height - TOLERANCE

const overlaps = (left: ShellRect, right: ShellRect) =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height

export class FullscreenYield {
  private readonly tracked = new Map<BrowserWindow, () => boolean>()
  private readonly yielded = new Set<BrowserWindow>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly native: () => PrefabNative | null,
    private readonly screens: FullscreenScreens,
    private readonly interval = FULLSCREEN_POLL_MS,
  ) {}

  /** 登记需要让开的窗口；shouldYield 返回 false 时（例如贴在桌面上）不隐藏。 */
  track(win: BrowserWindow, shouldYield: () => boolean): void {
    if (!this.native()) return
    this.tracked.set(win, shouldYield)
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), this.interval)
      this.timer.unref?.()
    }
  }

  untrack(win: BrowserWindow): void {
    this.tracked.delete(win)
    this.yielded.delete(win)
    if (!this.tracked.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 当前被全屏程序占满的显示器（逻辑像素）。 */
  fullscreenDisplays(): ShellRect[] {
    const api = this.native()
    if (!api) return []
    const foreground = api.foregroundWindow()
    if (isZeroHandle(foreground) || DESKTOP_CLASSES.has(api.className(foreground))) return []
    const native = api.windowRect(foreground)
    if (!native) return []
    // 自己的窗口（例如全屏的 infOS 主窗口）同样让开，不做特殊处理。
    const rect = this.screens.toDip({
      x: native.left,
      y: native.top,
      width: native.right - native.left,
      height: native.bottom - native.top,
    })
    return this.screens.displays().filter((display) => covers(rect, display))
  }

  check(): void {
    const busy = this.fullscreenDisplays()
    for (const [win, shouldYield] of [...this.tracked]) {
      if (win.isDestroyed()) {
        this.untrack(win)
        continue
      }
      const hide = shouldYield() && busy.some((display) => overlaps(win.getBounds(), display))
      if (hide && !this.yielded.has(win) && win.isVisible()) {
        this.yielded.add(win)
        win.hide()
      } else if (!hide && this.yielded.has(win)) {
        this.yielded.delete(win)
        win.showInactive()
      }
    }
  }

  isYielded(win: BrowserWindow): boolean {
    return this.yielded.has(win)
  }
}
