import { t as __t } from '../utils/i18n'
/**
 * @file 开机启动与后端启动程序
 * @description 阶段 5（仅开机启动部分）：适配“后端从源码运行 + 纯客户端 Electron 包”的用法。
 *
 *              - 开机启动客户端：`app.setLoginItemSettings`，只在打包后的客户端（Windows / macOS）可用。
 *              - 启动时同时启动后端（可选）：用户在设置页用文件对话框选择后端启动程序（如 `只启动后端.bat`）。
 *                客户端启动时先探测本机后端；未运行时才用系统默认方式打开该程序，再等待后端就绪。
 *              - 启动程序路径只能由用户在设置页经文件对话框选择：渲染进程不能传入路径，
 *                也没有任何角色工具或能力可以修改它（它会运行一个程序）。重新启用需在主进程原生确认框中确认。
 *              - 设置文件带 HMAC 签名（密钥经系统加密保存）：在应用外改写 desktop-startup.json
 *                （例如角色的文件工具）会使启动程序设置作废。
 *              - 启动程序每个进程只打开一次；已打开但未就绪时不改用便携 Daemon，重试只继续等待，退出时中止等待。
 *              - 连接远程服务器时不启动后端。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 5
 * @module electron/main/services/desktopStartup
 */

import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcMain, shell, BrowserWindow, type WebContents } from 'electron'
import { sameSignature, settingsSigner, type SettingsSigner } from './settingsSigner'
import { logger } from '../utils/logger'

export const DESKTOP_STARTUP_FILE = 'desktop-startup.json'

/** 可以作为后端启动程序的文件类型。 */
export const BACKEND_LAUNCHER_EXTENSIONS = ['.bat', '.cmd', '.exe'] as const

/**
 * 单次等待后端就绪的上限：源码运行可能先编译（超过 3 分钟也常见）。超时后显示连接错误，
 * 用户点重试时只继续等待，不会再次打开启动程序。
 */
export const BACKEND_LAUNCH_TIMEOUT_MS = 300_000
const BACKEND_POLL_INTERVAL_MS = 1_000

export const DESKTOP_STARTUP_CHANNELS = {
  get: 'desktop-startup:get',
  setOpenAtLogin: 'desktop-startup:set-open-at-login',
  pickLauncher: 'desktop-startup:pick-launcher',
  setLauncherEnabled: 'desktop-startup:set-launcher-enabled',
  clearLauncher: 'desktop-startup:clear-launcher',
} as const

export interface DesktopStartupSettings {
  version: 1
  backendLauncher: { enabled: boolean; path: string }
}

export interface DesktopStartupState {
  /** 当前运行环境能否设置开机启动（开发模式与 Linux 不支持）。 */
  loginItemSupported: boolean
  openAtLogin: boolean
  backendLauncher: { enabled: boolean; path: string; name: string; exists: boolean }
  /** 连接远程服务器时不启动本机后端。 */
  remote: boolean
}

export function createDefaultStartupSettings(): DesktopStartupSettings {
  return { version: 1, backendLauncher: { enabled: false, path: '' } }
}

/** 启动程序路径必须是绝对路径且类型在白名单内。 */
export function isBackendLauncherPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    (BACKEND_LAUNCHER_EXTENSIONS as readonly string[]).includes(path.extname(value).toLowerCase())
  )
}

export function normalizeStartupSettings(value: unknown): DesktopStartupSettings {
  const settings = createDefaultStartupSettings()
  const launcher =
    value && typeof value === 'object'
      ? (value as { backendLauncher?: { enabled?: unknown; path?: unknown } }).backendLauncher
      : undefined
  if (launcher && isBackendLauncherPath(launcher.path)) {
    settings.backendLauncher.path = launcher.path
    settings.backendLauncher.enabled = launcher.enabled === true
  }
  return settings
}

/** 启动后端所需的宿主能力；测试中替换。 */
export interface BackendLaunchDeps {
  remote(): boolean
  settings(): DesktopStartupSettings
  /** 后端业务接口是否就绪。 */
  probe(): Promise<boolean>
  exists(file: string): boolean
  /** 用系统默认方式打开程序；失败时返回错误说明，成功返回空字符串。 */
  open(file: string): Promise<string>
  /** 等待指定时间；signal 中止时提前结束。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): number
}

/**
 * - `skipped`：未启用、远程连接、文件无效或打开失败，本次没有启动程序；调用方继续原有流程（便携 Daemon）。
 * - `ready`：后端已就绪。
 * - `not-ready`：启动程序已在本进程中打开，但在等待期内未就绪或被取消；调用方不能再启动便携 Daemon
 *   （启动程序可能仍在编译，两个后端会抢同一端口），而是显示连接错误让用户重试或改选。
 */
export type BackendLaunchResult = 'skipped' | 'ready' | 'not-ready'

/**
 * 按设置启动后端。启动程序每个进程只打开一次：启动流程重试时只继续等待，
 * 不会重复打开控制台窗口。
 */
export class BackendLauncher {
  private started = false

