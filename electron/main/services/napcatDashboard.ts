import { t as __t } from '../utils/i18n'
import { getClientCredential } from '../utils/clientCredential'
import { getBackendOrigin } from './clientConnection'
import { BrowserWindow, app, session } from 'electron'
import http from 'node:http'
import { desktopTabs } from '../windows/desktopTabs'
import { getNapCatStatus, getNapCatDashboardEndpoint, startNapCat } from './napcat'
import { createApplicationWaitingPage } from '@infos/shared'
import { isNapCatWebUiDocument } from './napcatWebUi'
import { logger } from '../utils/logger'

export const NAPCAT_APPLICATION_ID = 'infos.napcat'
type DashboardPhase = 'stopped' | 'starting' | 'ready' | 'error'
let phase: DashboardPhase = 'stopped'
let error = ''
let registered = false
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let origin: string | undefined
let loadedUrl = ''
let startedAt = 0
let processId: number | null = null
const preparedOrigins = new Map<string, Promise<void>>()

/** 仅清理管理标签的程序缓存；Cookie、localStorage 和 QQ 登录数据全部保留。 */
export function prepareDashboardSession(endpoint: URL): Promise<void> {
  const existing = preparedOrigins.get(endpoint.origin)
  if (existing) return existing
  const operation = (async () => {
    const partition = session.fromPartition('persist:infos-napcat-webui')
    const results = await Promise.allSettled([
      partition.clearStorageData({
        origin: endpoint.origin,
        storages: ['serviceworkers', 'cachestorage'],
      }),
      partition.clearCache(),
    ])
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('管理页部分缓存未完成清理')
  })().catch(() => {
    preparedOrigins.delete(endpoint.origin)
    logger.warn('NapCat', __t('electron.logs.napcatDashboard', '管理页缓存清理未完成，将继续加载'))
  })
  preparedOrigins.set(endpoint.origin, operation)
  return operation
}

