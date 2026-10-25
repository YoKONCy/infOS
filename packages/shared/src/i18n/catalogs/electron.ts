// 按模块、语言分别维护词库；此入口只装配当前运行端需要的资源。
import { registerCatalog } from '../index'
import messages0 from '../locales/zh-CN/common/tools.json'
import messages1 from '../locales/zh-TW/common/tools.json'
import messages2 from '../locales/en-US/common/tools.json'
import messages3 from '../locales/zh-CN/errors/common.json'
import messages4 from '../locales/zh-TW/errors/common.json'
import messages5 from '../locales/en-US/errors/common.json'
import messages6 from '../locales/zh-CN/common/interface.json'
import messages7 from '../locales/zh-TW/common/interface.json'
import messages8 from '../locales/en-US/common/interface.json'
import messages9 from '../locales/zh-CN/common/prompts.json'
import messages10 from '../locales/zh-TW/common/prompts.json'
import messages11 from '../locales/en-US/common/prompts.json'
import messages12 from '../locales/zh-CN/electron/ui/index/ts.json'
import messages13 from '../locales/zh-TW/electron/ui/index/ts.json'
import messages14 from '../locales/en-US/electron/ui/index/ts.json'
import messages15 from '../locales/zh-CN/electron/logs/index/ts.json'
import messages16 from '../locales/zh-TW/electron/logs/index/ts.json'
import messages17 from '../locales/en-US/electron/logs/index/ts.json'
import messages18 from '../locales/zh-CN/electron/logs/ipcBridge/ts.json'
import messages19 from '../locales/zh-TW/electron/logs/ipcBridge/ts.json'
import messages20 from '../locales/en-US/electron/logs/ipcBridge/ts.json'
import messages21 from '../locales/zh-CN/electron/ui/ipcBridge/ts.json'
import messages22 from '../locales/zh-TW/electron/ui/ipcBridge/ts.json'
import messages23 from '../locales/en-US/electron/ui/ipcBridge/ts.json'
import messages24 from '../locales/zh-CN/electron/logs/assets.json'
import messages25 from '../locales/zh-TW/electron/logs/assets.json'
import messages26 from '../locales/en-US/electron/logs/assets.json'
import messages27 from '../locales/zh-CN/electron/ui/browserRuntime.json'
import messages28 from '../locales/zh-TW/electron/ui/browserRuntime.json'
import messages29 from '../locales/en-US/electron/ui/browserRuntime.json'
import messages30 from '../locales/zh-CN/electron/logs/capabilityProvider.json'
import messages31 from '../locales/zh-TW/electron/logs/capabilityProvider.json'
import messages32 from '../locales/en-US/electron/logs/capabilityProvider.json'
import messages33 from '../locales/zh-CN/electron/ui/capabilityProvider.json'
import messages34 from '../locales/zh-TW/electron/ui/capabilityProvider.json'
import messages35 from '../locales/en-US/electron/ui/capabilityProvider.json'
import messages36 from '../locales/zh-CN/electron/logs/cloudSync.json'
import messages37 from '../locales/zh-TW/electron/logs/cloudSync.json'
import messages38 from '../locales/en-US/electron/logs/cloudSync.json'
import messages39 from '../locales/zh-CN/electron/logs/completionAlerts.json'
import messages40 from '../locales/zh-TW/electron/logs/completionAlerts.json'
import messages41 from '../locales/en-US/electron/logs/completionAlerts.json'
import messages42 from '../locales/zh-CN/electron/logs/desktopAutomation.json'
import messages43 from '../locales/zh-TW/electron/logs/desktopAutomation.json'
import messages44 from '../locales/en-US/electron/logs/desktopAutomation.json'
import messages45 from '../locales/zh-CN/electron/logs/desktopAwareness.json'
import messages46 from '../locales/zh-TW/electron/logs/desktopAwareness.json'
import messages47 from '../locales/en-US/electron/logs/desktopAwareness.json'
import messages48 from '../locales/zh-CN/electron/ui/desktopControl.json'
import messages49 from '../locales/zh-TW/electron/ui/desktopControl.json'
import messages50 from '../locales/en-US/electron/ui/desktopControl.json'
import messages51 from '../locales/zh-CN/electron/logs/desktopControl.json'
import messages52 from '../locales/zh-TW/electron/logs/desktopControl.json'
import messages53 from '../locales/en-US/electron/logs/desktopControl.json'
import messages54 from '../locales/zh-CN/electron/logs/napcat.json'
import messages55 from '../locales/zh-TW/electron/logs/napcat.json'
import messages56 from '../locales/en-US/electron/logs/napcat.json'
import messages57 from '../locales/zh-CN/electron/logs/napcatDashboard.json'
import messages58 from '../locales/zh-TW/electron/logs/napcatDashboard.json'
import messages59 from '../locales/en-US/electron/logs/napcatDashboard.json'
import messages60 from '../locales/zh-CN/electron/ui/napcatDashboard.json'
import messages61 from '../locales/zh-TW/electron/ui/napcatDashboard.json'
import messages62 from '../locales/en-US/electron/ui/napcatDashboard.json'
import messages63 from '../locales/zh-CN/electron/logs/petControls.json'
import messages64 from '../locales/zh-TW/electron/logs/petControls.json'
import messages65 from '../locales/en-US/electron/logs/petControls.json'
import messages66 from '../locales/zh-CN/electron/logs/portableDaemon.json'
import messages67 from '../locales/zh-TW/electron/logs/portableDaemon.json'
import messages68 from '../locales/en-US/electron/logs/portableDaemon.json'
import messages69 from '../locales/zh-CN/electron/logs/steam.json'
import messages70 from '../locales/zh-TW/electron/logs/steam.json'
import messages71 from '../locales/en-US/electron/logs/steam.json'
import messages72 from '../locales/zh-CN/electron/logs/system.json'
import messages73 from '../locales/zh-TW/electron/logs/system.json'
import messages74 from '../locales/en-US/electron/logs/system.json'
import messages75 from '../locales/zh-CN/electron/ui/tray.json'
import messages76 from '../locales/zh-TW/electron/ui/tray.json'
import messages77 from '../locales/en-US/electron/ui/tray.json'
import messages78 from '../locales/zh-CN/electron/logs/tray.json'
import messages79 from '../locales/zh-TW/electron/logs/tray.json'
import messages80 from '../locales/en-US/electron/logs/tray.json'
import messages81 from '../locales/zh-CN/electron/ui/updater.json'
import messages82 from '../locales/zh-TW/electron/ui/updater.json'
import messages83 from '../locales/en-US/electron/ui/updater.json'
import messages84 from '../locales/zh-CN/electron/logs/updater.json'
import messages85 from '../locales/zh-TW/electron/logs/updater.json'
import messages86 from '../locales/en-US/electron/logs/updater.json'
import messages87 from '../locales/zh-CN/electron/logs/utils.json'
import messages88 from '../locales/zh-TW/electron/logs/utils.json'
import messages89 from '../locales/en-US/electron/logs/utils.json'
import messages90 from '../locales/zh-CN/electron/logs/windows.json'
import messages91 from '../locales/zh-TW/electron/logs/windows.json'
import messages92 from '../locales/en-US/electron/logs/windows.json'
import messages93 from '../locales/zh-CN/electron/ui/windows.json'
import messages94 from '../locales/zh-TW/electron/ui/windows.json'
import messages95 from '../locales/en-US/electron/ui/windows.json'
import messages96 from '../locales/zh-CN/errors/electron.json'
import messages97 from '../locales/zh-TW/errors/electron.json'
import messages98 from '../locales/en-US/errors/electron.json'
import messages99 from '../locales/zh-CN/electron/ui/completionAlerts.json'
import messages100 from '../locales/zh-TW/electron/ui/completionAlerts.json'
import messages101 from '../locales/en-US/electron/ui/completionAlerts.json'
import splashUiZh from '../locales/zh-CN/electron/ui/startupSplash.json'
import splashUiTw from '../locales/zh-TW/electron/ui/startupSplash.json'
import splashUiEn from '../locales/en-US/electron/ui/startupSplash.json'
import splashLogsZh from '../locales/zh-CN/electron/logs/startupSplash.json'
import splashLogsTw from '../locales/zh-TW/electron/logs/startupSplash.json'
import splashLogsEn from '../locales/en-US/electron/logs/startupSplash.json'
registerCatalog('common.tools', 'zh-CN', messages0)
registerCatalog('common.tools', 'zh-TW', messages1)
registerCatalog('common.tools', 'en-US', messages2)
registerCatalog('errors.common', 'zh-CN', messages3)
registerCatalog('errors.common', 'zh-TW', messages4)
registerCatalog('errors.common', 'en-US', messages5)
registerCatalog('common.interface', 'zh-CN', messages6)
registerCatalog('common.interface', 'zh-TW', messages7)
registerCatalog('common.interface', 'en-US', messages8)
registerCatalog('common.prompts', 'zh-CN', messages9)
registerCatalog('common.prompts', 'zh-TW', messages10)
registerCatalog('common.prompts', 'en-US', messages11)
registerCatalog('electron.ui.index.ts', 'zh-CN', messages12)
registerCatalog('electron.ui.index.ts', 'zh-TW', messages13)
registerCatalog('electron.ui.index.ts', 'en-US', messages14)
registerCatalog('electron.logs.index.ts', 'zh-CN', messages15)
registerCatalog('electron.logs.index.ts', 'zh-TW', messages16)
registerCatalog('electron.logs.index.ts', 'en-US', messages17)
registerCatalog('electron.logs.ipcBridge.ts', 'zh-CN', messages18)
registerCatalog('electron.logs.ipcBridge.ts', 'zh-TW', messages19)
registerCatalog('electron.logs.ipcBridge.ts', 'en-US', messages20)
registerCatalog('electron.ui.ipcBridge.ts', 'zh-CN', messages21)
registerCatalog('electron.ui.ipcBridge.ts', 'zh-TW', messages22)
registerCatalog('electron.ui.ipcBridge.ts', 'en-US', messages23)
registerCatalog('electron.logs.assets', 'zh-CN', messages24)
registerCatalog('electron.logs.assets', 'zh-TW', messages25)
registerCatalog('electron.logs.assets', 'en-US', messages26)
registerCatalog('electron.ui.browserRuntime', 'zh-CN', messages27)
registerCatalog('electron.ui.browserRuntime', 'zh-TW', messages28)
registerCatalog('electron.ui.browserRuntime', 'en-US', messages29)
registerCatalog('electron.logs.capabilityProvider', 'zh-CN', messages30)
registerCatalog('electron.logs.capabilityProvider', 'zh-TW', messages31)
registerCatalog('electron.logs.capabilityProvider', 'en-US', messages32)
registerCatalog('electron.ui.capabilityProvider', 'zh-CN', messages33)
registerCatalog('electron.ui.capabilityProvider', 'zh-TW', messages34)
registerCatalog('electron.ui.capabilityProvider', 'en-US', messages35)
registerCatalog('electron.logs.cloudSync', 'zh-CN', messages36)
registerCatalog('electron.logs.cloudSync', 'zh-TW', messages37)
registerCatalog('electron.logs.cloudSync', 'en-US', messages38)
registerCatalog('electron.logs.completionAlerts', 'zh-CN', messages39)
registerCatalog('electron.logs.completionAlerts', 'zh-TW', messages40)
registerCatalog('electron.logs.completionAlerts', 'en-US', messages41)
registerCatalog('electron.logs.desktopAutomation', 'zh-CN', messages42)
registerCatalog('electron.logs.desktopAutomation', 'zh-TW', messages43)
registerCatalog('electron.logs.desktopAutomation', 'en-US', messages44)
registerCatalog('electron.logs.desktopAwareness', 'zh-CN', messages45)
registerCatalog('electron.logs.desktopAwareness', 'zh-TW', messages46)
registerCatalog('electron.logs.desktopAwareness', 'en-US', messages47)
registerCatalog('electron.ui.desktopControl', 'zh-CN', messages48)
registerCatalog('electron.ui.desktopControl', 'zh-TW', messages49)
registerCatalog('electron.ui.desktopControl', 'en-US', messages50)
registerCatalog('electron.logs.desktopControl', 'zh-CN', messages51)
registerCatalog('electron.logs.desktopControl', 'zh-TW', messages52)
registerCatalog('electron.logs.desktopControl', 'en-US', messages53)
registerCatalog('electron.logs.napcat', 'zh-CN', messages54)
registerCatalog('electron.logs.napcat', 'zh-TW', messages55)
registerCatalog('electron.logs.napcat', 'en-US', messages56)
registerCatalog('electron.logs.napcatDashboard', 'zh-CN', messages57)
registerCatalog('electron.logs.napcatDashboard', 'zh-TW', messages58)
registerCatalog('electron.logs.napcatDashboard', 'en-US', messages59)
registerCatalog('electron.ui.napcatDashboard', 'zh-CN', messages60)
registerCatalog('electron.ui.napcatDashboard', 'zh-TW', messages61)
registerCatalog('electron.ui.napcatDashboard', 'en-US', messages62)
registerCatalog('electron.logs.petControls', 'zh-CN', messages63)
registerCatalog('electron.logs.petControls', 'zh-TW', messages64)
registerCatalog('electron.logs.petControls', 'en-US', messages65)
registerCatalog('electron.logs.portableDaemon', 'zh-CN', messages66)
registerCatalog('electron.logs.portableDaemon', 'zh-TW', messages67)
registerCatalog('electron.logs.portableDaemon', 'en-US', messages68)
registerCatalog('electron.logs.steam', 'zh-CN', messages69)
registerCatalog('electron.logs.steam', 'zh-TW', messages70)
registerCatalog('electron.logs.steam', 'en-US', messages71)
registerCatalog('electron.logs.system', 'zh-CN', messages72)
registerCatalog('electron.logs.system', 'zh-TW', messages73)
registerCatalog('electron.logs.system', 'en-US', messages74)
registerCatalog('electron.ui.tray', 'zh-CN', messages75)
registerCatalog('electron.ui.tray', 'zh-TW', messages76)
registerCatalog('electron.ui.tray', 'en-US', messages77)
registerCatalog('electron.logs.tray', 'zh-CN', messages78)
registerCatalog('electron.logs.tray', 'zh-TW', messages79)
registerCatalog('electron.logs.tray', 'en-US', messages80)
registerCatalog('electron.ui.updater', 'zh-CN', messages81)
registerCatalog('electron.ui.updater', 'zh-TW', messages82)
registerCatalog('electron.ui.updater', 'en-US', messages83)
registerCatalog('electron.logs.updater', 'zh-CN', messages84)
registerCatalog('electron.logs.updater', 'zh-TW', messages85)
registerCatalog('electron.logs.updater', 'en-US', messages86)
registerCatalog('electron.logs.utils', 'zh-CN', messages87)
registerCatalog('electron.logs.utils', 'zh-TW', messages88)
registerCatalog('electron.logs.utils', 'en-US', messages89)
registerCatalog('electron.logs.windows', 'zh-CN', messages90)
registerCatalog('electron.logs.windows', 'zh-TW', messages91)
registerCatalog('electron.logs.windows', 'en-US', messages92)
registerCatalog('electron.ui.windows', 'zh-CN', messages93)
registerCatalog('electron.ui.windows', 'zh-TW', messages94)
registerCatalog('electron.ui.windows', 'en-US', messages95)
registerCatalog('errors.electron', 'zh-CN', messages96)
registerCatalog('errors.electron', 'zh-TW', messages97)
registerCatalog('errors.electron', 'en-US', messages98)
registerCatalog('electron.ui.completionAlerts', 'zh-CN', messages99)
registerCatalog('electron.ui.completionAlerts', 'zh-TW', messages100)
registerCatalog('electron.ui.completionAlerts', 'en-US', messages101)
registerCatalog('electron.ui.startupSplash', 'zh-CN', splashUiZh)
registerCatalog('electron.ui.startupSplash', 'zh-TW', splashUiTw)
registerCatalog('electron.ui.startupSplash', 'en-US', splashUiEn)
registerCatalog('electron.logs.startupSplash', 'zh-CN', splashLogsZh)
registerCatalog('electron.logs.startupSplash', 'zh-TW', splashLogsTw)
registerCatalog('electron.logs.startupSplash', 'en-US', splashLogsEn)
import resourceVersionsZh from '../locales/zh-CN/electron/ui/resource-recovery.json'
import resourceVersionsTw from '../locales/zh-TW/electron/ui/resource-recovery.json'
import resourceVersionsEn from '../locales/en-US/electron/ui/resource-recovery.json'
registerCatalog('electron.ui.resource-recovery', 'zh-CN', resourceVersionsZh)
registerCatalog('electron.ui.resource-recovery', 'zh-TW', resourceVersionsTw)
registerCatalog('electron.ui.resource-recovery', 'en-US', resourceVersionsEn)
