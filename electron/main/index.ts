import './utils/stdioGuard'
import { steamAchievements } from './services/steamAchievements'
import { t as __t } from './utils/i18n'
/**
 * @file Electron 主进程入口
 * @description 遵循 07_DUAL_DEPLOYMENT.md — Electron 壳层仅做窗口/IPC/系统能力
 *              所有业务逻辑在 @infos/backend 中，通过 HTTP :9120 通信
 *
 *              职责:
 *              1. 应用生命周期管理 (单实例锁, 退出清理)
 *              2. 注册 IPC 通道 (通过 ipcBridge.ts)
 *              3. 创建窗口 (通过 WindowManager)
 *              4. 启动系统服务 (托盘, 快捷键, 自动更新)
 *              5. 连接 Daemon CapabilityBridge 注册平台能力（第七阶段修复 E4：不再启动后端子进程）
 *
 * @platform ELECTRON
 * @module electron/main
 */

import { app, BrowserWindow, protocol, safeStorage } from 'electron'
import { release } from 'node:os'
import { logger } from './utils/logger'
import { windowManager } from './windows/manager'
import { desktopTabs } from './windows/desktopTabs'
import { registerIpcHandlers } from './ipcBridge'
import { initSteam } from './services/steam'
import { closePictoriaDesktopGuard } from './services/pictoriaLifetime'
import { closeArcaDesktopGuard } from './services/arcaLifetime'
import { APPLICATION_NAME, WINDOWS_APP_ID } from './utils/appIdentity'
import { configureClientCredential, getClientCredential } from './utils/clientCredential'
import { paths } from './utils/env'
import { StartupSplash } from './windows/startupSplash'
import { waitForLauncherFirstFrame } from './windows/launcherFirstFrame'
import { StartupFlow } from './services/startupFlow'
import {
  ClientConnectionStore,
  clientConnection,
  configureClientConnection,
  ensureSelectedBackend,
  isRemoteConnection,
} from './services/clientConnection'
import {
  configureConnectionSetup,
  showConnectionSetup,
  focusConnectionSetup,
} from './services/clientConnectionSetup'
import { notifyRendererError, reportMainError } from './utils/mainErrorHandler'

configureClientCredential(process.env.PERO_DATA_DIR || paths.data)
configureClientConnection(
  new ClientConnectionStore(paths.userData, {
    encrypt(value) {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      )
        throw new Error('CONNECTION_ENCRYPTION_UNAVAILABLE')
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt(value) {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    },
  }),
)

// ─── 全局错误捕获 ─────────────────────────────────────
process.on('uncaughtException', (error) => {
  reportMainError('exception', error)
})

process.on('unhandledRejection', (reason) => {
  reportMainError('rejection', reason)
})

// ─── 协议注册 (必须在 app.ready 之前) ──────────────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'asset',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

// ─── 平台适配 ────────────────────────────────────────
// 禁用 Windows 7 的 GPU 加速
if (release().startsWith('6.1')) app.disableHardwareAcceleration()

// 透明窗口支持
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'Autofill,CalculateNativeWinOcclusion')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// @platform WINDOWS — 设置应用名称
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if (process.platform === 'win32') {
  app.setName(APPLICATION_NAME)
  // 正式版与安装包使用同一标识，开发版独立归组，进程与窗口共用对应身份。
  app.setAppUserModelId(WINDOWS_APP_ID)
  logger.info(
    'AppIdentity',
    __t('electron.logs.index.ts', 'Windows 任务栏身份：{0}；程序路径：{1}', [
      WINDOWS_APP_ID,
      app.getPath('exe'),
    ]),
  )
}

// ─── 单实例锁 ─────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

// ─── Steam 初始化 (可选) ──────────────────────────────
try {
  const steamStatus = initSteam()
  if (steamStatus === 'restarting') {
    logger.info('Main', __t('electron.logs.index.ts', '通过 Steam 重启，当前进程退出...'))
    app.quit()
  } else {
    logger.info('Main', __t('electron.logs.index.ts', 'Steam 初始化: {0}', [steamStatus]))
  }
} catch (e: unknown) {
  logger.error('Main', __t('electron.logs.index.ts', 'Steam 初始化异常 (已跳过): {0}', [e]))
}

// ─── IPC 注册 (在 app.ready 之前即可) ─────────────────
registerIpcHandlers()

