import { app, BrowserWindow } from 'electron'
import { paths } from '../utils/env'
import { getPortableDaemonStatus } from './portableDaemon'

/** 只读取本应用窗口及渲染状态，不执行 Agent 提供的页面脚本。 */
export async function runtimeDiagnostics(signal: AbortSignal) {
  signal.throwIfAborted()
  const windows = await Promise.all(
    BrowserWindow.getAllWindows().map(async (window) => {
      const contents = window.webContents
      if (window.isDestroyed() || contents.isDestroyed()) return { id: window.id, destroyed: true }
      const info = {
        id: window.id,
        title: window.getTitle(),
        visible: window.isVisible(),
        bounds: window.getBounds(),
        crashed: contents.isCrashed(),
        url: contents.getURL().split('?')[0],
        rendererPid: contents.getOSProcessId(),
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const page = await Promise.race([
          contents.executeJavaScript(`({readyState: document.readyState,
        viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio},
        background: {html: getComputedStyle(document.documentElement).backgroundColor,
          body: document.body ? getComputedStyle(document.body).backgroundColor : null},
        canvasCount: document.querySelectorAll('canvas').length})`),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('DEBUG_RENDERER_TIMEOUT')), 1500)
          }),
        ])
        signal.throwIfAborted()
        return { ...info, page }
      } catch {
        return { ...info, page: null }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }),
  )
  const daemon = getPortableDaemonStatus()
  signal.throwIfAborted()
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    versions: process.versions,
    paths,
    windows,
    daemon: {
      ready: daemon.ready,
      running: daemon.running,
      logPath: daemon.logPath,
      error: daemon.error,
    },
  }
}
