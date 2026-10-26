import { afterEach, describe, expect, it, vi } from 'vitest'
import { RegistryToolExecutor } from '@infos/backend/services/agent/toolExecutor'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'
import { AutomaticApprovalService } from '@infos/backend/services/execution/automaticApprovalService'
import { ApprovalService } from '@infos/backend/services/execution/approvalService'
import { PolicyEngine } from '@infos/backend/services/execution/policyEngine'
import type { CapabilityGate } from '@infos/backend/capabilities/capabilityGate'
import type { LlmService } from '@infos/backend/services/llm/llmService'
import type { ChatMessage } from '@infos/backend/services/llm/types'
import { resolveExecutionMode } from '@infos/shared'

vi.mock('@infos/backend/tools/productivityRuntimeHolder', () => ({
  resolveExecutionSession: vi.fn(async () => ({ id: 'session', workspaceRoot: process.cwd() })),
  getProductivityRuntime: vi.fn(() => ({
    terminals: {
      get: vi.fn(() => ({
        id: 'terminal',
        cwd: process.cwd(),
        outputLength: 0,
        command: 'powershell',
      })),
      read: vi.fn(() => ({ output: 'PS>' })),
    },
  })),
}))

function fixture(name = 'terminal_execute', allowedCommands = ['safe']) {
  const registry = new ToolRegistry()
  const handler = vi.fn(async () => '操作完成')
  registry.register({ name, description: '演示操作', parameters: { type: 'object' } }, handler)
  const gate = {
    isToolAllowed: vi.fn(() => true),
    isPathAllowed: vi.fn(
      (_agent: string, _channel: string, _tool: string, value: string) =>
        !value.includes('outside'),
    ),
    getToolPermission: vi.fn(() => ({ paramPolicy: { allowedCommands } })),
  } as unknown as CapabilityGate
  const approvals = new ApprovalService()
  const executor = new RegistryToolExecutor(registry, gate, null, null, {
    agentId: 'pero',
    sessionId: 'thread',
    channel: 'desktop',
  })
  executor.setPolicyRuntime(new PolicyEngine(), approvals)
  return { executor, handler, approvals }
}

afterEach(() => vi.useRealTimers())

