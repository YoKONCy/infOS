/**
 * @file 「她在操作」标记：她操作别的程序时，屏幕顶部居中显示一条醒目的小条，带一键停止。
 *
 * - 置顶、不抢焦点、不进任务栏；setContentProtection 让它不出现在截图里，不干扰她看屏幕。
 * - 「停止」等同停止快捷键：完全停止（输入与盯窗口、耳朵、陪看一起停），要用户手动继续。
 * - 按 300ms 读取桌面控制状态，不改动 desktopControl 的推送逻辑。
 *
 * @platform ELECTRON
 */

import path from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { t as __t, getLocale } from '../utils/i18n'
import { desktopControl } from '../services/desktopControl'
import { OperatingIndicator, type OperatingView } from './homeOperating'

const WIDTH = 420
const HEIGHT = 44
const ui = (text: string, args?: unknown[]) => __t('electron.ui.home', text, args)

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;background:transparent;overflow:hidden;font:13px/1.2 "Segoe UI","Microsoft YaHei UI",sans-serif;user-select:none}
#bar{display:flex;align-items:center;gap:10px;height:36px;margin:4px;padding:0 8px 0 14px;border-radius:18px;background:#d9472b;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3)}
#dot{width:8px;height:8px;border-radius:50%;background:#fff;animation:p 1s infinite alternate}
@keyframes p{from{opacity:.35}to{opacity:1}}
#text{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
button{font:inherit;border:0;border-radius:14px;padding:5px 12px;background:#fff;color:#b3321b;font-weight:700;cursor:pointer}
</style></head><body><div id="bar"><span id="dot"></span><span id="text"></span><button id="stop"></button></div>
<script>
window.homeNotice.onState(function(s){document.getElementById('text').textContent=s.text||'';document.getElementById('stop').textContent=s.stop||'';document.getElementById('stop').title=s.hint||''});
document.getElementById('stop').onclick=function(){window.homeNotice.action({kind:'stop'})};
window.homeNotice.ready();
</script></body></html>`

class HomeOperatingBar {
  private win: BrowserWindow | null = null
  private ready = false
  private timer?: ReturnType<typeof setInterval>
  private readonly indicator = new OperatingIndicator()
  private view: OperatingView = { visible: false, shortcut: '' }
  private registered = false

  start(): void {
    if (this.timer) return
    this.register()
    this.timer = setInterval(() => this.tick(), 300)
    this.timer.unref?.()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.ready = false
  }

  private tick(): void {
    const next = this.indicator.update(desktopControl.snapshot(), Date.now())
    const changed = next.visible !== this.view.visible || next.target !== this.view.target
    this.view = next
    if (!next.visible) {
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide()
      return
    }
    this.ensure()
    if (changed) this.push()
    if (this.win && !this.win.isVisible() && this.ready) this.win.showInactive()
  }

  private push(): void {
    if (!this.win || this.win.isDestroyed() || !this.ready) return
    this.win.webContents.send('home-notice:state', {
      text: this.view.target
        ? ui('她正在操作「{0}」', [this.view.target])
        : ui('她正在操作你的电脑'),
      stop: ui('停止'),
      hint: ui('也可以按 {0}', [this.view.shortcut]),
    })
  }

  private register(): void {
    if (this.registered) return
    this.registered = true
    const trusted = (sender: Electron.WebContents) =>
      !!this.win && !this.win.isDestroyed() && sender === this.win.webContents
    // 与通知窗口共用同一个受限预加载；按发送方区分，只认这个小条自己的消息。
    ipcMain.on('home-notice:ready', (event) => {
      if (!trusted(event.sender)) return
      this.ready = true
      this.push()
      if (this.view.visible) this.win!.showInactive()
    })
    ipcMain.on('home-notice:action', (event, action: unknown) => {
      if (!trusted(event.sender) || (action as { kind?: unknown })?.kind !== 'stop') return
      // 与停止快捷键相同：完全停止，观察一起停。
      desktopControl.pause('你已停止桌面操作')
      this.view = { visible: false, shortcut: this.view.shortcut }
      this.win?.hide()
    })
  }

  private ensure(): void {
    if (this.win && !this.win.isDestroyed()) return
    const area = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: area.y + 6,
      width: WIDTH,
      height: HEIGHT,
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
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true)
    // 不出现在截图里：她看屏幕时不会把这条标记当成界面内容。
    win.setContentProtection(true)
    win.setMenu(null)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.ready = false
      }
    })
    this.win = win
    this.ready = false
    void win.loadURL(
      `data:text/html;charset=utf-8;base64,${Buffer.from(
        PAGE.replace('<html>', `<html lang="${getLocale().replace(/[^a-zA-Z-]/g, '')}">`),
      ).toString('base64')}`,
    )
  }
}

export const homeOperatingBar = new HomeOperatingBar()
