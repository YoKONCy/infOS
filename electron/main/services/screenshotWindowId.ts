/**
 * @file 截图 windowId 适配：除窗口列表中的十进制 HWND 外，也接受 infOS 自己的窗口 ID。
 * @platform WINDOWS
 */

/** infOS 自有窗口 ID：主窗口、摘出的面板与桌面卡片。 */
const INFOS_WINDOW_ID = /^(?:main|panel:[\w-]+|card:[\w-]+)$/

/**
 * 把截图参数里的 windowId 转为 Windows 桌面组件可识别的十进制 HWND。
 * 未提供时返回 undefined；格式不对时抛出带说明的错误，而不是交给原生组件报“格式不正确”。
 */
export function screenshotWindowId(
  value: unknown,
  shell: { nativeWindowId(target: string): string },
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return text
  if (INFOS_WINDOW_ID.test(text)) return shell.nativeWindowId(text)
  throw new Error(
    'DESKTOP_WINDOW_ID_INVALID: windowId 应为窗口列表中的十进制 windowId，或 infOS 窗口 ID（main、panel:<页面 ID>、card:<卡片 ID>）',
  )
}
