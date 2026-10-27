import { t as __t } from './utils/i18n'
/**
 * @file IPC 通道集中注册
 * @description 遵循 07_DUAL_DEPLOYMENT.md — IPC 仅用于 Electron 专属的系统能力
 *              所有业务 API 走 HTTP (localhost:9120)，这里只注册系统级 IPC
 *
 *              按职责分组注册，清晰可维护
 *
 *              通道命名规范: kebab-case (如 window-minimize, start-backend)
 *
 * @platform ELECTRON
 * @module electron/main/ipcBridge
 */

import {
  ipcMain,
  BrowserWindow,
  shell,
  screen,
  Notification,
  nativeTheme,
  app,
  dialog,
  webContents,
} from 'electron'
import AdmZip from 'adm-zip'
import { getLocale, setLocale, t } from './utils/i18n'
import { systemFileOpenAction } from '../../packages/shared/src/resources'
import { normalizeLocale } from '../../packages/shared/src/i18n'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { windowManager } from './windows/manager'
import { toggleWindowMaximized } from './windows/windowState'
import { isApplicationFocused } from './services/notificationVisibility'
import { desktopTabs } from './windows/desktopTabs'
import { desktopToasts } from './windows/desktopToasts'
import type {
  DesktopTabBounds,
  PetConversationTarget,
  DesktopToastSnapshot,
  DesktopToastAction,
  MessageResource,
} from '@infos/shared'
import { petControls } from './services/petControls'
import { desktopControl } from './services/desktopControl'
import {
  captureScreen,
  readClipboard,
  writeClipboard,
  readClipboardImage,
  writeClipboardImage,
  getActiveWindow,
} from './services/desktopAwareness'
import {
  getSteamUser,
  getSubscribedItems,
  getWorkshopInstallations,
  getCloudStatus,
} from './services/steam'
import { completionAlerts } from './services/completionAlerts'
import { steamAchievements } from './services/steamAchievements'
import { registerPictoriaSurface } from './services/pictoriaSurface'
import { startDesktopArca } from './services/arcaLifetime'
import { registerArcaSurface } from './services/arcaSurface'
import { paths, isDev, isPackaged, isPortable } from './utils/env'
import { logger } from './utils/logger'
import { getClientCredential } from './utils/clientCredential'
import {
  getBackendOrigin,
  ensureSelectedBackend,
  isRemoteConnection,
} from './services/clientConnection'
import { showConnectionSetup, focusConnectionSetup } from './services/clientConnectionSetup'

// ─── 按功能边界延迟导入的服务 ─────────────────────────
// 窗口、桌面感知与 Steam 状态已有启动期静态依赖，直接复用；
// 可选服务保留动态入口，模块求值与服务启动分别由各自的调用时序控制。
const getNapCatService = () => import('./services/napcat')
const getNapCatDashboard = () => import('./services/napcatDashboard')
const getAssetService = () => import('./services/assets')
const getSystemService = () => import('./services/system')
const getUpdaterService = () => import('./services/updater')
const execFileAsync = promisify(execFile)

const CLIENT_AGENT_FILE = path.join(paths.userData, 'client-default-agent.txt')

function readClientDefaultAgent(): string | null {
  try {
    const agentId = fs.readFileSync(CLIENT_AGENT_FILE, 'utf8').trim()
    return agentId || null
  } catch {
    return null
  }
}

function writeClientDefaultAgent(agentId: string): void {
  fs.mkdirSync(path.dirname(CLIENT_AGENT_FILE), { recursive: true })
  fs.writeFileSync(CLIENT_AGENT_FILE, agentId, 'utf8')
}

function broadcastClientAgent(agentId: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('client-agent-changed', { agentId })
  })
}

async function getDevelopmentInfo(): Promise<Record<string, unknown>> {
  if (!isDev) return { available: false }
  try {
    const [branch, commit, status] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], { cwd: paths.app }),
      execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: paths.app }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: paths.app }),
    ])
    return {
      available: true,
      branch: branch.stdout.trim(),
      commit: commit.stdout.trim(),
      dirty: Boolean(status.stdout.trim()),
      projectPath: paths.app,
      updateCommand: 'git pull --rebase; pnpm install',
    }
  } catch (error) {
    return { available: false, error: String(error), projectPath: paths.app }
  }
}

