/**
 * @file 预制件用到的 user32 / kernel32 最小子集（koffi，复用项目已有依赖）：
 *       全屏让开读前台窗口的位置与类名；隐藏桌面原图标找桌面图标窗口并发送资源管理器自带的切换命令；
 *       映射文件夹读文件的隐藏属性（Node 的 fs 拿不到）。
 *       只在 Windows 加载；其他系统或加载失败时返回 null，相关功能视为不支持。
 * @platform ELECTRON (Windows)
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import { t as __t } from '../utils/i18n'
import { logger } from '../utils/logger'

export type Handle = number | bigint

export interface PrefabNative {
  foregroundWindow(): Handle
  /** 窗口矩形（物理像素）；失败时为 null。 */
  windowRect(window: Handle): { left: number; top: number; right: number; bottom: number } | null
  className(window: Handle): string
  findWindow(className: string, title: string | null): Handle
  findWindowEx(parent: Handle, after: Handle, className: string, title: string | null): Handle
  isWindowVisible(window: Handle): boolean
  /** SendMessageTimeoutW；返回是否成功。 */
  sendMessageTimeout(window: Handle, message: number, wParam: number, lParam: number): boolean
  /** GetFileAttributesW（kernel32）；读不到时为 null。 */
  fileAttributes(target: string): number | null
}

export const isZeroHandle = (handle: Handle) => handle === 0 || handle === 0n

let cached: PrefabNative | null | undefined

export function loadPrefabNative(): PrefabNative | null {
  if (cached !== undefined) return cached
  cached = null
  if (process.platform !== 'win32') return cached
  try {
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    koffi.struct('INFOS_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
    const getForeground = user32.func('uintptr_t __stdcall GetForegroundWindow()')
    const getRect = user32.func(
      'bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ INFOS_RECT *rect)',
    )
    const getClass = user32.func(
      'int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ void *buffer, int max)',
    )
    const findWindow = user32.func('uintptr_t __stdcall FindWindowW(str16 cls, str16 title)')
    const findWindowEx = user32.func(
      'uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 cls, str16 title)',
    )
    const isVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)')
    const sendMessageTimeout = user32.func(
      'intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint msg, uintptr_t wparam, intptr_t lparam, uint flags, uint timeout, _Out_ uintptr_t *result)',
    )
    const getAttributes = koffi
      .load('kernel32.dll')
      .func('uint32 __stdcall GetFileAttributesW(str16 path)')
    cached = {
      fileAttributes: (target) => {
        const attributes = getAttributes(target) as number
        // INVALID_FILE_ATTRIBUTES
        return attributes === 0xffffffff ? null : attributes
      },
      foregroundWindow: () => getForeground(),
      windowRect: (hwnd) => {
        const rect = { left: 0, top: 0, right: 0, bottom: 0 }
        return getRect(hwnd, rect) ? rect : null
      },
      className: (hwnd) => {
        const buffer = Buffer.alloc(512)
        const length = getClass(hwnd, buffer, 256) as number
        return length > 0 ? buffer.toString('utf16le', 0, length * 2) : ''
      },
      findWindow: (cls, title) => findWindow(cls, title),
      findWindowEx: (parent, after, cls, title) => findWindowEx(parent, after, cls, title),
      isWindowVisible: (hwnd) => Boolean(isVisible(hwnd)),
      // SMTO_ABORTIFHUNG（0x2），最多等 1 秒：资源管理器无响应时不卡住主进程。
      sendMessageTimeout: (hwnd, msg, w, l) =>
        sendMessageTimeout(hwnd, msg, w, l, 0x2, 1000, [0]) !== 0,
    }
  } catch (error) {
    logger.warn(
      'DesktopPrefabs',
      __t('electron.logs.windows', '预制件所需的原生组件加载失败：{0}', [String(error)]),
    )
  }
  return cached
}
