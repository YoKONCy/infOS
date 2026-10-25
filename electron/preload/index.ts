/**
 * @file Electron Preload 脚本
 * @description 通过 contextBridge 向渲染进程安全暴露最小化的 IPC 接口
 *              遵循 07_DUAL_DEPLOYMENT.md — contextIsolation: true
 *
 *              暴露的 API 挂载在 window.electron 上:
 *              - invoke(channel, ...args)  → 请求/响应式
 *              - send(channel, ...args)    → 单向消息
 *              - on(channel, listener)     → 监听主进程推送，返回注销函数
 *
 * @platform ELECTRON
 * @module electron/preload
 */

import { contextBridge, ipcRenderer } from 'electron'
import { createEmbeddedSurfaceMotion } from './surfaceMotion'
import { installDesktopEntry } from './desktopEntry'

const embedded = process.argv.includes('--infos-embedded-app')
const toastOverlay = process.argv.includes('--infos-toast-overlay')
if (!embedded && !toastOverlay) installDesktopEntry()
const toastInvokes = new Set(['desktop-toasts:get-state', 'i18n:get-language'])
const toastEvents = new Set(['desktop-toasts:changed', 'desktop-toasts:active', 'i18n:changed'])
const applicationInvokes = new Set([
  'i18n:get-language',
  'desktop-tabs:get-theme',
  'window-close',
  'arca-host:control',
  'arca-host:request',
  'pictoria:request',
])
const applicationEvents = new Set(['desktop-shell:theme-changed', 'i18n:changed'])

if (embedded) {
  const motion = createEmbeddedSurfaceMotion()
  ipcRenderer.on('desktop-shell:surface-activated', (_event, level: unknown) => motion.enter(level))
  ipcRenderer.on('desktop-shell:motion-changed', (_event, level: unknown) => {
    if (level === 'off' || level === 'reduced') motion.cancel()
  })
  window.addEventListener('pagehide', motion.cancel)
}

contextBridge.exposeInMainWorld('electron', {
  embedded,
  toastOverlay,
  /** 只有主应用页面可取安装实例凭据，子应用和通知层不开放。 */
  clientCredential: () =>
    embedded || toastOverlay ? '' : ipcRenderer.sendSync('client-access:credential'),
  backendOrigin: () =>
    embedded || toastOverlay ? '' : ipcRenderer.sendSync('client-access:credential', 'origin'),
  connectionMode: () =>
    embedded || toastOverlay ? '' : ipcRenderer.sendSync('client-access:credential', 'mode'),
  /**
   * 调用主进程 (请求/响应式 IPC)
   * 对应 ipcMain.handle()
   */
  invoke: (channel: string, ...args: unknown[]) => {
    if (toastOverlay && !toastInvokes.has(channel))
      return Promise.reject(new Error('通知层无权调用此系统接口'))
    if (embedded && !applicationInvokes.has(channel)) {
      return Promise.reject(new Error('该应用无权调用此系统接口'))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  /**
   * 向主进程发送单向消息 (fire-and-forget)
   * 对应 ipcMain.on()
   */
  send: (channel: string, ...args: unknown[]) => {
    if (toastOverlay && channel !== 'desktop-toasts:pointer' && channel !== 'desktop-toasts:action')
      return
    if (
      !embedded ||
      channel === 'desktop-tabs:unsaved-changes' ||
      channel === 'desktop-tabs:surface-state'
    )
      ipcRenderer.send(channel, ...args)
  },

  /**
   * 监听主进程推送的事件
   * 返回注销函数，调用即可取消监听
   */
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (toastOverlay && !toastEvents.has(channel)) return () => {}
    if (embedded && !applicationEvents.has(channel)) return () => {}
    // 包装 listener，去掉 Electron event 对象，只传 payload
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    // 返回注销函数
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
})
