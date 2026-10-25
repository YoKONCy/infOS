/**
 * Transport 层 — 前端通信抽象
 *
 * 核心设计：前端代码 **0 个 Electron 依赖**。
 * 通过 Transport 接口隔离 Electron IPC 和 HTTP。
 *
 * - Docker/Web 模式 → HttpTransport (纯 fetch)
 * - Electron 模式   → ElectronTransport (API 走 HTTP, 系统能力走 IPC)
 *
 */

import type { ApiResponse } from '@infos/shared'
import { getLocale, translate } from '@infos/shared/i18n'

/**
 * Electron 模式下后端服务根地址。
 *
 * 所有 localhost:9120 引用**必须**使用此常量，
 * 禁止在其他文件中硬编码端口号 (S05 §3)。
 *
 * 原生客户端由主进程提供已选业务服务器地址，兼容本地与远程模式。
 */
export const ELECTRON_BACKEND_ORIGIN =
  (typeof window !== 'undefined' && window.electron?.backendOrigin?.()) || 'http://localhost:9120'

export function isElectronRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as Record<string, unknown>).electron !== undefined
  )
}

const WEB_SERVER_KEY = 'infos.currentServerOrigin'
const WEB_SERVER_TOKEN_KEY = 'infos.currentServerToken'

export function getWebServerOrigin(): string {
  if (typeof window === 'undefined') return ''
  if (isElectronRuntime()) return ELECTRON_BACKEND_ORIGIN
  try {
    return localStorage.getItem(WEB_SERVER_KEY) || window.location.origin
  } catch {
    return window.location.origin
  }
}

export function setWebServerOrigin(origin: string, token = ''): void {
  if (isElectronRuntime())
    throw new Error(translate('ui.connection', '桌面客户端请通过连接窗口切换服务器。'))
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('服务器地址必须使用 HTTP 或 HTTPS')
  localStorage.setItem(WEB_SERVER_KEY, url.origin)
  if (token) sessionStorage.setItem(WEB_SERVER_TOKEN_KEY, token)
  else sessionStorage.removeItem(WEB_SERVER_TOKEN_KEY)
}

export function clearWebClientCredential(): void {
  if (!isElectronRuntime()) sessionStorage.removeItem(WEB_SERVER_TOKEN_KEY)
}

export function getClientToken(): string {
  if (isElectronRuntime()) return window.electron?.clientCredential?.() || ''
  return typeof sessionStorage === 'undefined'
    ? ''
    : sessionStorage.getItem(WEB_SERVER_TOKEN_KEY) || ''
}

/** 普通请求、SSE 和二进制上传共用凭据与未授权通知。 */
export async function clientFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers)
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', getLocale())
  const token = getClientToken()
  if (token) headers.set('Authorization', 'Bearer ' + token)
  const response = await fetch(url, { ...options, headers, credentials: 'include' })
  if (response.status === 401 && typeof window !== 'undefined')
    window.dispatchEvent(new Event('infos:unauthorized'))
  return response
}

export function getGatewayWsUrl(): string {
  if (isElectronRuntime()) {
    const token = getClientToken()
    return `${ELECTRON_BACKEND_ORIGIN.replace(/^http/, 'ws')}/ws/gateway${token ? `?token=${encodeURIComponent(token)}` : ''}`
  }

  const origin = getWebServerOrigin()
  const protocol = origin.startsWith('https:') ? 'wss:' : 'ws:'
  const token =
    typeof sessionStorage === 'undefined'
      ? ''
      : (sessionStorage.getItem(WEB_SERVER_TOKEN_KEY) ?? '')
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${protocol}//${new URL(origin).host}/ws/gateway${query}`
}

// ─────────────────────────────────────────────
// Transport 接口
// ─────────────────────────────────────────────

export interface Transport {
  /** HTTP API 请求 */
  request<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T>>
  /** 系统能力调用 (Electron IPC / HTTP 替代) */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
}

// ─────────────────────────────────────────────
// Docker / 纯 Web 模式
// ─────────────────────────────────────────────

