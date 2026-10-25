import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplicationRealmManager } from '@infos/backend/applications/applicationRealm'
import { RegistryToolExecutor, type HookEmitter } from '@infos/backend/services/agent/toolExecutor'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'
import type { CapabilityGate } from '@infos/backend/capabilities/capabilityGate'
import type { SkillLoader } from '@infos/backend/capabilities/skillLoader'
import { PolicyEngine } from '@infos/backend/services/execution/policyEngine'
import { ApprovalService } from '@infos/backend/services/execution/approvalService'
import { MODEL_TOOL_OUTPUT_CHARACTERS } from '@infos/backend/services/execution/toolObservation'
import { getDataDir } from '@infos/backend/lib/env'
import path from 'node:path'

// 本文件验证工具审批与分派，执行会话只提供隔离路径，不运行真实文件处理器。
vi.mock('@infos/backend/tools/productivityRuntimeHolder', async (original) => ({
  ...(await original<typeof import('@infos/backend/tools/productivityRuntimeHolder')>()),
  resolveExecutionSession: vi.fn(async ({ agentId }: { agentId: string }) => ({
    workspaceRoot: path.resolve('TEMP/tool-executor-workspace', agentId),
  })),
}))

function createRegistry() {
  const registry = new ToolRegistry()
  const handler = vi.fn().mockResolvedValue('执行结果')
  registry.register(
    { name: 'demo.run', description: '演示工具', parameters: { type: 'object' } },
    handler,
  )
  return { registry, handler }
}

