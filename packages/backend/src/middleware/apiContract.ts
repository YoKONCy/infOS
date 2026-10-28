import { t as __t } from '../lib/i18n'
import type { MiddlewareHandler } from 'hono'
import { CODE_MESSAGES, type ResponseCode } from '@infos/shared'
import { createLogger } from '../lib/logger'

const logger = createLogger('ApiContract')
const responseCodes = new Set(Object.keys(CODE_MESSAGES))

/** REST响应契约守卫：补齐默认中文消息，并阻止未注册业务码离开后端。 */
export const apiContractMiddleware: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.res.headers.get('X-InfOS-Package-Asset') === '1') return
  if (!c.req.path.startsWith('/api/') || !c.res.headers.get('content-type')?.includes('json'))
    return
  const body = (await c.res
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.code !== 'string') return
  if (!responseCodes.has(body.code)) {
    logger.error(__t('logs.middleware', 'REST响应包含未注册业务码'), {
      code: body.code,
      path: c.req.path,
    })
    body.code = 'INTERNAL_ERROR'
    body.message = CODE_MESSAGES.INTERNAL_ERROR
    c.res = rebuild(c.res, body, 500)
    return
  }
  if (typeof body.message !== 'string' || !body.message.trim()) {
    body.message = CODE_MESSAGES[body.code as ResponseCode]
    c.res = rebuild(c.res, body)
  }
}

function rebuild(response: Response, body: unknown, status = response.status): Response {
  const headers = new Headers(response.headers)
  headers.set('content-type', 'application/json; charset=UTF-8')
  headers.delete('content-length')
  return new Response(JSON.stringify(body), { status, statusText: response.statusText, headers })
}
