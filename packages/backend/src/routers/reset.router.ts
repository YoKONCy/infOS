import { t as __t } from '../lib/i18n'
/**
 * Reset Router — 危险区域重置 API
 *
 * 三个端点均要求调用方提交确认短语，防止误触：
 * - POST /api/reset/clear-logs      确认短语：清空记录
 * - POST /api/reset/memories        确认短语：忘掉一切
 * - POST /api/reset/factory         确认短语：我们还会再见的
 *
 * 端点均为物理删除且不可撤销，执行成功后前端应刷新页面。
 *
 * @module packages/backend/src/routers/reset.router
 */

import { Hono } from 'hono'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import { AppError } from '../lib/appError'
import type { AppContext } from '../container'

/** 各操作的确认短语（与前端提示保持一致） */
const CONFIRM_PHRASES = {
  'clear-logs': '清空记录',
  memories: '忘掉一切',
  factory: '我们还会再见的',
} as const

const confirmSchema = z.object({
  confirm: z.string().min(1, '请填写确认短语'),
  includeSocial: z.boolean().default(true),
})

export function createResetRouter(ctx: AppContext) {
  const router = new Hono()

  router.post('/clear-logs', zValidator('json', confirmSchema), async (c) => {
    const { confirm } = c.req.valid('json')
    if (confirm.trim() !== CONFIRM_PHRASES['clear-logs']) {
      throw new AppError('INVALID_PARAMETER', { message: '确认短语不匹配，操作已取消' })
    }
    const mainThreads = await Promise.all(ctx.agentManager.listAgents().map((agent) => ctx.threadService.getMainThread(agent.id)))
    const releases: Array<() => void> = []
    try {
      for (const main of mainThreads) releases.push(ctx.conversationQueue.beginHistoryChange(main.id))
      for (const task of ctx.runtimeStateService.listActiveTasks()) ctx.runtimeStateService.cancelTask(task.threadId)
      for (const execution of ctx.kernelScheduler.list()) {
        if (execution.descriptor.threadId) await ctx.kernelScheduler.cancel(execution.descriptor.executionId)
      }
      const cancellation = __t('errors.backend', '会话已重置，本次执行已过期')
      const affected = new Set([
        ...mainThreads.map((thread) => thread.id),
        ...ctx.runtimeStateService.listActiveTasks().map((task) => task.threadId),
        ...ctx.approvalService.list().map((request) => request.threadId),
        ...ctx.agentInputService.list().map((request) => request.threadId),
      ])
      for (const threadId of affected) {
        ctx.approvalService.cancelThread(threadId, cancellation)
        ctx.agentInputService.cancelThread(threadId, cancellation)
      }
      const result = await ctx.promptWorkspace.variableStore.clearConversationScopes((configuration) =>
        ctx.resetService.clearLogs(configuration),
      )
      ctx.home.closeAllSessions()
      for (const threadId of affected) {
        ctx.runtimeStateService.unregisterTask(threadId)
        ctx.conversationQueue.historyChanged(threadId, false, true)
        ctx.conversationQueue.setLive(threadId)
        ctx.toolContextService.deleteThread(threadId)
        ctx.conversationProjection.invalidate(threadId)
      }
      for (const main of mainThreads) {
        await ctx.companionSchedulerService.discardThreadActivity(main.id)
        const current = await ctx.threadService.getThread(main.id)
        if (current) await ctx.gatewayHub.pushBusiness('thread_reset', {
          threadId: current.id, agentId: current.agentId, generation: current.generation,
        }, { type: 'all_principal_clients', principalId: current.agentId }).catch(() => {})
      }
      return c.json({ code: 'OK', message: __t('server.routers', '对话记录已清空'), data: result })
    } finally {
      for (const release of releases) release()
    }
  })

  router.post('/memories', zValidator('json', confirmSchema), async (c) => {
    const { confirm } = c.req.valid('json')
    if (confirm.trim() !== CONFIRM_PHRASES.memories) {
      throw new AppError('INVALID_PARAMETER', { message: '确认短语不匹配，操作已取消' })
    }
    await ctx.privacyDeletionService.resetMemories(c.req.valid('json').includeSocial)
    const result = { operation: 'reset_memories', cleared: {} }
    return c.json({ code: 'OK', message: __t('server.routers', '记忆已重置'), data: result })
  })

  router.post('/factory', zValidator('json', confirmSchema), async (c) => {
    const { confirm } = c.req.valid('json')
    if (confirm.trim() !== CONFIRM_PHRASES.factory) {
      throw new AppError('INVALID_PARAMETER', { message: '确认短语不匹配，操作已取消' })
    }
    const knowledge = await ctx.knowledgeService.clear()
    ctx.home.closeAllSessions()
    await ctx.privacyDeletionService.resetMemories()
    const result = await ctx.resetService.factoryReset()
    for (const agent of ctx.agentManager.listAgents()) await ctx.threadService.getMainThread(agent.id)
    result.cleared.knowledge_documents = knowledge.documentCount
    result.cleared.knowledge_parts = knowledge.partCount
    return c.json({ code: 'OK', message: __t('server.routers', '已恢复出厂设置'), data: result })
  })

  return router
}
