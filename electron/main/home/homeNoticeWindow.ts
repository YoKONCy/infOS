/**
 * @file 右下角「家」通知窗口：确认请求（带按钮）与活动小提示共用一个小窗口。
 *
 * - 置顶、不抢焦点（focusable:false + showInactive），不出现在任务栏；用户不用切回 infOS。
 * - 页面通过 data: URL 加载，只能收到主进程整理好的文字，按钮动作回到主进程再核对。
 * - 没有通知时隐藏；高度跟随内容，位置贴主显示器工作区右下角。
 *
 * Windows 原生 toast 的按钮数量、二次核对界面都受限，所以用自己的小窗口实现。
 *
 * @platform ELECTRON
 * @see .docs/home/electron-integration.md 实时事件与设置页
 */

import path from 'node:path'
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron'
import { getLocale } from '../utils/i18n'
import { homeNoticePage } from './homeNoticePage'
import type { HomeNotice } from './homeNoticeView'

const WIDTH = 360
const MARGIN = 12
const MAX_HEIGHT = 640

export interface HomeNoticeAction {
  kind: 'choose' | 'back' | 'toggle' | 'undo' | 'open' | 'dismiss' | 'hover'
  id?: string
  choice?: string
  confirm?: boolean
  hovered?: boolean
}

export class HomeNoticeWindow {
  private win: BrowserWindow | null = null
  private ready = false
  private height = 0
  private registered = false

  constructor(
    private readonly notices: () => HomeNotice[],
    private readonly onAction: (action: HomeNoticeAction) => void,
  ) {}

  /** 通知内容变化后调用：有内容就显示（不抢焦点），没有就隐藏。 */
  refresh(): void {
    const notices = this.notices()
    if (!notices.length) {
      if (this.win && !this.win.isDestroyed()) this.win.hide()
      return
    }
    this.ensure()
    if (this.ready) this.win!.webContents.send('home-notice:state', { notices })
  }

  dispose(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.ready = false
  }

  private register(): void {
    if (this.registered) return
    this.registered = true
    ipcMain.on('home-notice:ready', (event) => {
      if (!this.trusted(event)) return
      this.ready = true
      this.refresh()
    })
    ipcMain.on('home-notice:resize', (event, height: unknown) => {
      if (!this.trusted(event) || typeof height !== 'number' || !Number.isFinite(height)) return
      this.height = Math.min(MAX_HEIGHT, Math.max(40, Math.ceil(height) + 12))
      this.place()
    })
    ipcMain.on('home-notice:action', (event, action: unknown) => {
      if (!this.trusted(event) || !action || typeof action !== 'object') return
      this.onAction(action as HomeNoticeAction)
    })
  }

  private trusted(event: IpcMainEvent): boolean {
    return !!this.win && !this.win.isDestroyed() && event.sender === this.win.webContents
  }

  private ensure(): void {
    this.register()
    if (this.win && !this.win.isDestroyed()) return
    const win = new BrowserWindow({
      width: WIDTH,
      height: 120,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/homeNotice.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.setVisibleOnAllWorkspaces(true)
    win.setMenu(null)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('render-process-gone', () => {
      if (this.win === win) this.dispose()
    })
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.ready = false
      }
    })
    this.win = win
    this.ready = false
    void win.loadURL(homeNoticePage(getLocale()))
  }

  private place(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const area = screen.getPrimaryDisplay().workArea
    const height = this.height || 120
    win.setBounds({
      x: area.x + area.width - WIDTH - MARGIN,
      y: area.y + area.height - height - MARGIN,
      width: WIDTH,
      height,
    })
    if (!win.isVisible()) win.showInactive()
  }
}
