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
import { logger } from '../utils/logger'
import { onLocaleChange } from '../../../packages/shared/src/i18n'
import { showResourceRecovery } from './resourceRecovery'
import { showConnectionSetup, focusConnectionSetup } from './clientConnectionSetup'

let tray: Tray | null = null
let stopLocaleListener: (() => void) | undefined

function updateTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: __t('electron.ui.tray', '启动器'),
        click: () => windowManager.createLauncherWindow(),
      },
      { label: __t('electron.ui.tray', '桌宠召唤'), click: () => windowManager.createPetWindow() },
      {
        label: __t('electron.ui.tray', '工作台'),
        click: () => windowManager.createDashboardWindow(),
      },
      { type: 'separator' },
      {
        label: __t('electron.ui.startupSplash', '选择运行方式'),
        click: () => {
          if (focusConnectionSetup()) return
          void showConnectionSetup(false)
            .then(() => {
              app.relaunch()
              app.quit()
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
