import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDrizzleConnection,
  closeDrizzleConnection,
  type DrizzleDb,
} from '@infos/backend/database'
import { BackgroundTaskRepository } from '@infos/backend/repositories/backgroundTask.repo'
import { BackgroundScheduler } from '@infos/backend/services/task/backgroundTaskService'
import { readTaskLifecycle } from '@infos/backend/services/task/taskLifecycle'

vi.mock('@infos/backend/tools/productivityRuntimeHolder', () => ({
  disposeTaskExecution: vi.fn(async () => undefined),
  taskTerminals: () => [],
  retainTaskTerminals: vi.fn(),
}))
const connections: DrizzleDb[] = []
afterEach(() => connections.splice(0).forEach(closeDrizzleConnection))

describe('任务取消的持久收口', () => {
  it('外部取消失败仍撤销所有子任务，重启后重试取消并保留意图记录', async () => {
    const db = createDrizzleConnection(':memory:')
    connections.push(db)
    const repo = new BackgroundTaskRepository(db)
    const scheduler = { subscribe: vi.fn(() => () => undefined), get: vi.fn(), cancel: vi.fn() }
    const service = () =>
      new BackgroundScheduler(repo, {} as never, {} as never, scheduler as never)
    const parent = await repo.create({
      id: 'parent',
      agentId: 'pero',
      threadId: 'parent-thread',
      title: '社交任务',
      instruction: '汇报',
      status: 'waiting',
      metadataJson: JSON.stringify({ delegatedExecutor: 'social' }),
      lifecycleJson: JSON.stringify(readTaskLifecycle(null, '汇报')),
    })
    await repo.create({
      id: 'child',
      agentId: 'pero',
      threadId: 'child-thread',
      title: '子任务',
      instruction: '整理',
      status: 'queued',
      parentTaskId: parent.id,
      lifecycleJson: JSON.stringify(readTaskLifecycle(null, '整理')),
    })
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error('平台暂时离线'))
      .mockResolvedValue(undefined)
    const first = service()
    first.registerDelegatedExecutor('social', { cancel, run: vi.fn() })
    expect(await first.changeTask(parent.id, 1, { action: 'cancel' })).toMatchObject({
      status: 'cancelled',
      metadata: { cancellationPending: true },
    })
    expect((await repo.findById('child'))!.status).toBe('cancelled')
    await expect(first.deleteTask(parent.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    const restarted = service()
    restarted.registerDelegatedExecutor('social', { cancel, run: vi.fn() })
    await restarted.wakeWaitingTasks()
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(await repo.listPendingCancellations()).toEqual([])
    expect((await repo.findById(parent.id))!.status).toBe('cancelled')
  })
})
