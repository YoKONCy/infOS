/**
 * @file infOS 自有窗口 ID 与系统窗口 ID（HWND）的互相换算。
 * @description 统一入口：`main`、`panel:<页面 ID>`、`card:<卡片 ID>` 都经 `resolveShellTarget` 解析，
 *              截图的 windowId、窗口列表的 infosWindowId、shell_window 的 target 共用同一套规则。
 * @platform ELECTRON
 */

import { DETACHABLE_PAGE_IDS } from '../../../packages/shared/src/desktopShell'
import { desktopCardTarget } from '../../../packages/shared/src/desktopCards'
import { resolveShellTarget, type ShellHost } from './shellCapabilityModel'

type Host = Pick<ShellHost, 'mainWindow' | 'panels' | 'cards'>

/** infOS 窗口 ID 对应的十进制 HWND；窗口不存在或未打开时抛出 DESKTOP_SHELL_INVALID_TARGET。 */
export function nativeWindowId(host: Host, target: string): string {
  const buffer = resolveShellTarget(host, target).win.getNativeWindowHandle()
  return (buffer.length >= 8 ? buffer.readBigUInt64LE(0) : buffer.readUInt32LE(0)).toString()
}

/** 已打开的 infOS 窗口：十进制 HWND → infOS 窗口 ID。 */
export function nativeWindowIds(host: Host): Map<string, string> {
  const ids = new Map<string, string>()
  const targets = [
    'main',
    ...DETACHABLE_PAGE_IDS.filter((page) => host.panels.windowOf(page)).map(
      (page) => `panel:${page}`,
    ),
    ...host.cards.list().map((card) => desktopCardTarget(card.id)),
  ]
  for (const target of targets) {
    try {
      ids.set(nativeWindowId(host, target), target)
    } catch {
      // 窗口未打开或已关闭：不出现在列表里。
    }
  }
  return ids
}
