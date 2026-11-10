import { t as __t } from '../utils/i18n'
/**
 * @file 贴到桌面底层（WorkerW）
 * @description 阶段 5：把卡片或桌面面板的窗口挂到 Windows 桌面图标层（WorkerW），Win+D 后仍可见。
 *              只在 Windows 生效，按窗口逐个开启（shell_window set desktopLayer）；其他系统或原生调用失败时
 *              返回不支持，窗口保持原样。
 *
 *              做法（无需新增依赖，复用项目已有的 koffi 调用 user32）：
 *              1. `FindWindow("Progman")`，发送 `0x052C`（SendMessageTimeout）让资源管理器在图标层后生成 WorkerW；
 *              2. 找 WorkerW：Windows 11 24H2 起 WorkerW 是 Progman 的子窗口；更早的版本在顶层窗口中找
 *                 含 `SHELLDLL_DefView` 的 WorkerW，取它后面的那个 WorkerW；
 *              3. `SetParent(窗口, WorkerW)`；取消时 `SetParent(窗口, 0)`。
 *              资源管理器重启后 WorkerW 会重建：有贴底窗口时每 30 秒用 `IsWindow` 检查一次，失效则重新挂接。
 *
 *              局限：贴底后窗口坐标相对 WorkerW，移动与缩放须先取消贴底；窗口不再置顶，焦点与输入行为需实机验证。
 *              本模块从未在开发机的真实桌面上运行过，必须由用户在测试机上验证。
 *
 * @platform ELECTRON (Windows)
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 5
 * @module electron/main/windows/desktopLayer
 */

import type { BrowserWindow } from 'electron'
import { logger } from '../utils/logger'

type Handle = number | bigint

/** user32 的最小子集；测试中替换。 */
export interface DesktopLayerNative {
  findWindow(className: string, title: string | null): Handle
  findWindowEx(parent: Handle, after: Handle, className: string, title: string | null): Handle
  /** SendMessageTimeoutW；返回是否成功。 */
  sendMessageTimeout(window: Handle, message: number, wParam: number, lParam: number): boolean
  setParent(child: Handle, parent: Handle): Handle
  isWindow(window: Handle): boolean
}

/** Progman 收到后在桌面图标层后面生成 WorkerW（未公开但被壁纸类软件广泛使用的消息）。 */
export const SPAWN_WORKERW = 0x052c
export const REPIN_INTERVAL_MS = 30_000

const isZero = (handle: Handle) => handle === 0 || handle === 0n

/** 生产环境：用 koffi 加载 user32；不是 Windows 或加载失败时为 null。 */
export function loadDesktopLayerNative(): DesktopLayerNative | null {
  if (process.platform !== 'win32') return null
  try {
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const findWindow = user32.func('uintptr_t __stdcall FindWindowW(str16 cls, str16 title)')
    const findWindowEx = user32.func(
      'uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 cls, str16 title)',
    )
    const sendMessageTimeout = user32.func(
      'intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint msg, uintptr_t wparam, intptr_t lparam, uint flags, uint timeout, _Out_ uintptr_t *result)',
    )
    const setParent = user32.func(
      'uintptr_t __stdcall SetParent(uintptr_t child, uintptr_t parent)',
    )
    const isWindow = user32.func('bool __stdcall IsWindow(uintptr_t hwnd)')
    // SMTO_NORMAL，最多等 1 秒（资源管理器无响应时不卡住主进程太久）。
    return {
      findWindow: (cls, title) => findWindow(cls, title),
      findWindowEx: (parent, after, cls, title) => findWindowEx(parent, after, cls, title),
      sendMessageTimeout: (hwnd, msg, w, l) =>
        sendMessageTimeout(hwnd, msg, w, l, 0, 1000, [0]) !== 0,
      setParent: (child, parent) => setParent(child, parent),
      isWindow: (hwnd) => Boolean(isWindow(hwnd)),
    }
  } catch (error) {
    logger.warn(
      'DesktopLayer',
      __t('electron.logs.windows', '贴到桌面所需的原生组件加载失败：{0}', [String(error)]),
    )
    return null
  }
}

