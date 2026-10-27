import type { Asset, Bootstrap, HostStatus, Run, SurfaceBridge } from '../types'

export const desktop = (window as unknown as { electron?: SurfaceBridge }).electron
const root = '/api/applications/pictoria'
const parameters = new URLSearchParams(window.location.search)
// 宿主发布路径本身可识别挂载模式，直接访问 Docker 页面无需手工补参数。
const hostedPath = /^\/applications\/pictoria(?:\/|$)/.test(window.location.pathname)
export const standalone = !desktop?.embedded && !parameters.has('kernelOrigin') && !hostedPath
const standaloneOrigin = new URL(
  parameters.get('pictoriaOrigin') ||
    (window.location.port === '7363' ? 'http://127.0.0.1:7364' : window.location.origin),
)
export const clipboardScope = standalone
  ? standaloneOrigin.origin
  : parameters.get('kernelOrigin') || window.location.origin
const sessionKey = `pictoria.session.${standaloneOrigin.origin}`
if (standalone) {
  const fragment = new URLSearchParams(window.location.hash.slice(1)),
    token = fragment.get('pictoria-session')
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    sessionStorage.setItem(sessionKey, token)
    fragment.delete('pictoria-session')
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${fragment.size ? `#${fragment}` : ''}`,
    )
  }
}

/** 独立浏览器直接连接 Pictoria；挂载模式通过受限桥接，不持有宿主桥接密钥。 */
async function request<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  if (desktop?.embedded)
    return desktop.invoke('pictoria:request', { action, ...input }) as Promise<T>
  if (standalone) {
    if (
      !['http:', 'https:'].includes(standaloneOrigin.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(standaloneOrigin.hostname)
    )
      throw new Error('独立后台必须使用本机地址')
    const response = await fetch(`${standaloneOrigin.origin}/pictoria-api/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pictoria-session': sessionStorage.getItem(sessionKey) || '',
      },
      body: JSON.stringify({ action, ...input }),
      signal: AbortSignal.timeout(90_000),
      redirect: 'error',
    })
    const result = (await response.json()) as { code: string; data: T; message?: string }
    if (!response.ok || result.code !== 'OK')
      throw new Error(result.message || '暂时无法连接 Pictoria 后台')
    return result.data
  }
  let path: string
  let method = 'POST'
  let body: unknown
  if (action === 'bootstrap') {
    path = '/canvas/bootstrap'
    method = 'GET'
  } else if (action === 'start') path = '/start'
  else if (action === 'stop') path = '/stop'
  else if (action === 'operation') {
    path = `/operations/${encodeURIComponent(String(input.operation))}`
    body = { agentId: input.agentId, input: input.input }
  } else if (action === 'upload') {
    path = '/canvas/assets'
    body = input.input
  } else if (action === 'run') {
    path = '/canvas/run'
    body = input.input
  } else if (action === 'asset') {
    path = `/canvas/assets/${encodeURIComponent(String(input.id))}?agentId=${encodeURIComponent(String(input.agentId))}`
    method = 'GET'
  } else throw new Error('未知画布操作')
  const configured = new URLSearchParams(window.location.search).get('kernelOrigin')
  const origin = new URL(configured || window.location.origin)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    (origin.origin !== window.location.origin &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
  )
    throw new Error('画布控制面地址无效')
  const token =
    origin.origin === window.location.origin
      ? sessionStorage.getItem('infos.currentServerToken')
      : null
  const response = await fetch(`${origin.origin}${root}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(90_000),
    redirect: 'error',
  })
  const result = (await response.json()) as { code: string; data: T; message?: string }
  if (!response.ok || result.code !== 'OK')
    throw new Error(result.message || '暂时无法连接创作后台')
  return result.data
}

export const pictoria = {
  bootstrap: () => request<Bootstrap>('bootstrap'),
  start: () => request<HostStatus>('start'),
  stop: () => request<HostStatus>('stop'),
  operation: <T>(agentId: string, operation: string, input: Record<string, unknown> = {}) =>
    request<T>('operation', { agentId, operation, input }),
  upload: (agentId: string, name: string, mimeType: string, base64: string) =>
    request<Asset>('upload', { input: { agentId, name, mimeType, base64 } }),
  asset: (agentId: string, id: string) =>
    request<{ info: Asset; base64: string }>('asset', { agentId, id }),
  run: (agentId: string, input: Record<string, unknown>, key: string) =>
    request<{ accepted: boolean; taskId: string; projectId: string }>('run', {
      input: { agentId, input, key },
    }),
  task: (agentId: string, id: string): Promise<Run | null> =>
    pictoria.operation<Run | null>(agentId, 'task.get', { id }),
}

export function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('素材读取失败'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.readAsDataURL(file)
  })
}