// ─── Electron 壳层启动过渡 ───────────────────────────
let isQuitting = false
let isPreparingQuit = false
let assetProtocolRegistered = false
let desktopServicesStarted = false
let preparedLauncher: BrowserWindow | null = null
const startupSplash = new StartupSplash({
  retry: () => {
    // 等上一轮失败的 Promise 完成清理后再重试，原生提示同步返回时也不重入。
    setImmediate(() => {
      if (!isPreparingQuit) void startDesktop()
    })
  },
  quit: () => {
    app.quit()
  },
})
windowManager.setStartupVisibilityGate(() => startupSplash.focus())
const startupFlow = new StartupFlow({
  phase: (phase) => startupSplash.setPhase(phase),
  open: () => startupSplash.open(),
  prepare: async () => {
    // 重试选择服务器前销毁旧隐藏页面，旧请求不能携带新服务器的凭据。
    windowManager.launcherWin?.destroy()
    const selected = clientConnection().load()
    if (!selected) await showConnectionSetup()
    else if (selected.mode === 'remote') {
      try {
        await clientConnection().verify()
      } catch {
        await showConnectionSetup(true, '连接失败，请检查地址、令牌和网络。')
      }
    }
    // 开屏已绘制后再扫描资源；外部模型映射仍先于 Launcher 初始化。
    const { registerAssetProtocol, scan3DModels } = await import('./services/assets')
    if (!assetProtocolRegistered) {
      registerAssetProtocol()
      assetProtocolRegistered = true
    }
    await scan3DModels()
  },
  backend: async () => {
    const { ensurePortableDaemon } = await import('./services/portableDaemon')
    return ensureSelectedBackend(ensurePortableDaemon)
  },
  launcher: async (signal) => {
    // 前一次失败的隐藏页面不能携带旧的首帧握手进入下一次重试。
    const previous = windowManager.launcherWin
    if (previous && !previous.isDestroyed()) previous.destroy()
    preparedLauncher = null
    preparedLauncher = await waitForLauncherFirstFrame(
      () => windowManager.createLauncherWindow(),
      signal,
    )
  },
  verifyBackend: async () => {
    const { probeBusinessHealth } = await import('./services/portableDaemon')
    return ensureSelectedBackend(probeBusinessHealth)
  },
  finish: (signal) => startupSplash.finish(signal),
  reveal: () => {
    if (
      isPreparingQuit ||
      !preparedLauncher ||
      preparedLauncher.isDestroyed() ||
      preparedLauncher.webContents.isDestroyed() ||
      preparedLauncher.webContents.isCrashed()
    )
      throw new Error('startup-launcher-lost')
    windowManager.setStartupVisibilityGate(null)
    windowManager.showLauncherWindow()
  },
  close: () => startupSplash.hide(),
  failed: (kind, error) => startupSplash.fail(kind, error),
})
configureConnectionSetup({
  selectConnection: (activate = true, error = '') => {
    // 启动进行中只聚焦现有开屏，不能插入另一轮配置并打断显窗门控。
    if (!activate && startupFlow.running) {
      startupSplash.focus()
      return Promise.reject(new Error('CONNECTION_STARTUP_IN_PROGRESS'))
    }
    return startupSplash.selectConnection(activate, error)
  },
  focusConnection: () => startupSplash.focusConnection(),
})

async function startDesktop(): Promise<void> {
  await startupFlow.start()
  if (!startupFlow.completed || isPreparingQuit || desktopServicesStarted) return
  desktopServicesStarted = true
  steamAchievements.start()
  try {
    // 后端就绪后连接 Daemon 并注册桌面能力；开发模式由外部 Daemon 提供业务服务。
    const { capabilityProvider } = await import('./services/capabilityProvider')
    if (isPreparingQuit) return
    capabilityProvider.start().catch((e) => {
      const message = `CapabilityProvider 启动失败（Daemon 是否已运行？）: ${String(e)}`
      logger.error('Main', message)
      notifyRendererError('桌面能力连接失败', '无法连接 Daemon，截图、剪贴板等桌面工具暂不可用。')
    })

    // 启动系统服务
    const { createTray } = await import('./services/tray')
    if (isPreparingQuit) return
    createTray()

    const { registerShortcuts } = await import('./services/shortcuts')
    if (isPreparingQuit) return
    await registerShortcuts()

    const { setupUpdater } = await import('./services/updater')
    if (isPreparingQuit) return
    setupUpdater()

    logger.info('Main', __t('electron.logs.index.ts', '应用启动完成（Daemon 连接模式）'))
  } catch (e: unknown) {
    logger.error('Main', __t('electron.logs.index.ts', 'App whenReady 失败: {0}', [e]))
  }
}

// 窗口、后端与重试共享同一启动链；浏览器和 Docker 入口不使用此过渡。
app
  .whenReady()
  .then(async () => {
    // 恢复托盘先于后端加载，首次启动失败时也必须保留原生恢复入口。
    const { createTray } = await import('./services/tray')
    createTray()
    await startDesktop()
  })
  .catch((error) => startupSplash.fail('shell', error))

// ─── 应用生命周期 ─────────────────────────────────────
app.on('window-all-closed', () => {
  // 保持托盘运行，不退出
  if (process.platform === 'darwin') return
})

