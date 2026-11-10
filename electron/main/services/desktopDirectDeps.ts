/**
 * @file 直通通道的生产依赖：护栏、桌面控制、剪贴板、媒体键与默认浏览器。与 desktopDirect.ts 分开，便于测试。
 * @platform ELECTRON
 */

import { app, clipboard, shell } from 'electron'
import { desktopControl } from './desktopControl'
import { desktopActionGuard } from './desktopGuard'
import { readClipboard, writeClipboard } from './desktopAwareness'
import { windowsDesktop } from './windowsDesktop'
import { PROTECTED_CLIPBOARD_FORMATS, type DirectDeps } from './desktopDirect'

/** 剪贴板里是否有「别监视」标记（密码管理器常用）。查询本身失败时按没有处理（不让读剪贴板整个失效），真机确认见报告。 */
async function clipboardProtected(): Promise<boolean> {
  try {
    for (const format of PROTECTED_CLIPBOARD_FORMATS)
      if (await clipboard.has(`electron application/osclipboard;format="${format}"`)) return true
    return false
  } catch {
    return false
  }
}

export function directDeps(): DirectDeps {
  return {
    guard: desktopActionGuard(),
    assertAvailable: (signal) => desktopControl.assertAvailable(signal),
    mutate: (caller, action) => desktopControl.mutate(caller, action),
    readClipboard,
    clipboardProtected,
    writeClipboard,
    sendMediaKey: (key, times, signal) => windowsDesktop.request('media', { key, times }, signal),
    defaultBrowser: async () => {
      if (process.platform !== 'win32' && process.platform !== 'darwin') return undefined
      return (await app.getApplicationInfoForProtocol('https://')).path || undefined
    },
    openExternal: (url) => shell.openExternal(url),
  }
}
