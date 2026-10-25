import { afterEach, describe, expect, it, vi } from 'vitest'
import { runScriptTool } from '@infos/backend/tools/runScript'
import type { ToolContext } from '@infos/backend/services/agent/toolRegistry'
import type { ToolExecutionResult } from '@infos/backend/services/agent/reactLoop'
import { trackCancellationCleanup } from '@infos/backend/services/execution/cancellation'
import { ToolLoopGuard } from '@infos/backend/services/agent/toolLoopGuard'

vi.mock('@infos/backend/tools/workspaceServiceHolder', () => ({ getWorkspaceService: () => null }))

const originalExecutor = runScriptTool._toolExecutor
const context: ToolContext = {
  agentId: 'pero',
  source: 'desktop',
  channel: 'desktop',
  threadId: 'nit-thread',
  sessionId: 'nit-session',
  taskId: 'nit-task',
  pairId: 'nit-pair',
  interactionMode: 'work',
  executionMode: 'manual',
}
const success = (output = '完成'): ToolExecutionResult => ({
  output,
  durationMs: 1,
  isError: false,
  shouldTerminate: false,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  runScriptTool._toolExecutor = originalExecutor
  vi.useRealTimers()
})

describe('NIT 取消与超时', () => {
  it('循环切断信号会取消正在等待的 NIT 子工具，且内部共享同一检测器', async () => {
    const guard = new ToolLoopGuard()
    for (let index = 0; index < 6; index++)
      guard.observe('edit_file', { path: 'a' }, '相同失败', true)
    const started = deferred<void>()
    let childSignal: AbortSignal | undefined
    runScriptTool.bindToolExecutor!((_name, _args, _source, ctx) => {
      expect(ctx?.loopGuard).toBe(guard)
      childSignal = ctx?.signal
      started.resolve()
      return new Promise<ToolExecutionResult>((_resolve, reject) => {
        ctx!.signal!.addEventListener('abort', () => reject(ctx!.signal!.reason), { once: true })
      })
    })
    const execution = runScriptTool.execute(
      { code: 'waiting()' },
      {
        ...context,
        loopGuard: guard,
        signal: guard.signal,
      },
    )
    const rejected = expect(execution).rejects.toThrow('相同的无进展循环')
    await started.promise
    expect(guard.before('edit_file', { path: 'a' })).toBeDefined()
    expect(() => guard.before('edit_file', { path: 'a' })).toThrow('相同的无进展循环')
    await rejected
    expect(childSignal?.aborted).toBe(true)
  })

  it('子调用在执行前报告父调用与唯一 ID，完成观察沿用同一 ID', async () => {
    const onNestedToolCall = vi.fn()
    const onToolObserved = vi.fn()
    const executor = vi.fn(async (name, args, _source, runtimeContext) => {
      expect(onNestedToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          name,
          args,
          parentCallId: 'outer-script',
          callId: runtimeContext.toolCallId,
        }),
      )
      await runtimeContext.onToolObserved?.({
        name,
        args,
        callId: runtimeContext.toolCallId,
        output: '已完成',
        isError: false,
        durationMs: 1,
      })
      return success()
    })
    runScriptTool.bindToolExecutor!(executor)
    await runScriptTool.execute(
      { code: 'first()\nsecond()' },
      {
        ...context,
        toolCallId: 'outer-script',
        onNestedToolCall,
        onToolObserved,
      },
    )
    expect(onNestedToolCall).toHaveBeenCalledTimes(2)
    expect(onToolObserved).toHaveBeenCalledTimes(2)
    const ids = onNestedToolCall.mock.calls.map(([call]) => call.callId)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id: string) => id.startsWith('nit-'))).toBe(true)
  })

  it.each([false, true])(
    '高级菜单 expanded=%s 时，未开放工具在任何副作用前被拒绝',
    async (expanded) => {
      const executor = vi.fn().mockResolvedValue(success())
      runScriptTool.bindToolExecutor!(executor)
      await expect(
        runScriptTool.execute(
          { code: 'terminal_execute(command="先执行")\nif true { browser_get_content() }' },
          { ...context, advancedToolAccess: { expanded, names: new Set() } },
        ),
      ).rejects.toThrow('脚本尚未执行任何工具')
      expect(executor).not.toHaveBeenCalled()
    },
  )

  it('预检不会把字符串中的高级工具名识别为工具调用', async () => {
    const executor = vi.fn().mockResolvedValue(success())
    runScriptTool.bindToolExecutor!(executor)
    await runScriptTool.execute(
      { code: 'return "browser_get_content()"' },
      { ...context, advancedToolAccess: { expanded: false, names: new Set() } },
    )
    expect(executor).not.toHaveBeenCalled()
  })

  it.each(['open_application', 'get_active_windows', 'activate_window'])(
    '%s 未展开时，脚本在前置工具产生副作用前拒绝整段执行',
    async (name) => {
      const executor = vi.fn().mockResolvedValue(success())
      runScriptTool.bindToolExecutor!(executor)
      await expect(
        runScriptTool.execute(
          { code: `terminal_execute(command="前置操作")\n${name}()` },
          { ...context, advancedToolAccess: { expanded: false, names: new Set([name]) } },
        ),
      ).rejects.toThrow('脚本尚未执行任何工具')
      expect(executor).not.toHaveBeenCalled()
    },
  )

  it('桌面接管后停止脚本，脚本 catch 也不能继续下一项工具', async () => {
    const executor = vi.fn(async () => ({
      output: JSON.stringify({
        success: false,
        error: { code: 'DESKTOP_WAITING', message: '用户已接管' },
      }),
      durationMs: 1,
      isError: true,
      shouldTerminate: false,
    }))
    runScriptTool.bindToolExecutor!(executor)
    await expect(
      runScriptTool.execute(
        {
          code: 'try { open_application() } catch { unexpected() }\nafter()',
        },
        context,
      ),
    ).rejects.toThrow('桌面已被接管')
    expect(executor).toHaveBeenCalledOnce()
  })
  it('不能在脚本内部虚报高级工具已展开', async () => {
    const executor = vi.fn()
    runScriptTool.bindToolExecutor!(executor)
    await expect(
      runScriptTool.execute({ code: 'expand_advanced_tools()' }, context),
    ).rejects.toThrow('脚本外直接调用')
    expect(executor).not.toHaveBeenCalled()
  })

  it('内部工具沿用当前执行的高级工具展开状态', async () => {
    const access = { names: new Set(['browser_get_content']), expanded: true }
    const executor = vi.fn().mockResolvedValue(success('网页正文'))
    runScriptTool.bindToolExecutor!(executor)
    await runScriptTool.execute(
      { code: 'browser_get_content()' },
      { ...context, advancedToolAccess: access },
    )
    expect(executor.mock.calls[0]?.[3].advancedToolAccess).toBe(access)
  })

  it('完整传递父任务上下文，顺序调用前一个返回后才启动下一项', async () => {
    const first = deferred<ToolExecutionResult>()
    const started = deferred<void>()
    const executor = vi.fn(async (name: string) => {
      if (name === 'first') {
        started.resolve()
        return first.promise
      }
      return success()
    })
    runScriptTool.bindToolExecutor!(executor)
    const execution = runScriptTool.execute({ code: 'first()\nsecond()' }, context)
    await started.promise
    expect(executor).toHaveBeenCalledTimes(1)
    first.resolve(success())
    await execution
    expect(executor).toHaveBeenCalledTimes(2)
    expect(executor.mock.calls[0]).toEqual([
      'first',
      {},
      'desktop',
      expect.objectContaining({
        taskId: context.taskId,
        threadId: context.threadId,
        pairId: context.pairId,
        signal: expect.any(AbortSignal),
        deadline: expect.any(String),
        toolCallId: expect.stringMatching(/^nit-/),
      }),
    ])
  })

  it('父任务停止会取消正在执行的工具，不能进入 catch 或下一项', async () => {
    const parent = new AbortController()
    const started = deferred<void>()
    const executor = vi.fn(
      (_name: string, _args: unknown, _source: string, ctx?: { signal?: AbortSignal }) => {
        started.resolve()
        return new Promise<ToolExecutionResult>((_resolve, reject) => {
          ctx!.signal!.addEventListener('abort', () => reject(ctx!.signal!.reason), { once: true })
        })
      },
    )
    runScriptTool.bindToolExecutor!(executor)
    const execution = runScriptTool.execute(
      { code: 'try { waiting() } catch { unexpected() }\nafter()' },
      {
        ...context,
        signal: parent.signal,
      },
    )
    const rejected = expect(execution).rejects.toThrow('父任务已停止')
    await started.promise
    parent.abort(new Error('父任务已停止'))
    await rejected
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('等待超过30秒不会耗尽自身执行预算，但总耗时上限仍会取消工具', async () => {
    vi.useFakeTimers()
    const started = deferred<void>()
    let childSignal: AbortSignal | undefined
    runScriptTool.bindToolExecutor!((_name, _args, _source, ctx) => {
      childSignal = ctx?.signal
      started.resolve()
      return new Promise<ToolExecutionResult>((_resolve, reject) => {
        childSignal!.addEventListener('abort', () => reject(childSignal!.reason), { once: true })
      })
    })
    let settled = false
    const execution = runScriptTool
      .execute({ code: 'waiting()', timeout_ms: 60_000 }, context)
      .finally(() => {
        settled = true
      })
    const rejected = expect(execution).rejects.toThrow('截止时间')
    await started.promise
    await vi.advanceTimersByTimeAsync(31_000)
    expect(settled).toBe(false)
    expect(childSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(29_000)
    await rejected
    expect(childSignal?.aborted).toBe(true)
  })

  it('父任务截止时间优先于脚本预算，已取消任务不会启动任何工具', async () => {
    vi.useFakeTimers()
    const executor = vi.fn(
      (_name: string, _args: unknown, _source: string, ctx?: { signal?: AbortSignal }) =>
        new Promise<ToolExecutionResult>((_resolve, reject) => {
          ctx!.signal!.addEventListener('abort', () => reject(ctx!.signal!.reason), { once: true })
        }),
    )
    runScriptTool.bindToolExecutor!(executor)
    const execution = runScriptTool.execute(
      { code: 'waiting()', timeout_ms: 60_000 },
      {
        ...context,
        deadline: new Date(Date.now() + 100).toISOString(),
      },
    )
    const rejected = expect(execution).rejects.toThrow('截止时间')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    executor.mockClear()
    const parent = new AbortController()
    parent.abort(new Error('预先停止'))
    await expect(
      runScriptTool.execute({ code: 'waiting()' }, { ...context, signal: parent.signal }),
    ).rejects.toThrow('预先停止')
    expect(executor).not.toHaveBeenCalled()
  })

  it('脚本结束会等待本脚本所创建资源的取消回收完成', async () => {
    let reclaimed = false
    runScriptTool.bindToolExecutor!(async (_name, _args, _source, ctx) => {
      ctx!.signal!.addEventListener(
        'abort',
        () => {
          const cleanup = Promise.resolve().then(() => {
            reclaimed = true
          })
          trackCancellationCleanup(ctx!.signal!, cleanup)
        },
        { once: true },
      )
      return success()
    })
    await runScriptTool.execute({ code: 'create_resource()' }, context)
    expect(reclaimed).toBe(true)
  })

  it('并行创建的资源可供后续顺序步骤使用，最后仍跟随脚本回收', async () => {
    let resourceSignal: AbortSignal | undefined
    let reclaimed = false
    runScriptTool.bindToolExecutor!(async (name, _args, _source, ctx) => {
      if (name === 'create_resource') {
        resourceSignal = ctx?.signal
        resourceSignal!.addEventListener(
          'abort',
          () => {
            trackCancellationCleanup(
              resourceSignal!,
              Promise.resolve().then(() => {
                reclaimed = true
              }),
            )
          },
          { once: true },
        )
      } else {
        expect(resourceSignal?.aborted).toBe(false)
      }
      return success()
    })
    await runScriptTool.execute({ code: 'parallel { create_resource() }\nuse_resource()' }, context)
    expect(resourceSignal?.aborted).toBe(true)
    expect(reclaimed).toBe(true)
  })

  it('禁止嵌套脚本重置预算，也禁止在脚本内调用读图工具', async () => {
    const executor = vi.fn().mockResolvedValue(success())
    runScriptTool.bindToolExecutor!(executor)
    await expect(
      runScriptTool.execute({ code: 'run_script(code="return 1")' }, context),
    ).rejects.toThrow('不允许嵌套')
    await expect(
      runScriptTool.execute({ code: 'read_image(file_path="a.png")' }, context),
    ).rejects.toThrow('直接调用 read_image')
    expect(executor).not.toHaveBeenCalled()
  })
})
