import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { onLocaleChange } from '../../../packages/shared/src/i18n'
import { getLocale, t } from '../utils/i18n'
import { paths } from '../utils/env'
import { APPLICATION_NAME, applyWindowIdentity } from '../utils/appIdentity'
import { loadSystemIcon } from '../utils/appIcon'
import { logger } from '../utils/logger'
import { isPackagedRuntime } from '../utils/runtimeMode'
import { guardTransparentWindowMaterial } from './windowConfig'
import { clientConnection, type ConnectionInput } from '../services/clientConnection'
import type {
  StartupFailureKind,
  StartupPhase,
  StartupSplashState,
  StartupConnectionView,
} from '../../shared/startupSplash'

interface SplashActions {
  retry: () => void
  quit: () => void
}

/** 独立本地开屏，后端、Vue 路由和通用预加载脚本均不参与其显示。 */
export class StartupSplash {
  private win: BrowserWindow | null = null
  private phase: StartupPhase = 'opening'
  private failure: StartupFailureKind = 'shell'
  private revision = 0
  private painted = false
  private disposed = false
  private openPromise: Promise<void> | null = null
  private resolveOpen: (() => void) | undefined
  private rejectOpen: ((error: Error) => void) | undefined
  private openTimer: ReturnType<typeof setTimeout> | undefined
  private nativeFailureVisible = false
  private nativeDialogController: AbortController | undefined
  private connection: StartupConnectionView | null = null
  private connectionError = ''
  private connectionSequence = 0
  private selection: {
    activate: boolean
    controller: AbortController
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
  } | null = null
  private readonly stopLocale: () => void

  constructor(private readonly actions: SplashActions) {
    ipcMain.handle('startup-splash:state', (event) => {
      if (!this.trusted(event)) throw new Error('untrusted-startup-splash')
      return this.snapshot()
    })
    ipcMain.on('startup-splash:painted', this.onPainted)
    ipcMain.on('startup-splash:render-failed', this.onRenderFailed)
    ipcMain.on('startup-splash:action', this.onAction)
    ipcMain.handle('startup-splash:save-connection', this.saveConnection)
    this.stopLocale = onLocaleChange(() => this.publish())
  }

