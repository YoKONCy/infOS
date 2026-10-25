import { t as __t } from '../utils/i18n'
/**
 * @file 窗口管理器
 * @description 管理 infOS 的 5 种窗口类型，提供创建/销毁/切换等操作
 *              遵循 07_DUAL_DEPLOYMENT.md 的 Electron 壳层规范
 *
 *              窗口类型:
 *              - Launcher    启动器 (900×600, 透明, 无边框, 亚克力)
 *              - Pet3D       桌宠   (600×600, 透明, 置顶, 鼠标追踪)
 *              - Dashboard   控制面板 (1280×800, 透明, 无边框)
 *              - Stronghold  据点   (1200×800, 透明, 无边框)
 *              - IDE         工作台 (1400×900, 透明, 无边框)
 *
 * @platform ELECTRON
 * @module electron/main/windows/manager
 */

import { BrowserWindow, shell, screen, nativeTheme } from 'electron'
import path from 'node:path'
import { loadSystemIcon } from '../utils/appIcon'
import { applyWindowIdentity, APPLICATION_NAME } from '../utils/appIdentity'
import { isDevelopmentRuntime } from '../utils/runtimeMode'
import { logger } from '../utils/logger'
import { guardTransparentWindowMaterial, resolveWindowBackground } from './windowConfig'
import { desktopTabs } from './desktopTabs'
import { isSelectedBackendUrl } from '../services/clientConnection'

// ─── 窗口配置表 ─────────────────────────────────────────
interface WindowConfig {
  route: string
  width: number
  height: number
  transparent: boolean
  alwaysOnTop: boolean
  skipTaskbar: boolean
  resizable: boolean
  hasShadow: boolean
}

const WINDOW_CONFIGS: Record<string, WindowConfig> = {
  launcher: {
    route: '/launcher',
    width: 1080,
    height: 720,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
  },
  pet: {
    route: '/pet-3d',
    width: 600,
    height: 600,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
  },
  dashboard: {
    // 综合面板已统一承载 Dashboard/Chat/Stronghold/Workspace 功能
    route: '/app',
    width: 1280,
    height: 800,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
  },
  stronghold: {
    // 保留独立窗口 IPC 兼容性，实际统一打开 MainView
    route: '/app',
    width: 1200,
    height: 800,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
  },
  chat: {
    // 保留独立窗口 IPC 兼容性，实际统一打开 MainView
    route: '/app',
    width: 1100,
    height: 760,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
  },
  ide: {
    // WorkView 已废弃，保留 IPC 兼容性并统一打开 MainView
    route: '/app',
    width: 1400,
    height: 900,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
  },
}

export class WindowManager {
  private static instance: WindowManager

  // ─── 窗口引用 ──────────────────────────────────────
  public launcherWin: BrowserWindow | null = null
  public petWin: BrowserWindow | null = null
  public dashboardWin: BrowserWindow | null = null
  public strongholdWin: BrowserWindow | null = null
  public chatWin: BrowserWindow | null = null
  public ideWin: BrowserWindow | null = null

  /** 记录窗口当前是否应当可见，避免异步ready事件覆盖主动隐藏。 */
  private readonly visibilityIntent = new WeakMap<BrowserWindow, boolean>()

  private launcherReleaseTimer: ReturnType<typeof setTimeout> | undefined
  private destroyingAll = false

  /** 启动过渡期间所有显窗入口共用门控，包括聚焦、加载兜底和失败兜底。 */
  private startupVisibilityGate: (() => void) | null = null

  public setStartupVisibilityGate(gate: (() => void) | null): void {
    this.startupVisibilityGate = gate
    if (!gate && this.launcherWin && !this.launcherWin.isDestroyed())
      this.launcherWin.webContents.setBackgroundThrottling(true)
  }

  /** Pet 窗口鼠标追踪定时器 */
  private mouseTrackInterval: ReturnType<typeof setInterval> | null = null

