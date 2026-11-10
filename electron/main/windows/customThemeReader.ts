/**
 * @file 读取当前自定义主题
 * @description 自定义主题按设备保存在主窗口渲染进程的 localStorage（useCustomTheme），
 *              外壳能力（阶段 3）与桌面卡片（阶段 4）只读读取，不修改。
 *
 * @platform ELECTRON
 * @module electron/main/windows/customThemeReader
 */

import type { BrowserWindow } from 'electron'

/** 读取主窗口保存的自定义主题时的等待上限。 */
const THEME_READ_TIMEOUT_MS = 1_500

/** 当前自定义主题 ID；空字符串为默认外观，主窗口不可用或读取失败时为 null。 */
export async function readCustomTheme(main: BrowserWindow | null): Promise<string | null> {
  if (!main || main.isDestroyed()) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      main.webContents.executeJavaScript(
        "(() => { try { return localStorage.getItem('infos.customTheme') ?? '' } catch { return null } })()",
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), THEME_READ_TIMEOUT_MS)
      }),
    ])
    return typeof value === 'string' ? value : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
