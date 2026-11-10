import { t as __t } from '../utils/i18n'
import { logger } from '../utils/logger'
import { windowsDesktop } from './windowsDesktop'

interface NutWindow {
  title: Promise<string> | string
  focus(): Promise<void>
}

interface NutModule {
  getWindows(): Promise<NutWindow[]>
  mouse: {
    getPosition(): Promise<{ x: number; y: number }>
  }
}

let runtimePromise: Promise<NutModule> | undefined

function loadRuntime(): Promise<NutModule> {
  if (!runtimePromise) {
    // 使用静态包名，让打包器识别主进程运行依赖；首次操作时才加载原生组件。
    runtimePromise = import('@nut-tree-fork/nut-js')
      .then((module) => {
        logger.info(
          'DesktopAutomation',
          __t('electron.logs.desktopAutomation', '桌面自动化组件已在 Electron 能力进程加载'),
        )
        return module as unknown as NutModule
      })
      .catch((error: unknown) => {
        runtimePromise = undefined
        throw new Error(
          `DESKTOP_AUTOMATION_UNAVAILABLE: 桌面自动化组件加载失败：${String(error)}`,
          {
            cause: error,
          },
        )
      })
  }
  return runtimePromise
}

export async function listWindows(): Promise<
  Array<{ processName: string; title: string; windowId?: string; pid?: number }>
> {
  if (process.platform === 'win32') return windowsDesktop.windows()
  const nut = await loadRuntime()
  const result: Array<{ processName: string; title: string }> = []
  for (const window of await nut.getWindows()) {
    try {
      const title = await window.title
      if (title) result.push({ processName: String(title), title: String(title) })
    } catch {
      //窗口可能在枚举后立即销毁，忽略该项。
    }
  }
  return result
}

export async function activateWindow(target: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (!target.trim()) throw new Error('WINDOW_TARGET_REQUIRED: 请指定目标窗口')
  if (process.platform === 'win32') {
    const windows = await windowsDesktop.windows()
    const exact = windows.filter((window) => window.windowId === target || window.title === target)
    const matches = exact.length
      ? exact
      : windows.filter((window) => window.title.toLowerCase().includes(target.toLowerCase()))
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? 'WINDOW_AMBIGUOUS: 找到多个窗口，请使用 windowId'
          : 'WINDOW_NOT_FOUND: 未找到目标窗口',
      )
    const result = await windowsDesktop.request<{ title: string }>(
      'activate',
      {
        windowId: matches[0]!.windowId,
      },
      signal,
    )
    return result.title
  }
  const nut = await loadRuntime()
  for (const window of await nut.getWindows()) {
    const title = String(await window.title)
    if (title.toLowerCase().includes(target.toLowerCase())) {
      await window.focus()
      return title
    }
  }
  throw new Error(`WINDOW_NOT_FOUND: ${target}`)
}

export async function mousePosition(): Promise<{ x: number; y: number }> {
  if (process.platform === 'win32') return windowsDesktop.request('position')
  return (await loadRuntime()).mouse.getPosition()
}
