import { describe, expect, it, vi } from 'vitest'
import { createBackgroundTaskRouter } from '@infos/backend/routers/backgroundTask.router'

describe('BackgroundTaskRouter', () => {
  it('历史终态和父任务过滤在分页前传入查询层', async () => {
    const query = vi.fn().mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 20 })
    const router = createBackgroundTaskRouter({
      backgroundTaskService: { query, onEvent: vi.fn() },
    } as never)
    const response = await router.request('http://test/?view=history&parentTaskId=parent&page=2')
    expect(response.status).toBe(200)
    expect(query).toHaveBeenCalledWith({
      parentTaskId: 'parent',
      status: ['completed', 'failed', 'cancelled'],
      page: 2,
    })
  })
  it('历史视图不会返回活跃状态', async () => {
    const query = vi.fn()
    const router = createBackgroundTaskRouter({
      backgroundTaskService: { query, onEvent: vi.fn() },
    } as never)
    const response = await router.request('http://test/?view=history&status=running')
    expect((await response.json()).data.total).toBe(0)
    expect(query).not.toHaveBeenCalled()
  })
  it('send_to_chat 缺少目标 Thread 时应拒绝派发', async () => {
    const dispatch = vi.fn()
    const router = createBackgroundTaskRouter({
      backgroundTaskService: {
        dispatch,
        onEvent: vi.fn(),
      },
      agentManager: {
        getAgent: vi.fn(() => ({ id: 'pero' })),
      },
    } as never)

    const response = await router.request('http://test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'pero',
        instruction: '整理任务结果',
        completionAction: 'send_to_chat',
      }),
    })

    expect(response.status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