/** 桌宠输入设置仅由第一方窗口访问。 */
function registerPetControlHandlers(): void {
  const assertTrusted = (sender: Electron.WebContents, petOnly = false) => {
    if (sender === windowManager.petWin?.webContents) return
    if (!petOnly && desktopTabs.isHost(sender)) return
    throw new Error('仅桌宠与主应用可以管理桌宠输入')
  }
  ipcMain.handle('pet-controls:get', (event) => {
    assertTrusted(event.sender)
    return petControls.snapshot()
  })
  ipcMain.handle('desktop-control:get', (event) => {
    assertTrusted(event.sender)
    return { state: desktopControl.snapshot(), settings: desktopControl.configuration() }
  })
  ipcMain.handle('desktop-control:pause', (event) => {
    assertTrusted(event.sender)
    return desktopControl.pause('你已暂停桌面操作')
  })
  ipcMain.handle('desktop-control:resume', (event) => {
    assertTrusted(event.sender)
    return desktopControl.resume()
  })
  ipcMain.handle('desktop-control:update', (event, patch: unknown) => {
    assertTrusted(event.sender)
    if (!patch || typeof patch !== 'object') throw new Error('桌面设置格式不正确')
    return desktopControl.update(patch)
  })
  ipcMain.handle('desktop-control:capture', (event, active: unknown) => {
    assertTrusted(event.sender)
    desktopControl.setShortcutCapturing(event.sender, active === true)
    try {
      petControls.setCapturing(event.sender, active === true)
    } catch (error) {
      desktopControl.setShortcutCapturing(event.sender, false)
      throw error
    }
  })
  ipcMain.handle('pet-controls:update', (event, patch: unknown) => {
    assertTrusted(event.sender)
    return petControls.update(patch)
  })
  ipcMain.handle('pet-controls:capture', (event, active: unknown) => {
    assertTrusted(event.sender)
    petControls.setCapturing(event.sender, active === true)
  })
  ipcMain.handle('pet-controls:arm', (event, ready: unknown) => {
    assertTrusted(event.sender, true)
    petControls.setArmed(ready === true)
  })
  ipcMain.handle('pet-controls:conversation', (event, target: PetConversationTarget) => {
    assertTrusted(event.sender, true)
    petControls.setConversation(target)
  })
  ipcMain.handle('pet-controls:open-conversation', (event, target?: PetConversationTarget) => {
    assertTrusted(event.sender)
    petControls.openConversation(target)
  })
  ipcMain.handle('pet-controls:open-section', (event, section: unknown) => {
    assertTrusted(event.sender)
    if (!['tasks', 'voice_config', 'agent_config'].includes(String(section)))
      throw new Error('不支持的页面')
    windowManager.createDashboardWindow()
    desktopTabs.openHome(String(section))
  })
  ipcMain.handle('pet-controls:open-resource', (event, input: unknown) => {
    assertTrusted(event.sender, true)
    // 只转发资源引用；实际读取与权限校验仍由服务端资源接口负责。
    if (!input || typeof input !== 'object') return false
    const value = input as { resource?: MessageResource; target?: PetConversationTarget }
    const item = value.resource
    const target = value.target
    if (
      !item ||
      !target ||
      typeof target.agentId !== 'string' ||
      !target.agentId ||
      typeof item.name !== 'string' ||
      item.name.length > 1024 ||
      typeof item.kind !== 'string' ||
      typeof item.mimeType !== 'string' ||
      !Number.isFinite(item.sizeBytes) ||
      item.sizeBytes < 0
    )
      return false
    const id = typeof item.id === 'string' && /^[\w-]{1,128}$/.test(item.id) ? item.id : undefined
    const origin = item.origin
    const validOrigin =
      origin &&
      ['workspace', 'url', 'arca'].includes(origin.type) &&
      typeof origin.value === 'string' &&
      origin.value.length <= 8192 &&
      (origin.type !== 'url' || /^https?:\/\//i.test(origin.value))
    if (!id && !validOrigin) return false
    const resource: MessageResource = {
      id,
      name: item.name,
      kind: item.kind,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      origin:
        validOrigin && origin
          ? {
              type: origin.type,
              value: origin.value,
              agentId: target.agentId,
              threadId: typeof target.threadId === 'string' ? target.threadId : undefined,
              taskId: typeof origin.taskId === 'string' ? origin.taskId : undefined,
            }
          : undefined,
    }
    windowManager.createDashboardWindow()
    desktopTabs.openHome(
      'chat',
      {
        agentId: target.agentId,
        threadId: typeof target.threadId === 'string' ? target.threadId : undefined,
        messageId: typeof target.messageId === 'string' ? target.messageId : undefined,
      },
      resource,
    )
    return true
  })
}

function trustedClient(url: string): boolean {
  const development =
    process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL || 'http://localhost:7359'
  return url.startsWith('file://') || url.startsWith(`${new URL(development).origin}/`)
}

function trustedWindow(sender: Electron.WebContents): boolean {
  return (
    desktopTabs.isHost(sender) ||
    [
      windowManager.launcherWin,
      windowManager.petWin,
      windowManager.dashboardWin,
      windowManager.chatWin,
      windowManager.strongholdWin,
      windowManager.ideWin,
    ].some((win) => win?.webContents === sender)
  )
}

/** 注册所有 IPC 通道。 */
export function registerIpcHandlers(): void {
  const languageFile = path.join(paths.data, 'client-language.txt')
  try {
    setLocale(fs.readFileSync(languageFile, 'utf8').trim())
  } catch {
    /* 首次启动使用默认语言 */
  }
  ipcMain.handle('i18n:get-language', () => getLocale())
  ipcMain.handle('i18n:set-language', (event, value: unknown) => {
    if (!trustedWindow(event.sender) || !trustedClient(event.sender.getURL()))
      throw new Error('仅主应用可以修改界面语言')
    const language = normalizeLocale(value)
    fs.mkdirSync(path.dirname(languageFile), { recursive: true })
    fs.writeFileSync(languageFile, language, 'utf8')
    setLocale(language)
    for (const contents of webContents.getAllWebContents())
      if (!contents.isDestroyed()) contents.send('i18n:changed', language)
    return language
  })
  let credentialHooksInstalled = false
  ipcMain.handle('client-connection:configure', async (event) => {
    if (
      !trustedWindow(event.sender) ||
      !trustedClient(event.sender.getURL()) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('CONNECTION_HOST_REQUIRED')
    if (focusConnectionSetup()) return
    try {
      await showConnectionSetup(false)
    } catch {
      return
    }
    setImmediate(() => {
      app.relaunch()
      app.quit()
    })
  })
  ipcMain.on('client-access:credential', (event, kind?: string) => {
    const url = event.sender.getURL()
    const trusted =
      trustedWindow(event.sender) &&
      trustedClient(url) &&
      event.senderFrame === event.sender.mainFrame
    if (trusted && !credentialHooksInstalled) {
      // 原生 img/audio/video 等不能自设 Header，只给可信主应用帧的本机请求附加凭据。
      event.sender.session.webRequest.onBeforeSendHeaders(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          const source =
            typeof details.webContentsId === 'number'
              ? webContents.fromId(details.webContentsId)
              : undefined
          const frame = (details as { frame?: { url: string } | null }).frame
          const allowed =
            new URL(details.url).origin === getBackendOrigin() &&
            source &&
            trustedWindow(source) &&
            trustedClient(source.getURL()) &&
            (!frame || frame.url.split('#')[0] === source.getURL().split('#')[0])
          const headers = details.requestHeaders
          const hasAuthorization = Object.entries(headers).some(
            ([name, value]) => name.toLowerCase() === 'authorization' && String(value).trim(),
          )
          const credential = allowed && !hasAuthorization ? getClientCredential() : ''
          // 媒体请求只补齐缺失的凭据，不覆盖 fetch 的显式身份，也不注入空 Bearer。
          callback({
            requestHeaders: credential
              ? { ...headers, Authorization: `Bearer ${credential}` }
              : headers,
          })
        },
      )
      credentialHooksInstalled = true
    }
    event.returnValue = trusted
      ? kind === 'origin'
        ? getBackendOrigin()
        : kind === 'mode'
          ? isRemoteConnection()
            ? 'remote'
            : 'local'
          : getClientCredential(kind === 'refresh')
      : ''
  })
  logger.info('IPC', __t('electron.logs.ipcBridge.ts', '正在注册 IPC 通道...'))
  const assertCompletionSettingsSender = (sender: Electron.WebContents) => {
    if (sender !== windowManager.petWin?.webContents && !desktopTabs.isHost(sender)) {
      throw new Error('仅主应用与桌宠可以管理完成提醒')
    }
  }
  ipcMain.handle('completion-alerts:get', (event) => {
    assertCompletionSettingsSender(event.sender)
    return completionAlerts.snapshot()
  })
  ipcMain.handle('completion-alerts:update', (event, patch: unknown) => {
    assertCompletionSettingsSender(event.sender)
    const settings = completionAlerts.update(patch)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('completion-alerts:changed', settings)
    }
    return settings
  })
  ipcMain.handle('completion-alerts:preview', (event) => {
    assertCompletionSettingsSender(event.sender)
    return completionAlerts.preview()
  })

  registerWindowHandlers()
  registerPetControlHandlers()
  registerDesktopTabHandlers()
  registerNavigationHandlers()
  registerBackendHandlers()
  registerSystemHandlers()
  registerSkillHandlers()
  registerExportHandlers()
  registerAssetHandlers()
  registerNapCatHandlers()
  registerSteamHandlers()
  registerDragHandlers()
  registerDesktopAwarenessHandlers()
  registerSystemMonitorHandlers()
  registerAudioOutputHandlers()

  logger.info('IPC', __t('electron.logs.ipcBridge.ts', 'IPC 通道注册完成'))
}

