import path from 'node:path'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionSessionManager } from '@infos/backend/services/execution/executionSession'
import { LocalPolicyRunner } from '@infos/backend/services/execution/sandboxRunner'
import { TerminalManager } from '@infos/backend/services/execution/terminalManager'
import {
  planReadOnlyTerminal,
  grantReadOnlyTerminal,
} from '@infos/backend/services/execution/readOnlyTerminal'

let root = ''
const managers = new Set<TerminalManager>()

/** 无界面进程集成固定使用真实管道，避免把终端呈现差异混入输出和退出验证。 */
class HeadlessPolicyRunner extends LocalPolicyRunner {
  override spawnTerminal(...[session, spec]: Parameters<LocalPolicyRunner['spawnTerminal']>) {
    return super.spawnTerminal(session, { ...spec, preferPipe: true })
  }
}

function createManager(sessions: ExecutionSessionManager, runner: LocalPolicyRunner) {
  const manager = new TerminalManager(sessions, runner)
  managers.add(manager)
  return manager
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'infos-terminal-')))
})

afterEach(async () => {
  // 断言失败或测试超时也要先结束进程，Windows 不允许删除仍被终端持有的工作目录。
  try {
    await Promise.all([...managers].map((manager) => manager.dispose()))
  } finally {
    managers.clear()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 30_000)

describe('TerminalManager', () => {
  it('只读脚本内容保留终端历史，且不启动系统进程', async () => {
    const sessions = new ExecutionSessionManager()
    const runner = new HeadlessPolicyRunner()
    const spawn = vi.spyOn(runner, 'spawnTerminal')
    const manager = createManager(sessions, runner)
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'readonly',
      channel: 'desktop',
      workspaceRoot: root,
    })
    await writeFile(path.join(root, 'read.py'), 'print("不执行脚本")\n')
    const args = { command: 'cat', argv: ['read.py'] }
    const plan = planReadOnlyTerminal(args, 'linux')!
    const readOnly = await grantReadOnlyTerminal(plan, root, '.', () => true)
    expect(readOnly).not.toBeNull()
    const result = await manager.run({
      ...args,
      executionSessionId: session.id,
      readOnly: readOnly!,
    })
    expect(result.output).toBe('print("不执行脚本")')
    expect(result.terminal).toMatchObject({ status: 'exited', exitCode: 0, pid: null })
    expect(manager.read(result.terminal.id, session.id).output).toBe('print("不执行脚本")')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('不存在的可执行文件立即报告失败，失败日志保留历史句柄', async () => {
    const sessions = new ExecutionSessionManager()
    const manager = createManager(sessions, new HeadlessPolicyRunner())
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'spawn-failed',
      channel: 'desktop',
      workspaceRoot: root,
    })
    try {
      await expect(
        manager.run({
          executionSessionId: session.id,
          command: 'infos-nonexistent-executable',
          argv: [],
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ code: 'TERMINAL_FAILED' })
      expect(manager.list(session.id, true)).toHaveLength(1)
    } finally {
      await manager.dispose()
    }
  })

  it('取消短命令时等待回收整棵进程树，终端记录也被清理', async () => {
    const sessions = new ExecutionSessionManager()
    const manager = createManager(sessions, new HeadlessPolicyRunner())
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'cancel-tree',
      channel: 'desktop',
      workspaceRoot: root,
    })
    const controller = new AbortController()
    const source = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
console.log('子进程:'+child.pid);setInterval(()=>{},1000);`
    const execution = manager.run({
      executionSessionId: session.id,
      command: process.execPath,
      argv: ['-e', source],
      signal: controller.signal,
      timeoutMs: 30_000,
    })
    const cancelled = expect(execution).rejects.toThrow('父任务停止')
    let childPid = 0
    try {
      await vi.waitFor(
        () => {
          const terminal = manager.list(session.id)[0]!
          const output = manager.read(terminal.id, session.id).output
          childPid = Number(output.match(/子进程:(\d+)/)?.[1] ?? 0)
          expect(childPid).toBeGreaterThan(0)
        },
        { timeout: 10_000 },
      )
      controller.abort(new Error('父任务停止'))
      await cancelled
      expect(manager.list(session.id)).toHaveLength(0)
      await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 5_000 })
    } finally {
      controller.abort(new Error('清理测试资源'))
      await execution.catch(() => undefined)
      await manager.disposeSession(session.id)
    }
  }, 20_000)

  it('短命令超时后回收终端，预先取消的调用不创建进程', async () => {
    const sessions = new ExecutionSessionManager()
    const runner = new HeadlessPolicyRunner()
    const manager = createManager(sessions, runner)
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'timeout-cleanup',
      channel: 'desktop',
      workspaceRoot: root,
    })
    await expect(
      manager.run({
        executionSessionId: session.id,
        command: process.execPath,
        argv: ['-e', 'setInterval(()=>{},1000)'],
        timeoutMs: 100,
      }),
    ).rejects.toThrow('超时')
    expect(manager.list(session.id)).toHaveLength(0)
    const spy = vi.spyOn(runner, 'spawnTerminal')
    const controller = new AbortController()
    controller.abort(new Error('已停止'))
    await expect(
      manager.create({
        executionSessionId: session.id,
        command: process.execPath,
        signal: controller.signal,
      }),
    ).rejects.toThrow('已停止')
    expect(spy).not.toHaveBeenCalled()
  })

  it('参数数组完整保留 JSON、引号、空字符串、中文与尾部反斜杠', async () => {
    const sessions = new ExecutionSessionManager()
    const manager = createManager(sessions, new HeadlessPolicyRunner())
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'argv',
      channel: 'desktop',
      workspaceRoot: root,
    })
    const args = [
      JSON.stringify({ zoom: 1, offsetY: 0, title: '含空格与"引号"' }),
      '',
      'C:\\带空格目录\\',
      '$env:PATH; & echo 不应执行',
    ]
    const result = await manager.run({
      executionSessionId: session.id,
      command: process.execPath,
      argv: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args],
      timeoutMs: 5_000,
    })
    expect(JSON.parse(result.output)).toEqual(args)
    expect(result.terminal.backend).toBe('pipe')
    expect(result.terminal.exitCode).toBe(0)
  })

  it('创建终端后可等待、增量读取和关闭', async () => {
    const sessions = new ExecutionSessionManager()
    const runner = new HeadlessPolicyRunner()
    const manager = createManager(sessions, runner)
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'thread-1',
      channel: 'desktop',
      workspaceRoot: root,
    })
    // 生命周期使用持续运行的真实进程，单独的系统 Shell 用例负责冷启动验证。
    const terminal = await manager.create({
      executionSessionId: session.id,
      command: process.execPath,
      argv: ['-e', "console.log('准备完成'); setInterval(() => {}, 1000)"],
    })
    expect(terminal.backend).toBe('pipe')
    expect(terminal.status).toBe('running')
    const output = await manager.wait(terminal.id, session.id, {
      pattern: '准备完成',
      timeoutMs: 10_000,
    })
    expect(output.output).toContain('准备完成')
    expect(output).toMatchObject({
      status: 'running',
      waitReason: 'pattern',
      timedOut: false,
      matched: true,
      completed: false,
    })
    expect(manager.list(session.id)).toHaveLength(1)
    manager.resize(terminal.id, session.id, 100, 40)
    expect(manager.get(terminal.id, session.id)).toMatchObject({ cols: 100, rows: 40 })
    await manager.close(terminal.id, session.id)
    expect(manager.list(session.id)).toHaveLength(0)
  }, 30_000)

  it('系统 Shell 短命令等待退出并返回完整结果', async () => {
    const sessions = new ExecutionSessionManager()
    const manager = createManager(sessions, new HeadlessPolicyRunner())
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'short',
      channel: 'desktop',
      workspaceRoot: root,
    })
    const command =
      process.platform === 'win32'
        ? 'Write-Output "第一行"; Start-Sleep -Milliseconds 100; Write-Output "第二行"'
        : 'printf "第一行\\n"; sleep 0.1; printf "第二行\\n"'
    const result = await manager.run({ executionSessionId: session.id, command, timeoutMs: 30_000 })
    expect(result.output).toContain('第一行')
    expect(result.output).toContain('第二行')
    expect(result.terminal.status).toBe('exited')
    expect(manager.list(session.id)).toHaveLength(0)
  }, 45_000)

  it('输出缓冲裁剪后仍使用绝对游标继续读取', async () => {
    const sessions = new ExecutionSessionManager()
    const manager = createManager(sessions, new HeadlessPolicyRunner())
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'cursor',
      channel: 'desktop',
      workspaceRoot: root,
      sandboxProfile: {
        name: 'workspace-write',
        readableRoots: [root],
        writableRoots: [root],
        protectedPaths: [],
        network: 'deny',
        inheritEnv: ['PATH', 'Path', 'SystemRoot', 'WINDIR'],
        maxProcesses: 2,
        maxRuntimeMs: 10_000,
        maxOutputBytes: 32,
      },
    })
    // 游标测试直接产生可控输出，不把 PowerShell 冷启动时间混入缓冲区行为。
    const terminal = await manager.create({
      executionSessionId: session.id,
      command: process.execPath,
      argv: [
        '-e',
        "process.stdout.write('a'.repeat(80)); setTimeout(() => console.log('TAIL'), 100)",
      ],
    })
    await manager.wait(terminal.id, session.id, { exitOnly: true, timeoutMs: 5_000 })
    const read = manager.read(terminal.id, session.id, 0, 32_000)
    expect(read.droppedChars).toBeGreaterThan(0)
    expect(read.output).toContain('TAIL')
    expect(read.nextCursor).toBeGreaterThan(32)
    await manager.close(terminal.id, session.id)
  }, 30_000)

  it('相对 cwd 始终以执行会话 workspace 根目录为基准', async () => {
    const sessions = new ExecutionSessionManager()
    const manager = createManager(sessions, new HeadlessPolicyRunner())
    const session = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'relative-cwd',
      channel: 'desktop',
      workspaceRoot: root,
    })
    await mkdir(path.join(root, 'notes'))
    const result = await manager.run({
      executionSessionId: session.id,
      command: process.execPath,
      argv: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: 'notes',
      timeoutMs: 10_000,
    })
    expect(result.output).toContain(path.join(root, 'notes'))
  }, 30_000)

  it('拒绝其他执行会话访问终端', async () => {
    const sessions = new ExecutionSessionManager()
    const manager = createManager(sessions, new HeadlessPolicyRunner())
    const owner = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'owner',
      channel: 'desktop',
      workspaceRoot: root,
    })
    const other = await sessions.getOrCreate({
      ownerAgentId: 'pero',
      threadId: 'other',
      channel: 'desktop',
      workspaceRoot: root,
    })
    const terminal = await manager.create({
      executionSessionId: owner.id,
      command: process.platform === 'win32' ? 'Write-Output ok' : 'printf ok',
    })
    expect(() => manager.get(terminal.id, other.id)).toThrow(Error)
    await manager.disposeSession(owner.id)
  })
})
