import path from 'node:path'
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
  it.each(['manual', 'auto', 'auto_approve', 'full'] as const)(
    '%s 中终端命令、只读查询、脚本和外部删除均由用户逐次确认',
    async (executionMode) => {
      for (const [name, args, channel] of [
        ['terminal_execute', { command: 'safe' }, 'desktop'],
        ['terminal_execute', {
          command: process.platform === 'win32' ? 'Get-Location' : 'pwd',
        }, 'desktop'],
        ['terminal_write', { terminal_id: 'terminal', data: 'hello\r' }, 'desktop'],
        ['runtime_debug', { code: 'return 1' }, 'desktop'],
        ['delete_file', { file_path: 'outside/old.txt' }, 'social'],
      ] as const) {
        const { executor, handler, approvals } = fixture(name, [])
        const review = vi.fn()
        executor.setAutomaticApprovalService({ review } as unknown as AutomaticApprovalService)
        const executing = executor.execute(name, args, channel, { executionMode, channel })
        await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
        expect(handler).not.toHaveBeenCalled()
        const request = approvals.list({ status: 'pending' })[0]!
        expect(() => approvals.resolve(request.id, 'allow_session')).toThrow('APPROVAL_ONCE_ONLY')
        approvals.resolve(request.id, 'allow_once')
        expect(await executing).toMatchObject({ isError: false })
        const expectedArgs = name === 'delete_file'
          ? { file_path: path.resolve('outside/old.txt') }
          : args
        expect(handler).toHaveBeenCalledExactlyOnceWith(
          expectedArgs,
          expect.objectContaining({ approvedSensitiveAction: true }),
        )
        expect(approvals.get(request.id)?.status).toBe('consumed')
        expect(review).not.toHaveBeenCalled()
        const repeated = executor.execute(name, args, channel, { executionMode, channel })
        await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
        approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'deny_once')
        expect(await repeated).toMatchObject({ isError: true })
        expect(handler).toHaveBeenCalledTimes(1)
      }
    },
  )

  it('用户的单次拒绝优先于只读查询和自动审批', async () => {
    const { executor, handler, approvals } = fixture('terminal_execute', [])
    const args = { command: process.platform === 'win32' ? 'Get-Location' : 'pwd' }
    const denied = approvals.create({
      agentId: 'pero', sessionId: 'thread', threadId: 'thread', channel: 'desktop',
      toolName: 'terminal_execute', args, reason: '用户决定',
    })
    approvals.resolve(denied.id, 'deny_once', '本次先不要读取')
    const result = await executor.execute('terminal_execute', args, 'desktop', {
      executionMode: 'auto_approve',
    })
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'APPROVAL_DENIED', source: 'user', userMessage: '本次先不要读取',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('旧布尔设置保留原有模式', () => {
    expect(resolveExecutionMode(undefined, true)).toBe('auto')
    expect(resolveExecutionMode(undefined, false)).toBe('manual')
    expect(resolveExecutionMode('auto_approve', false)).toBe('auto_approve')
  })

  it('显式命令限制在自动审批模式中仍然生效', async () => {
    const { executor, handler, approvals } = fixture()
    const result = await executor.execute('terminal_execute', { command: 'other' }, 'desktop', {
      executionMode: 'auto_approve',
    })
    expect(result.output).toContain('COMMAND_NOT_ALLOWED')
    expect(handler).not.toHaveBeenCalled()
    expect(approvals.list()).toEqual([])
  })

  it.each(['deny', 'timeout', 'throw', 'invalid', 'missing', 'changed'] as const)(
    '普通远程终端关闭的自动审批 %s 不执行工具，也不创建人工审批', async (scenario) => {
      const { executor, handler, approvals } = fixture('remote_terminal_close')
      const review = vi.fn(async () => {
        if (scenario === 'throw') throw new Error('审批模型连接失败')
        return {
          source: 'automatic_reviewer',
          decision: scenario === 'invalid' ? 'manual' : scenario === 'changed' ? 'allow' : 'deny',
          reason: '审批结论',
          ...(scenario === 'timeout' ? { errorCode: 'timeout' } : {}),
          ...(scenario === 'changed' ? { validate: async () => false } : {}),
        }
      })
      if (scenario !== 'missing')
        executor.setAutomaticApprovalService({ review } as unknown as AutomaticApprovalService)
      const result = await executor.execute('remote_terminal_close', {
        terminal_id: 'terminal',
      }, 'desktop', { executionMode: 'auto_approve' })
      const errorCode = {
        deny: undefined,
        timeout: 'timeout',
        throw: 'model_error',
        invalid: 'invalid_response',
        missing: 'model_error',
        changed: 'context_changed',
      }[scenario]
      expect(result).toMatchObject({ isError: true, shouldTerminate: false })
      const response = JSON.parse(result.output)
      expect(response).toMatchObject({
        code: scenario === 'deny' ? 'AUTOMATIC_APPROVAL_DENIED' : 'AUTOMATIC_APPROVAL_ERROR',
        source: 'automatic_reviewer',
      })
      expect(response.errorCode).toBe(errorCode)
      expect(result.output).toContain('不是用户拒绝')
      expect(handler).not.toHaveBeenCalled()
      expect(approvals.list()).toEqual([])
    },
  )

  it('普通远程终端关闭通过自动审批后取得本次授权', async () => {
    const { executor, handler, approvals } = fixture('remote_terminal_close')
    const review = vi.fn(async () => ({
      source: 'automatic_reviewer', decision: 'allow', reason: '符合委托',
    }))
    executor.setAutomaticApprovalService({ review } as unknown as AutomaticApprovalService)
    const result = await executor.execute('remote_terminal_close', {
      terminal_id: 'terminal',
    }, 'desktop', { executionMode: 'auto_approve' })
    expect(result.isError).toBe(false)
    expect(review).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      { terminal_id: 'terminal' },
      expect.objectContaining({ approvedSensitiveAction: true }),
    )
    expect(approvals.list()).toEqual([])
  })

  it('Thread 权威模式优先，不能通过调用上下文冒充完整权限', async () => {
    const { executor, handler } = fixture()
    executor.setThreadPolicyResolver(async () => ({
      interactionMode: 'chat', disabledTools: [], executionMode: 'manual',
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
