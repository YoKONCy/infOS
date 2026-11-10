/**
 * Reset Router 单元测试
 *
 * 验证三个危险重置端点的确认短语防护：
 * - 确认短语正确 → 调用对应 Service 并返回 OK
 * - 确认短语不匹配 → 400 INVALID_PARAMETER，且不调用 Service
 * - 缺少 confirm 字段 → 400 参数校验失败
 *
 * @module packages/backend/tests/unit/routers/resetRouter.test
 */

import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createResetRouter } from '@infos/backend/routers/reset.router'
import { errorHandler } from '@infos/backend/middleware/errorHandler'
import type { ApiResponse } from '@infos/shared'

/** 创建带 mock Service 的路由实例（挂载真实 errorHandler 以获得准确 HTTP 状态码） */
function makeRouter(service: ReturnType<typeof createMockService>) {
  const app = new Hono()
  app.onError(errorHandler)
  app.route(
    '/',
    createResetRouter({
      resetService: service,
      home: { closeAllSessions: vi.fn() },
      privacyDeletionService: { resetMemories: service.resetMemories },
      knowledgeService: { clear: service.clearKnowledge },
      agentManager: { listAgents: () => [] },
      runtimeStateService: { listActiveTasks: () => [] },
      kernelScheduler: { list: () => [] },
      approvalService: { list: () => [] },
      agentInputService: { list: () => [] },
      promptWorkspace: { variableStore: {
        clearConversationScopes: async (commit: (configuration: { key: string; value: string }) => Promise<unknown>) =>
          commit({ key: 'prompt.variables.st.v1', value: '{}' }),
      } },
    } as never),
  )
  return app
}

function createMockService() {
  return {
    clearLogs: vi.fn(async () => ({ operation: 'clear_logs', cleared: {} })),
    resetMemories: vi.fn(async () => ({ operation: 'reset_memories', cleared: {} })),
    factoryReset: vi.fn(async () => ({ operation: 'factory_reset', cleared: {} })),
    clearKnowledge: vi.fn(async () => ({ documentCount: 2, partCount: 3 })),
  }
}

/** 发起 POST JSON 请求的辅助函数 */
function post(
  path: string,
  body: Record<string, unknown>,
  router: ReturnType<typeof createResetRouter>,
) {
  return router.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('ResetRouter 确认短语防护', () => {
  it('clear-logs 确认短语正确时执行并返回 OK', async () => {
    const service = createMockService()
    const res = await post('/clear-logs', { confirm: '清空记录' }, makeRouter(service))
    expect(res.status).toBe(200)
    expect(service.clearLogs).toHaveBeenCalledTimes(1)
  })

  it('clear-logs 确认短语不匹配时返回 400 且不执行', async () => {
    const service = createMockService()
    const res = await post('/clear-logs', { confirm: '错误短语' }, makeRouter(service))
    expect(res.status).toBe(400)
    expect(service.clearLogs).not.toHaveBeenCalled()
  })

  it('memories 确认短语正确时执行并返回 OK', async () => {
    const service = createMockService()
    const res = await post('/memories', { confirm: '忘掉一切' }, makeRouter(service))
    expect(res.status).toBe(200)
    expect(service.resetMemories).toHaveBeenCalledTimes(1)
    expect(service.clearKnowledge).not.toHaveBeenCalled()
  })

  it('memories 确认短语不匹配时返回 400 且不执行', async () => {
    const service = createMockService()
    const res = await post('/memories', { confirm: '我要忘了' }, makeRouter(service))
    expect(res.status).toBe(400)
    expect(service.resetMemories).not.toHaveBeenCalled()
  })

  it('factory 确认短语正确时执行并返回 OK', async () => {
    const service = createMockService()
    const res = await post('/factory', { confirm: '我们还会再见的' }, makeRouter(service))
    expect(res.status).toBe(200)
    expect(service.factoryReset).toHaveBeenCalledTimes(1)
    expect(service.clearKnowledge).toHaveBeenCalledTimes(1)
    const response = (await res.json()) as ApiResponse<{ cleared: Record<string, number> }>
    expect(response.data?.cleared).toMatchObject({
      knowledge_documents: 2,
      knowledge_parts: 3,
    })
  })

  it('factory 确认短语不匹配时返回 400 且不执行', async () => {
    const service = createMockService()
    const res = await post('/factory', { confirm: '再也不见' }, makeRouter(service))
    expect(res.status).toBe(400)
    expect(service.factoryReset).not.toHaveBeenCalled()
    expect(service.clearKnowledge).not.toHaveBeenCalled()
  })

  it('缺少 confirm 字段时返回 400 参数校验失败', async () => {
    const service = createMockService()
    const res = await post('/factory', {}, makeRouter(service))
    expect(res.status).toBe(400)
    expect(service.factoryReset).not.toHaveBeenCalled()
  })
})
