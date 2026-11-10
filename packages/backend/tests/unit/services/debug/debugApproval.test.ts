import { describe, it, expect, vi } from 'vitest'
import { RegistryToolExecutor } from '@infos/backend/services/agent/toolExecutor'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'
import { PolicyEngine } from '@infos/backend/services/execution/policyEngine'
import { ApprovalService } from '@infos/backend/services/execution/approvalService'
import type { CapabilityGate } from '@infos/backend/capabilities/capabilityGate'
import { runtimeDebugTool, setRuntimeDebugService } from '@infos/backend/tools/runtimeDebug'

function fixture() {
  const registry = new ToolRegistry()
  const handler = vi.fn(async () => '已完成')
  registry.register({ name: 'runtime_debug', description: '调试', parameters: {} }, handler, [
    'desktop',
  ])
  const gate = {
    isToolAllowed: vi.fn(() => true),
    getToolPermission: vi.fn(),
  } as unknown as CapabilityGate
  const executor = new RegistryToolExecutor(registry, gate, null, null, {
    agentId: 'pero',
    channel: 'desktop',
    sessionId: 'thread-a',
  })
  const approvals = new ApprovalService()
  executor.setPolicyRuntime(new PolicyEngine(), approvals)
  return { executor, handler, approvals }
}
describe('统一调试工具的权限链', () => {
  it('纯现场读取直接执行，脚本逐次审批，不复用上一调用的批准', async () => {
    const { executor, handler, approvals } = fixture()
    expect((await executor.execute('runtime_debug', {}, 'desktop')).isError).toBe(false)
    const first = executor.execute(
      'runtime_debug',
      { code: 'return await debug.inspect()' },
      'desktop',
    )
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    expect(handler).toHaveBeenCalledTimes(1)
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'allow_once')
    expect((await first).isError).toBe(false)
    expect(handler).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ approvedSensitiveAction: true }),
    )
    const second = executor.execute(
      'runtime_debug',
      { code: 'return await debug.inspect()' },
      'desktop',
    )
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'deny_once')
    expect((await second).isError).toBe(true)
    expect(handler).toHaveBeenCalledTimes(2)
  })
  it.each(['auto', 'full'] as const)('%s 中任意 Node 脚本均需用户单次确认', async (executionMode) => {
    const { executor, approvals, handler } = fixture()
    const pending = executor.execute('runtime_debug', { code: 'return 1' }, 'desktop', { executionMode })
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    expect(handler).not.toHaveBeenCalled()
    const request = approvals.list({ status: 'pending' })[0]!
    expect(() => approvals.resolve(request.id, 'allow_session')).toThrow('APPROVAL_ONCE_ONLY')
    approvals.resolve(request.id, 'allow_once')
    expect((await pending).isError).toBe(false)
    expect(handler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ approvedSensitiveAction: true }))
  })
  it('没有策略引擎时拒绝脚本；最新 Thread 模式覆盖陈旧的工作模式请求', async () => {
    const { executor, handler } = fixture()
    executor.setThreadPolicyResolver(async () => ({
      interactionMode: 'minimal',
      disabledTools: [],
      executionMode: 'full',
      autoExecuteTools: true,
    }))
    expect(
      (
        await executor.execute('runtime_debug', { code: 'return 1' }, 'desktop', {
          interactionMode: 'work',
        })
      ).isError,
    ).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    const registry = new ToolRegistry()
    registry.register({ name: 'runtime_debug', description: '调试', parameters: {} }, handler)
    const noPolicy = new RegistryToolExecutor(registry)
    expect(
      (
        await noPolicy.execute('runtime_debug', { code: 'return 1' }, 'desktop', {
          executionMode: 'auto',
        })
      ).isError,
    ).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })
  it('脚本在自动审批模式中交给用户，审批模型不参与', async () => {
    const { executor, handler, approvals } = fixture()
    const review = vi.fn()
    executor.setAutomaticApprovalService({ review } as never)
    const pending = executor.execute('runtime_debug', { code: 'return 1' }, 'desktop', { executionMode: 'auto_approve' })
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    expect(review).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'deny_once')
    expect((await pending).isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })
  it('处理器拒绝 Realm、任务和 ambient，不能借脚本嵌套绕过', async () => {
    const execute = vi.fn()
    setRuntimeDebugService({ execute } as never)
    const ctx = {
      threadId: 'thread-a',
      agentId: 'pero',
      source: 'desktop',
      channel: 'desktop',
      sessionId: 'thread-a',
    }
    try {
      await expect(
        runtimeDebugTool.execute({}, { ...ctx, realmId: 'infos.social' }),
      ).rejects.toThrow('DEBUG_SCOPE_DENIED')
      await expect(runtimeDebugTool.execute({}, { ...ctx, taskId: 'task-1' })).rejects.toThrow(
        'DEBUG_SCOPE_DENIED',
      )
      await expect(
        runtimeDebugTool.execute({}, { ...ctx, capabilityScope: 'ambient' }),
      ).rejects.toThrow('DEBUG_SCOPE_DENIED')
      await expect(runtimeDebugTool.execute({ code: {} }, ctx)).rejects.toThrow(
        'DEBUG_ARGUMENT_INVALID',
      )
      expect(execute).not.toHaveBeenCalled()
    } finally {
      setRuntimeDebugService(undefined)
    }
  })
})
