import { t as __t } from '../utils/i18n'
import { BrowserWindow, type WebContents } from 'electron'
import path from 'node:path'
import type { DesktopToastAction, DesktopToastSnapshot } from '@infos/shared'
import { logger } from '../utils/logger'
import { guardTransparentWindowMaterial } from './windowConfig'

const emptySnapshot = (): DesktopToastSnapshot => ({
  revision: -1,
  theme: 'light',
  normal: [],
  tasks: [],
})

/** 子窗口覆盖原生应用视图；仅通知卡片接收点击，其他区域穿透回原窗口。 */
export class DesktopToastLayer {
  private host: BrowserWindow | null = null
  private hostContents: WebContents | null = null
  private overlay: BrowserWindow | null = null
  private overlayContents: WebContents | null = null
  private snapshot = emptySnapshot()
  private nativeVisible = false
  private ready = false
  private active = false
  private pointerOver = false
  private hoveredTasks = new Set<string>()
  private cleanup: Array<() => void> = []

  attach(host: BrowserWindow): void {
    if (host.isDestroyed()) return
    if (this.host === host) return
    this.dispose()
    this.host = host
    const contents = host.webContents
    this.hostContents = contents
    const listen = (event: string, handler: () => void) => {
      host.on(event as 'resize', handler)
      this.cleanup.push(() => host.removeListener(event as 'resize', handler))
    }
    for (const event of [
      'move',
      'resize',
      'show',
      'hide',
      'minimize',
      'restore',
      'focus',
      'blur',
      'enter-full-screen',
      'leave-full-screen',
    ])
      listen(event, () => this.sync())
    listen('closed', () => this.dispose())
    const reset = () => {
      this.snapshot = emptySnapshot()
      this.nativeVisible = false
      this.sync()
      const overlay = this.overlay
      this.overlay = null
      this.overlayContents = null
      this.ready = false
      if (overlay && !overlay.isDestroyed()) overlay.destroy()
    }
    contents.on('did-start-loading', reset)
    contents.on('render-process-gone', reset)
    this.cleanup.push(() => {
      // closed 回调中窗口原生对象已经销毁，解绑只使用提前保存的 EventEmitter。
      contents.removeListener('did-start-loading', reset)
      contents.removeListener('render-process-gone', reset)
    })
  }

  private assertHost(sender: WebContents): void {
    if (
      !this.host ||
      this.host.isDestroyed() ||
      this.hostContents !== sender ||
      sender.isDestroyed()
    )
      throw new Error('仅主窗口可以发布通知')
  }

  private assertOverlay(sender: WebContents): void {
    if (
      !this.overlay ||
      this.overlay.isDestroyed() ||
      this.overlayContents !== sender ||
      sender.isDestroyed()
    )
      throw new Error('仅通知层可以操作通知')
  }

  update(sender: WebContents, snapshot: DesktopToastSnapshot): void {
    this.assertHost(sender)
    if (
      !snapshot ||
      !Number.isSafeInteger(snapshot.revision) ||
      !Array.isArray(snapshot.normal) ||
      !Array.isArray(snapshot.tasks)
    )
      throw new Error('通知数据无效')
    if (snapshot.revision < this.snapshot.revision) return
    this.snapshot = snapshot
    this.push()
    this.sync()
  }

  state(sender: WebContents): DesktopToastSnapshot {
    this.assertOverlay(sender)
    return this.snapshot
  }

  setNativeVisible(visible: boolean): void {
    this.nativeVisible = visible
    this.sync()
  }

  pointer(sender: WebContents, over: boolean): void {
    this.assertOverlay(sender)
    this.setPointer(over === true && this.active)
  }

  action(sender: WebContents, action: DesktopToastAction): void {
    this.assertOverlay(sender)
    if (!action || !this.host || this.host.isDestroyed()) return
    if (action.kind === 'normal' && !this.snapshot.normal.some((toast) => toast.id === action.id))
      return
    if (
      (action.kind === 'task' || action.kind === 'hover') &&
      !this.snapshot.tasks.some((toast) => toast.id === action.id)
    )
      return
    if (!['normal', 'task', 'hover'].includes(action.kind)) return
    if (action.kind === 'hover') {
      if (action.hovered) this.hoveredTasks.add(action.id)
      else this.hoveredTasks.delete(action.id)
    }
    this.sendHost('desktop-toasts:action', action)
  }

  private setPointer(over: boolean): void {
    if (!this.overlay || this.overlay.isDestroyed() || this.pointerOver === over) return
    this.pointerOver = over
    this.overlay.setIgnoreMouseEvents(!over, { forward: true })
  }