function registerAudioOutputHandlers(): void {
  ipcMain.on('audio-output:receipt', (_event, input: unknown) => {
    const payload = input as { playbackId?: unknown; state?: unknown }
    const playbackId = String(payload.playbackId ?? '')
    const state = payload.state === 'completed' ? 'completed' : 'cancelled'
    if (!playbackId) return
    void import('./services/capabilityProvider').then(({ capabilityProvider }) => {
      capabilityProvider.completePlayback(playbackId, state)
    })
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 窗口控制
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerWindowHandlers(): void {
  ipcMain.handle('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win.isMinimized()) return
    win.minimize()
  })

  ipcMain.handle('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    return toggleWindowMaximized(win)
  })

  ipcMain.handle('window-close', async (event) => {
    if (desktopTabs.isApplication(event.sender)) {
      await desktopTabs.closeBySender(event.sender)
      return
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.webContents === event.sender) win.close()
  })

  ipcMain.handle('window-is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
  ipcMain.handle('window-is-visible', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
  })

  ipcMain.handle('window-show', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      win.show()
      win.focus()
    }
  })

  ipcMain.handle('window-focus', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.focus()
  })

  ipcMain.handle('resize-pet-window', (event, { width, height }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    try {
      win.setResizable(true)
      win.setMinimumSize(200, 200)
      const bounds = win.getBounds()
      win.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: Math.round(width),
        height: Math.round(height),
      })
      win.setResizable(false)
      return true
    } catch (e: unknown) {
      logger.error('IPC', __t('electron.logs.ipcBridge.ts', 'resize-pet-window 失败: {0}', [e]))
      return false
    }
  })

  ipcMain.handle('set-ignore-mouse', (event, ignore: boolean) => {
    BrowserWindow.fromWebContents(event.sender)?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  ipcMain.handle('set-fix-window-topmost', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.setAlwaysOnTop(true, 'screen-saver')
  })

  // 同步 app 深浅色到系统原生主题（影响原生标题栏/滚动条/右键菜单等）
  ipcMain.handle('set-native-theme', (_event, mode: unknown) => {
    if (mode === 'dark' || mode === 'light' || mode === 'system') {
      nativeTheme.themeSource = mode
      if (windowManager.launcherWin && !windowManager.launcherWin.isDestroyed())
        windowManager.launcherWin.setBackgroundColor(
          nativeTheme.shouldUseDarkColors ? '#15151d' : '#f6f2ff',
        )
      desktopTabs.setTheme(
        mode === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : mode,
      )
    }
  })
}

