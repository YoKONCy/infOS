/**
 * @file 设置页「桌面与家」的 IPC 与实时状态推送。
 *
 * - desktop-home:get → { settings, status }；desktop-home:update({ section, patch }) → settings
 * - desktop-home:model('download' | 'cancel' | 'remove') → status（下载由用户在设置页点按钮触发）
 * - desktop-home:stop-listening → 立刻停止录音（录音标识上的「停止」按钮）
 * - 推送 desktop-home:status：录音、陪看、模型下载进度变化时发给所有窗口。
 *
 * 只接受受信任的主应用窗口（与桌面操作设置相同的检查）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 「桌面与家」设置
 */

import { t as __t } from '../../utils/i18n'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { DesktopHomeStatus } from '@infos/shared'
import { homeSettings } from './homeSettings'
import { earsCapture, earsModel, earsService } from '../ears/earsRuntime'
import { companionService } from '../companion/companionRuntime'
import { registerCompanionInput } from '../companion/companionInput'
import { registerEnvironmentIpc } from './environmentRuntime'
import { setTrayRecording } from '../tray'
import { registerPerceptionIpc } from './perceptionRuntime'

const PERCEPTION_STORED_FIELDS = new Set(['proactiveLevel', 'redactedApps', 'unrecordedApps'])

export function homeStatus(): DesktopHomeStatus {
  const companion = companionService.summary()
  return {
    listening: earsService.listening,
    ...(companion ? { companionTitle: companion.title, companionPaused: companion.paused } : {}),
    model: earsModel.status(),
    ...(earsService.lastError && !earsService.listening
      ? { earsError: earsService.lastError }
      : {}),
    ...(earsService.listening && earsCapture.mode ? { earsCapture: earsCapture.mode } : {}),
    ...(earsCapture.fallbackReason ? { earsCaptureFallback: earsCapture.fallbackReason } : {}),
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
/** 合并短时间内的多次变化（下载进度每 MB 一次）再推送。 */
function publish(): void {
  setTrayRecording(earsService.listening, stopListening)
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    const status = homeStatus()
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send('desktop-home:status', status)
  }, 150)
  timer.unref?.()
}

function stopListening(): void {
  homeSettings.update('perception', {sound: false})
  companionService.stopAll()
  earsService.stopAll(
    `EARS_STOPPED_BY_USER: ${__t('electron.ui.desktopControl', '用户停止了录音')}`,
  )
}

export function registerHomeIpc(assertTrusted: (sender: WebContents) => void): void {
  registerPerceptionIpc(assertTrusted)
  registerCompanionInput(assertTrusted)
  registerEnvironmentIpc(assertTrusted)
  setTrayRecording(earsService.listening, stopListening)
  earsService.on('status', publish)
  companionService.on('status', publish)
  homeSettings.onChange(publish)
  ipcMain.handle('desktop-home:get', (event) => {
    assertTrusted(event.sender)
    return { settings: homeSettings.get(), status: homeStatus() }
  })
  ipcMain.handle('desktop-home:update', (event, input: unknown) => {
    assertTrusted(event.sender)
    const { section, patch } = (input ?? {}) as { section?: unknown; patch?: unknown }
    // 硬停止、暂停和各开关只能走 perception-action，这条路只放行频率和名单。
    if (section === 'perception' && Object.keys((patch ?? {}) as object).some((key) => !PERCEPTION_STORED_FIELDS.has(key)))
      throw new Error('PERCEPTION_FORBIDDEN')
    return homeSettings.update(section, patch)
  })
  ipcMain.handle('desktop-home:model', async (event, action: unknown) => {
    assertTrusted(event.sender)
    if (action === 'download') void earsModel.start().catch(() => undefined)
    else if (action === 'cancel') earsModel.cancel()
    else if (action === 'remove') {
      earsService.stopAll(`EARS_MODEL_MISSING: ${__t('electron.ui.desktopControl', '模型已删除')}`)
      await earsModel.remove()
    } else throw new Error('DESKTOP_HOME_ACTION_INVALID')
    publish()
    return homeStatus()
  })
  ipcMain.handle('desktop-home:stop-listening', (event) => {
    assertTrusted(event.sender)
    stopListening()
    return homeStatus()
  })
}
