import { describe, expect, it, vi } from 'vitest'
import { AppManagerImpl } from '@infos/backend/applications/appManager'
import { SocialAppRuntime } from '@infos/social/runtime'

describe('同一人格的社交委派与交付', () => {
  it('宿主启动角色与社交当前人格不同时，任务与记忆只流向当前人格', async () => {
    let persona = 'keromi'
    const grants = {
      queryGrants: vi.fn(async () => [
        { resource: { kind: 'persona', agentId: persona }, permissions: ['read'] },
      ]),
    }
    const manager = new AppManagerImpl(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      grants as never,
      {} as never,
      {} as never,
      { getAgent: (id: string) => ({ id }) } as never,
    )
    const executeCommand = vi.fn(async () => ({
      correlationId: 'command',
      status: 'completed',
      summary: '已交付',
    }))
    const getDailySummaries = vi.fn(async () => ['社交经历'])
    Object.assign(manager, {
      runtimes: new Map([
        [
          'social-instance',
          {
            manifest: { id: 'social' },
            ctx: { hostAgentId: 'pero' },
            runtime: { executeCommand, getDailySummaries },
          },
        ],
      ]),
    })
    vi.spyOn(manager, 'getManifest').mockResolvedValue({
      id: 'social',
      actions: [
        { name: 'get_task', mode: 'command' },
        { name: 'chat_in_group', mode: 'command' },
      ],
    } as never)
    expect(
      await manager.executeCommand({
        appId: 'social',
        hostAgentId: 'keromi',
        action: 'get_task',
        input: {},
      }),
    ).toMatchObject({ status: 'completed' })
    expect(await manager.collectDailySummaries('pero', '2026-10-25')).toEqual([])
    expect(await manager.collectDailySummaries('keromi', '2026-10-25')).toEqual(['社交经历'])
    persona = 'nana'
    await expect(
      manager.executeCommand({
        appId: 'social',
        hostAgentId: 'keromi',
        action: 'chat_in_group',
        input: {},
      }),
    ).rejects.toThrow('应用未运行')
    await manager.executeCommand({
      appId: 'social',
      hostAgentId: 'keromi',
      action: 'get_task',
      input: {},
    })
    expect(executeCommand).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'keromi' }))
  })

  it('托管编排返回等待与真实编号，传递平台、账号、取消和执行身份', async () => {
    const runtime = new SocialAppRuntime()
    const runCommand = vi.fn(async () => ({ type: 'orchestration', wakeAt: Date.now() + 10000 }))
    Object.assign(runtime, {
      ctx: {},
      socialMessageRepo: {},
      socialBridge: { runCommand },
      adapters: [{ platform: 'telegram', getOwnerId: () => 'owner' }],
    })
    const signal = new AbortController().signal
    const result = await runtime.executeCommand({
      correlationId: 'stable-command',
      action: 'chat_in_group',
      communicationBudget: 8,
      executionId: 'execution' as never,
      processId: 'process' as never,
      signal,
      input: { platform: 'telegram', account_id: 'bot', group_id: 'topic', intent: '观察后汇报' },
    })
    expect(result).toMatchObject({
      status: 'waiting',
      output: { scheduled: true, sent: false, taskId: expect.stringMatching(/^social:command:/) },
    })
    expect(runCommand).toHaveBeenCalledWith(
      'stable-command',
      'pero',
      'topic',
      expect.any(String),
      'owner',
      'telegram',
      'bot',
      signal,
      { executionId: 'execution', processId: 'process' },
    )
  })

  it('已完成、等待、失败与不明交付按实际状态返回；取消到达原社交回合', async () => {
    const runtime = new SocialAppRuntime()
    const turn = {
      id: 'social-task',
      kind: 'task',
      agentId: 'pero',
      status: 'waiting',
      commandResult: undefined as unknown,
    }
    const cancelTurn = vi.fn(async () => {
      turn.status = 'cancelled'
    })
    Object.assign(runtime, {
      socialMessageRepo: { getTurn: async () => turn },
      socialBridge: { cancelTurn },
    })
    const request = {
      correlationId: 'query',
      action: 'get_task',
      input: { task_id: turn.id },
      communicationBudget: 8,
    }
    expect((await runtime.executeCommand({ ...request, agentId: 'foreign' })).status).toBe('failed')
    expect((await runtime.executeCommand(request)).status).toBe('waiting')
    turn.status = 'completed'
    turn.commandResult = { sent: true, content: '真实发送内容' }
    expect(await runtime.executeCommand(request)).toMatchObject({
      status: 'completed',
      summary: '真实发送内容',
      output: { sent: true },
    })
    turn.status = 'delivery_unknown'
    expect((await runtime.executeCommand(request)).status).toBe('failed')
    turn.status = 'waiting'
    Object.assign(runtime, { socialAgentId: 'keromi' })
    expect(
      (await runtime.executeCommand({ ...request, agentId: 'pero', action: 'cancel_task' })).status,
    ).toBe('failed')
    expect(cancelTurn).toHaveBeenCalledWith(turn.id)
  })
})