  /** 本进程是否已打开过启动程序。 */
  get wasStarted(): boolean {
    return this.started
  }

  async ensure(
    deps: BackendLaunchDeps,
    signal?: AbortSignal,
    timeoutMs = BACKEND_LAUNCH_TIMEOUT_MS,
  ): Promise<BackendLaunchResult> {
    const { enabled, path: file } = deps.settings().backendLauncher
    if (deps.remote() || !enabled || !file) return 'skipped'
    if (await deps.probe()) return 'ready'
    if (!this.started) {
      if (!isBackendLauncherPath(file) || !deps.exists(file)) {
        logger.warn(
          'DesktopStartup',
          __t('electron.logs.desktopStartup', '后端启动程序不存在或类型不受支持：{0}', [file]),
        )
        return 'skipped'
      }
      logger.info(
        'DesktopStartup',
        __t('electron.logs.desktopStartup', '本机后端未运行，正在启动：{0}', [file]),
      )
      const error = await deps.open(file)
      if (error) {
        logger.warn(
          'DesktopStartup',
          __t('electron.logs.desktopStartup', '后端启动程序打开失败：{0}', [error]),
        )
        return 'skipped'
      }
      this.started = true
    } else {
      logger.info(
        'DesktopStartup',
        __t('electron.logs.desktopStartup', '后端启动程序已打开过，继续等待后端就绪'),
      )
    }
    const deadline = deps.now() + timeoutMs
    while (deps.now() < deadline) {
      if (signal?.aborted) return 'not-ready'
      await deps.sleep(BACKEND_POLL_INTERVAL_MS, signal)
      if (signal?.aborted) return 'not-ready'
      if (await deps.probe()) return 'ready'
    }
    logger.warn(
      'DesktopStartup',
      __t('electron.logs.desktopStartup', '等待后端就绪超时（{0} 秒）', [
        Math.round(timeoutMs / 1000),
      ]),
    )
    return 'not-ready'
  }
}

export const backendLauncher = new BackendLauncher()

// ─── 设置存储 ─────────────────────────────────────────

/** 启动程序设置使用的签名接口（见 settingsSigner.ts）。 */
export type StartupSettingsSigner = SettingsSigner

function launcherPayload(launcher: DesktopStartupSettings['backendLauncher']): string {
  return JSON.stringify({ path: launcher.path, enabled: launcher.enabled })
}

export class DesktopStartupStore {
  private cache: DesktopStartupSettings | null = null

  constructor(
    private readonly file: () => string,
    private readonly signer: StartupSettingsSigner,
  ) {}

  get(): DesktopStartupSettings {
    if (!this.cache) {
      let settings = createDefaultStartupSettings()
      try {
        const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as { signature?: unknown }
        settings = normalizeStartupSettings(raw)
        if (
          settings.backendLauncher.path &&
          !sameSignature(raw.signature, this.signer.sign(launcherPayload(settings.backendLauncher)))
        ) {
          logger.warn(
            'DesktopStartup',
            __t(
              'electron.logs.desktopStartup',
              '后端启动程序设置的签名无效（可能被应用外修改），已忽略',
            ),
          )
          settings = createDefaultStartupSettings()
        }
      } catch {
        settings = createDefaultStartupSettings()
      }
      this.cache = settings
    }
    return structuredClone(this.cache)
  }

  /** 先写临时文件再改名；启动程序设置附带签名。 */
  set(settings: DesktopStartupSettings): DesktopStartupSettings {
    const normalized = normalizeStartupSettings(settings)
    const signature = normalized.backendLauncher.path
      ? this.signer.sign(launcherPayload(normalized.backendLauncher))
      : null
    if (normalized.backendLauncher.path && !signature)
      throw new Error('DESKTOP_STARTUP_ENCRYPTION_UNAVAILABLE')
    const file = this.file()
    const temporary = `${file}.tmp`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      temporary,
      JSON.stringify(signature ? { ...normalized, signature } : normalized, null, 2),
      'utf8',
    )
    fs.renameSync(temporary, file)
    this.cache = normalized
    return structuredClone(normalized)
  }
}

export const desktopStartupStore = new DesktopStartupStore(
  () => path.join(app.getPath('userData'), DESKTOP_STARTUP_FILE),
  settingsSigner,
)

/** 开机启动只对打包后的客户端有意义；开发模式下 execPath 是 electron.exe。 */
function loginItemSupported(): boolean {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
}

