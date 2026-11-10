import { t as __t } from '../utils/i18n'
/**
 * @file 桌面外壳面板窗口
 * @description 主界面的功能页摘成独立的桌面面板窗口：创建、启动恢复、布局保存、合回与屏幕外修正。
 *
 *              - 布局按设备保存在 Electron 用户数据目录的 desktop-shell.json，写入用临时文件再改名；
 *                移动、缩放停止 500ms 后才写盘。
 *              - 关闭面板等同于合回但不切换主窗口；退出应用时面板一起关闭，下次启动恢复。
 *              - 窗口创建复用 WindowManager 的通用流程（preload、沙箱、加载路由），由其在构造时注入。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 1
 * @module electron/main/windows/detachedPanels
 */

import { app, ipcMain, screen, type BrowserWindow, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../utils/logger'
import {
  DESKTOP_SHELL_CHANNELS,
  DESKTOP_SHELL_LAYOUT_FILE,
  DESKTOP_SHELL_SAVE_DELAY_MS,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  correctOffscreenBounds,
  createEmptyLayout,
  defaultPanelSize,
  isDetachablePage,
  isMainPageId,
  normalizeDesktopShellLayout,
  normalizePanelPatch,
  panelStates,
  parseDetachRequest,
  placeNewPanel,
  readPageId,
  type DesktopShellLayout,
  type DetachRequest,
  type DetachedPanelLayout,
  type DetachedPanelPatch,
  type DetachedPanelState,
  type MainPageId,
  type ShellRect,
} from '../../../packages/shared/src/desktopShell'
import { desktopLayer } from './desktopLayer'
import { watchDisplayChanges } from './displayWatch'

/** 由 WindowManager 注入的宿主能力，避免与窗口管理器循环依赖，也便于测试。 */
export interface DetachedPanelsHost {
  /** 用通用流程创建（不聚焦地显示）面板窗口并加载指定前端路由。 */
  createWindow(route: string, options: Electron.BrowserWindowConstructorOptions): BrowserWindow
  /** 当前主窗口（可能尚未创建或已关闭）。 */
  mainWindow(): BrowserWindow | null
  /** 显示主窗口并切到指定页面。 */
  showMainPage(pageId: string): void
  /** 发送者是否为主窗口。 */
  isMain(sender: WebContents): boolean
}

/** 显示器信息来源；测试中替换为固定数据。 */
export interface DisplaySource {
  workAreas(): ShellRect[]
  primaryWorkArea(): ShellRect
  workAreaNear(rect: ShellRect): ShellRect
}

const electronDisplays: DisplaySource = {
  workAreas: () => screen.getAllDisplays().map((display) => ({ ...display.workArea })),
  primaryWorkArea: () => ({ ...screen.getPrimaryDisplay().workArea }),
  workAreaNear: (rect) => ({ ...screen.getDisplayMatching(rect).workArea }),
}

/** 关闭面板时等待页面 beforeunload 的上限。 */
const GRACEFUL_CLOSE_TIMEOUT_MS = 5_000

export class DetachedPanels {
  private host: DetachedPanelsHost | null = null
  private layoutCache: DesktopShellLayout | null = null
  private readonly windows = new Map<MainPageId, BrowserWindow>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private shuttingDown = false

  constructor(
    private readonly file: () => string,
    private readonly displays: DisplaySource = electronDisplays,
  ) {}

  configure(host: DetachedPanelsHost): void {
    this.host = host
  }

  // ─── 布局读写 ──────────────────────────────────────

  private get layout(): DesktopShellLayout {
    if (!this.layoutCache) this.layoutCache = this.load()
    return this.layoutCache
  }

  private load(): DesktopShellLayout {
    try {
      return normalizeDesktopShellLayout(JSON.parse(fs.readFileSync(this.file(), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn(
          'DetachedPanels',
          __t('electron.logs.windows', '桌面面板布局读取失败，使用默认布局：{0}', [String(error)]),
        )
      return createEmptyLayout()
    }
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), DESKTOP_SHELL_SAVE_DELAY_MS)
  }

  /** 立即写盘；先写临时文件再改名，中途退出不会留下半个文件。 */
  flush(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (!this.layoutCache) return
    const file = this.file()
    const temporary = `${file}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify(this.layoutCache, null, 2), 'utf8')
      fs.renameSync(temporary, file)
    } catch (error) {
      logger.warn(
        'DetachedPanels',
        __t('electron.logs.windows', '桌面面板布局保存失败：{0}', [String(error)]),
      )
    }
  }

  // ─── 查询 ──────────────────────────────────────────

  states(): DetachedPanelState[] {
    return panelStates(this.layout)
  }

  isPanel(sender: WebContents): boolean {
    return this.pageOf(sender) !== undefined
  }

  pageOf(sender: WebContents): MainPageId | undefined {
    for (const [pageId, win] of this.windows)
      if (!win.isDestroyed() && win.webContents === sender) return pageId
    return undefined
  }

  /** 已打开的面板窗口（阶段 3 外壳能力读取窗口状态与广播主题用）。 */
  windowOf(pageId: MainPageId): BrowserWindow | undefined {
    const win = this.windows.get(pageId)
    return win && !win.isDestroyed() ? win : undefined
  }

  /** 当前所有已打开的面板窗口。 */
  openWindows(): BrowserWindow[] {
    return [...this.windows.values()].filter((win) => !win.isDestroyed())
  }

  /** 主窗口或该页面自己的面板才可以操作该面板。 */
  canControl(sender: WebContents, pageId: MainPageId): boolean {
    return Boolean(this.host?.isMain(sender)) || this.pageOf(sender) === pageId
  }

  // ─── 操作 ──────────────────────────────────────────

  /** 摘出页面；已摘出时聚焦现有面板。 */
  detach(request: DetachRequest): DetachedPanelState[] {
    const { pageId } = request
    const existing = this.windows.get(pageId)
    if (existing && !existing.isDestroyed()) {
      this.reveal(existing)
      return this.states()
    }
    const panel: DetachedPanelLayout = this.layout.panels[pageId] ?? {
      alwaysOnTop: false,
      opacity: 1,
    }
    if (request.bounds) panel.bounds = request.bounds
    this.layout.panels[pageId] = panel
    this.open(pageId, panel, true)
    logger.info('DetachedPanels', __t('electron.logs.windows', '已摘出页面 {0}', [pageId]))
    this.scheduleSave()
    this.broadcast()
    return this.states()
  }

  /** 已摘出时聚焦面板；未摘出时在主窗口打开该页面。 */
  focus(pageId: MainPageId): boolean {
    const win = this.windows.get(pageId)
    if (win && !win.isDestroyed()) {
      this.reveal(win)
      return true
    }
    const panel = isDetachablePage(pageId) ? this.layout.panels[pageId] : undefined
    if (panel) {
      // 已摘出但窗口尚未恢复（例如主窗口刚创建），直接打开面板。
      this.open(pageId, panel, true)
      return true
    }
    this.host?.showMainPage(pageId)
    return false
  }

  /** 合回：关闭面板（页面已在渲染进程确认过未保存修改），主窗口切到该页。 */
  attach(pageId: MainPageId): DetachedPanelState[] {
    this.discard(pageId)
    logger.info('DetachedPanels', __t('electron.logs.windows', '已合回页面 {0}', [pageId]))
    this.host?.showMainPage(pageId)
    return this.states()
  }

  /**
   * 角色发起的合回：先普通关闭面板，尊重页面的未保存确认；
   * 页面拒绝卸载时保持打开并返回 false，否则合回并切到该页。
   */
  async attachGracefully(pageId: MainPageId): Promise<boolean> {
    const win = this.windows.get(pageId)
    if (win && !win.isDestroyed() && !(await this.closeGracefully(win))) return false
    this.attach(pageId)
    return true
  }

  /** 关闭面板，不切换主窗口。 */
  close(pageId: MainPageId): DetachedPanelState[] {
    this.discard(pageId)
    return this.states()
  }

  set(pageId: MainPageId, patch: DetachedPanelPatch): DetachedPanelState[] {
    const panel = this.layout.panels[pageId]
    if (!panel) throw new Error('DESKTOP_SHELL_NOT_DETACHED')
    const win = this.windows.get(pageId)
    if (patch.alwaysOnTop !== undefined) {
      panel.alwaysOnTop = patch.alwaysOnTop
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(patch.alwaysOnTop)
    }
    if (patch.opacity !== undefined) {
      panel.opacity = patch.opacity
      if (win && !win.isDestroyed()) win.setOpacity(patch.opacity)
    }
    this.scheduleSave()
    this.broadcast()
    return this.states()
  }

  /**
   * 恢复默认布局：逐个关闭面板并清除保存的位置。
   * 页面仍有未保存修改（beforeunload 拒绝卸载）的面板保持打开，返回其数量。
   */
  async reset(): Promise<{ remaining: number }> {
    const open = [...this.windows.entries()]
    await Promise.all(open.map(([, win]) => this.closeGracefully(win)))
    for (const pageId of Object.keys(this.layout.panels) as MainPageId[])
      if (!this.windows.has(pageId)) delete this.layout.panels[pageId]
    this.flush()
    this.broadcast()
    const remaining = this.windows.size
    logger.info(
      'DetachedPanels',
      __t('electron.logs.windows', '已恢复默认桌面布局，保留 {0} 个面板', [remaining]),
    )
    return { remaining }
  }

  /** 主窗口显示后恢复所有已摘出、尚未打开的面板。 */
  restoreWhenReady(main: BrowserWindow): void {
    const run = () => {
      if (!main.isDestroyed()) this.restore()
    }
    if (main.isVisible()) setImmediate(run)
    else main.once('show', run)
  }

  restore(): void {
    if (this.shuttingDown) return
    for (const state of this.states()) {
      const panel = this.layout.panels[state.pageId]
      if (panel && !this.windows.has(state.pageId)) this.open(state.pageId, panel, false)
    }
  }

  /** 退出应用前调用：之后窗口销毁不再视为用户关闭，布局原样保留到下次启动。 */
  shutdown(): void {
    this.shuttingDown = true
    if (this.saveTimer) this.flush()
  }

  // ─── 内部 ──────────────────────────────────────────

  private open(pageId: MainPageId, panel: DetachedPanelLayout, focus: boolean): BrowserWindow {
    if (!this.host) throw new Error('DESKTOP_SHELL_NOT_CONFIGURED')
    const bounds = this.resolveBounds(pageId, panel)
    panel.bounds = bounds
    const win = this.host.createWindow(`/panel/${pageId}`, {
      ...bounds,
      center: false,
      minWidth: PANEL_MIN_WIDTH,
      minHeight: PANEL_MIN_HEIGHT,
      alwaysOnTop: panel.alwaysOnTop,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
    })
    this.windows.set(pageId, win)
    win.setOpacity(panel.opacity)
    if (panel.alwaysOnTop) win.setAlwaysOnTop(true)
    const capture = () => this.captureBounds(pageId, win)
    win.on('move', capture)
    win.on('resize', capture)
    win.on('closed', () => this.handleClosed(pageId, win))
    if (focus)
      win.once('show', () => {
        if (!win.isDestroyed()) win.focus()
      })
    return win
  }

  /**
   * 显示器拔掉或分辨率变化后：可见面积不足的已打开面板拉回工作区。贴在桌面底层的面板
   * （坐标相对桌面图标层）与全屏、最大化的面板不动。
   */
  correctOffscreen(isPinned: (win: BrowserWindow) => boolean = () => false): void {
    for (const win of this.windows.values()) {
      if (win.isDestroyed() || win.isFullScreen() || win.isMaximized() || isPinned(win)) continue
      const current = win.getBounds()
      const next = correctOffscreenBounds(
        current,
        this.displays.workAreas(),
        this.displays.primaryWorkArea(),
      )
      if (JSON.stringify(next) !== JSON.stringify(current)) win.setBounds(next)
    }
  }

  /** 保存的位置做屏幕外修正；没有位置时放在主窗口旁边。 */
  private resolveBounds(pageId: MainPageId, panel: DetachedPanelLayout): ShellRect {
    if (panel.bounds)
      return correctOffscreenBounds(
        panel.bounds,
        this.displays.workAreas(),
        this.displays.primaryWorkArea(),
      )
    const main = this.host?.mainWindow()
    const mainBounds = main && !main.isDestroyed() ? main.getBounds() : undefined
    const workArea = mainBounds
      ? this.displays.workAreaNear(mainBounds)
      : this.displays.primaryWorkArea()
    return placeNewPanel(defaultPanelSize(pageId), mainBounds, workArea, this.windows.size)
  }

  private captureBounds(pageId: MainPageId, win: BrowserWindow): void {
    if (win.isDestroyed() || win.isMinimized() || this.windows.get(pageId) !== win) return
    const panel = this.layout.panels[pageId]
    if (!panel) return
    panel.bounds = win.getBounds()
    this.scheduleSave()
  }

  /** 窗口真正关闭后（含系统关闭快捷键）移除布局；退出应用时保留。 */
  private handleClosed(pageId: MainPageId, win: BrowserWindow): void {
    if (this.windows.get(pageId) !== win) return
    this.windows.delete(pageId)
    if (this.shuttingDown) return
    delete this.layout.panels[pageId]
    this.scheduleSave()
    this.broadcast()
  }

  /** 移除布局并立即销毁窗口（渲染进程已完成离开确认）。 */
  private discard(pageId: MainPageId): void {
    const win = this.windows.get(pageId)
    this.windows.delete(pageId)
    delete this.layout.panels[pageId]
    this.scheduleSave()
    this.broadcast()
    if (win && !win.isDestroyed()) win.destroy()
  }

  /** 普通关闭，尊重页面的 beforeunload；返回是否已关闭。 */
  private closeGracefully(win: BrowserWindow): Promise<boolean> {
    if (win.isDestroyed()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const contents = win.webContents
      const settle = (closed: boolean) => {
        clearTimeout(timer)
        win.removeListener('closed', onClosed)
        contents.removeListener('will-prevent-unload', onPrevented)
        resolve(closed)
      }
      const onClosed = () => settle(true)
      const onPrevented = () => settle(false)
      const timer = setTimeout(() => settle(win.isDestroyed()), GRACEFUL_CLOSE_TIMEOUT_MS)
      win.once('closed', onClosed)
      contents.once('will-prevent-unload', onPrevented)
      win.close()
    })
  }

  private reveal(win: BrowserWindow): void {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  }

  /** 已摘出页面列表变化时通知主窗口与所有面板。 */
  private broadcast(): void {
    const payload = { panels: this.states() }
    const targets = new Set<BrowserWindow>(this.windows.values())
    const main = this.host?.mainWindow()
    if (main) targets.add(main)
    for (const win of targets) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send(DESKTOP_SHELL_CHANNELS.changed, payload)
    }
  }
}

/** 全局单例 */
export const detachedPanels = new DetachedPanels(() =>
  path.join(app.getPath('userData'), DESKTOP_SHELL_LAYOUT_FILE),
)

function requirePage(value: unknown, detachable = true): MainPageId {
  const pageId = readPageId(value)
  if (detachable ? !isDetachablePage(pageId) : !isMainPageId(pageId))
    throw new Error('DESKTOP_SHELL_INVALID_PAGE')
  return pageId as MainPageId
}

/** 注册 desktop-shell:* 通道；所有入参在此校验，调用方只能是主窗口或面板窗口。 */
export function registerDetachedPanelHandlers(
  isMain: (sender: WebContents) => boolean,
  panels: DetachedPanels = detachedPanels,
): void {
  const assertShell = (sender: WebContents) => {
    if (!isMain(sender) && !panels.isPanel(sender)) throw new Error('DESKTOP_SHELL_FORBIDDEN')
  }
  const assertControl = (sender: WebContents, pageId: MainPageId) => {
    if (!panels.canControl(sender, pageId)) throw new Error('DESKTOP_SHELL_FORBIDDEN')
  }
  // 显示器变化后把跑到屏幕外的面板拉回来；退出时自动解绑监听。
  watchDisplayChanges(() => panels.correctOffscreen((win) => desktopLayer.isPinned(win)))
  ipcMain.handle(DESKTOP_SHELL_CHANNELS.panels, (event) => {
    assertShell(event.sender)
    return panels.states()
  })
  ipcMain.handle(DESKTOP_SHELL_CHANNELS.detach, (event, input: unknown) => {
    if (!isMain(event.sender)) throw new Error('DESKTOP_SHELL_FORBIDDEN')
    const request = parseDetachRequest(input)
    if (!request) throw new Error('DESKTOP_SHELL_INVALID_PAGE')
    return panels.detach(request)
  })
  ipcMain.handle(DESKTOP_SHELL_CHANNELS.attach, (event, input: unknown) => {
    const pageId = requirePage(input)
    assertControl(event.sender, pageId)
    return panels.attach(pageId)
  })
  ipcMain.handle(DESKTOP_SHELL_CHANNELS.close, (event, input: unknown) => {
    const pageId = requirePage(input)
    assertControl(event.sender, pageId)
    return panels.close(pageId)
  })
  ipcMain.handle(DESKTOP_SHELL_CHANNELS.focus, (event, input: unknown) => {
    assertShell(event.sender)
    return panels.focus(requirePage(input, false))
  })
  ipcMain.handle(DESKTOP_SHELL_CHANNELS.set, (event, input: unknown) => {
    const pageId = requirePage(input)
    assertControl(event.sender, pageId)
    const patch = normalizePanelPatch(input)
    if (!patch) throw new Error('DESKTOP_SHELL_INVALID_PATCH')
    return panels.set(pageId, patch)
  })
  ipcMain.handle(DESKTOP_SHELL_CHANNELS.reset, (event) => {
    assertShell(event.sender)
    return panels.reset()
  })
}
