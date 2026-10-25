import { describe, expect, it, vi } from 'vitest'
import { createSocialTaskExecutor } from '@infos/backend/applications/socialTaskExecutor'
import { readTaskLifecycle } from '@infos/backend/services/task/taskLifecycle'
import type { BackgroundTaskInfo } from '@infos/backend/services/task/backgroundTaskService'

function setup() {
  const task = {
    id: 'stable-task',
    revision: 1,
    agentId: 'pero',
    lifecycle: readTaskLifecycle(null, '观察后汇报'),
    metadata: { socialInput: { platform: 'telegram', account_id: 'bot', group_id: 'topic' } },
  } as unknown as BackgroundTaskInfo
  const executeCommand = vi.fn(async (request) =>
    request.action === 'get_task'
      ? { status: 'failed', summary: '找不到任务' }
      : { status: 'waiting', summary: '等待群消息', output: { taskId: 'social-task' } },
  )
  const update = vi.fn(async () => undefined)
  const executor = createSocialTaskExecutor({ executeCommand } as never, { update } as never)
  const signal = new AbortController().signal
  const execution = { executionId: 'parent-execution', processId: 'parent-process' } as never
  return { task, executeCommand, update, executor, signal, execution }
}

describe('持久社交任务执行器', () => {
  it('首次提交先落派发意图，传递账号与原执行；等待不会被报告完成', async () => {
    const { task, executeCommand, update, executor, signal, execution } = setup()
    const result = await executor.run(task, signal, execution)
    expect(result.outcome).toBe('wait')
    expect(update).toHaveBeenCalledWith(
      task.id,
      { metadataJson: expect.stringContaining('"socialDispatchAttempted":true') },
      1,
    )
    expect(executeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'chat_in_group',
        correlationId: task.id,
        execution,
        signal,
        input: task.metadata.socialInput,
      }),
    )
  })

  it('恢复只查询原回合，完整发送内容与回执进入交付结果', async () => {
    const { task, executeCommand, update, executor, signal, execution } = setup()
    executeCommand.mockResolvedValue({
      status: 'completed',
      summary: '已送达',
      output: { taskId: 'social-task', sent: true, content: '实际发送正文' },
    } as never)
    task.metadata.socialDispatchAttempted = true
    task.lifecycle.segments = 3
    const result = await executor.run(task, signal, execution)
    expect(result.outcome).toBe('deliver')
    expect(result.summary).toContain('实际发送正文')
    expect(executeCommand).toHaveBeenCalledOnce()
    expect(update).not.toHaveBeenCalled()
  })

  it('派发记录消失或离线读取失败后阻塞，不重新执行有副作用的委派', async () => {
    const { task, executeCommand, executor, signal, execution } = setup()
    task.metadata.socialDispatchAttempted = true
    expect((await executor.run(task, signal, execution)).outcome).toBe('blocked')
    expect(executeCommand).toHaveBeenCalledOnce()
  })

  it('已失败的社交回合返回失败，取消使用同一稳定回合编号', async () => {
    const { task, executeCommand, executor, signal, execution } = setup()
    executeCommand.mockResolvedValue({
      status: 'failed',
      summary: '发送结果不明',
      output: { taskId: 'social-task', state: 'delivery_unknown' },
    } as never)
    expect((await executor.run(task, signal, execution)).outcome).toBe('failed')
    const queryId = executeCommand.mock.calls[0]![0].input.task_id
    await executor.cancel!(task)
    expect(executeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'cancel_task', input: { task_id: queryId } }),
    )
  })
})