/** 标签管理仅接受主外壳请求，网页和子应用没有这些通道的权限。 */
function registerDesktopTabHandlers(): void {
  registerPictoriaSurface()
  registerArcaSurface()
  ipcMain.handle('arca:host-start', async (event) => {
    desktopTabs.assertHost(event.sender)
    return startDesktopArca()
  })
  const browser = async () => (await import('./services/browserRuntime')).browserRuntime
  // Arca 只访问自身控制面的固定操作，系统凭据不交给子应用页面。
  ipcMain.handle('arca-host:control', async (event, action: unknown) => {
    if (!desktopTabs.isApplication(event.sender, 'infos.arca'))
      throw new Error('仅 Arca 应用可以调用自己的运行控制接口')
    if (typeof action !== 'string' || !['status', 'start', 'stop', 'reconnect'].includes(action)) {
      throw new Error('不支持此 Arca 控制操作')
    }
    if (action === 'start') return startDesktopArca()
    const origin = getBackendOrigin()
    const token = getClientCredential()
    const response = await fetch(`${origin}/api/applications/arca/${action}`, {
      method: action === 'status' ? 'GET' : 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const body = (await response.json()) as { code: string; data?: unknown; message?: string }
    if (!response.ok || body.code !== 'OK')
      throw new Error(body.message ?? `Arca 控制请求失败：HTTP ${response.status}`)
    return body.data
  })
  ipcMain.on('desktop-tabs:unsaved-changes', (event, dirty: unknown) => {
    if (desktopTabs.isApplication(event.sender))
      desktopTabs.setUnsavedChanges(event.sender, dirty === true)
  })
  ipcMain.on('desktop-tabs:surface-state', (event, value: unknown) => {
    if (desktopTabs.isApplication(event.sender)) desktopTabs.setSurfaceState(event.sender, value)
  })
  ipcMain.handle('desktop-tabs:get-state', (event) => {
    desktopTabs.assertHost(event.sender)
    return desktopTabs.snapshot()
  })
  ipcMain.handle('desktop-toasts:update', (event, snapshot: DesktopToastSnapshot) =>
    desktopToasts.update(event.sender, snapshot),
  )
  ipcMain.handle('desktop-toasts:get-state', (event) => desktopToasts.state(event.sender))
  ipcMain.on('desktop-toasts:pointer', (event, over: boolean) => {
    try {
      desktopToasts.pointer(event.sender, over)
    } catch {
      /* 忽略不属于通知层的消息。 */
    }
  })
  ipcMain.on('desktop-toasts:action', (event, action: DesktopToastAction) => {
    try {
      desktopToasts.action(event.sender, action)
    } catch {
      /* 关闭窗口后的在途消息无需处理。 */
    }
  })
  ipcMain.handle('desktop-tabs:create', (event) => {
    desktopTabs.assertHost(event.sender)
    return desktopTabs.createNew()
  })
  ipcMain.handle('desktop-tabs:open-tarot', (event, input?: { replaceId?: string }) => {
    desktopTabs.assertHost(event.sender)
    return desktopTabs.openTarot(input?.replaceId)
  })
  ipcMain.handle('desktop-tabs:activate', async (event, id: string) => {
    desktopTabs.assertHost(event.sender)
    const tab = desktopTabs.snapshot().tabs.find((candidate) => candidate.id === id)
    if (tab?.targetId) (await browser()).retainTarget(tab.targetId)
    desktopTabs.assertHost(event.sender)
    return desktopTabs.activate(id)
  })
  ipcMain.handle('desktop-tabs:close', async (event, id: string) => {
    desktopTabs.assertHost(event.sender)
    await desktopTabs.close(id)
    return desktopTabs.snapshot()
  })
  ipcMain.handle(
    'desktop-tabs:open-browser',
    async (event, input: { url: string; replaceId?: string }) => {
      desktopTabs.assertHost(event.sender)
      const runtime = await browser()
      desktopTabs.assertHost(event.sender)
      await runtime.openUserTab(String(input?.url ?? ''), input?.replaceId)
      return desktopTabs.snapshot()
    },
  )
  ipcMain.handle(
    'desktop-tabs:open-application',
    async (
      event,
      input: { appId: string; url?: string; replaceId?: string; navigateExisting?: boolean },
    ) => {
      desktopTabs.assertHost(event.sender)
      if (input?.appId === 'infos.napcat') {
        const dashboard = await getNapCatDashboard()
        desktopTabs.assertHost(event.sender)
        return dashboard.startNapCatWithDashboard(input.replaceId)
      }
      return desktopTabs.openApplication(
        String(input?.appId ?? ''),
        input?.url,
        input?.replaceId,
        input?.navigateExisting === true,
      )
    },
  )
  ipcMain.handle(
    'desktop-tabs:navigate',
    async (event, input: { targetId: string; url: string }) => {
      desktopTabs.assertHost(event.sender)
      const runtime = await browser()
      desktopTabs.assertHost(event.sender)
      await runtime.navigateUserTarget(String(input?.targetId ?? ''), String(input?.url ?? ''))
    },
  )
  ipcMain.handle(
    'desktop-tabs:browser-action',
    async (event, input: { targetId: string; action: string }) => {
      desktopTabs.assertHost(event.sender)
      const runtime = await browser()
      desktopTabs.assertHost(event.sender)
      runtime.userAction(String(input?.targetId ?? ''), String(input?.action ?? ''))
    },
  )
  ipcMain.handle('desktop-tabs:set-bounds', (event, bounds: DesktopTabBounds) => {
    desktopTabs.assertHost(event.sender)
    if (bounds) desktopTabs.setBounds(bounds)
  })
  ipcMain.handle('desktop-tabs:set-obscured', (event, value: boolean) => {
    desktopTabs.assertHost(event.sender)
    desktopTabs.setObscured(value === true)
  })
  ipcMain.handle('desktop-tabs:get-theme', (event) => {
    if (!desktopTabs.isHost(event.sender) && !desktopTabs.isApplication(event.sender)) {
      throw new Error('该界面无权读取桌面主题')
    }
    return desktopTabs.getTheme()
  })
  ipcMain.handle('desktop-tabs:set-motion', (event, level: unknown) => {
    desktopTabs.assertHost(event.sender)
    desktopTabs.setMotionLevel(level)
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 窗口导航 (打开/关闭/隐藏)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerNavigationHandlers(): void {
  ipcMain.handle('open-pet-window', () => {
    windowManager.createPetWindow()
    return true
  })

  ipcMain.handle('hide-pet-window', () => {
    windowManager.hidePetWindow()
  })

  ipcMain.handle('get-pet-window-state', (event) => {
    if (event.sender !== windowManager.petWin?.webContents) return { visible: false }
    return windowManager.getPetWindowState()
  })

  ipcMain.handle('open-dashboard-window', () => {
    windowManager.createDashboardWindow()
    desktopTabs.openHome()
  })

  ipcMain.handle('close-dashboard', () => {
    windowManager.dashboardWin?.close()
  })

  ipcMain.handle('open-arca-window', (_event, input: unknown) => {
    const requestedUrl =
      typeof input === 'object' && input !== null
        ? String((input as { url?: unknown }).url ?? '')
        : String(input ?? '')
    const backendOrigin = getBackendOrigin()
    const url = new URL(requestedUrl, backendOrigin).toString()
    windowManager.createArcaWindow(url)
    return windowManager.getArcaWindowState()
  })

  ipcMain.handle('close-arca-window', async () => {
    await windowManager.closeArcaWindow()
    return windowManager.getArcaWindowState()
  })

  ipcMain.handle('get-arca-window-state', () => windowManager.getArcaWindowState())

  ipcMain.handle('open-stronghold-window', () => {
    windowManager.createStrongholdWindow()
  })

  ipcMain.handle('open-chat-window', () => {
    windowManager.createChatWindow()
  })

  ipcMain.handle('open-ide-window', () => {
    windowManager.createIDEWindow()
  })

  ipcMain.handle('hide-launcher', () => {
    windowManager.hideLauncherWindow()
  })

  ipcMain.handle('close-launcher', () => {
    windowManager.closeLauncherWindow()
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 内置后端启动与诊断
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 仅管理本应用的内置 Daemon；业务操作继续通过 HTTP API 完成。
function registerBackendHandlers(): void {
  ipcMain.handle('resource-recovery:restart', async (event) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('RESOURCE_HOST_REQUIRED')
    const { restartForResources } = await import('./services/resourceRecovery')
    const result = await dialog.showMessageBox({
      type: 'question',
      message: __t('electron.ui.resource-recovery', '重启应用以切换资源？'),
      buttons: [
        __t('electron.ui.resource-recovery', '重启'),
        __t('electron.ui.resource-recovery', '取消'),
      ],
      cancelId: 1,
      defaultId: 1,
    })
    if (result.response === 0) await restartForResources()
  })
  ipcMain.handle('start-backend', async () => {
    const { ensurePortableDaemon, getPortableDaemonStatus } =
      await import('./services/portableDaemon')
    const ready = await ensureSelectedBackend(ensurePortableDaemon)
    return isRemoteConnection()
      ? { ready, running: false, mode: 'remote' }
      : getPortableDaemonStatus()
  })

  ipcMain.handle('stop-backend', async () => {
    logger.info(
      'IPC',
      __t('electron.logs.ipcBridge.ts', 'stop-backend 已废弃：Daemon 生命周期由自身管理'),
    )
    return null
  })

  ipcMain.handle('get-backend-logs', async () => {
    const { getPortableDaemonStatus } = await import('./services/portableDaemon')
    return getPortableDaemonStatus()
  })
}

function registerSkillHandlers(): void {
  ipcMain.handle('select-skill-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: __t('electron.ui.ipcBridge.ts', '选择 Skill 文件夹'),
      buttonLabel: __t('electron.ui.ipcBridge.ts', '选择此文件夹'),
      properties: ['openDirectory'] as Array<'openDirectory'>,
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const selectedPath = result.filePaths[0]
    if (result.canceled || !selectedPath) return { canceled: true }
    if (!fs.existsSync(path.join(selectedPath, 'SKILL.md'))) {
      throw new Error('所选文件夹内没有 SKILL.md，不是有效的 Skill')
    }
    return {
      canceled: false,
      path: selectedPath,
      name: path.basename(selectedPath),
    }
  })
}

function registerExportHandlers(): void {
  ipcMain.handle('export-agent-package', async (event, input: unknown) => {
    const payload = input as {
      format?: unknown
      version?: unknown
      agentId?: unknown
      fileName?: unknown
      files?: unknown
    }
    if (payload?.format !== 'infos.agent-package' || payload.version !== 1) {
      throw new Error('角色包格式不受支持')
    }
    if (typeof payload.agentId !== 'string' || !/^[a-z0-9_-]+$/.test(payload.agentId)) {
      throw new Error('角色包ID无效')
    }
    if (!Array.isArray(payload.files) || payload.files.length === 0) {
      throw new Error('角色包没有可导出的资源')
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions = {
      title: __t('electron.ui.ipcBridge.ts', '选择角色包导出目录'),
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
    }
    const selected = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    const directory = selected.filePaths[0]
    if (selected.canceled || !directory) return { canceled: true }

    const requestedName = typeof payload.fileName === 'string' ? payload.fileName : ''
    const fileName = /^[a-z0-9_-]+\.infos-agent\.zip$/i.test(requestedName)
      ? requestedName
      : `${payload.agentId}.infos-agent.zip`
    const target = path.join(directory, fileName)
    const zip = new AdmZip()
    for (const value of payload.files) {
      if (!value || typeof value !== 'object') throw new Error('角色包资源无效')
      const file = value as { path?: unknown; contentBase64?: unknown }
      const relative = typeof file.path === 'string' ? file.path.replaceAll('\\', '/') : ''
      if (
        !relative ||
        relative.startsWith('/') ||
        relative.split('/').some((segment) => !segment || segment === '..') ||
        typeof file.contentBase64 !== 'string'
      ) {
        throw new Error(`角色包资源路径无效: ${relative}`)
      }
      zip.addFile(relative, Buffer.from(file.contentBase64, 'base64'))
    }
    zip.addFile(
      'package.json',
      Buffer.from(
        JSON.stringify(
          {
            format: 'infos.agent-package',
            version: 1,
            agentId: payload.agentId,
            exportedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      ),
    )
    zip.writeZip(target)
    return { canceled: false, path: target, fileName }
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 系统能力
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerSystemHandlers(): void {
  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('get-capability-node-id', async () => {
    const { capabilityProvider } = await import('./services/capabilityProvider')
    return capabilityProvider.getNodeId()
  })

  ipcMain.handle('get-client-info', async () => {
    const stats = await getSystemService().then((service) => service.getSystemStats())
    const edition = isDev
      ? 'development'
      : isPortable
        ? 'portable'
        : process.env.INFOS_EDITION === 'steam'
          ? 'steam'
          : 'release'
    return {
      version: app.getVersion(),
      edition,
      isPackaged,
      platform: process.platform,
      architecture: process.arch,
      osVersion: os.release(),
      osName: os.type(),
      hostname: os.hostname(),
      cpuModel: os.cpus()[0]?.model ?? '未知',
      cpuCores: os.cpus().length,
      memoryUsed: stats.memoryUsed,
      memoryTotal: stats.memoryTotal,
      uptime: stats.uptime,
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      dataPath: paths.data,
      logsPath: paths.logs,
      appPath: paths.app,
      windows: {
        launcher: Boolean(windowManager.launcherWin && !windowManager.launcherWin.isDestroyed()),
        dashboard: Boolean(windowManager.dashboardWin && !windowManager.dashboardWin.isDestroyed()),
        pet: Boolean(windowManager.petWin && !windowManager.petWin.isDestroyed()),
      },
      development: await getDevelopmentInfo(),
    }
  })

  ipcMain.handle('get-client-default-agent', () => readClientDefaultAgent())
  ipcMain.handle('set-client-default-agent', (_event, input: unknown) => {
    const agentId =
      typeof input === 'string'
        ? input
        : typeof input === 'object' && input !== null
          ? String((input as { agentId?: unknown }).agentId ?? '')
          : ''
    if (!agentId) throw new Error('缺少 Agent ID')
    writeClientDefaultAgent(agentId)
    broadcastClientAgent(agentId)
    return { agentId }
  })

  ipcMain.handle('get-update-state', async () => (await getUpdaterService()).getUpdateState())
  ipcMain.handle('get-client-update-releases', async () =>
    (await getUpdaterService()).getCachedReleases(),
  )
  ipcMain.handle('check-client-update', async () => (await getUpdaterService()).checkForUpdates())
  ipcMain.handle('download-client-update', async (_event, input: unknown) => {
    const tagName =
      typeof input === 'string'
        ? input
        : typeof input === 'object' && input !== null
          ? String((input as { tagName?: unknown }).tagName ?? '')
          : ''
    return (await getUpdaterService()).downloadUpdate(tagName || undefined)
  })
  ipcMain.handle('install-client-update', async () => (await getUpdaterService()).installUpdate())
  ipcMain.handle('get-latest-release', async () => (await getUpdaterService()).getLatestRelease())

  ipcMain.handle('open-external-url', async (_event, input: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : typeof input === 'object' && input !== null
          ? String((input as { url?: unknown }).url ?? '')
          : ''
    if (!/^https:\/\//.test(url)) throw new Error('仅允许打开 HTTPS 链接')
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle('open-client-path', async (_event, key: unknown) => {
    const target = key === 'logs' ? paths.logs : key === 'app' ? paths.app : paths.data
    const errorMessage = await shell.openPath(target)
    if (errorMessage) throw new Error(errorMessage)
    return true
  })

  ipcMain.handle('open-root-folder', () => {
    return shell.openPath(process.cwd())
  })

  /** 仅可信本机主界面可打开后端文件，远程路径不能解释成客户端路径。 */
  ipcMain.handle('open-local-path', async (event, targetPath: unknown) => {
    const tr = (source: string) => t('electron.ui.ipcBridge.ts', source)
    if (
      !trustedWindow(event.sender) ||
      !trustedClient(event.sender.getURL()) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error(tr('只能从主应用打开本地文件'))
    if (isRemoteConnection()) throw new Error(tr('远程文件请使用应用内预览或下载'))
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath) || targetPath.includes('\0'))
      throw new Error(tr('请提供有效的绝对文件路径'))
    let actual: string
    let info: fs.Stats
    try {
      actual = await fs.promises.realpath(targetPath)
      info = await fs.promises.stat(actual)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new Error(
        tr(code === 'ENOENT' || code === 'ENOTDIR' ? '文件不存在或已移动' : '文件暂不可访问'),
      )
    }
    if (!info.isDirectory() && !info.isFile()) throw new Error(tr('目标不是普通文件或目录'))
    if (info.isFile() && systemFileOpenAction(actual) === 'reveal') {
      shell.showItemInFolder(actual)
      return true
    }
    const errorMessage = await shell.openPath(actual)
    if (errorMessage) throw new Error(errorMessage)
    return true
  })

  ipcMain.handle('quit-app', () => {
    const { app } = require('electron')
    app.quit()
  })

  // 跨窗口事件广播
  ipcMain.handle('emit-event', (_event, { event, payload }) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(event, payload)
      }
    })
  })

  // 系统通知
  ipcMain.on('show-notification', (_event, { title, body }) => {
    if (isApplicationFocused()) return
    new Notification({ title, body }).show()
  })

  // 渲染进程日志转发
  ipcMain.on('log-from-renderer', (_event, message) => {
    logger.info('Renderer', String(message))
  })

  // 渲染进程错误日志
  ipcMain.handle('system-error-log', (_event, errMsg) => {
    logger.error('Renderer', String(errMsg))
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3D模型资源
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerAssetHandlers(): void {
  ipcMain.handle('scan-3d-models', async () => {
    const { scan3DModels } = await getAssetService()
    return scan3DModels()
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NapCat QQ 机器人
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerNapCatHandlers(): void {
  void getNapCatDashboard()
    .then(({ initializeNapCatDashboard }) => initializeNapCatDashboard())
    .catch(() => logger.warn('NapCat', __t('electron.logs.ipcBridge.ts', '管理页入口初始化失败')))
  ipcMain.handle('start-napcat', async (event) => {
    desktopTabs.assertHost(event.sender)
    const { startNapCatWithDashboard } = await getNapCatDashboard()
    return startNapCatWithDashboard()
  })
  ipcMain.handle('open-napcat-dashboard', async (event) => {
    desktopTabs.assertHost(event.sender)
    const { openNapCatDashboard } = await getNapCatDashboard()
    return openNapCatDashboard()
  })

  ipcMain.handle('stop-napcat', async (event) => {
    desktopTabs.assertHost(event.sender)
    const { stopNapCat } = await getNapCatService()
    await stopNapCat()
  })

  ipcMain.handle('get-napcat-logs', async () => {
    const { getNapCatLogs } = await getNapCatService()
    return getNapCatLogs()
  })

  ipcMain.handle('send-napcat-command', async (_event, args) => {
    const { sendNapCatCommand } = await getNapCatService()
    const cmd = typeof args === 'string' ? args : args?.command
    if (cmd) sendNapCatCommand(cmd)
  })

  ipcMain.handle('install-napcat', async () => {
    const { installNapCat } = await getNapCatService()
    return installNapCat()
  })

  ipcMain.handle('update-napcat', async () => {
    const { installNapCat } = await getNapCatService()
    return installNapCat(true)
  })

  ipcMain.handle('check-napcat', async () => {
    const { checkNapCat } = await getNapCatService()
    return checkNapCat()
  })

  ipcMain.handle('napcat-status', async () => {
    const { getNapCatDashboardStatus } = await getNapCatDashboard()
    return getNapCatDashboardStatus()
  })

  ipcMain.handle('ensure-napcat-config', async () => {
    const { ensureNapCatConfig } = await getNapCatService()
    return ensureNapCatConfig()
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Steam 集成 (IS_STEAM 门控)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerSteamHandlers(): void {
  ipcMain.handle('steam-achievements-sync', () => steamAchievements.sync())
  // Steam 通道在运行时检查 IS_STEAM 标记
  // 非 Steam 版调用这些通道会安全返回 null

  ipcMain.handle('steam-get-user', async () => {
    try {
      return getSteamUser()
    } catch {
      return null
    }
  })

  ipcMain.handle('steam-workshop-get-subscribed', async () => {
    try {
      return getSubscribedItems()
    } catch {
      return []
    }
  })

  ipcMain.handle('steam-workshop-get-installations', async () => {
    try {
      return getWorkshopInstallations()
    } catch {
      return []
    }
  })

  // 云存档系列
  ipcMain.handle('steam-cloud-get-status', async () => {
    try {
      return getCloudStatus()
    } catch {
      return { enabled: false }
    }
  })

  ipcMain.handle('steam-cloud-upload', async () => {
    try {
      const { cloudSyncService } = await import('./services/cloudSync')
      return cloudSyncService.uploadFullSnapshot()
    } catch {
      return { success: false, errors: ['Steam 不可用'] }
    }
  })

  ipcMain.handle('steam-cloud-download', async () => {
    try {
      const { cloudSyncService } = await import('./services/cloudSync')
      return cloudSyncService.downloadFullSnapshot()
    } catch {
      return { success: false, errors: ['Steam 不可用'] }
    }
  })

  ipcMain.handle('steam-cloud-sync', async () => {
    try {
      const { cloudSyncService } = await import('./services/cloudSync')
      return cloudSyncService.sync()
    } catch {
      return { success: false, uploaded: [], downloaded: [], failed: [], errors: ['Steam 不可用'] }
    }
  })

  ipcMain.handle('steam-cloud-clear', async () => {
    try {
      const { cloudSyncService } = await import('./services/cloudSync')
      return cloudSyncService.clearCloudData()
    } catch {
      return false
    }
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 窗口拖拽 (Pet 窗口高刷拖拽)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerDragHandlers(): void {
  let dragInterval: ReturnType<typeof setInterval> | null = null

  ipcMain.on('window-drag-start', (event, { offsetX, offsetY }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    if (dragInterval) clearInterval(dragInterval)

    const { width, height } = win.getBounds()

    // 1ms 轮询鼠标位置直接移动窗口 → 最大平滑度
    dragInterval = setInterval(() => {
      try {
        if (win.isDestroyed()) {
          if (dragInterval) clearInterval(dragInterval)
          return
        }
        const cursor = screen.getCursorScreenPoint()
        win.setBounds({
          x: cursor.x - Math.round(offsetX),
          y: cursor.y - Math.round(offsetY),
          width,
          height,
        })
      } catch {
        if (dragInterval) clearInterval(dragInterval)
      }
    }, 1)
  })

  ipcMain.on('window-drag-end', () => {
    if (dragInterval) {
      clearInterval(dragInterval)
      dragInterval = null
    }
  })

  // 兼容: 单次移动
  ipcMain.handle('window-move', (event, { x, y }) => {
    BrowserWindow.fromWebContents(event.sender)?.setPosition(Math.round(x), Math.round(y))
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 桌面感知 (截屏/剪贴板/前台窗口)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerDesktopAwarenessHandlers(): void {
  ipcMain.handle('capture-screen', async (_event, maxWidth?: number) => {
    return captureScreen(maxWidth)
  })

  ipcMain.handle('read-clipboard', async () => {
    return readClipboard()
  })

  ipcMain.handle('write-clipboard', async (_event, text: string) => {
    await writeClipboard(text)
  })

  ipcMain.handle('read-clipboard-image', async () => {
    return readClipboardImage()
  })

  ipcMain.handle('write-clipboard-image', async (_event, dataUrl: string) => {
    await writeClipboardImage(dataUrl)
  })

  ipcMain.handle('get-active-window', async () => {
    return getActiveWindow()
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 系统监控
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function registerSystemMonitorHandlers(): void {
  ipcMain.handle('get-system-stats', async () => {
    const { getSystemStats } = await getSystemService()
    return getSystemStats()
  })

  ipcMain.handle('start-system-monitor', async () => {
    const { startSystemMonitor } = await getSystemService()
    startSystemMonitor()
  })
}
