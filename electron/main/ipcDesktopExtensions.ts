/**
 * @file 我们自加的 IPC 处理（从 ipcBridge.ts 原样挪出，减少合并上游时的冲突）。
 *
 * - 桌面面板、桌面卡片、护栏设置页、开机启动等处理器的统一注册；
 * - 「桌面与家」的处理器注册；
 * - 桌面操作的恢复与设置更新（重新打开总开关须经原生确认框）；
 * - 角色卡另存为。
 *
 * @platform ELECTRON
 */
import { t as __t } from './utils/i18n'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import type { DesktopControlSettings } from '@infos/shared'
import { desktopTabs } from './windows/desktopTabs'
import { detachedPanels, registerDetachedPanelHandlers } from './windows/detachedPanels'
import {
  registerDesktopCardAdminHandlers,
  registerDesktopCardHandlers,
} from './windows/desktopCards'
import { registerDesktopStartupHandlers } from './services/desktopStartup'
import { confirmDesktopControlPatch, registerDesktopSafetyHandlers } from './services/desktopGuard'
import { desktopControl } from './services/desktopControl'
import { registerHomeIpc } from './services/home/homeIpc'
import { perceptionControl } from './services/home/perceptionState'
import { isRemoteConnection } from './services/clientConnection'

/** 桌面面板、卡片、护栏设置页与开机启动的处理器（在 registerWindowHandlers 之后注册）。 */
export function registerDesktopExtensionHandlers(): void {
  registerDetachedPanelHandlers((sender) => desktopTabs.isHost(sender))
  // 阶段 4：卡片 preload 的通道，只接受卡片窗口本身的请求。
  registerDesktopCardHandlers()
  // 设置页的卡片列表：卡片之外的查看、关闭与删除入口。
  registerDesktopCardAdminHandlers(
    (sender) => desktopTabs.isHost(sender) || detachedPanels.isPanel(sender),
  )
  // 阶段 2：桌面操作护栏设置页，只接受主窗口与桌面面板；放宽一律经主进程原生确认框。
  registerDesktopSafetyHandlers(
    (sender) => desktopTabs.isHost(sender) || detachedPanels.isPanel(sender),
  )
  // 阶段 5：开机启动与后端启动程序，只接受主窗口与桌面面板（设置页）。
  registerDesktopStartupHandlers(
    (sender) => desktopTabs.isHost(sender) || detachedPanels.isPanel(sender),
    isRemoteConnection,
  )
}

/** 桌宠控制组里的「桌面与家」处理器，沿用同一个信任校验。 */
export function registerDesktopHomeHandlers(
  assertTrusted: (sender: Electron.WebContents) => void,
): void {
  // 「桌面与家」：眼睛、耳朵、陪看与环境事件的设置与实时状态（desktop-home.json）。
  registerHomeIpc(assertTrusted)
}

/** 恢复桌面操作；只解除感知的硬停止，只是暂停了输入时不清掉感知的软暂停。 */
export function resumeDesktopControl(): ReturnType<typeof desktopControl.resume> {
  if (perceptionControl.state().settings.hardStopped) perceptionControl.action({ type: 'resume' })
  return desktopControl.resume()
}

/** 更新桌面设置：重新打开总开关须经主进程原生确认框；关闭立即生效。 */
export async function updateDesktopControlConfirmed(patch: object): Promise<DesktopControlSettings> {
  const confirmed = await confirmDesktopControlPatch(
    patch as Partial<DesktopControlSettings>,
    desktopControl.configuration().enabled,
  )
  return confirmed ? desktopControl.update(confirmed) : desktopControl.configuration()
}

/** 角色卡另存为（PNG 或 ZIP），只接受校验通过的文件名与内容。 */
export function registerAgentCardSaveHandler(): void {
  ipcMain.handle('save-agent-card', async (event, input: unknown) => {
    const payload = input as { fileName?: unknown; contentBase64?: unknown }
    if (
      typeof payload?.fileName !== 'string' ||
      !/^[a-z0-9_-]+\.infos-agent\.(png|zip)$/.test(payload.fileName) ||
      typeof payload.contentBase64 !== 'string' ||
      payload.contentBase64.length > 90_000_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.contentBase64)
    )
      throw new Error(__t('electron.ui.ipcBridge.ts', '角色卡无效'))
    const bytes = Buffer.from(payload.contentBase64, 'base64')
    if (bytes.length > 64 * 1024 * 1024 || bytes.toString('base64') !== payload.contentBase64)
      throw new Error(__t('electron.ui.ipcBridge.ts', '角色卡无效'))
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: __t('electron.ui.ipcBridge.ts', '保存角色卡'),
      defaultPath: payload.fileName,
      filters: [
        {
          name: __t('electron.ui.ipcBridge.ts', 'infOS 角色卡'),
          extensions: [payload.fileName.endsWith('.png') ? 'png' : 'zip'],
        },
      ],
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    await fs.promises.writeFile(result.filePath, bytes)
    return { canceled: false, path: result.filePath }
  })
}
