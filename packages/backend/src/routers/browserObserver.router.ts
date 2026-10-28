import { Hono } from 'hono'
import { z } from 'zod'
import type { BrowserObserverSession } from '@infos/shared'
import type { AppContext } from '../container'
import { validate } from '../lib/validation'
import { AppError } from '../lib/appError'

const owner = z.object({
  agentId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256),
})

/** 沿用主应用鉴权，每次读取重新核对会话归属；不接受页面目标、操作或视口参数。 */
export function createBrowserObserverRouter(ctx: AppContext) {
  const router = new Hono()
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })
  const assertOwner = async (agentId: string, threadId: string) => {
    const thread = await ctx.threadService.getThread(threadId)
    if (!thread || thread.agentId !== agentId) throw new AppError('FORBIDDEN')
  }
  router.get('/sessions', validate('query', owner), async (c) => {
    const { agentId, threadId } = c.req.valid('query')
    await assertOwner(agentId, threadId)
    const sessions = ctx.browserTools.listObservations(agentId)
    const data: BrowserObserverSession[] = []
    for (const session of sessions) {
      if (session.threadId === threadId) {
        data.push(session)
        continue
      }
      // 只把当前对话交办的任务及子任务带回小窗，不混入其他对话或渠道。
      if (!session.taskId) continue
      let task = await ctx.backgroundTaskRepo.findById(session.taskId)
      if (!task || task.agentId !== agentId || task.threadId !== session.threadId) continue
      const visited = new Set<string>()
      while (task && task.agentId === agentId && !visited.has(task.id) && visited.size < 8) {
        visited.add(task.id)
        if (task.targetThreadId === threadId) {
          data.push(session)
          break
        }
        task = task.parentTaskId ? await ctx.backgroundTaskRepo.findById(task.parentTaskId) : null
      }
    }
    return c.json({ code: 'OK', data })
  })
  router.get('/sessions/:id/frame', validate('query', owner), async (c) => {
    const { agentId, threadId } = c.req.valid('query')
    await assertOwner(agentId, threadId)
    const data = await ctx.browserTools.observe(c.req.param('id'), agentId, threadId)
    return c.json({ code: 'OK', data })
  })
  return router
}
