import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowStateService } from '@infos/backend/services/flow/flowStateService'

describe('FlowStateService', () => {
  const repo = {
    get: vi.fn(),
    listByThread: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    rollbackPairs: vi.fn(),
    deleteThread: vi.fn(),
  }
  const threadService = { getThread: vi.fn() }
  let service: FlowStateService

  beforeEach(() => {
    vi.clearAllMocks()
    threadService.getThread.mockResolvedValue({
      id: 'thread-1',
      agentId: 'pero',
      channel: 'desktop',
    })
    service = new FlowStateService(repo as never, threadService as never)
  })

  it('局部补丁交给仓库事务合并，返回仓库保存后的完整心流', async () => {
    repo.save.mockResolvedValue({
      threadId: 'thread-1', agentId: 'pero', currentGoal: '主持海龟汤', privateFacts: '隐藏汤底',
      revision: 2,
      updatedAt: '2026-08-14 12:00:00',
    })

    const result = await service.update({
      threadId: 'thread-1',
      agentId: 'pero',
      currentGoal: '主持海龟汤',
    })

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ currentGoal: '主持海龟汤', privateFacts: undefined }),
    )
    expect(result.revision).toBe(2)
    expect(result.privateFacts).toBe('隐藏汤底')
  })

  it('拒绝访问普通 Thread 中其他 Agent 的心流', async () => {
    await expect(service.get('thread-1', 'nana')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    )
  })

  it('旧对象中的工作正文不进入心流投影', async () => {
    repo.get.mockResolvedValue({
      threadId: 'thread-1',
      agentId: 'pero',
      currentGoal: '继续整理',
      privateFacts: '内部提示',
      workContext: '旧文件正文',
      workContextUpdatedAtPairCount: 3,
      revision: 2,
      updatedAt: '2026-08-14 12:00:00',
    })

    const result = await service.get('thread-1', 'pero')

    expect(result).toEqual({
      threadId: 'thread-1',
      agentId: 'pero',
      currentGoal: '继续整理',
      privateFacts: '内部提示',
      revision: 2,
      updatedAt: '2026-08-14 12:00:00',
    })
  })
})
