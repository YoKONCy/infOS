/**
 * @file 桌面卡片的沙箱窗口
 * @description 阶段 4：为每张卡片创建隔离的 BrowserWindow 与内存 session。
 *
 *              - session：拒绝全部权限请求与下载；只放行本卡片的 `infos-card://<ID>/` 与内联 data / blob 资源；
 *                `infos-card` 协议只返回本卡片的 index.html，并附带 CSP（不能联网、不能嵌套页面）。
 *              - 网络旁路：session 使用不可达的代理（`127.0.0.1:9`），绕过 CSP / webRequest 的
 *                dns-prefetch、preconnect 等也连不出去；WebRTC 禁止非代理 UDP（STUN / TURN）。
 *                `infos-card://` 由自定义协议处理，不经过代理。
 *              - 窗口：sandbox、contextIsolation、禁止 Node 与 webview；拒绝导航、重定向与新窗口；
 *                忽略页面的 onbeforeunload，卡片总能关闭；唯一 preload 是 `preload/card.js`（只暴露 `window.infosCard`）。
 *              - 预制件（受信任的内置卡片）沿用同一套沙箱，另用 `preload/prefab.js`（不向页面暴露任何接口）
 *                与更严的 CSP（页面不能运行脚本），窗口全透明、不用毛玻璃、不可原生缩放（由页面内的手柄缩放）。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 * @module electron/main/windows/desktopCardWindow
 */

import path from 'node:path'
import { release } from 'node:os'
import { t } from '../utils/i18n'
import { homeCardFailureHtml, supportsHomeCardMaterial } from '../home/homeCardAppearance'
import { BrowserWindow, app, session } from 'electron'
import {
  CARD_MIN_SIZE,
  DESKTOP_CARD_CSP,
  DESKTOP_CARD_SCHEME,
  DESKTOP_PREFABS,
  DESKTOP_PREFAB_CSP,
  desktopCardDocumentPath,
  desktopCardUrl,
  isDesktopCardRequestAllowed,
  type DesktopCardMeta,
} from '../../../packages/shared/src/desktopCards'
import type { ShellRect } from '../../../packages/shared/src/desktopShell'

/**
 * 卡片 session 的代理：discard 端口上的本机地址，任何走网络栈的请求都会失败。
 * 不设绕过规则（`<-loopback>` 表示连本机也走代理），本机服务同样连不上。
 */
export const DESKTOP_CARD_PROXY: Electron.ProxyConfig = {
  mode: 'fixed_servers',
  proxyRules: 'http://127.0.0.1:9',
  proxyBypassRules: '<-loopback>',
}

/** 已配置过的 session（同一张卡片重新打开时复用）。 */
const configured = new Map<string, Promise<void>>()

/** 卡片 session 的分区名；不带 `persist:`，只存在于内存中，卡片之间互不共享存储。 */
export function desktopCardPartition(id: string): string {
  return `infos-card-${id}`
}

/** 协议响应：只有本卡片的 index.html；其他路径或卡片不存在时返回 404。 */
export function desktopCardResponse(
  id: string,
  url: string,
  readHtml: (id: string) => string | undefined,
  csp: string = DESKTOP_CARD_CSP,
): Response {
  const html = desktopCardDocumentPath(id, url) ? readHtml(id) : undefined
  if (html === undefined)
    return new Response(
      homeCardFailureHtml(
        t('home.cards', '卡片加载失败'),
        t('home.cards', '找不到卡片内容，请让她修复或重新创建。'),
      ),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  })
}

function configureSession(id: string, readHtml: (id: string) => string | undefined, csp: string) {
  const partition = desktopCardPartition(id)
  const cardSession = session.fromPartition(partition)
  const existing = configured.get(partition)
  if (existing) return { cardSession, ready: existing }
  cardSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  cardSession.setPermissionCheckHandler(() => false)
  cardSession.setDevicePermissionHandler(() => false)
  cardSession.on('will-download', (event) => event.preventDefault())
  cardSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !isDesktopCardRequestAllowed(id, details.url) }),
  )
  cardSession.protocol.handle(DESKTOP_CARD_SCHEME, (request) =>
    desktopCardResponse(id, request.url, readHtml, csp),
  )
  // 代理生效后才加载页面；设置失败时仍有 CSP 与 webRequest 拦截。
  const ready = cardSession.setProxy(DESKTOP_CARD_PROXY).catch(() => undefined)
  configured.set(partition, ready)
  return { cardSession, ready }
}

/** 创建卡片窗口并加载卡片页面；不抢焦点地显示。 */
export function createDesktopCardWindow(
  card: DesktopCardMeta,
  bounds: ShellRect,
  readHtml: (id: string) => string | undefined,
): BrowserWindow {
  const prefab = card.prefab ? DESKTOP_PREFABS[card.prefab.kind] : undefined
  const minSize = prefab?.minSize ?? CARD_MIN_SIZE
  const { cardSession, ready } = configureSession(
    card.id,
    readHtml,
    prefab ? DESKTOP_PREFAB_CSP : DESKTOP_CARD_CSP,
  )
  const material = supportsHomeCardMaterial(process.platform, release())
  const win = new BrowserWindow({
    ...bounds,
    title: card.name,
    show: false,
    frame: false,
    ...(prefab
      ? {
          // 背景由页面自己画，透明度才真实生效（acrylic 在窗口失焦时会退成不透明的灰色）。
          transparent: true,
          backgroundColor: '#00000000',
          hasShadow: false,
          thickFrame: false,
          // 缩放由页面内的手柄实现；透明窗口的原生边缘不可靠，还会抢走手柄的指针事件。
          resizable: false,
        }
      : material
        ? { backgroundColor: '#00000000', backgroundMaterial: 'acrylic' as const }
        : { backgroundColor: '#ffffff' }),
    minWidth: minSize.width,
    minHeight: minSize.height,
    alwaysOnTop: card.alwaysOnTop,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      session: cardSession,
      preload: path.join(__dirname, prefab ? '../preload/prefab.js' : '../preload/card.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      disableDialogs: true,
      autoplayPolicy: 'user-gesture-required',
      devTools: !app.isPackaged,
    },
  })
  const contents = win.webContents
  let showingFailure = false
  const showFailure = (reason: string) => {
    if (win.isDestroyed() || showingFailure) return
    showingFailure = true
    const html = homeCardFailureHtml(t('home.cards', '卡片加载失败'), reason)
    void win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => undefined)
    win.showInactive()
  }
  contents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && url === desktopCardUrl(card.id)) showingFailure = false
  })
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3)
      showFailure(t('home.cards', '加载未完成：{0}', [`${code} ${description}`]))
  })
  contents.on('render-process-gone', (_event, details) =>
    showFailure(t('home.cards', '卡片进程已停止：{0}', [details.reason])),
  )
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  // 卡片页面不能用 onbeforeunload 阻止关闭。
  contents.on('will-prevent-unload', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-redirect', (event) => event.preventDefault())
  contents.on('will-attach-webview', (event) => event.preventDefault())
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  void ready
    .then(() => (win.isDestroyed() ? undefined : win.loadURL(desktopCardUrl(card.id))))
    .catch((error) => showFailure(t('home.cards', '加载未完成：{0}', [String(error)])))
  return win
}
