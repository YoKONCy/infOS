import { describe, expect, it, vi } from 'vitest'
import { TaskControlService } from '@infos/backend/services/task/taskControlService'
import { readTaskLifecycle } from '@infos/backend/services/task/taskLifecycle'

function setup() {
  const task = {
    id: 'task',
    agentId: 'pero',
    revision: 1,
    title: '整理资料',
    instruction: '整理资料',
    status: 'completed',
    category: 'agent_task',
    lifecycle: readTaskLifecycle(null, '整理资料'),
    result: '甲'.repeat(20000),
    parentTaskId: null,
  }
  const tasks = {
    dispatch: vi.fn(async (_input: { idempotencyKey?: string }) => task),
    getTask: vi.fn(async () => task),
    query: vi.fn(async () => ({ items: [task], total: 1 })),
    changeTask: vi.fn(),
  }
  const service = new TaskControlService(
    tasks as never,
    {} as never,
    {} as never,
    async () => 'pero',
  )
  return { task, tasks, service }
}

describe('统一任务控制入口', () => {
  it('桌面派发绑定原会话并开启结果回填，重试使用稳定工具调用身份', async () => {
    const { tasks, service } = setup()
    await service.execute(
      'pero',
      { action: 'create', instruction: '整理资料' },
      undefined,
      false,
      'origin',
      { callId: 'call-1' },
    )
    expect(tasks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        targetThreadId: 'origin',
        completionAction: 'send_to_chat',
        metadata: { originThreadId: 'origin' },
        idempotencyKey: 'tool:pero:origin:call-1',
      }),
    )
  })

  it('完整结果分页读取，返回后续偏移而非丢失截断部分', async () => {
    const { service } = setup()
    expect(
      await service.execute('pero', {
        action: 'get',
        taskId: 'task',
        resultOffset: 11999,
        resultLimit: 8000,
      }),
    ).toMatchObject({ result: '甲'.repeat(8000), resultTotalChars: 20000, nextResultOffset: 19999 })
    expect(
      await service.execute('pero', { action: 'get', taskId: 'task', resultOffset: 19999 }),
    ).toMatchObject({ result: '甲', nextResultOffset: null })
  })

  it('后台执行不能操作自身或其他父任务的子任务', async () => {
    const { service, tasks } = setup()
    await expect(
      service.execute(
        'pero',
        { action: 'cancel', taskId: 'task', expectedRevision: 1 },
        undefined,
        false,
        'background',
        { taskId: 'task', executionId: 'execution' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      service.execute('pero', { action: 'get', taskId: 'task' }, undefined, false, 'background', {
        taskId: 'another-parent',
        executionId: 'execution',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(tasks.changeTask).not.toHaveBeenCalled()
  })

  it('不同平台已核验的主人能读取同一人格任务，结果投递仍保留原来源', async () => {
    const { service, task } = setup()
    const origin = {
      platform: 'qq',
      accountId: 'bot',
      senderId: 'owner',
      channelType: 'private' as const,
      channelId: 'dm',
      messageId: 'message',
    }
    task.lifecycle.origin = origin
    expect(
      await service.remote({ ...origin, platform: 'telegram' }, { action: 'get', taskId: 'task' }),
    ).toMatchObject({ agentId: 'pero', lifecycle: { origin } })
  })

  it('同一社交消息的两个派发动作使用各自的幂等键', async () => {
    const { service, tasks } = setup()
    const origin = {
      platform: 'qq',
      accountId: 'bot',
      senderId: 'owner',
      channelType: 'private' as const,
      channelId: 'dm',
      messageId: 'message',
    }
    await service.remote(origin, { action: 'create', instruction: '第一项' }, 'step-1')
    await service.remote(origin, { action: 'create', instruction: '第二项' }, 'step-2')
    expect(tasks.dispatch.mock.calls[0]![0].idempotencyKey).not.toBe(
      tasks.dispatch.mock.calls[1]![0].idempotencyKey,
    )
  })
})
