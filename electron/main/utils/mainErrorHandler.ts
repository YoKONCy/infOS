import { BrowserWindow, dialog } from 'electron'
import { logger } from './logger'
import { t as __t } from './i18n'

let reporting = false

/** 逐个隔离窗口关闭与 IPC 发送竞态，不让错误通知制造第二个异常。 */
export function notifyRendererError(title: string, message: string): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed())
          win.webContents.send('system-error', { title, message })
      } catch {
        /* 一个窗口不可用时仍尝试通知其余窗口。 */
      }
    }
  } catch {
    /* Electron 退出阶段可能已无法枚举窗口。 */
  }
}

function details(reason: unknown): { message: string; stack: string } {
  try {
    return reason instanceof Error
      ? {
          message: String(reason.message).slice(0, 8000),
          stack: String(reason.stack ?? '').slice(0, 64_000),
        }
      : { message: String(reason).slice(0, 8000), stack: '' }
  } catch {
    return { message: 'UNKNOWN_MAIN_ERROR', stack: '' }
  }
}

/** 原始异常先同步记录；日志、翻译、窗口通知与弹窗各自隔离故障。 */
export function reportMainError(kind: 'exception' | 'rejection', reason: unknown): void {
  if (reporting) return
  reporting = true
  try {
    const error = details(reason)
    const code = kind === 'exception' ? 'UNCAUGHT_EXCEPTION' : 'UNHANDLED_REJECTION'
    let diagnostic = `${code}: ${error.message}\n${error.stack}`
    try {
      diagnostic =
        kind === 'exception'
          ? __t('electron.logs.index.ts', '未捕获的异常: {0}\n{1}', [error.message, error.stack])
          : __t('electron.logs.index.ts', '未处理的 Promise 拒绝: {0}\n{1}', [
              error.message,
              error.stack,
            ])
    } catch {
      /* 翻译不可用时保留稳定错误码与原始诊断。 */
    }
    try {
      logger.critical('Main', diagnostic)
    } catch {
      /* 异常通道不回退到普通日志器。 */
    }
    try {
      const title = __t(
        'electron.ui.index.ts',
        kind === 'exception' ? '桌面应用异常' : '桌面服务异常',
      )
      notifyRendererError(title, error.message)
      if (kind === 'exception') {
        try {
          dialog.showErrorBox(title, diagnostic)
        } catch {
          /* 无法展示时保留已记录的原始诊断。 */
        }
      }
    } catch {
      /* 展示故障不能抛回全局异常处理器。 */
    }
  } finally {
    reporting = false
  }
}