app.on('before-quit', async (event) => {
  if (isQuitting) return

  event.preventDefault()
  if (isPreparingQuit) return
  isPreparingQuit = true
  try {
    if (!(await desktopTabs.closeAll())) {
      isPreparingQuit = false
      return
    }
  } catch (error) {
    isPreparingQuit = false
    logger.warn(
      'Main',
      __t('electron.logs.index.ts', '关闭应用标签失败，已取消退出：{0}', [String(error)]),
    )
    return
  }
  isQuitting = true
  steamAchievements.stop()
  startupFlow.cancel()
  startupSplash.dispose()

  logger.info('Main', __t('electron.logs.index.ts', '正在执行退出清理...'))
  try {
    // 1. 销毁所有窗口
    windowManager.destroyAll()

    // 2.分别停止当前宿主托管的子应用；一个失败不阻塞另一个，外部实例保持独立。
    if (!isRemoteConnection())
      await Promise.all(
        ['arca', 'pictoria'].map(async (name) => {
          try {
            const token = getClientCredential()
            const response = await fetch(
              `http://127.0.0.1:${Number(process.env.PERO_PORT ?? 9120)}/api/applications/${name}/shutdown-managed`,
              {
                method: 'POST',
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                signal: AbortSignal.timeout(12000),
                redirect: 'error',
              },
            )
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
          } catch (error) {
            logger.warn(
              'Main',
              __t('electron.logs.index.ts', '停止托管 {0} 失败，继续退出清理：{1}', [
                name,
                String(error),
              ]),
            )
          }
        }),
      )

    await closePictoriaDesktopGuard()
    await closeArcaDesktopGuard()

    // 3.停止能力提供者（断开与 Daemon 的连接，注销能力）
    const { capabilityProvider } = await import('./services/capabilityProvider')
    await capabilityProvider.stop()

    // 4. 注销快捷键
    const { unregisterShortcuts } = await import('./services/shortcuts')
    unregisterShortcuts()

    // 5. 销毁托盘
    const { destroyTray } = await import('./services/tray')
    destroyTray()
  } catch (e: unknown) {
    logger.error('Main', __t('electron.logs.index.ts', '退出清理失败: {0}', [e]))
  } finally {
    // 前面的清理失败时也必须等待本应用拉起的 Daemon 退出，避免重启时遗留进程。
    await import('./services/portableDaemon')
      .then(({ stopPortableDaemon }) => stopPortableDaemon())
      .catch((error) =>
        logger.warn(
          'Main',
          __t('electron.logs.index.ts', '停止内置 Daemon 失败：{0}', [String(error)]),
        ),
      )
    // 其他退出步骤失败也必须等待 NapCat 进程树回收完成。
    await import('./services/napcat')
      .then(({ stopNapCat }) => stopNapCat())
      .catch((error) =>
        logger.warn(
          'Main',
          __t('electron.logs.index.ts', '停止 NapCat 失败：{0}', [String(error)]),
        ),
      )
    // 即使 Daemon 不可达，断开桌面存活连接也能触发 Pictoria 自行停止。
    await closePictoriaDesktopGuard().catch((error) =>
      logger.warn(
        'Main',
        __t('electron.logs.index.ts', '关闭 Pictoria 存活连接失败：{0}', [String(error)]),
      ),
    )
    await closeArcaDesktopGuard().catch((error) =>
      logger.warn(
        'Main',
        __t('electron.logs.index.ts', '关闭 Arca 存活连接失败：{0}', [String(error)]),
      ),
    )
    logger.close()
  }

  app.quit()
})

app.on('second-instance', () => {
  if (isPreparingQuit) return
  if (!startupFlow.completed) {
    if (!focusConnectionSetup()) startupSplash.focus()
    return
  }
  logger.info('Main', __t('electron.logs.index.ts', '第二个实例启动请求，激活现有窗口'))
  const win = windowManager.launcherWin ?? windowManager.dashboardWin ?? windowManager.petWin
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
    if (!win.isVisible()) win.show()
  } else {
    windowManager.createLauncherWindow()
  }
})

app.on('activate', () => {
  if (isPreparingQuit) return
  if (!startupFlow.completed) {
    startupSplash.focus()
    return
  }
  const allWindows = BrowserWindow.getAllWindows()
  // 提示音播放器不参与主界面唤起，避免聚焦不可见的辅助窗口。
  const firstWin =
    windowManager.dashboardWin ??
    windowManager.launcherWin ??
    allWindows.find((win) => win.isVisible())
  if (firstWin) {
    if (firstWin.isMinimized()) firstWin.restore()
    firstWin.show()
    firstWin.focus()
  } else {
    windowManager.createLauncherWindow()
  }
})