describe('RegistryToolExecutor', () => {
  it('普通文件分派保持可用，资源运行目录写入要求先创建候选', async () => {
    const registry = new ToolRegistry(),
      handler = vi.fn(async () => '已写入')
    registry.register({ name: 'write_file', description: '写文件', parameters: {} }, handler)
    const executor = new RegistryToolExecutor(registry)
    const context = {
      agentId: 'pero',
      threadId: 'resource-write',
      channel: 'desktop',
      interactionMode: 'work' as const,
      executionMode: 'full' as const,
    }
    const denied = await executor.execute(
      'write_file',
      { file_path: path.join(getDataDir(), 'skills', 'SKILL.md'), content: '新内容' },
      'desktop',
      context,
    )
    expect(denied).toMatchObject({ isError: true, shouldTerminate: false })
    expect(JSON.parse(denied.output).code).toBe('RESOURCE_CANDIDATE_REQUIRED')
    expect(handler).not.toHaveBeenCalled()
    const candidate = path.join(
      getDataDir(),
      'resource-versions',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'candidate',
      'SKILL.md',
    )
    expect(
      await executor.execute(
        'write_file',
        { file_path: candidate, content: '候选内容' },
        'desktop',
        context,
      ),
    ).toMatchObject({ isError: false })
    expect(handler).toHaveBeenCalledOnce()
  })
  it('NIT 常驻系统入口在聊天模式可用，旧禁用记录不关闭它，内部工具仍按模式校验', async () => {
    const registry = new ToolRegistry()
    const script = vi.fn(async () => '已编排')
    const browser = vi.fn(async () => '网页')
    registry.register({ name: 'run_script', description: '脚本', parameters: {} }, script)
    registry.register({ name: 'browser_open_url', description: '网页', parameters: {} }, browser)
    const executor = new RegistryToolExecutor(registry)
    const context = {
      agentId: 'pero',
      threadId: 'nit-chat',
      channel: 'desktop',
      interactionMode: 'chat' as const,
      disabledTools: ['run_script'],
      advancedToolAccess: { names: new Set<string>(), expanded: false },
    }
    expect((await executor.execute('run_script', {}, 'desktop', context)).isError).toBe(false)
    expect(script).toHaveBeenCalledOnce()
    expect((await executor.execute('browser_open_url', {}, 'desktop', context)).isError).toBe(true)
    expect(browser).not.toHaveBeenCalled()
  })

  it('浏览器截图在观察回传前保存预览，直接调用和脚本共用执行入口', async () => {
    const registry = new ToolRegistry()
    registry.register(
      { name: 'browser_screenshot', description: '截图', parameters: {} },
      async () => '{"screenshots":[{"dataUri":"data:image/png;base64,AAAA"}]}',
    )
    const executor = new RegistryToolExecutor(registry)
    const output =
      '{"screenshots":[{"dataUri":"data:image/png;base64,AAAA","imagePreview":{"id":"saved"}}]}'
    const captureScreenshotPreviews = vi.fn().mockResolvedValue(output)
    executor.setScreenshotResourceService({ captureScreenshotPreviews } as never)
    const onToolObserved = vi.fn()
    const result = await executor.execute('browser_screenshot', {}, 'desktop', {
      agentId: 'pero',
      threadId: 'thread-1',
      pairId: 'pair-1',
      toolCallId: 'capture-1',
      advancedToolAccess: { expanded: true, names: new Set(['browser_screenshot']) },
      onToolObserved,
    })
    expect(captureScreenshotPreviews).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'pero',
        threadId: 'thread-1',
        pairId: 'pair-1',
        toolCallId: 'capture-1',
      }),
      expect.any(String),
    )
    expect(result.output).toBe(output)
    expect(onToolObserved).toHaveBeenCalledWith(expect.objectContaining({ output }))
  })

  beforeEach(() => {
    vi.useRealTimers()
  })

  it('工具执行超过原30秒边界仍保持挂起，直到工具自身完成', async () => {
    vi.useFakeTimers()
    const registry = new ToolRegistry()
    let finish: ((value: string) => void) | undefined
    registry.register(
      { name: 'wait.forever', description: '等待外部输入', parameters: { type: 'object' } },
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const executor = new RegistryToolExecutor(registry)
    let settled = false
    const execution = executor.execute('wait.forever', {}, 'desktop').finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(31_000)
    expect(settled).toBe(false)

    finish?.('用户已回复')
    await expect(execution).resolves.toMatchObject({
      output: '用户已回复',
      isError: false,
    })
  })

  it('Application Realm工具不得被主应用或其他Realm调用', async () => {
    const registry = new ToolRegistry()
    const realms = new ApplicationRealmManager(registry)
    const arca = realms.register({
      realmId: 'infos.arca',
      appId: 'infos.arca',
      principalId: 'application:infos.arca',
      instanceId: 'managed',
    })
    const handler = vi.fn().mockResolvedValue('已提交')
    arca.registerTool(
      { name: 'arca_changeset_propose', description: '提交变更', parameters: { type: 'object' } },
      handler,
    )
    const executor = new RegistryToolExecutor(registry)
    executor.setApplicationRealmManager(realms)

    await expect(executor.execute('arca_changeset_propose', {}, 'desktop')).resolves.toMatchObject({
      isError: true,
    })
    await expect(
      executor.execute('arca_changeset_propose', {}, 'desktop', { realmId: 'infos.social' }),
    ).resolves.toMatchObject({ isError: true })
    await expect(
      executor.execute('arca_changeset_propose', {}, 'desktop', { realmId: 'infos.arca' }),
    ).resolves.toMatchObject({ isError: false, output: '已提交' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('据点group通道应只注入并执行据点工具与固定协议工具', async () => {
    const registry = new ToolRegistry()
    const strongholdHandler = vi.fn().mockResolvedValue('已移动')
    const terminalHandler = vi.fn().mockResolvedValue('不应执行')
    registry.register(
      { name: 'stronghold_move_to_room', description: '移动房间', parameters: {} },
      strongholdHandler,
      ['group'],
    )
    registry.register(
      { name: 'terminal_execute', description: '执行终端命令', parameters: {} },
      terminalHandler,
    )
    registry.register(
      { name: 'finish_task', description: '结束任务', parameters: {} },
      vi.fn().mockResolvedValue('已结束'),
    )
    const executor = new RegistryToolExecutor(registry)

    expect(registry.getDefinitions('group').map((tool) => tool.name)).toEqual([
      'stronghold_move_to_room',
      'finish_task',
    ])
    await expect(
      executor.execute('terminal_execute', { command: 'pwd' }, 'group'),
    ).resolves.toMatchObject({ isError: true })
    expect(terminalHandler).not.toHaveBeenCalled()
  })

  it('工具定义通道限制应同时阻止执行，避免手工FC绕过', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn().mockResolvedValue('已移动')
    registry.register(
      { name: 'stronghold_move_to_room', description: '移动房间', parameters: {} },
      handler,
      ['group'],
    )
    const executor = new RegistryToolExecutor(registry)

    expect(registry.getDefinitions('desktop').map((tool) => tool.name)).not.toContain(
      'stronghold_move_to_room',
    )
    expect(registry.getDefinitions('group').map((tool) => tool.name)).toContain(
      'stronghold_move_to_room',
    )
    await expect(
      executor.execute('stronghold_move_to_room', { room_name: '卧室' }, 'desktop'),
    ).resolves.toMatchObject({ isError: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('应将旧工具的JSON错误结果归一化为失败状态', async () => {
    const registry = new ToolRegistry()
    registry.register(
      { name: 'legacy.read', description: '旧读取工具', parameters: { type: 'object' } },
      vi.fn().mockResolvedValue(JSON.stringify({ error: '文件不存在' })),
    )
    const executor = new RegistryToolExecutor(registry)

    await expect(executor.execute('legacy.read', {}, 'desktop')).resolves.toMatchObject({
      isError: true,
      output: expect.stringContaining('文件不存在'),
    })
  })

  it('应将旧工具的 success=false 结果归一化为失败状态', async () => {
    const registry = new ToolRegistry()
    registry.register(
      { name: 'legacy.edit', description: '旧编辑工具', parameters: { type: 'object' } },
      vi.fn().mockResolvedValue(JSON.stringify({ success: false, error: '编辑失败' })),
    )
    const executor = new RegistryToolExecutor(registry)

    await expect(executor.execute('legacy.edit', {}, 'desktop')).resolves.toMatchObject({
      isError: true,
    })
  })

  it('应当直接执行 finish_task 并返回终止信号', async () => {
    const { registry } = createRegistry()
    const executor = new RegistryToolExecutor(registry)

    const result = await executor.execute('finish_task', { summary: '完成啦' }, 'desktop')

    expect(result).toMatchObject({
      output: '完成啦',
      isError: false,
      shouldTerminate: true,
    })
  })

  it('应当拒绝 CapabilityGate 不允许的工具', async () => {
    const { registry, handler } = createRegistry()
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(false),
    } as unknown as CapabilityGate
    // AIOS: mode 已改为 channel（Work 模式废弃，按对话通道鉴权）
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, null, {
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'session-1',
    })

    const result = await executor.execute('demo.run', {}, 'desktop')

    expect(capabilityGate.isToolAllowed).toHaveBeenCalledWith(
      'pero',
      'desktop',
      'demo.run',
      'session-1',
      undefined,
    )
    expect(handler).not.toHaveBeenCalled()
    expect(result).toMatchObject({ isError: true, shouldTerminate: false })
  })

  it('即使旧 Thread 禁用列表含系统协议工具也应继续执行', async () => {
    const registry = new ToolRegistry()
    const finishHandler = vi.fn(async () => JSON.stringify({ success: true }))
    registry.register(
      { name: 'finish_task', description: '完成任务', parameters: {} },
      finishHandler,
    )
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
    } as unknown as CapabilityGate
    const executor = new RegistryToolExecutor(registry, capabilityGate)

    const result = await executor.execute('finish_task', { reply: '完成' }, 'desktop', {
      agentId: 'pero',
      threadId: 'thread-1',
      channel: 'desktop',
      disabledTools: ['finish_task', 'load_skill'],
    })

    expect(finishHandler).toHaveBeenCalledOnce()
    expect(result.isError).toBe(false)
    expect(result.shouldTerminate).toBe(true)
  })

  it('应当在任何内置捷径和 CapabilityGate 之前拒绝本会话禁用工具', async () => {
    const { registry, handler } = createRegistry()
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
    } as unknown as CapabilityGate
    const executor = new RegistryToolExecutor(registry, capabilityGate)

    const result = await executor.execute('demo.run', {}, 'desktop', {
      agentId: 'pero',
      threadId: 'thread-1',
      channel: 'desktop',
      disabledTools: ['demo.run'],
    })

    expect(capabilityGate.isToolAllowed).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    expect(result).toMatchObject({ isError: true, shouldTerminate: false })
  })

  it('应当允许会话未禁用且 CapabilityGate 授权的工具', async () => {
    const { registry, handler } = createRegistry()
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
    } as unknown as CapabilityGate
    const hookEmitter = {
      emitHook: vi.fn(async (event: string, data: unknown) => {
        if (event === 'chat:beforeToolCall')
          return { ...(data as object), args: { value: 'hooked' } }
        return data
      }),
    } as HookEmitter & { emitHook: ReturnType<typeof vi.fn> }
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, hookEmitter, {
      agentId: 'pero',
      sessionId: 'session-1',
    })

    const result = await executor.execute('demo.run', { value: 'raw' }, 'desktop')

    expect(handler).toHaveBeenCalledWith(
      { value: 'hooked' },
      // 执行上下文同时携带权限和取消信息，此处核对调用身份。
      expect.objectContaining({
        source: 'desktop',
        agentId: 'pero',
        sessionId: 'session-1',
        threadId: 'session-1',
        channel: 'desktop',
        executionMode: 'manual',
        interactionMode: 'work',
      }),
    )
    expect(hookEmitter.emitHook).toHaveBeenCalledWith(
      'chat:afterToolCall',
      expect.objectContaining({
        name: 'demo.run',
        args: { value: 'hooked' },
        output: '执行结果',
        durationMs: expect.any(Number),
        isError: false,
      }),
    )
    expect(result).toMatchObject({ output: '执行结果', isError: false, shouldTerminate: false })
  })

  it('审批允许后恢复原工具调用并向 Agent 回传附言', async () => {
    const { registry, handler } = createRegistry()
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
      getToolPermission: vi.fn().mockReturnValue({
        toolName: 'demo.run',
        resourceScope: { scope: 'system', allowedRoots: [], deniedPaths: [] },
        requiresApproval: true,
      }),
    } as unknown as CapabilityGate
    const approvals = new ApprovalService()
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, null, {
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'approval-thread',
    })
    executor.setPolicyRuntime(new PolicyEngine(), approvals)

    const execution = executor.execute('demo.run', { value: 1 }, 'desktop')
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    const request = approvals.list({ status: 'pending' })[0]!
    approvals.resolve(request.id, 'allow_once', '请谨慎执行')
    const result = await execution

    expect(handler).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      output: '执行结果',
      isError: false,
      approvalObservation: expect.stringContaining('请谨慎执行'),
    })
    expect(approvals.get(request.id)?.status).toBe('consumed')
  })

  it('敏感命令工具在审批运行时不可用时应失败关闭', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn().mockResolvedValue('不应执行')
    registry.register(
      { name: 'terminal_execute', description: '执行命令', parameters: { type: 'object' } },
      handler,
    )
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
      isPathAllowed: vi.fn().mockReturnValue(true),
    } as unknown as CapabilityGate
    const executor = new RegistryToolExecutor(registry, capabilityGate)

    const result = await executor.execute(
      'terminal_execute',
      { command: 'move C:\\outside\\a.txt C:\\outside\\b.txt' },
      'desktop',
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('APPROVAL_UNAVAILABLE')
    expect(handler).not.toHaveBeenCalled()
  })

  it('终端命令必须逐次获得单次审批', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn().mockResolvedValue('命令完成')
    registry.register(
      { name: 'terminal_execute', description: '执行命令', parameters: { type: 'object' } },
      handler,
    )
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
      isPathAllowed: vi.fn().mockReturnValue(true),
      getToolPermission: vi.fn().mockReturnValue({
        toolName: 'terminal_execute',
        resourceScope: {
          scope: 'principal_workspace',
          allowedRoots: ['C:/workspace'],
          deniedPaths: [],
        },
        requiresApproval: false,
      }),
    } as unknown as CapabilityGate
    const approvals = new ApprovalService()
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, null, {
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'terminal-thread',
    })
    executor.setPolicyRuntime(new PolicyEngine(), approvals)
    const args = { command: 'Write-Output "hello"' }

    const firstExecution = executor.execute('terminal_execute', args, 'desktop')
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    expect(handler).not.toHaveBeenCalled()
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'allow_once')
    expect((await firstExecution).isError).toBe(false)
    expect(handler).toHaveBeenCalledWith(
      args,
      expect.objectContaining({ approvedSensitiveAction: true }),
    )
    expect(handler).toHaveBeenCalledTimes(1)

    const secondExecution = executor.execute('terminal_execute', args, 'desktop')
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    expect(handler).toHaveBeenCalledTimes(1)
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'deny_once')
    expect((await secondExecution).isError).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('自动执行模式仅保留终端与工作区外删除审批', async () => {
    const registry = new ToolRegistry()
    const browserHandler = vi.fn().mockResolvedValue('完成')
    const terminalHandler = vi.fn().mockResolvedValue('命令完成')
    const deleteHandler = vi.fn().mockResolvedValue('已删除')
    registry.register(
      { name: 'browser_type', description: '输入', parameters: { type: 'object' } },
      browserHandler,
    )
    registry.register(
      { name: 'terminal_execute', description: '终端', parameters: { type: 'object' } },
      terminalHandler,
    )
    registry.register(
      { name: 'delete_file', description: '删除', parameters: { type: 'object' } },
      deleteHandler,
    )
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
      isPathAllowed: vi.fn().mockReturnValue(true),
      getToolPermission: vi.fn(),
    } as unknown as CapabilityGate
    const approvals = new ApprovalService()
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, null, {
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'auto-thread',
    })
    executor.setPathBoundaryChecker(
      (_agentId, _channel, inputPath) => !inputPath.includes('outside'),
    )
    executor.setPolicyRuntime(new PolicyEngine(), approvals)

    await expect(
      executor.execute('browser_type', { text: 'hello' }, 'desktop', {
        autoExecuteTools: true,
      }),
    ).resolves.toMatchObject({ isError: false })
    expect(browserHandler).toHaveBeenCalledTimes(1)

    const terminal = executor.execute('terminal_execute', { command: 'echo ok' }, 'desktop', {
      autoExecuteTools: true,
    })
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'deny_once')
    expect((await terminal).isError).toBe(true)
    expect(terminalHandler).not.toHaveBeenCalled()

    const outsideDelete = executor.execute(
      'delete_file',
      { file_path: 'C:/outside/old.txt' },
      'desktop',
      { autoExecuteTools: true },
    )
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'deny_once')
    expect((await outsideDelete).isError).toBe(true)
    expect(deleteHandler).not.toHaveBeenCalled()

    await expect(
      executor.execute('delete_file', { file_path: 'notes/old.txt' }, 'desktop', {
        autoExecuteTools: true,
      }),
    ).resolves.toMatchObject({ isError: false })
    expect(deleteHandler).toHaveBeenCalledWith(
      { file_path: 'notes/old.txt' },
      expect.objectContaining({ approvedSensitiveAction: true }),
    )
  })

  it('远程终端只按自动执行开关决定是否逐次审批', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn().mockResolvedValue('远程终端完成')
    registry.register(
      { name: 'remote_terminal_read', description: '读取远程终端', parameters: { type: 'object' } },
      handler,
    )
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
      isPathAllowed: vi.fn().mockReturnValue(true),
      getToolPermission: vi.fn(),
    } as unknown as CapabilityGate
    const approvals = new ApprovalService()
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, null, {
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'remote-shell-thread',
    })
    executor.setPolicyRuntime(new PolicyEngine(), approvals)

    const guarded = executor.execute(
      'remote_terminal_read',
      { node_id: 'gpu-1', terminal_id: 'term-1' },
      'desktop',
      { autoExecuteTools: false },
    )
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'allow_once')
    await expect(guarded).resolves.toMatchObject({ isError: false })
    expect(handler).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ approvedSensitiveAction: true }),
    )

    approvals.clearSession('remote-shell-thread')
    handler.mockClear()
    await expect(
      executor.execute(
        'remote_terminal_read',
        { node_id: 'gpu-1', terminal_id: 'term-1' },
        'desktop',
        { autoExecuteTools: true },
      ),
    ).resolves.toMatchObject({ isError: false })
    expect(approvals.list({ status: 'pending' })).toHaveLength(0)
    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approvedSensitiveAction: true }),
    )
  })

  it('纯读取工具应获得设备只读范围且不触发越界审批', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn().mockResolvedValue('内容')
    registry.register(
      { name: 'read_file_range', description: '范围读取', parameters: { type: 'object' } },
      handler,
    )
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
      isPathAllowed: vi.fn().mockReturnValue(false),
      getToolPermission: vi.fn(),
    } as unknown as CapabilityGate
    const approvals = new ApprovalService()
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, null, {
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'read-thread',
    })
    executor.setPathBoundaryChecker(() => false)
    executor.setPolicyRuntime(new PolicyEngine(), approvals)

    const result = await executor.execute(
      'read_file_range',
      { path: 'C:/outside/file.txt', line_start: 1, line_end: 10 },
      'desktop',
    )

    expect(result.isError).toBe(false)
    expect(approvals.list({ status: 'pending' })).toHaveLength(0)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'C:/outside/file.txt' }),
      expect.objectContaining({ deviceReadScope: true }),
    )
  })

  it('工作区外路径必须审批后才执行，并仅向本次工具上下文授予越界能力', async () => {
    const { registry, handler } = createRegistry()
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
      isPathAllowed: vi.fn().mockReturnValue(false),
      getToolPermission: vi.fn().mockReturnValue({
        toolName: 'demo.run',
        resourceScope: {
          scope: 'principal_workspace',
          allowedRoots: ['C:/workspace'],
          deniedPaths: [],
        },
        requiresApproval: false,
      }),
    } as unknown as CapabilityGate
    const approvals = new ApprovalService()
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, null, {
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'outside-thread',
    })
    executor.setPathBoundaryChecker(() => false)
    executor.setPolicyRuntime(new PolicyEngine(), approvals)

    const execution = executor.execute('demo.run', { path: 'C:/outside/file.txt' }, 'desktop')
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    expect(handler).not.toHaveBeenCalled()
    const request = approvals.list({ status: 'pending' })[0]!
    expect(request.argsSummary).toMatchObject({ path: 'C:/outside/file.txt' })

    approvals.resolve(request.id, 'allow_once')
    const result = await execution

    expect(result.isError).toBe(false)
    expect(handler).toHaveBeenCalledWith(
      { path: 'C:/outside/file.txt' },
      expect.objectContaining({ approvedOutsideWorkspace: true }),
    )

    const secondExecution = executor.execute(
      'demo.run',
      { path: 'C:/outside/another.txt' },
      'desktop',
    )
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    expect(handler).toHaveBeenCalledTimes(1)
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'deny_once')
    const denied = await secondExecution
    expect(denied.isError).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('文件读取结果应保留工具自身限定的完整行数', async () => {
    const registry = new ToolRegistry()
    const fullRead = Array.from({ length: 800 }, (_, index) => `第${index + 1}行内容`).join('\n')
    const rangeRead = JSON.stringify({
      content: fullRead,
      lineStart: 1,
      lineEnd: 800,
      totalLines: 2_000,
      truncated: true,
    })
    registry.register(
      { name: 'read_file', description: '完整读取', parameters: {} },
      vi.fn().mockResolvedValue(fullRead),
    )
    registry.register(
      { name: 'read_file_range', description: '范围读取', parameters: {} },
      vi.fn().mockResolvedValue(rangeRead),
    )
    const executor = new RegistryToolExecutor(registry)

    const full = await executor.execute('read_file', { file_path: 'large.txt' }, 'desktop')
    const range = await executor.execute(
      'read_file_range',
      { path: 'large.txt', line_start: 1, line_end: 2_000 },
      'desktop',
    )

    expect(full.output).toBe(fullRead)
    expect(JSON.parse(range.output)).toMatchObject({
      content: fullRead,
      lineStart: 1,
      lineEnd: 800,
    })
    expect(full.output).not.toContain('truncated by system')
    expect(range.output).not.toContain('truncated by system')
  })

  it('应当处理未知工具与执行异常，展示原件完整且模型观察有界', async () => {
    const registry = new ToolRegistry()
    registry.register(
      { name: 'broken', description: '坏工具', parameters: {} },
      vi.fn().mockRejectedValue(new Error('坏掉了')),
    )
    registry.register(
      { name: 'long', description: '长输出', parameters: {} },
      vi.fn().mockResolvedValue('x'.repeat(MODEL_TOOL_OUTPUT_CHARACTERS + 10_000)),
    )
    const hookEmitter = {
      emitHook: vi.fn(async <T>(_event: string, data: T) => data),
    } as HookEmitter & { emitHook: ReturnType<typeof vi.fn> }
    const executor = new RegistryToolExecutor(registry, null, null, hookEmitter)

    const missing = await executor.execute('missing', {}, 'desktop')
    const broken = await executor.execute('broken', {}, 'desktop')
    const long = await executor.execute('long', {}, 'desktop')

    expect(missing).toMatchObject({ isError: true })
    expect(missing.output).toContain('missing')
    expect(broken.output).toContain('坏掉了')
    expect(broken.isError).toBe(true)
    expect(long.output).toBe('x'.repeat(MODEL_TOOL_OUTPUT_CHARACTERS + 10_000))
    expect(long.modelOutput!.length).toBeLessThanOrEqual(MODEL_TOOL_OUTPUT_CHARACTERS)
    expect(JSON.parse(long.modelOutput!)).toMatchObject({
      observationTruncated: true,
      totalCharacters: long.output.length,
      excerpt: expect.stringContaining('x'.repeat(100)),
    })
    expect(hookEmitter.emitHook).toHaveBeenCalledWith(
      'chat:afterToolCall',
      expect.objectContaining({ isError: true }),
    )
  })

  it('应当加载 Skill、注入参数并递归解锁依赖工具', async () => {
    const { registry } = createRegistry()
    const capabilityGate = {
      unlockSkillTools: vi.fn(),
    } as unknown as CapabilityGate
    const skillLoader = {
      loadSkillContentWithParams: vi.fn().mockReturnValue('技能内容'),
      getManifest: vi.fn((skillId: string) => {
        if (skillId === 'parent') return { dependsOnSkills: ['child'] }
        if (skillId === 'child') return { dependsOnSkills: [] }
        return undefined
      }),
    } as unknown as SkillLoader
    const executor = new RegistryToolExecutor(registry, capabilityGate, skillLoader, null, {
      sessionId: 'session-1',
    })

    const result = await executor.execute(
      'load_skill',
      { skill_id: 'parent', params: { topic: '猫' } },
      'desktop',
    )

    expect(skillLoader.loadSkillContentWithParams).toHaveBeenCalledWith('parent', { topic: '猫' })
    expect(capabilityGate.unlockSkillTools).toHaveBeenCalledWith('session-1', 'parent')
    expect(capabilityGate.unlockSkillTools).toHaveBeenCalledWith('session-1', 'child')
    expect(result).toMatchObject({ output: '技能内容', isError: false, shouldTerminate: false })
  })

  it('Skill临时解锁工具首次调用应审批且会话允许后可复用', async () => {
    const { registry, handler } = createRegistry()
    const capabilityGate = {
      isToolAllowed: vi.fn().mockReturnValue(true),
      isSkillUnlockedTool: vi.fn().mockReturnValue(true),
      isPathAllowed: vi.fn().mockReturnValue(true),
      getToolPermission: vi.fn(),
    } as unknown as CapabilityGate
    const approvals = new ApprovalService()
    const executor = new RegistryToolExecutor(registry, capabilityGate, null, null, {
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'skill-thread',
    })
    executor.setPolicyRuntime(new PolicyEngine(), approvals)

    const first = executor.execute('demo.run', { value: 1 }, 'desktop')
    await vi.waitFor(() => expect(approvals.list({ status: 'pending' })).toHaveLength(1))
    expect(handler).not.toHaveBeenCalled()
    approvals.resolve(approvals.list({ status: 'pending' })[0]!.id, 'allow_session')
    expect((await first).isError).toBe(false)

    const second = await executor.execute('demo.run', { value: 2 }, 'desktop')
    expect(second.isError).toBe(false)
    expect(approvals.list({ status: 'pending' })).toHaveLength(0)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('应当处理 load_skill 参数缺失、系统未初始化与内容缺失', async () => {
    const { registry } = createRegistry()
    const executorWithoutLoader = new RegistryToolExecutor(registry)
    const skillLoader = {
      loadSkillContentWithParams: vi.fn().mockReturnValue(null),
    } as unknown as SkillLoader
    const executorWithLoader = new RegistryToolExecutor(registry, null, skillLoader)

    const missingId = await executorWithoutLoader.execute('load_skill', {}, 'desktop')
    const noLoader = await executorWithoutLoader.execute('load_skill', { skill_id: 'x' }, 'desktop')
    const missingContent = await executorWithLoader.execute(
      'load_skill',
      { skillId: 'x' },
      'desktop',
    )

    expect(missingId).toMatchObject({ output: '缺少参数 skill_id', isError: true })
    expect(noLoader).toMatchObject({ output: 'Skill 系统未初始化', isError: true })
    expect(missingContent).toMatchObject({ output: 'Skill "x" 不存在或加载失败', isError: true })
  })

  // ── 第七阶段修复（批次 A2）：平台能力工具名 → 能力名映射 ──
  describe('平台能力工具路由', () => {
    it('take_screenshot调用应映射为screenCapture Desktop Port操作', async () => {
      const { registry } = createRegistry()
      const invoke = vi.fn().mockResolvedValue({
        success: true,
        screenshots: [{ index: 0, dataUri: 'data:image/png;base64,xxx' }],
        message: '已截取屏幕',
      })
      const executor = new RegistryToolExecutor(registry)
      executor.setDesktopCapabilities({ invoke })

      const result = await executor.execute('take_screenshot', {}, 'desktop')

      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith(
        'screenCapture',
        { __desktopCaller: { agentId: 'pero', threadId: 'default', taskId: undefined } },
        expect.objectContaining({ principalId: 'pero' }),
        undefined,
      )
      expect(result.isError).toBe(false)
      expect(result.output).toContain('screenshots')
    })

    it('screen_capture工具名映射到同一screenCapture操作', async () => {
      const { registry } = createRegistry()
      const invoke = vi.fn().mockResolvedValue({ success: true, screenshots: [] })
      const executor = new RegistryToolExecutor(registry)
      executor.setDesktopCapabilities({ invoke })

      await executor.execute('screen_capture', {}, 'desktop')

      expect(invoke).toHaveBeenCalledWith(
        'screenCapture',
        { __desktopCaller: { agentId: 'pero', threadId: 'default', taskId: undefined } },
        expect.objectContaining({ principalId: 'pero' }),
        undefined,
      )
    })

    it('clipboard_read 等其他平台工具应当直接透传', async () => {
      const { registry } = createRegistry()
      const invoke = vi.fn().mockResolvedValue({ text: '剪贴板内容' })
      const executor = new RegistryToolExecutor(registry)
      executor.setDesktopCapabilities({ invoke })

      await executor.execute('clipboard_read', {}, 'desktop')

      expect(invoke).toHaveBeenCalledWith(
        'clipboardRead',
        { __desktopCaller: { agentId: 'pero', threadId: 'default', taskId: undefined } },
        expect.objectContaining({ principalId: 'pero' }),
        undefined,
      )
    })

    it('CapabilityBridge 未注入时应当返回友好错误', async () => {
      const { registry } = createRegistry()
      // 不调用 setCapabilityBridge，模拟非 Daemon 模式
      const executor = new RegistryToolExecutor(registry)

      const result = await executor.execute('take_screenshot', {}, 'desktop')

      expect(result.isError).toBe(true)
      expect(result.shouldTerminate).toBe(false)
    })

    it('Desktop Capability Port抛错时应返回错误信息', async () => {
      const { registry } = createRegistry()
      const invoke = vi.fn().mockRejectedValue(new Error('节点无响应'))
      const executor = new RegistryToolExecutor(registry)
      executor.setDesktopCapabilities({ invoke })

      const result = await executor.execute('take_screenshot', {}, 'desktop')

      expect(result.isError).toBe(true)
      expect(result.output).toContain('节点无响应')
    })
  })

  it('应当在 before Hook 失败时继续执行工具', async () => {
    const { registry, handler } = createRegistry()
    const hookEmitter = {
      emitHook: vi.fn(async (event: string, data: unknown) => {
        if (event === 'chat:beforeToolCall') throw new Error('Hook 坏了')
        return data
      }),
    } as HookEmitter & { emitHook: ReturnType<typeof vi.fn> }
    const executor = new RegistryToolExecutor(registry, null, null, hookEmitter)

    const result = await executor.execute('demo.run', { value: 1 }, 'desktop')

    expect(handler).toHaveBeenCalledWith({ value: 1 }, expect.any(Object))
    expect(result.isError).toBe(false)
  })
})