  private constructor() {
    desktopTabs.configure(() => this.createDashboardWindow())
    let configuredUiOrigin: string | undefined
    try {
      const configuredUi =
        process.env.INFOS_ARCA_UI_URL ?? (isDevelopmentRuntime ? 'http://127.0.0.1:7362' : '')
      if (configuredUi) configuredUiOrigin = new URL(configuredUi).origin
    } catch {
      /* 相对入口由本机 Daemon 的应用路径规则处理。 */
    }
    desktopTabs.registerApplication({
      id: 'infos.arca',
      title: 'Arca',
      description: __t('electron.ui.windows', '星页工房 · 文档与创作'),
      icon: 'book',
      preload: true,
      acceptsUrl: (url) =>
        ['http:', 'https:'].includes(url.protocol) &&
        ((isSelectedBackendUrl(url) && /^\/applications\/arca(?:\/|$)/.test(url.pathname)) ||
          url.origin === configuredUiOrigin) &&
        !url.username &&
        !url.password,
    })
    let pictoriaOrigin: string | undefined
    try {
      const configured =
        process.env.INFOS_PICTORIA_UI_URL ?? (isDevelopmentRuntime ? 'http://127.0.0.1:7363' : '')
      if (configured) pictoriaOrigin = new URL(configured).origin
    } catch {
      /* 相对入口由本机应用路径处理。 */
    }
    desktopTabs.registerApplication({
      id: 'infos.pictoria',
      title: 'Pictoria',
      description: __t('electron.ui.windows', '自由画布 · 图像与灵感'),
      icon: 'image',
      preload: true,
      waitForSurfaceReady: true,
      acceptsUrl: (url) =>
        ['http:', 'https:'].includes(url.protocol) &&
        ((isSelectedBackendUrl(url) && /^\/applications\/pictoria(?:\/|$)/.test(url.pathname)) ||
          url.origin === pictoriaOrigin) &&
        !url.username &&
        !url.password,
    })
  }

  public static getInstance(): WindowManager {
    if (!WindowManager.instance) {
      WindowManager.instance = new WindowManager()
    }
    return WindowManager.instance
  }

  // ─── 工具方法 ──────────────────────────────────────

  private getPreloadPath(): string {
    // electron-vite 编译后: dist-electron/preload/index.js
    return path.join(__dirname, '../preload/index.js')
  }

  /**
   * 加载窗口内容
   * - 开发: Vite Dev Server URL
   * - 生产: loadFile()
   */
  private loadWindowContent(win: BrowserWindow, route: string): void {
    // electron-vite 注入 ELECTRON_RENDERER_URL；旧版兼容 VITE_DEV_SERVER_URL
    const devUrl = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL
    if (devUrl) {
      const url = `${devUrl}#${route}`
      logger.info('WindowManager', __t('electron.logs.windows', '加载 Dev URL: {0}', [url]))
      void win.loadURL(url).catch(() => {
        /* 具体错误由 did-fail-load 统一报告。 */
      })
    } else {
      const { app } = require('electron')
      const indexPath = path.join(app.getAppPath(), 'renderer', 'index.html')
      logger.info(
        'WindowManager',
        __t('electron.logs.windows', '加载文件: {0}, hash: {1}', [indexPath, route]),
      )
      void win.loadFile(indexPath, { hash: route }).catch(() => {
        /* 具体错误由 did-fail-load 统一报告。 */
      })
    }
  }