const pages = new Set<string>()
function waitingPage(): string {
  const dark = desktopTabs.getTheme() === 'dark'
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(createApplicationWaitingPage({ dark, applicationName: 'NapCat 管理页' }))}`
  pages.add(url)
  return url
}

function setPhase(next: DashboardPhase, message = ''): void {
  if (phase === next && error === message) return
  phase = next
  error = message
  const status = getNapCatDashboardStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('napcat-state-changed', status)
  }
}

export function getNapCatDashboardStatus() {
  const status = getNapCatStatus()
  return {
    ...status,
    webUi: status.running ? phase : 'stopped',
    webUiError: status.running ? error : '',
  }
}

export function initializeNapCatDashboard(): void {
  if (registered) return
  registered = true
  desktopTabs.registerApplication({
    id: NAPCAT_APPLICATION_ID,
    title: 'NapCat',
    description: __t('electron.ui.napcatDashboard', 'QQ 登录与机器人管理'),
    icon: 'chat',
    url: waitingPage(),
    preload: false,
    embedded: false,
    sensitive: true,
    partition: 'persist:infos-napcat-webui',
    acceptsUrl: (url) =>
      pages.has(url.href) ||
      (url.protocol === 'http:' &&
        url.origin === origin &&
        !url.username &&
        !url.password &&
        /^\/webui(?:\/|$)/.test(url.pathname)),
    isWaitingUrl: (url) => pages.has(url.href),
  })
  app.once('before-quit', () => {
    generation++
    clearTimeout(timer)
  })
}

/** 就绪探测不携带凭据，端口必须来自当前 NapCat 进程的启动日志。 */
function isReady(endpoint: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timeout)
      resolve(ready)
    }
    const request = http.get(new URL('/webui/', endpoint.origin), (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        text += chunk
        if (text.length > 65536) response.destroy()
      })
      response.on('end', () =>
        finish(isNapCatWebUiDocument(response.statusCode, response.headers['content-type'], text)),
      )
      response.on('close', () => finish(false))
      response.on('error', () => finish(false))
    })
    const timeout = setTimeout(() => {
      request.destroy()
      finish(false)
    }, 1500)
    request.on('error', () => finish(false))
  })
}

async function watchDashboard(epoch: number): Promise<void> {
  if (epoch !== generation) return
  const status = getNapCatStatus()
  if (!status.running) {
    setPhase('stopped')
    desktopTabs.setApplicationError(NAPCAT_APPLICATION_ID, 'NapCat 已停止，请回到社交配置重新启动')
    return
  }
  if (!desktopTabs.getApplicationState(NAPCAT_APPLICATION_ID).open) return
  try {
    if (processId !== status.pid) {
      processId = status.pid
      loadedUrl = ''
      origin = undefined
      startedAt = Date.now()
      setPhase('starting')
    }
    const endpoint = getNapCatDashboardEndpoint()
    if (endpoint && endpoint.href !== loadedUrl) {
      if (await isReady(endpoint)) {
        await prepareDashboardSession(endpoint)
        if (epoch !== generation || !getNapCatStatus().running) return
        if (!desktopTabs.getApplicationState(NAPCAT_APPLICATION_ID).open) return
        origin = endpoint.origin
        const loaded = await desktopTabs.navigateApplication(NAPCAT_APPLICATION_ID, endpoint.href)
        if (epoch !== generation) return
        if (!desktopTabs.getApplicationState(NAPCAT_APPLICATION_ID).open) return
        if (loaded) {
          loadedUrl = endpoint.href
          setPhase('ready')
        } else {
          setPhase('error', '管理页加载失败，请重新打开管理页')
          return
        }
      }
    }
    if (!loadedUrl && Date.now() - startedAt > 45000)
      throw new Error('管理页尚未就绪，请检查 NapCat 日志后重试')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'NapCat 管理页暂不可用'
    setPhase('error', message)
    desktopTabs.setApplicationError(NAPCAT_APPLICATION_ID, message)
    return
  }
  if (epoch === generation) timer = setTimeout(() => void watchDashboard(epoch), 1500)
}

export async function openNapCatDashboard(replaceId?: string) {
  initializeNapCatDashboard()
  if (!getNapCatStatus().running) throw new Error('NapCat 未运行，请先启动')
  const wasOpen = desktopTabs.getApplicationState(NAPCAT_APPLICATION_ID).open
  const state = desktopTabs.openApplication(NAPCAT_APPLICATION_ID, waitingPage(), replaceId)
  desktopTabs.reveal(state.activeTabId)
  const epoch = ++generation
  clearTimeout(timer)
  const tabError = state.tabs.find((t) => t.id === state.activeTabId)?.error
  const alreadyPreparing =
    wasOpen && phase === 'starting' && !tabError && processId === getNapCatStatus().pid
  // 已有标签保留当前输入；只有启动失败或新进程才重新加载。
  if (
    !wasOpen ||
    phase === 'error' ||
    tabError ||
    (!loadedUrl && !alreadyPreparing) ||
    processId !== getNapCatStatus().pid
  ) {
    loadedUrl = ''
    startedAt = Date.now()
    setPhase('starting')
    if (wasOpen) await desktopTabs.navigateApplication(NAPCAT_APPLICATION_ID, waitingPage())
  }
  void watchDashboard(epoch)
  return desktopTabs.snapshot()
}

export async function startNapCatWithDashboard(replaceId?: string) {
  if (!getNapCatStatus().running) {
    try {
      const token = getClientCredential()
      const response = await fetch(`${getBackendOrigin()}/api/social/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(5000),
      })
      const body = (await response.json()) as { data?: { adapters?: Array<{ platform: string }> } }
      if (!response.ok || !body.data?.adapters?.some((a) => a.platform === 'qq'))
        throw new Error('社交服务未就绪')
    } catch {
      throw new Error('社交服务未就绪，请先检查社交配置与后端运行状态')
    }
    processId = null
    loadedUrl = ''
    origin = undefined
  }
  await startNapCat()
  return openNapCatDashboard(replaceId)
}
