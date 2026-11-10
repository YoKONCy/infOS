/**
 * @file 耳朵的录音窗口：隐藏的 BrowserWindow + 独立内存 session，用 Electron 自带的系统回环录电脑放出的声音。
 *
 * - 只给这个 session 设 setDisplayMediaRequestHandler，回调里给 `audio: 'loopback'`（整机声音），
 *   不弹系统选择器；不请求麦克风，其他权限一律拒绝。
 * - 窗口：sandbox、contextIsolation、禁止 Node；页面是 `infos-ears://capture/` 空白页；拒绝导航与新窗口；
 *   session 走不可达代理，不能联网。唯一 preload 是 `preload/earsCapture.js`。
 * - 只接受这个窗口发来的音频块。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 耳朵
 */

import { t as __t } from '../../utils/i18n'
import path from 'node:path'
import { BrowserWindow, desktopCapturer, ipcMain, session, type IpcMainEvent } from 'electron'
import { DESKTOP_CARD_PROXY } from '../../windows/desktopCardWindow'

const PARTITION = 'infos-ears-capture'
/** 录音页的协议（在 index.ts 里注册为安全来源，getDisplayMedia 需要安全上下文）。 */
export const EARS_SCHEME = 'infos-ears'
const PAGE = `${EARS_SCHEME}://capture/`

export interface CaptureCallbacks {
  ready?: () => void
  chunk: (samples: Float32Array, at: number) => void
  /** 录音结束或失败（error 为错误码开头的说明）。 */
  ended: (error?: string) => void
}

let configured = false
function captureSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION)
  if (configured) return ses
  configured = true
  ses.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === 'display-capture'),
  )
  ses.setPermissionCheckHandler((_contents, permission) => permission === 'display-capture')
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith(PAGE) }),
  )
  // 空白页：不含任何脚本，CSP 禁止一切加载；逻辑全在 preload 里。
  ses.protocol.handle(
    EARS_SCHEME,
    () =>
      new Response('<!doctype html><meta charset="utf-8"><title>infOS ears</title>', {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'",
          'Cache-Control': 'no-store',
        },
      }),
  )
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // 声音只能随一路画面一起给出；画面在页面里拿到后立刻停止。
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) =>
          sources[0] ? callback({ video: sources[0], audio: 'loopback' }) : callback({}),
        )
        .catch(() => callback({}))
    },
    { useSystemPicker: false },
  )
  void ses.setProxy(DESKTOP_CARD_PROXY).catch(() => undefined)
  return ses
}

export class EarsCapture {
  private win?: BrowserWindow
  private callbacks?: CaptureCallbacks
  private readonly onChunk = (event: IpcMainEvent, payload: unknown) => {
    if (!this.win || event.sender !== this.win.webContents) return
    const data = payload as { samples?: unknown; at?: unknown }
    if (!(data?.samples instanceof Float32Array) || typeof data.at !== 'number') return
    this.callbacks?.chunk(data.samples, data.at)
  }
  private readonly onState = (event: IpcMainEvent, payload: unknown) => {
    if (!this.win || event.sender !== this.win.webContents) return
    const data = payload as { state?: string; error?: string }
    if (data?.state === 'loaded') this.win.webContents.send('ears-capture:start')
    else if (data?.state === 'failed') this.finish(data.error ?? 'EARS_CAPTURE_FAILED')
    else if (data?.state === 'ended')
      this.finish(`EARS_CAPTURE_ENDED: ${__t('electron.ui.desktopControl', '系统声音采集已结束')}`)
  }

  get running(): boolean {
    return !!this.win
  }

  /** 内容进程：判断「infOS 自己在出声」时要排除它。 */
  get contents(): Electron.WebContents | undefined {
    return this.win?.webContents
  }

  start(callbacks: CaptureCallbacks): void {
    if (this.win) return
    this.callbacks = callbacks
    ipcMain.on('ears-capture:chunk', this.onChunk)
    ipcMain.on('ears-capture:state', this.onState)
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      skipTaskbar: true,
      webPreferences: {
        session: captureSession(),
        preload: path.join(__dirname, '../preload/earsCapture.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        devTools: false,
      },
    })
    this.win = win
    const contents = win.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('render-process-gone', () =>
      this.finish(`EARS_CAPTURE_CRASHED: ${__t('electron.ui.desktopControl', '录音页崩溃')}`),
    )
    win.on('closed', () => {
      if (this.win === win) this.finish()
    })
    void win
      .loadURL(PAGE)
      .catch(() =>
        this.finish(`EARS_CAPTURE_FAILED: ${__t('electron.ui.desktopControl', '录音页加载失败')}`),
      )
  }

  stop(): void {
    this.finish()
  }

  private finish(error?: string): void {
    const win = this.win
    const callbacks = this.callbacks
    this.win = undefined
    this.callbacks = undefined
    ipcMain.removeListener('ears-capture:chunk', this.onChunk)
    ipcMain.removeListener('ears-capture:state', this.onState)
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('ears-capture:stop')
      } catch {
        // 页面已不可用时直接关窗。
      }
      win.destroy()
    }
    callbacks?.ended(error)
  }
}