  private create(): void {
    const host = this.host
    if (!host || host.isDestroyed() || this.overlay) return
    const overlay = new BrowserWindow({
      parent: host,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        additionalArguments: ['--infos-toast-overlay'],
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    this.overlay = overlay
    guardTransparentWindowMaterial(overlay)
    const contents = overlay.webContents
    this.overlayContents = contents
    this.ready = false
    this.pointerOver = false
    overlay.setIgnoreMouseEvents(true, { forward: true })
    overlay.setMenu(null)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('did-finish-load', () => {
      if (this.overlay !== overlay || overlay.isDestroyed() || contents.isDestroyed()) return
      this.ready = true
      this.push()
      this.sync()
    })
    contents.on('render-process-gone', () => {
      if (this.overlay !== overlay) return
      this.ready = false
      this.sync()
      this.overlay = null
      this.overlayContents = null
      if (!overlay.isDestroyed()) overlay.destroy()
    })
    overlay.on('closed', () => {
      if (this.overlay !== overlay) return
      this.ready = false
      this.setActive(false)
      this.overlay = null
      this.overlayContents = null
    })
    const url = new URL(this.hostContents!.getURL())
    url.hash = '/notification-overlay'
    void overlay.loadURL(url.href).catch((error) => {
      logger.warn(
        'DesktopToasts',
        __t('electron.logs.windows', '通知层加载失败：{0}', [String(error)]),
      )
      if (this.overlay === overlay) {
        this.ready = false
        this.setActive(false)
        this.overlay = null
        this.overlayContents = null
      }
      if (!overlay.isDestroyed()) overlay.destroy()
    })
  }

  private push(): void {
    if (this.ready && this.overlay && !this.overlay.isDestroyed())
      this.sendOverlay('desktop-toasts:changed', this.snapshot)
  }

  private sendHost(channel: string, value: unknown): void {
    if (
      this.host &&
      !this.host.isDestroyed() &&
      this.hostContents &&
      !this.hostContents.isDestroyed()
    )
      this.hostContents.send(channel, value)
  }

  private sendOverlay(channel: string, value: unknown): void {
    if (
      this.overlay &&
      !this.overlay.isDestroyed() &&
      this.overlayContents &&
      !this.overlayContents.isDestroyed()
    )
      this.overlayContents.send(channel, value)
  }

  private setActive(active: boolean): void {
    if (!active) {
      this.setPointer(false)
      if (this.host && !this.host.isDestroyed())
        for (const id of this.hoveredTasks)
          this.sendHost('desktop-toasts:action', { kind: 'hover', id, hovered: false })
      this.hoveredTasks.clear()
    }
    if (this.active === active) return
    this.active = active
    if (this.ready && this.overlay && !this.overlay.isDestroyed())
      this.sendOverlay('desktop-toasts:active', active)
    if (this.host && !this.host.isDestroyed()) this.sendHost('desktop-toasts:visibility', active)
  }

  private sync(): void {
    const host = this.host
    if (!host || host.isDestroyed() || !this.hostContents || this.hostContents.isDestroyed()) return
    const shouldShow =
      this.nativeVisible &&
      (this.snapshot.normal.length > 0 || this.snapshot.tasks.length > 0) &&
      host.isVisible() &&
      !host.isMinimized() &&
      host.isFocused()
    if (shouldShow && !this.overlay) {
      try {
        this.create()
      } catch (error) {
        logger.warn(
          'DesktopToasts',
          __t('electron.logs.windows', '通知层创建失败：{0}', [String(error)]),
        )
        this.setActive(false)
        return
      }
    }
    const overlay = this.overlay
    if (
      !overlay ||
      overlay.isDestroyed() ||
      !this.overlayContents ||
      this.overlayContents.isDestroyed()
    ) {
      this.setActive(false)
      return
    }
    if (shouldShow && this.ready) {
      overlay.setBounds(host.getContentBounds())
      const zoom = this.hostContents.getZoomFactor()
      if (this.overlayContents.getZoomFactor() !== zoom) this.overlayContents.setZoomFactor(zoom)
      if (!overlay.isVisible()) overlay.showInactive()
      this.setActive(true)
    } else {
      this.setActive(false)
      if (overlay.isVisible()) overlay.hide()
    }
  }

  private dispose(): void {
    this.setActive(false)
    for (const cleanup of this.cleanup.splice(0)) cleanup()
    const overlay = this.overlay
    this.overlay = null
    this.overlayContents = null
    if (overlay && !overlay.isDestroyed()) overlay.destroy()
    this.host = null
    this.hostContents = null
    this.snapshot = emptySnapshot()
    this.nativeVisible = false
    this.ready = false
    this.pointerOver = false
  }
}

export const desktopToasts = new DesktopToastLayer()