describe('执行模式与审批来源', () => {
  it.each(['manual', 'auto', 'auto_approve'] as const)(
    '明确只读查询在 %s 中无需人工或模型审批',
    async (executionMode) => {
      const { executor, handler, approvals } = fixture('terminal_execute', [])
      const review = vi.fn()
      executor.setAutomaticApprovalService({ review } as unknown as AutomaticApprovalService)
      const result = await executor.execute(
        'terminal_execute',
        {
          command: process.platform === 'win32' ? 'Get-Location' : 'pwd',
        },
        'desktop',
        { executionMode },
      )
      expect(result.isError).toBe(false)
      expect(result.metadata).toMatchObject({ readOnly: true })
      expect(handler).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ readOnlyTerminal: expect.any(Object) }),
      )
      expect(handler).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ approvedSensitiveAction: true }),
      )
      expect(review).not.toHaveBeenCalled()
      expect(approvals.list()).toEqual([])
    },
  )

  it('已有的一次性拒绝优先于只读免审判定', async () => {
    const { executor, handler, approvals } = fixture('terminal_execute', [])
    const args = { command: process.platform === 'win32' ? 'Get-Location' : 'pwd' }
    const denied = approvals.create({
      agentId: 'pero',
      sessionId: 'thread',
      threadId: 'thread',
      channel: 'desktop',
      toolName: 'terminal_execute',
      args,
      reason: '用户决定',
    })
    approvals.resolve(denied.id, 'deny_once', '本次先不要读取')
    const result = await executor.execute('terminal_execute', args, 'desktop', {
      executionMode: 'auto_approve',
    })
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'APPROVAL_DENIED',
      source: 'user',
      userMessage: '本次先不要读取',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('旧布尔设置保留原有模式', () => {
    expect(resolveExecutionMode(undefined, true)).toBe('auto')
    expect(resolveExecutionMode(undefined, false)).toBe('manual')
    expect(resolveExecutionMode('auto_approve', false)).toBe('auto_approve')
  })

  it('完整权限跳过命令策略与所有审批，并提供本次执行授权', async () => {
    const { executor, handler, approvals } = fixture()
    const review = vi.fn()
    executor.setAutomaticApprovalService({ review } as unknown as AutomaticApprovalService)
    const result = await executor.execute(
      'terminal_execute',
      { command: 'git reset --hard' },
      'desktop',
      { executionMode: 'full' },
    )
    expect(result.isError).toBe(false)
    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approvedSensitiveAction: true, approvedOutsideWorkspace: true }),
    )
    expect(review).not.toHaveBeenCalled()
    expect(approvals.list()).toEqual([])
  })

  it('自动审批拒绝明确归属于审批员，且不执行、不伪造用户授权', async () => {
    const { executor, handler, approvals } = fixture()
    executor.setAutomaticApprovalService({
      review: vi.fn(async () => ({
        source: 'automatic_reviewer',
        decision: 'deny',
        reason: '操作超出本次委托范围',
      })),
    } as unknown as AutomaticApprovalService)
    const result = await executor.execute(
      'terminal_execute',
      { command: 'echo hello' },
      'desktop',
      { executionMode: 'auto_approve' },
    )
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'AUTOMATIC_APPROVAL_DENIED',
      source: 'automatic_reviewer',
    })
    expect(result.output).toContain('不是用户拒绝')
    expect(result.output).not.toContain('userMessage')
    expect(handler).not.toHaveBeenCalled()
    expect(approvals.list()).toEqual([])
  })

  it('每次终端输入都审批，即使存在会话授权', async () => {
    const { executor, handler, approvals } = fixture('terminal_write')
    const grant = approvals.create({
      agentId: 'pero',
      sessionId: 'thread',
      threadId: 'thread',
      channel: 'desktop',
      toolName: 'terminal_write',
      args: { terminal_id: 'terminal', data: 'hello\r' },
      reason: '用户确认',
    })
    approvals.resolve(grant.id, 'allow_session')
    const review = vi.fn(async () => ({
      source: 'automatic_reviewer',
      decision: 'allow',
      reason: '符合用户要求',
      validate: async () => true,
    }))
    executor.setAutomaticApprovalService({ review } as unknown as AutomaticApprovalService)
    for (let index = 0; index < 2; index++)
      await executor.execute(
        'terminal_write',
        { terminal_id: 'terminal', data: 'hello\r' },
        'desktop',
        { executionMode: 'auto_approve' },
      )
    expect(review).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('外部删除进入自动审批，并将最终路径的单次权限传给工具', async () => {
    const { executor, handler, approvals } = fixture('delete_file')
    const review = vi.fn(async () => ({
      source: 'automatic_reviewer',
      decision: 'allow',
      reason: '用户明确要求删除此文件',
    }))
    executor.setAutomaticApprovalService({ review } as unknown as AutomaticApprovalService)
    const result = await executor.execute(
      'delete_file',
      { file_path: 'outside/old.txt' },
      'desktop',
      { executionMode: 'auto_approve' },
    )
    expect(result.isError).toBe(false)
    expect(review).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approvedSensitiveAction: true, approvedOutsideWorkspace: true }),
    )
    expect(approvals.list()).toEqual([])
  })

  it('自动审批通过后仍保留明确配置的命令限制，完整权限才跳过该限制', async () => {
    const { executor, handler } = fixture()
    executor.setAutomaticApprovalService({
      review: vi.fn(async () => ({
        source: 'automatic_reviewer',
        decision: 'allow',
        reason: '符合委托',
      })),
    } as unknown as AutomaticApprovalService)
    const result = await executor.execute('terminal_execute', { command: 'other' }, 'desktop', {
      executionMode: 'auto_approve',
    })
    expect(result.output).toContain('COMMAND_NOT_ALLOWED')
    expect(handler).not.toHaveBeenCalled()
  })

  it('审批时脚本变化直接返回失败，不执行也不创建人工审批', async () => {
    const { executor, handler, approvals } = fixture()
    executor.setAutomaticApprovalService({
      review: vi.fn(async () => ({
        source: 'automatic_reviewer',
        decision: 'allow',
        reason: '符合委托',
        validate: async () => false,
      })),
    } as unknown as AutomaticApprovalService)
    const result = await executor.execute('terminal_execute', { command: 'safe' }, 'desktop', {
      executionMode: 'auto_approve',
    })
    expect(result).toMatchObject({ isError: true, shouldTerminate: false })
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'AUTOMATIC_APPROVAL_ERROR',
      errorCode: 'context_changed',
    })
    expect(handler).not.toHaveBeenCalled()
    expect(approvals.list()).toEqual([])
  })

  it('后台自动审批异常返回 Agent，不挂起等待用户', async () => {
    const { executor, handler, approvals } = fixture()
    const review = vi.fn(async () => ({
      source: 'automatic_reviewer',
      decision: 'deny',
      errorCode: 'timeout',
      reason: '审批模型超时',
    }))
    executor.setAutomaticApprovalService({ review } as unknown as AutomaticApprovalService)
    const context = {
      executionMode: 'auto_approve' as const,
      taskId: 'task',
      threadId: 'thread',
      sessionId: 'segment-1',
    }
    const args = { command: 'safe' }
    const result = await executor.execute('terminal_execute', args, 'desktop', context)
    expect(result).toMatchObject({ isError: true, shouldTerminate: false })
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'AUTOMATIC_APPROVAL_ERROR',
      source: 'automatic_reviewer',
      errorCode: 'timeout',
    })
    expect(result.output).toContain('不是用户拒绝')
    expect(result.output).toContain('审批模型超时')
    expect(handler).not.toHaveBeenCalled()
    expect(approvals.list()).toEqual([])
  })

  it('审批服务直接抛错也反馈审批异常，不触发人工审批', async () => {
    const { executor, handler, approvals } = fixture()
    executor.setAutomaticApprovalService({
      review: vi.fn(async () => {
        throw new Error('审批模型连接失败')
      }),
    } as unknown as AutomaticApprovalService)
    const result = await executor.execute('terminal_execute', { command: 'safe' }, 'desktop', {
      executionMode: 'auto_approve',
    })
    expect(result).toMatchObject({ isError: true, shouldTerminate: false })
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'AUTOMATIC_APPROVAL_ERROR',
      errorCode: 'model_error',
    })
    expect(result.output).toContain('审批模型连接失败')
    expect(handler).not.toHaveBeenCalled()
    expect(approvals.list()).toEqual([])
  })

  it('审批服务缺失或返回旧中间态时均拒绝执行，不挂起', async () => {
    const { executor, handler, approvals } = fixture()
    const context = { executionMode: 'auto_approve' as const }
    expect(
      JSON.parse(
        (await executor.execute('terminal_execute', { command: 'safe' }, 'desktop', context))
          .output,
      ).code,
    ).toBe('AUTOMATIC_APPROVAL_ERROR')
    executor.setAutomaticApprovalService({
      review: vi.fn(async () => ({
        source: 'automatic_reviewer',
        decision: 'manual',
        reason: '旧响应',
      })),
    } as unknown as AutomaticApprovalService)
    const result = await executor.execute(
      'terminal_execute',
      { command: 'safe' },
      'desktop',
      context,
    )
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'AUTOMATIC_APPROVAL_ERROR',
      errorCode: 'invalid_response',
    })
    expect(result.shouldTerminate).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(approvals.list()).toEqual([])
  })

  it('Thread 权威模式优先，不能通过调用上下文冒充完整权限', async () => {
    const { executor, handler } = fixture()
    executor.setThreadPolicyResolver(async () => ({
      interactionMode: 'chat',
      disabledTools: [],
      executionMode: 'manual',
    }))
    const result = await executor.execute('terminal_execute', { command: 'safe' }, 'desktop', {
      executionMode: 'full',
    })
    expect(result.isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('审批模型服务', () => {
  const model = { provider: 'openai', modelId: 'reviewer', apiKey: 'test' }

  it('注入请求与终端上下文，调用不携带执行工具，用量归入系统', async () => {
    const chat = vi.fn(async (_config: unknown, _messages: ChatMessage[], _options: unknown) => ({
      choices: [{ message: { content: '{"decision":"allow","reason":"符合委托"}' } }],
    }))
    const service = new AutomaticApprovalService(
      { chat } as unknown as LlmService,
      async () => model,
    )
    const result = await service.review({
      toolName: 'terminal_write',
      args: { terminal_id: 'terminal', data: 'echo hello\r' },
      agentId: 'pero',
      threadId: 'thread',
      channel: 'desktop',
      messages: [{ role: 'user', content: '输出 hello' }],
    })
    expect(result.decision).toBe('allow')
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ usagePurpose: 'system', usageAgentId: 'pero' })
    const packet = JSON.parse(chat.mock.calls[0]?.[1]?.[1]?.content as string)
    expect(packet).toMatchObject({ userRequest: '输出 hello', terminal: { command: 'powershell' } })
    expect(chat.mock.calls[0]?.[2]).not.toHaveProperty('tools')
  })

  it('无模型或返回无效格式均返回拒绝与审批异常原因', async () => {
    const input = {
      toolName: 'terminal_execute',
      args: { command: 'echo hello' },
      agentId: 'pero',
      threadId: 'thread',
      channel: 'desktop',
    }
    const noModel = new AutomaticApprovalService({} as LlmService, async () => null)
    expect(await noModel.review(input)).toMatchObject({
      decision: 'deny',
      errorCode: 'model_error',
    })
    const invalid = new AutomaticApprovalService(
      {
        chat: vi.fn(async () => ({ choices: [{ message: { content: '好的，可以' } }] })),
      } as unknown as LlmService,
      async () => model,
    )
    expect(await invalid.review(input)).toMatchObject({
      decision: 'deny',
      errorCode: 'invalid_response',
    })
  })

  it('脚本无法读取时返回拒绝与上下文异常，不转人工', async () => {
    const service = new AutomaticApprovalService(
      {
        chat: vi.fn(async () => ({
          choices: [{ message: { content: '{"decision":"allow","reason":"允许"}' } }],
        })),
      } as unknown as LlmService,
      async () => model,
    )
    const result = await service.review({
      toolName: 'terminal_execute',
      args: { command: 'python infos-review-file-does-not-exist.py' },
      agentId: 'pero',
      threadId: 'thread',
      channel: 'desktop',
    })
    expect(result).toMatchObject({ decision: 'deny', errorCode: 'context_unavailable' })
    expect(result.reason).toContain('脚本未完整读取')
  })

  it('审批服务卡住也在 60 秒返回拒绝与超时原因', async () => {
    vi.useFakeTimers()
    const service = new AutomaticApprovalService({} as LlmService, () => new Promise(() => {}))
    const pending = service.review({
      toolName: 'terminal_execute',
      args: {},
      agentId: 'pero',
      threadId: 'thread',
      channel: 'desktop',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toMatchObject({
      decision: 'deny',
      source: 'automatic_reviewer',
      errorCode: 'timeout',
    })
  })

  it('用户取消时立即中断等待，不生成新的人工审批请求', async () => {
    const service = new AutomaticApprovalService({} as LlmService, () => new Promise(() => {}))
    const controller = new AbortController()
    const pending = service.review({
      toolName: 'terminal_execute',
      args: {},
      agentId: 'pero',
      threadId: 'thread',
      channel: 'desktop',
      signal: controller.signal,
    })
    controller.abort(new Error('用户已停止'))
    await expect(pending).rejects.toThrow('用户已停止')
  })
})
