/**
 * 主进程调用后端 /api/home 的最小客户端（不依赖 Electron，便于测试）。
 *
 * 凭据只留在主进程；卡片脚本、通知页面都不能拿到它，也不能指定任意路径。
 * 后端错误统一成 HomeApiError：code 是信封 code，homeCode 是家的稳定错误码。
 */

export class HomeApiError extends Error {
  constructor(
    readonly code: string,
    readonly homeCode: string | undefined,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`${homeCode ?? code}: ${message}`)
    this.name = 'HomeApiError'
  }
}

export interface HomeApiDependencies {
  origin(): string
  credential(): string
  request: typeof fetch
}

export type HomeApiCall = <T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>

/** 只允许 /api/home 下的相对路径，防止被拼成别的接口。 */
function safePath(path: string): string {
  if (!/^\/[a-z0-9/_:.?=&%-]*$/i.test(path) || path.includes('..'))
    throw new HomeApiError('INVALID_PARAMETER', 'HOME_INVALID', 'invalid home api path')
  return path
}

export function createHomeApi(deps: HomeApiDependencies): HomeApiCall {
  return async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const token = deps.credential()
    const response = await deps.request(`${deps.origin()}/api/home${safePath(path)}`, {
      method,
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let envelope: { code?: string; message?: string; data?: unknown }
    try {
      envelope = (await response.json()) as typeof envelope
    } catch {
      throw new HomeApiError(`HTTP_${response.status}`, undefined, response.statusText)
    }
    if (!response.ok || envelope.code !== 'OK') {
      const data = envelope.data as { homeCode?: unknown; detail?: unknown } | undefined
      throw new HomeApiError(
        envelope.code ?? `HTTP_${response.status}`,
        typeof data?.homeCode === 'string' ? data.homeCode : undefined,
        envelope.message ?? response.statusText,
        data?.detail,
      )
    }
    return envelope.data as T
  }
}
