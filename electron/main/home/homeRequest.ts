/** @platform ELECTRON 家的可信 HTTP 入口；卡片只能调用固定操作。 */
import { getBackendOrigin } from '../services/clientConnection'
import { getClientCredential } from '../utils/clientCredential'
import { getLocale } from '../utils/i18n'
import type { HomeScope } from '../../../packages/shared/src/home'

export async function homeRequest<T>(
  endpoint: string,
  scope: HomeScope,
  input: unknown,
): Promise<T> {
  const token = getClientCredential()
  const response = await fetch(`${getBackendOrigin()}/api/home${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': getLocale(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ scope, input }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  }).catch(() => {
    throw new Error('HOME_REQUEST_FAILED')
  })
  const body = (await response.json().catch(() => {
    throw new Error('HOME_RESPONSE_INVALID')
  })) as {
    code: string
    message?: string
    data?: T & { homeCode?: string }
  }
  if (!body || typeof body !== 'object') throw new Error('HOME_RESPONSE_INVALID')
  if (!response.ok || body.code !== 'OK')
    throw new Error(`${body.data?.homeCode ?? body.code}: ${body.message ?? response.status}`)
  return body.data as T
}