class HttpTransport implements Transport {
  async request<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T>> {
    const headers = new Headers(options?.headers)
    if (!(options?.body instanceof FormData) && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json')
    const method = (options?.method ?? 'GET').toUpperCase()
    // 状态、历史与审批读取不能在网络切换后无限挂起；流式请求与写操作沿用各自的生命周期。
    const signal =
      options?.signal ??
      (method === 'GET' || method === 'HEAD' ? AbortSignal.timeout(15_000) : undefined)
    const res = await clientFetch(`${getWebServerOrigin()}/api${endpoint}`, {
      ...options,
      signal,
      headers,
    })

    if (!res.ok) {
      // 服务端返回了 HTTP 错误但仍有 JSON body
      const body = await res.json().catch(() => ({
        code: 'NETWORK_ERROR',
        message: `HTTP ${res.status} ${res.statusText}`,
      }))
      return body as ApiResponse<T>
    }

    return res.json()
  }

  async invoke<T>(channel: string, ..._args: unknown[]): Promise<T> {
    // 原生能力没有虚构的 /api/ipc 映射，业务功能应使用其明确的服务端接口。
    throw new Error(`浏览器客户端不提供本机窗口接口：${channel}`)
  }
}

// ─────────────────────────────────────────────
// Electron 模式
// ─────────────────────────────────────────────

class ElectronTransport extends HttpTransport {
  override async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    // Electron 专属能力走 IPC
    return (
      window as unknown as {
        electron: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> }
      }
    ).electron.invoke(channel, ...args)
  }
}

// ─────────────────────────────────────────────
// 自动选择
// ─────────────────────────────────────────────

/** 当前 Transport 实例 (单例) */
export const transport: Transport = isElectronRuntime()
  ? new ElectronTransport()
  : new HttpTransport()

/**
 * 获取 API 根路径 (含 /api 前缀)
 *
 * 用于非 fetch 场景 (如 img src) 拼接完整 URL。
 * Electron: http://localhost:9120/api
 * Web:      {window.location.origin}/api
 */
export function getApiBaseUrl(): string {
  if (isElectronRuntime()) return `${ELECTRON_BACKEND_ORIGIN}/api`
  return `${getWebServerOrigin()}/api`
}

/** 原生媒体元素与 PDF Range 请求使用现有查询参数鉴权。地址仅发往已配置的服务端。 */
export function getApiResourceUrl(endpoint: string, query: URLSearchParams): string {
  const params = new URLSearchParams(query)
  const token =
    !isElectronRuntime() && typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(WEB_SERVER_TOKEN_KEY)
      : null
  if (token) params.set('token', token)
  const suffix = params.toString()
  return `${getApiBaseUrl()}${endpoint}${suffix ? `?${suffix}` : ''}`
}

/** PDF Range 等由库直接发出的请求，凭据只允许传给当前业务服务端。 */
export function getApiResourceHeaders(url: string): Record<string, string> {
  const base = new URL(getApiBaseUrl())
  const target = new URL(url, base)
  const token = getClientToken()
  return token && target.origin === base.origin && target.pathname.startsWith('/api/')
    ? { Authorization: `Bearer ${token}` }
    : {}
}

/** 非 JSON 资源读取仍集中经过通信层，保留取消与鉴权。 */
export async function requestApiResource(
  endpoint: string,
  query: URLSearchParams,
  signal?: AbortSignal,
) {
  const response = await clientFetch(getApiResourceUrl(endpoint, query), { signal })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.message || `文件读取失败（HTTP ${response.status}）`)
  }
  return response
}

/** 音频等二进制请求复用当前服务器、鉴权与取消信号。 */
export async function requestApiBinary(
  endpoint: string,
  options: RequestInit,
): Promise<ArrayBuffer> {
  const response = await clientFetch(`${getApiBaseUrl()}${endpoint}`, options)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.message || `语音请求失败（HTTP ${response.status}）`)
  }
  return response.arrayBuffer()
}
