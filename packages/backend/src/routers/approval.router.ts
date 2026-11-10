import { Hono } from 'hono'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'
import { HOME_CHAT_CONFIRM_TOOL } from '../services/home/homeConfirmWait'

const resolveSchema = z.object({
  decision: z.enum(['allow_once', 'allow_session', 'deny_once']),
  /** 决策附言：同意/拒绝时写给 Agent 的理由（可选，最长 2000 字） */
  message: z.string().max(2000).optional(),
})

/** 工具审批 API；前端后续可直接消费此契约。 */
export function createApprovalRouter(ctx: AppContext) {
  const router = new Hono()

  router.get('/', (c) => {
    const status = c.req.query('status') as
      | 'pending'
      | 'approved'
      | 'denied'
      | 'consumed'
      | undefined
    const requests = ctx.approvalService.list({
      status,
      agentId: c.req.query('agentId'),
      sessionId: c.req.query('sessionId'),
    })
    return c.json({ code: 'OK', data: { requests, total: requests.length } })
  })

  router.get('/audit', (c) => {
    const records = ctx.approvalService.listAudit({
      approvalId: c.req.query('approvalId'),
      sessionId: c.req.query('sessionId'),
    })
    return c.json({ code: 'OK', data: { records, total: records.length } })
  })

  router.get('/:id', (c) => {
    const request = ctx.approvalService.get(c.req.param('id'))
    if (!request) throw new AppError('NOT_FOUND', { message: '审批请求不存在' })
    return c.json({ code: 'OK', data: request })
  })

  router.post('/:id/resolve', zValidator('json', resolveSchema), (c) => {
    const input = c.req.valid('json')
    // 家的确认只有管理身份能答，普通配对设备不能替用户应答。
    if (
      ctx.approvalService.get(c.req.param('id'))?.toolName === HOME_CHAT_CONFIRM_TOOL &&
      ctx.clientAccess &&
      !ctx.clientAccess.authenticate(c.req.raw)?.admin
    )
      throw new AppError('FORBIDDEN')
    const request = ctx.approvalService.resolve(c.req.param('id'), input.decision, input.message)
    return c.json({ code: 'OK', data: request })
  })

  return router
}