  private trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return (
      !!this.win &&
      !this.win.isDestroyed() &&
      event.sender === this.win.webContents &&
      event.senderFrame === this.win.webContents.mainFrame
    )
  }

  private snapshot(): StartupSplashState {
    const scope = 'electron.ui.startupSplash'
    const messages = {
      backend: '后端尚未就绪。可以重试，或查看启动日志。',
      launcher: '启动器页面未能就绪。请重试或查看日志。',
      shell: '桌面启动未能完成。请重试或查看日志。',
    } as const
    return {
      revision: this.revision,
      phase: this.phase,
      language: getLocale(),
      connection: this.connection
        ? {
            ...this.connection,
            error: this.connectionError ? t(scope, this.connectionError) : '',
          }
        : null,
      connectionLabels: Object.fromEntries(
        [
          '选择运行方式',
          '本机运行，或连接已有的 infOS 服务。',
          '本地运行',
          '连接服务器',
          '在这台设备启动服务端',
          '只启动客户端与本机能力',
          '服务器地址',
          '访问令牌',
          '能力通道地址',
          '留空时使用服务器同域的 9121 端口',
          '高级连接选项',
          '启动本地服务',
          '验证并连接',
          '保存并重启',
          '取消',
          '正在验证连接…',
          '正在保存…',
          '显示令牌',
          '隐藏令牌',
          '连接设置保存在本机，原有存档保持不变。',
          '修改将在客户端重启后生效。',
          '连接失败，请检查地址、令牌和网络。',
        ].map((source) => [source, t(scope, source)]),
      ),
      labels: {
        brandCaption: t(scope, '萌动链接：PeroperoChat'),
        loading: t(scope, '正在启动 infOS'),
        title: t(scope, '启动遇到问题'),
        message: t(scope, messages[this.failure]),
        retry: t(scope, '重试'),
        logs: t(scope, '查看日志'),
        quit: t(scope, '退出'),
        close: t(scope, this.selection && !this.selection.activate ? '取消' : '关闭'),
      },
    }
  }

  private publish(): void {
    this.revision++
    if (this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()) {
      try {
        this.win.webContents.send('startup-splash:changed', this.snapshot())
      } catch {
        this.painted = false
      }
    }
  }

  setPhase(phase: StartupPhase): void {
    const changedLayout = (this.phase === 'connection') !== (phase === 'connection')
    this.phase = phase
    if (changedLayout && this.win && !this.win.isDestroyed()) {
      this.win.setBounds(this.windowBounds())
    }
    this.publish()
  }

  /** 配置保留 Pero 的纵向空间，加载使用佩诺菈的横幅比例；始终复用当前窗口。 */
  private windowBounds(): Electron.Rectangle {
    const current = this.win && !this.win.isDestroyed() ? this.win.getBounds() : null
    const point = current
      ? {
          x: Math.round(current.x + current.width / 2),
          y: Math.round(current.y + current.height / 2),
        }
      : screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(point).workArea
    const aspect = this.phase === 'connection' ? 1569 / 1080 : 1920 / 1080
    const width = Math.round(Math.min(1040, area.width * 0.84, area.height * 0.84 * aspect))
    const height = Math.round(width / aspect)
    return {
      width,
      height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
    }
  }

  /** 连接选择与加载进度在同一张开屏中切换；保存前不会放行启动链。 */
  selectConnection(activate = true, error = ''): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('startup-splash-disposed'))
    if (this.selection) {
      this.focus()
      return this.selection.promise
    }
    const profile = clientConnection().current
    let resolve!: () => void
    let reject!: (reason: Error) => void
    const promise = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })
    this.selection = { activate, controller: new AbortController(), promise, resolve, reject }
    this.connection = {
      id: ++this.connectionSequence,
      mode: profile?.mode ?? 'local',
      origin: profile?.origin ?? '',
      capabilityEndpoint: profile?.capabilityEndpoint ?? '',
      busy: false,
      error: '',
      restartRequired: !activate,
    }
    this.connectionError = error
    this.setPhase('connection')
    void this.open().catch((reason: unknown) => {
      this.cancelSelection(reason instanceof Error ? reason : new Error(String(reason)))
    })
    return promise
  }

  focusConnection(): boolean {
    if (!this.selection) return false
    this.focus()
    return true
  }

  private cancelSelection(error = new Error('CONNECTION_CANCELLED')): void {
    const selection = this.selection
    if (!selection) return
    this.selection = null
    this.connection = null
    this.connectionError = ''
    selection.controller.abort()
    selection.reject(error)
    if (!selection.activate) this.hide()
  }

  private readonly saveConnection = async (
    event: Electron.IpcMainInvokeEvent,
    input: ConnectionInput,
  ): Promise<{ ok: boolean }> => {
    const selection = this.selection
    if (!this.trusted(event) || !selection || this.connection?.busy) return { ok: false }
    this.connection!.busy = true
    this.connectionError = ''
    this.publish()
    try {
      await clientConnection().save(input, selection.activate, selection.controller.signal)
      if (selection !== this.selection || selection.controller.signal.aborted) return { ok: false }
      this.selection = null
      this.connection = null
      this.setPhase('opening')
      selection.resolve()
      if (!selection.activate) this.hide()
      return { ok: true }
    } catch (error) {
      if (selection !== this.selection) return { ok: false }
      this.connectionError =
        error instanceof Error && error.message === 'CONNECTION_ENCRYPTION_UNAVAILABLE'
          ? '无法安全保存凭据，请检查系统密钥服务。'
          : '连接失败，请检查地址、令牌和网络。'
      return { ok: false }
    } finally {
      if (selection === this.selection && this.connection) {
        this.connection.busy = false
        this.publish()
      }
    }
  }

  /** 业务页面就绪后回收开屏渲染器，保留同一宿主供设置入口再次使用。 */
  hide(): void {
    this.win?.destroy()
    this.win = null
    this.painted = false
  }

  focus(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      if (this.painted) this.win.show()
      this.win.focus()
    }
  }

  open(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('startup-splash-disposed'))
    if (this.painted && this.win && !this.win.isDestroyed()) {
      this.focus()
      return Promise.resolve()
    }
    if (this.openPromise) return this.openPromise
    this.win?.destroy()
    this.win = null
    const bounds = this.windowBounds()
    const win = new BrowserWindow({
      title: APPLICATION_NAME,
      icon: loadSystemIcon(256),
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/startupSplash.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    this.win = win
    guardTransparentWindowMaterial(win)
    applyWindowIdentity(win)
    win.setMenu(null)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.on('close', (event) => {
      if (!this.disposed) {
        event.preventDefault()
        if (this.selection && !this.selection.activate) this.cancelSelection()
        else this.actions.quit()
      }
    })
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.painted = false
      }
      this.rejectOpen?.(new Error('startup-splash-closed'))
      this.cancelSelection(new Error('CONNECTION_CANCELLED'))
    })
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve
      this.rejectOpen = reject
      this.openTimer = setTimeout(() => reject(new Error('startup-splash-paint-timeout')), 10_000)
      this.openTimer.unref()
    }).finally(() => {
      clearTimeout(this.openTimer)
      this.resolveOpen = undefined
      this.rejectOpen = undefined
      this.openPromise = null
    })
    win.webContents.on('render-process-gone', () => {
      this.painted = false
      if (this.selection) {
        this.cancelSelection(new Error('startup-splash-renderer-gone'))
        return
      }
      if (this.rejectOpen) this.rejectOpen(new Error('startup-splash-renderer-gone'))
      else if (!this.disposed) this.showNativeFailure()
    })
    const entry = isPackagedRuntime
      ? path.join(process.resourcesPath, 'splash', 'index.html')
      : path.join(app.getAppPath(), 'electron/splash/index.html')
    void win
      .loadFile(entry)
      .catch((error: unknown) =>
        this.rejectOpen?.(error instanceof Error ? error : new Error(String(error))),
      )
    return this.openPromise
  }

  private readonly onPainted = (event: Electron.IpcMainEvent): void => {
    if (!this.trusted(event) || this.disposed) return
    this.painted = true
    this.win!.show()
    this.resolveOpen?.()
    this.publish()
  }

  private readonly onRenderFailed = (event: Electron.IpcMainEvent): void => {
    if (this.trusted(event)) this.rejectOpen?.(new Error('startup-splash-artwork-failed'))
  }

  private readonly onAction = (event: Electron.IpcMainEvent, action: unknown): void => {
    if (!this.trusted(event) || this.disposed) return
    if (action === 'cancel-connection' && this.selection && !this.selection.activate)
      this.cancelSelection()
    else if (action === 'quit') {
      if (this.selection && !this.selection.activate) this.cancelSelection()
      else this.actions.quit()
    } else if (action === 'retry' && this.phase === 'failed') this.actions.retry()
    else if (action === 'logs' && this.phase === 'failed') void this.openLogs()
  }

  fail(kind: StartupFailureKind, error: unknown): void {
    if (this.disposed) return
    this.failure = kind
    this.phase = 'failed'
    logger.error(
      'StartupSplash',
      t('electron.logs.startupSplash', '启动过渡失败（{0}）：{1}', [
        kind,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      ]),
    )
    this.publish()
    if (!this.painted || !this.win || this.win.isDestroyed()) this.showNativeFailure()
  }

  /** 开屏自身损坏时也有原生重试与退出入口，不能留下看不见的常驻进程。 */
  private showNativeFailure(): void {
    if (this.nativeFailureVisible || this.disposed) return
    this.nativeFailureVisible = true
    const controller = new AbortController()
    this.nativeDialogController = controller
    const state = this.snapshot()
    void dialog
      .showMessageBox({
        type: 'error',
        title: APPLICATION_NAME,
        message: t('electron.ui.startupSplash', '开屏资源加载失败'),
        detail: t('electron.ui.startupSplash', '无法显示开屏资源。请重试或退出应用。'),
        buttons: [state.labels.retry, state.labels.quit],
        defaultId: 0,
        cancelId: 1,
        signal: controller.signal,
      })
      .then(({ response }) => {
        if (this.disposed || controller.signal.aborted) return
        if (response === 0) this.actions.retry()
        else this.actions.quit()
      })
      .catch((error: unknown) => {
        if (!this.disposed) {
          logger.error(
            'StartupSplash',
            t('electron.logs.startupSplash', '启动过渡失败（{0}）：{1}', ['dialog', String(error)]),
          )
          this.actions.quit()
        }
      })
      .finally(() => {
        this.nativeFailureVisible = false
        if (this.nativeDialogController === controller) this.nativeDialogController = undefined
      })
  }

  private async openLogs(): Promise<void> {
    try {
      const file = path.join(paths.logs, 'daemon-bootstrap.log')
      const target = fs.existsSync(file) ? file : paths.logs
      if (!fs.existsSync(target)) throw new Error('startup-log-unavailable')
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    } catch {
      if (!this.disposed)
        await dialog
          .showMessageBox({
            type: 'info',
            title: APPLICATION_NAME,
            message: t('electron.ui.startupSplash', '启动日志尚未生成，请稍后再试。'),
          })
          .catch(() => {
            /* 日志入口失败不再触发全局错误弹窗。 */
          })
    }
  }

  finish(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('startup-aborted'))
        return
      }
      if (
        !this.painted ||
        !this.win ||
        this.win.isDestroyed() ||
        this.win.webContents.isCrashed()
      ) {
        reject(new Error('startup-splash-lost'))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('startup-aborted'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, 180)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.nativeDialogController?.abort()
    this.cancelSelection(new Error('startup-splash-disposed'))
    this.rejectOpen?.(new Error('startup-splash-disposed'))
    clearTimeout(this.openTimer)
    this.stopLocale()
    ipcMain.removeHandler('startup-splash:state')
    ipcMain.removeHandler('startup-splash:save-connection')
    ipcMain.off('startup-splash:painted', this.onPainted)
    ipcMain.off('startup-splash:render-failed', this.onRenderFailed)
    ipcMain.off('startup-splash:action', this.onAction)
    this.win?.destroy()
    this.win = null
  }
}
