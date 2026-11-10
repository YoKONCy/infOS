/**
 * @file 外壳能力的 Electron 宿主
 * @description 把主窗口、桌面面板、桌面卡片、显示器与主题状态接到 ShellCapability（阶段 3、4）。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 3
 * @module electron/main/services/shellHost
 */

import { screen } from 'electron'
import { windowManager } from '../windows/manager'
import { detachedPanels } from '../windows/detachedPanels'
import { desktopTabs } from '../windows/desktopTabs'
import { desktopCards, desktopPrefabs } from '../windows/desktopCards'
import { desktopLayer } from '../windows/desktopLayer'
import { readCustomTheme } from '../windows/customThemeReader'
import { ShellCapability } from './shellCapability'

export const shellCapability = new ShellCapability({
  mainWindow: () => windowManager.dashboardWin,
  panels: detachedPanels,
  displays: () => {
    const primary = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      primary: display.id === primary,
      workArea: { ...display.workArea },
      scaleFactor: display.scaleFactor,
    }))
  },
  workAreaNear: (rect) => ({ ...screen.getDisplayMatching(rect).workArea }),
  themeMode: () => desktopTabs.getTheme(),
  readCustomTheme: () => readCustomTheme(windowManager.dashboardWin),
  cards: desktopCards,
  desktopLayer,
  prefabs: desktopPrefabs,
})