  /** 监听窗口最大化状态变化，同步到渲染进程 */
  private setupWindowStateListeners(win: BrowserWindow): void {
    const sendState = () => {
      if (!win.isDestroyed()) {
        win.webContents.send('window-maximized-state-changed', win.isMaximized())
      }
    }
    win.on('maximize', sendState)
    win.on('unmaximize', sendState)
    win.on('restore', sendState)
    win.on('resize', sendState)
    // 原生可见性也用于暂停桌宠和页面动效，不能只依赖 Chromium 的遮挡判断。
    const sendVisibility = () => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send('window-visibility-changed', win.isVisible() && !win.isMinimized())
    }
    win.on('show', sendVisibility)
    win.on('hide', sendVisibility)
    win.on('minimize', sendVisibility)
    win.on('restore', sendVisibility)
  }

  /** 尝试为 Windows 窗口启用亚克力效果 */
  private trySetAcrylic(win: BrowserWindow): void {
    if (process.platform === 'win32') {
      try {
        win.setBackgroundMaterial('acrylic')
      } catch {
        // 不支持亚克力的 Windows 版本，静默忽略
      }
    }
  }

  /** 处理外部链接: 在系统浏览器中打开 */
  private setupExternalLinks(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https:') || url.startsWith('http:')) {
        shell.openExternal(url)
      }
      return { action: 'deny' }
    })
  }

  // ─── 通用窗口创建 ──────────────────────────────────

  private createOrFocus(
    existing: BrowserWindow | null,
    configKey: string,
    extraOpts?: Partial<Electron.BrowserWindowConstructorOptions>,
  ): BrowserWindow {
    // 如果已存在且未销毁，聚焦并返回
    if (existing && !existing.isDestroyed()) {
      this.visibilityIntent.set(existing, true)
      if (this.startupVisibilityGate) {
        this.startupVisibilityGate()
        return existing
      }
      // 始终显示并聚焦（调用者明确想要这个窗口）
      if (!existing.isVisible()) existing.show()
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return existing
    }

    const cfg = WINDOW_CONFIGS[configKey]
    if (!cfg) throw new Error(`未知窗口配置: ${configKey}`)

    // 分离 webPreferences 避免被 extraOpts 展开覆盖
    const { webPreferences: extraWebPrefs, backgroundMaterial, ...restExtraOpts } = extraOpts ?? {}
    const transparent = restExtraOpts.transparent ?? cfg.transparent

    const win = new BrowserWindow({
      title: APPLICATION_NAME,
      icon: loadSystemIcon(256),
      width: cfg.width,
      height: cfg.height,
      show: false,
      frame: false,
      center: true,
      transparent: cfg.transparent,
      hasShadow: cfg.hasShadow,
      alwaysOnTop: cfg.alwaysOnTop,
      skipTaskbar: cfg.skipTaskbar,
      resizable: cfg.resizable,
      backgroundColor: resolveWindowBackground({ transparent }, nativeTheme.shouldUseDarkColors),
      webPreferences: {
        preload: this.getPreloadPath(),
        backgroundThrottling: !this.startupVisibilityGate,
        ...extraWebPrefs,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
      ...restExtraOpts,
      // 包括 none 在内的 Electron 材质选项都不能进入透明窗口的创建路径。
      ...(!transparent && backgroundMaterial ? { backgroundMaterial } : {}),
    })

    applyWindowIdentity(win)

    // 透明窗口与系统背景材质互斥，不以阴影开关决定是否启用背景。
    if (transparent) {
      guardTransparentWindowMaterial(win)
    } else if (cfg.hasShadow) {
      this.trySetAcrylic(win)
    }

    this.setupWindowStateListeners(win)
    this.setupExternalLinks(win)

    this.visibilityIntent.set(win, true)

    let shownAfterLoad = false
    const showWhenReady = (source: string) => {
      if (this.startupVisibilityGate) return
      if (shownAfterLoad || win.isDestroyed() || this.visibilityIntent.get(win) === false) return
      shownAfterLoad = true
      applyWindowIdentity(win)
      logger.info(
        'WindowManager',
        __t('electron.logs.windows', '{0} 已就绪 ({1})', [configKey, source]),
      )
      if (configKey === 'pet') win.showInactive()
      else win.show()
    }

    // 透明窗口不保证稳定触发 ready-to-show，DOM 完成也可作为可靠显示信号。
    win.once('ready-to-show', () => showWhenReady('ready-to-show'))
    win.webContents.once('did-finish-load', () => showWhenReady('did-finish-load'))

    // 只为真正未完成页面加载的窗口保留兜底，避免正常透明窗口产生误告警。
    setTimeout(() => {
      if (
        !this.startupVisibilityGate &&
        !win.isDestroyed() &&
        !win.isVisible() &&
        this.visibilityIntent.get(win) !== false
      ) {
        if (win.webContents.isLoadingMainFrame()) {
          logger.warn(
            'WindowManager',
            __t('electron.logs.windows', '{0} 页面加载超时，先显示窗口', [configKey]),
          )
        } else {
          logger.info(
            'WindowManager',
            __t('electron.logs.windows', '{0} 首帧事件缺失，显示已加载窗口', [configKey]),
          )
        }
        showWhenReady('timeout-fallback')
      }
    }, 10_000)

    // 子框架取消导航不是窗口加载失败，也不能因此唤醒主动隐藏的窗口。
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (win.isDestroyed() || code === -3) return
      if (!isMainFrame) {
        logger.warn(
          'WindowManager',
          __t('electron.logs.windows', '{0} 内嵌页面加载失败: {1} ({2}), URL: {3}', [
            configKey,
            desc,
            code,
            url,
          ]),
        )
        return
      }
      logger.error(
        'WindowManager',
        __t('electron.logs.windows', '{0} 加载失败: {1} ({2}), URL: {3}', [
          configKey,
          desc,
          code,
          url,
        ]),
      )
      if (
        !this.startupVisibilityGate &&
        !win.isDestroyed() &&
        !win.isVisible() &&
        this.visibilityIntent.get(win) !== false
      ) {
        win.show()
      }
    })

    this.loadWindowContent(win, cfg.route)
    return win
  }

  // ─── 具体窗口 ──────────────────────────────────────

  public createLauncherWindow(): BrowserWindow {
    clearTimeout(this.launcherReleaseTimer)
    const previous = this.launcherWin
    this.launcherWin = this.createOrFocus(this.launcherWin, 'launcher')
    if (previous !== this.launcherWin) {
      const launcher = this.launcherWin
      launcher.on('closed', () => {
        clearTimeout(this.launcherReleaseTimer)
        if (this.launcherWin === launcher) this.launcherWin = null
      })
    }
    return this.launcherWin
  }

  public closeLauncherWindow(): void {
    if (this.launcherWin && !this.launcherWin.isDestroyed()) {
      this.launcherWin.close()
    }
  }

  public showLauncherWindow(): void {
    if (this.startupVisibilityGate) {
      this.startupVisibilityGate()
      return
    }
    clearTimeout(this.launcherReleaseTimer)
    if (!this.launcherWin || this.launcherWin.isDestroyed()) {
      this.createLauncherWindow()
      return
    }
    this.visibilityIntent.set(this.launcherWin, true)
    this.launcherWin.show()
    this.launcherWin.focus()
  }

  public hideLauncherWindow(): void {
    if (this.launcherWin && !this.launcherWin.isDestroyed()) {
      this.visibilityIntent.set(this.launcherWin, false)
      this.launcherWin.hide()
      logger.info('WindowManager', __t('electron.logs.windows', '已隐藏 Launcher 窗口'))
      clearTimeout(this.launcherReleaseTimer)
      const launcher = this.launcherWin
      // 启动完成后释放闲置页面，需要返回启动器时按已有配置重新创建。
      this.launcherReleaseTimer = setTimeout(() => {
        this.launcherReleaseTimer = undefined
        if (
          launcher === this.launcherWin &&
          !launcher.isDestroyed() &&
          !launcher.isVisible() &&
          this.visibilityIntent.get(launcher) === false &&
          [this.petWin, this.dashboardWin, this.strongholdWin, this.chatWin, this.ideWin].some(
            (win) => win && !win.isDestroyed(),
          )
        )
          launcher.destroy()
      }, 30_000)
    }
  }

  public createPetWindow(): BrowserWindow {
    const existing = this.petWin
    this.petWin = this.createOrFocus(this.petWin, 'pet', {
      // 桌宠长期不抢焦点，不能让 Chromium 按后台页面把可见动画压到约 1 帧。
      webPreferences: { backgroundThrottling: false },
    })
    if (this.petWin !== existing) {
      const pet = this.petWin
      const publishVisibility = () => {
        if (!pet.isDestroyed() && !pet.webContents.isDestroyed()) {
          const visible = pet.isVisible() && !pet.isMinimized()
          // 可见时由前端帧预算限速；隐藏时同时启用系统节流与前端主动停绘。
          pet.webContents.setBackgroundThrottling(!visible)
          if (visible) this.startMouseTracking()
          else this.stopMouseTracking()
          pet.webContents.send('pet-window-visibility-changed', this.getPetWindowState())
        }
      }
      pet.on('show', publishVisibility)
      pet.on('hide', publishVisibility)
      pet.on('minimize', publishVisibility)
      pet.on('restore', publishVisibility)
    }

    // Pet 窗口特殊设置
    this.petWin.setAlwaysOnTop(true, 'screen-saver')
    this.petWin.setIgnoreMouseEvents(false)

    // 初始定位: 屏幕右下角
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    this.petWin.setPosition(width - 650, height - 650)

    // 启动鼠标追踪 (30fps)
    this.startMouseTracking()

    // 渲染进程崩溃时恢复 Launcher
    this.petWin.webContents.on('render-process-gone', (_e, details) => {
      if (this.destroyingAll || !this.petWin || this.petWin.isDestroyed()) return
      logger.error(
        'WindowManager',
        __t('electron.logs.windows', 'Pet 渲染进程崩溃: {0} ({1})', [
          details.reason,
          details.exitCode,
        ]),
      )
      if (!this.destroyingAll) this.showLauncherWindow()
    })

    this.petWin.on('closed', () => {
      this.stopMouseTracking()
      this.petWin = null
      // 无可见窗口时恢复 Launcher
      const hasVisible = BrowserWindow.getAllWindows().some(
        (w) => !w.isDestroyed() && w.isVisible(),
      )
      if (!hasVisible && !this.destroyingAll) {
        logger.info(
          'WindowManager',
          __t('electron.logs.windows', 'Pet 关闭且无其他可见窗口，恢复 Launcher'),
        )
        this.showLauncherWindow()
      }
    })

    return this.petWin
  }

  public getPetWindowState(): { visible: boolean } {
    const pet = this.petWin
    return { visible: Boolean(pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized()) }
  }

  public hidePetWindow(): void {
    if (this.petWin && !this.petWin.isDestroyed()) {
      this.visibilityIntent.set(this.petWin, false)
      this.petWin.hide()
    }
  }

  /** 打开唯一的综合面板窗口；所有 App 功能入口都复用它。 */
  public createDashboardWindow(): BrowserWindow {
    // 兼容热更新前已打开的旧独立窗口：统一关闭，避免与综合面板并存。
    for (const legacyWindow of [this.strongholdWin, this.chatWin, this.ideWin]) {
      if (legacyWindow && !legacyWindow.isDestroyed()) legacyWindow.close()
    }
    this.strongholdWin = null
    this.chatWin = null
    this.ideWin = null
    const previous = this.dashboardWin
    this.dashboardWin = this.createOrFocus(this.dashboardWin, 'dashboard', {
      minWidth: 900,
      minHeight: 600,
    })
    desktopTabs.attach(this.dashboardWin)
    if (previous !== this.dashboardWin) {
      const win = this.dashboardWin
      win.on('closed', () => {
        if (this.dashboardWin === win) this.dashboardWin = null
      })
    }
    return this.dashboardWin
  }

  /** 据点已迁入综合面板，禁止再创建第二个 App 窗口。 */
  public createStrongholdWindow(): BrowserWindow {
    const win = this.createDashboardWindow()
    desktopTabs.openHome('stronghold')
    return win
  }

  /** 聊天已迁入综合面板，禁止再创建第二个 App 窗口。 */
  public createChatWindow(): BrowserWindow {
    const win = this.createDashboardWindow()
    desktopTabs.openHome('chat')
    return win
  }

  public async closeArcaWindow(): Promise<void> {
    await desktopTabs.closeApplication('infos.arca')
  }

  public getArcaWindowState(): { open: boolean; visible: boolean } {
    return desktopTabs.getApplicationState('infos.arca')
  }

  public createArcaWindow(url: string): BrowserWindow {
    // 兼容旧 IPC 名称，实际打开统一主窗口里的应用标签。
    const win = this.createDashboardWindow()
    desktopTabs.openApplication('infos.arca', url)
    return win
  }

  /** 工作台已迁入综合面板，禁止再创建第二个 App 窗口。 */
  public createIDEWindow(): BrowserWindow {
    const win = this.createDashboardWindow()
    desktopTabs.openHome('workspace')
    return win
  }

  // ─── Pet 鼠标追踪 ─────────────────────────────────

  private startMouseTracking(): void {
    if (this.mouseTrackInterval || !this.getPetWindowState().visible) return

    // 30fps 鼠标追踪，用于 Pet 视线跟随
    let previousX: number | undefined
    let previousY: number | undefined
    this.mouseTrackInterval = setInterval(() => {
      if (
        !this.petWin ||
        !this.getPetWindowState().visible ||
        this.petWin.webContents.isDestroyed()
      ) {
        this.stopMouseTracking()
        return
      }
      try {
        const cursor = screen.getCursorScreenPoint()
        const bounds = this.petWin.getBounds()
        const x = cursor.x - bounds.x
        const y = cursor.y - bounds.y
        if (x === previousX && y === previousY) return
        previousX = x
        previousY = y
        this.petWin.webContents.send('global-mouse-move', {
          x,
          y,
        })
      } catch {
        // 静默忽略追踪错误
      }
    }, 33)
  }

  private stopMouseTracking(): void {
    if (this.mouseTrackInterval) {
      clearInterval(this.mouseTrackInterval)
      this.mouseTrackInterval = null
    }
  }

  /** 销毁所有窗口 */
  public destroyAll(): void {
    this.destroyingAll = true
    clearTimeout(this.launcherReleaseTimer)
    this.stopMouseTracking()
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.destroy()
    })
    this.launcherWin = null
    this.petWin = null
    this.dashboardWin = null
    this.strongholdWin = null
    this.chatWin = null
    this.ideWin = null
    this.destroyingAll = false
  }
}

/** 全局单例 */
export const windowManager = WindowManager.getInstance()
