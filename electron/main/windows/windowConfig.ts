import type { BrowserWindow } from 'electron'
import { disableWindowsSystemBackdrop } from '../utils/windowsSystemBackdrop'

export function resolveWindowBackground(config: { transparent: boolean }, dark = false): string {
  return config.transparent ? '#00000000' : dark ? '#15151d' : '#f6f2ff'
}

/** 创建、显窗和聚焦时重申透明材质策略；第三方后续强制覆盖仍需设置进程排除。 */
export function guardTransparentWindowMaterial(
  win: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || win.isDestroyed()) return
  const clearMaterial = () => {
    if (win.isDestroyed()) return
    try {
      // Electron 的 none 会清空 DWM 边距并修改合成状态，使透明区域变黑。
      // 只禁用系统背景属性，透明合成交给 transparent: true 的窗口自行维持。
      disableWindowsSystemBackdrop(win.getNativeWindowHandle())
    } catch {
      // 原生句柄已失效等情况下保留原有透明配置，不切换合成模式。
    }
  }
  clearMaterial()
  win.on('show', clearMaterial)
  win.on('focus', clearMaterial)
  win.once('closed', () => {
    win.removeListener('show', clearMaterial)
    win.removeListener('focus', clearMaterial)
  })
}
