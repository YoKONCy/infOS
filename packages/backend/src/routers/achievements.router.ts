import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'

export function createAchievementsRouter(ctx: AppContext): Hono {
  const router = new Hono()
  const subject = (request: Request) => {
    const identity = ctx.clientAccess.authenticate(request)
    if (!identity) throw new AppError('UNAUTHORIZED')
    return identity.id
  }
  router.get('/', (c) =>
    c.json({ code: 'OK', data: ctx.achievementService.snapshot(subject(c.req.raw)) }),
  )
  const submission = z.object({
    achievementId: z.literal('fresh_start'),
    steamId: z.string().regex(/^\d{17}$/),
    submitted: z.boolean().optional(),
  })
  // 此入口只认领已达成记录，不接收任何解锁指令；Steam 原生调用由客户端主进程完成。
  router.post('/steam', async (c) => {
    const subjectId = subject(c.req.raw)
    const input = submission.parse(await c.req.json())
    if (!ctx.achievementService.claimSteamAccount(subjectId, input.achievementId, input.steamId))
      throw new AppError('CONFLICT')
    if (input.submitted)
      ctx.achievementService.markSteamSubmitted(subjectId, input.achievementId, input.steamId)
    return c.json({ code: 'OK' })
  })
  return router
}