export function readStartupState(
  remote: boolean,
  store: DesktopStartupStore = desktopStartupStore,
): DesktopStartupState {
  const { backendLauncher } = store.get()
  const supported = loginItemSupported()
  return {
    loginItemSupported: supported,
    openAtLogin: supported && app.getLoginItemSettings().openAtLogin,
    backendLauncher: {
      ...backendLauncher,
      name: backendLauncher.path ? path.basename(backendLauncher.path) : '',
      exists: Boolean(backendLauncher.path) && fs.existsSync(backendLauncher.path),
    },
    remote,
  }
}

/** 生产环境的启动依赖。 */
export function backendLaunchDeps(
  remote: () => boolean,
  probe: () => Promise<boolean>,
): BackendLaunchDeps {
  return {
    remote,
    settings: () => desktopStartupStore.get(),
    probe,
    exists: (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
    // Windows 下等同双击：.bat 在自己的控制台窗口中运行，工作目录为脚本所在文件夹。
    open: (file) => shell.openPath(file),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(done, ms)
        function done() {
          clearTimeout(timer)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        signal?.addEventListener('abort', done, { once: true })
      }),
    now: Date.now,
  }
}

/**
 * 注册设置页通道。只接受主窗口或桌面面板（设置页可能被摘出）；
 * 启动程序路径只能经主进程打开的文件对话框选择，渲染进程不能直接写入路径。
 */
export function registerDesktopStartupHandlers(
  isTrusted: (sender: WebContents) => boolean,
  remote: () => boolean,
  store: DesktopStartupStore = desktopStartupStore,
): void {
  const assert = (sender: WebContents) => {
    if (!isTrusted(sender)) throw new Error('DESKTOP_STARTUP_FORBIDDEN')
  }
  const state = () => readStartupState(remote(), store)
  ipcMain.handle(DESKTOP_STARTUP_CHANNELS.get, (event) => {
    assert(event.sender)
    return state()
  })
  ipcMain.handle(DESKTOP_STARTUP_CHANNELS.setOpenAtLogin, (event, enabled: unknown) => {
    assert(event.sender)
    if (typeof enabled !== 'boolean') throw new Error('DESKTOP_STARTUP_INVALID')
    if (!loginItemSupported()) throw new Error('DESKTOP_STARTUP_UNSUPPORTED')
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [] })
    logger.info(
      'DesktopStartup',
      __t('electron.logs.desktopStartup', '开机启动已设置为：{0}', [String(enabled)]),
    )
    return state()
  })
  ipcMain.handle(DESKTOP_STARTUP_CHANNELS.pickLauncher, async (event) => {
    assert(event.sender)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: __t('electron.ui.desktopStartup', '选择后端启动程序'),
      properties: ['openFile'],
      filters: [
        {
          name: __t('electron.ui.desktopStartup', '启动脚本或程序'),
          extensions: BACKEND_LAUNCHER_EXTENSIONS.map((extension) => extension.slice(1)),
        },
      ],
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const file = result.filePaths[0]
    if (result.canceled || !file) return state()
    if (!isBackendLauncherPath(file)) throw new Error('DESKTOP_STARTUP_INVALID_LAUNCHER')
    // 选择启动程序即表示启用。
    store.set({ version: 1, backendLauncher: { enabled: true, path: file } })
    logger.info(
      'DesktopStartup',
      __t('electron.logs.desktopStartup', '已设置后端启动程序：{0}', [file]),
    )
    return state()
  })
  ipcMain.handle(DESKTOP_STARTUP_CHANNELS.setLauncherEnabled, async (event, enabled: unknown) => {
    assert(event.sender)
    if (typeof enabled !== 'boolean') throw new Error('DESKTOP_STARTUP_INVALID')
    const settings = store.get()
    if (enabled && !settings.backendLauncher.path)
      throw new Error('DESKTOP_STARTUP_LAUNCHER_REQUIRED')
    // 重新启用会让客户端在启动时运行程序：主进程弹出原生确认框，页面脚本无法代替用户确认。
    // 关闭立即生效。
    if (enabled && !settings.backendLauncher.enabled) {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: __t('electron.ui.desktopStartup', '启用后端启动程序'),
        message: __t('electron.ui.desktopStartup', '客户端启动时将运行此程序：{0}', [
          settings.backendLauncher.path,
        ]),
        detail: __t(
          'electron.ui.desktopStartup',
          '只有在你本人打开这个开关时才确认。不认识这个程序请点取消。',
        ),
        buttons: [
          __t('electron.ui.desktopStartup', '启用'),
          __t('electron.ui.desktopStartup', '取消'),
        ],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }
      const result = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options)
      if (result.response !== 0) return state()
    }
    settings.backendLauncher.enabled = enabled
    store.set(settings)
    return state()
  })
  ipcMain.handle(DESKTOP_STARTUP_CHANNELS.clearLauncher, (event) => {
    assert(event.sender)
    store.set(createDefaultStartupSettings())
    return state()
  })
}