/** Electron 窗口的 HWND。 */
function nativeHandle(win: BrowserWindow): Handle {
  const buffer = win.getNativeWindowHandle()
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0) : buffer.readUInt32LE(0)
}

export class DesktopLayer {
  private native: DesktopLayerNative | null | undefined
  private readonly pinned = new Map<BrowserWindow, Handle>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly loadNative: () => DesktopLayerNative | null = loadDesktopLayerNative,
    private readonly handleOf: (win: BrowserWindow) => Handle = nativeHandle,
  ) {}

  private api(): DesktopLayerNative | null {
    if (this.native === undefined) this.native = this.loadNative()
    return this.native
  }

  /** 当前系统是否可能支持贴底（只代表能加载原生组件，不代表一定成功）。 */
  supported(): boolean {
    return this.api() !== null
  }

  /** 找到（必要时生成）桌面图标层后面的 WorkerW；找不到时为 0。 */
  findWorkerW(): Handle {
    const api = this.api()
    if (!api) return 0
    const progman = api.findWindow('Progman', null)
    if (isZero(progman)) return 0
    api.sendMessageTimeout(progman, SPAWN_WORKERW, 0xd, 0x1)
    api.sendMessageTimeout(progman, SPAWN_WORKERW, 0, 0)
    // Windows 11 24H2 起：WorkerW 是 Progman 的子窗口。
    const child = api.findWindowEx(progman, 0, 'WorkerW', null)
    if (!isZero(child)) return child
    // 更早的版本：含 SHELLDLL_DefView 的顶层 WorkerW 之后的那个 WorkerW。
    let current: Handle = 0
    for (let index = 0; index < 64; index += 1) {
      current = api.findWindowEx(0, current, 'WorkerW', null)
      if (isZero(current)) break
      if (!isZero(api.findWindowEx(current, 0, 'SHELLDLL_DefView', null))) {
        const next = api.findWindowEx(0, current, 'WorkerW', null)
        return next
      }
    }
    return 0
  }

  isPinned(win: BrowserWindow): boolean {
    return this.pinned.has(win)
  }

  /** 开启或取消贴底；返回是否成功（不支持或找不到 WorkerW 时为 false，窗口保持原样）。 */
  set(win: BrowserWindow, enabled: boolean): boolean {
    const api = this.api()
    if (!api || win.isDestroyed()) return false
    if (!enabled) {
      if (!this.pinned.has(win)) return true
      api.setParent(this.handleOf(win), 0)
      this.forget(win)
      return true
    }
    const worker = this.findWorkerW()
    if (isZero(worker)) {
      logger.warn(
        'DesktopLayer',
        __t('electron.logs.windows', '没有找到桌面图标层（WorkerW），未贴到桌面'),
      )
      return false
    }
    if (win.isAlwaysOnTop()) win.setAlwaysOnTop(false)
    api.setParent(this.handleOf(win), worker)
    if (!this.pinned.has(win)) win.once('closed', () => this.forget(win))
    this.pinned.set(win, worker)
    this.startWatch()
    return true
  }

  private forget(win: BrowserWindow): void {
    this.pinned.delete(win)
    if (!this.pinned.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 资源管理器重启后旧 WorkerW 失效：重新挂接。 */
  repinIfNeeded(): void {
    const api = this.api()
    if (!api) return
    for (const [win, worker] of [...this.pinned]) {
      if (win.isDestroyed()) {
        this.forget(win)
        continue
      }
      if (api.isWindow(worker)) continue
      const next = this.findWorkerW()
      if (isZero(next)) continue
      api.setParent(this.handleOf(win), next)
      this.pinned.set(win, next)
    }
  }

  private startWatch(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.repinIfNeeded(), REPIN_INTERVAL_MS)
    this.timer.unref?.()
  }
}

/** 全局单例 */
export const desktopLayer = new DesktopLayer()
