import { t as __t } from '../utils/i18n'
/**
 * @file 系统托盘
 * @description 创建系统托盘图标和右键菜单
 * @platform ELECTRON
 * @module electron/main/services/tray
 */

import { app, Tray, Menu } from 'electron'
import { loadSystemIcon } from '../utils/appIcon'
import { windowManager } from '../windows/manager'
import { desktopTabs } from '../windows/desktopTabs'
import { logger } from '../utils/logger'
import { onLocaleChange } from '../../../packages/shared/src/i18n'
import { showResourceRecovery } from './resourceRecovery'
import { showConnectionSetup, focusConnectionSetup } from './clientConnectionSetup'
import { requestClientRestart } from './clientRestart'

let tray: Tray | null = null
let stopLocaleListener: (() => void) | undefined
let recording = false
let stopRecording: (() => void) | undefined
let perceptionActions: {stop:()=>void}|undefined
export function configurePerceptionTray(actions:NonNullable<typeof perceptionActions>):void {perceptionActions=actions;updateTrayMenu()}
export function refreshPerceptionTray():void {updateTrayMenu()}

/** 主进程的录音状态不受聊天页、桌宠标识偏好或窗口最小化影响。 */
export function setTrayRecording(active: boolean, stop: () => void): void {
  recording = active
  stopRecording = stop
  updateTrayMenu()
}

function updateTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return
  tray.setToolTip(
    recording ? __t('electron.ui.tray', '正在听电脑的声音') : '萌动链接：PeroperoChat！',
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(perceptionActions ? [
        {label:__t('electron.ui.tray','全部停止感知'),click:()=>perceptionActions?.stop()},
        {type:'separator' as const},
      ] : []),
      ...(recording
        ? [
            { label: __t('electron.ui.tray', '停止录音'), click: () => stopRecording?.() },
            { type: 'separator' as const },
          ]
        : []),
      {
        label: __t('electron.ui.tray', '启动器'),
        click: () => windowManager.createLauncherWindow(),
      },
      { label: __t('electron.ui.tray', '桌宠召唤'), click: () => windowManager.createPetWindow() },
      {
        label: __t('electron.ui.tray', '工作台'),
        click: () => windowManager.createDashboardWindow(),
      },
      {
        label: __t('electron.ui.tray', '卡片'),
        click: () => {
          windowManager.createDashboardWindow()
          desktopTabs.openHome('cards')
        },
      },
      { type: 'separator' },
      {
        label: __t('electron.ui.startupSplash', '选择运行方式'),
        click: () => {
          if (focusConnectionSetup()) return
          void showConnectionSetup(false)
            .then(() => {
              return requestClientRestart()
            })
            .catch(() => {})
        },
      },
      {
        label: __t('electron.ui.resource-recovery', '拓展恢复'),
        click: () => {
          void showResourceRecovery()
        },
      },
      { label: __t('electron.ui.tray', '彻底退出'), click: () => app.quit() },
    ]),
  )
}

/** 创建系统托盘 */
export function createTray(): void {
  if (tray && !tray.isDestroyed()) return

  try {
    const icon = loadSystemIcon(32)
    if (!icon) return
    tray = new Tray(icon)

    tray.setToolTip('萌动链接：PeroperoChat！')
    updateTrayMenu()
    stopLocaleListener = onLocaleChange(updateTrayMenu)

    // 单击打开或聚焦综合工作台，保留用户当前所在的页面。
    tray.on('click', () => windowManager.createDashboardWindow())

    logger.info('Tray', __t('electron.logs.tray', '系统托盘已创建'))
  } catch (e: unknown) {
    logger.error('Tray', __t('electron.logs.tray', '创建托盘失败: {0}', [e]))
  }
}

/** 销毁系统托盘 */
export function destroyTray(): void {
  stopLocaleListener?.()
  stopLocaleListener = undefined
  tray?.destroy()
  tray = null
}
