import { t as __t } from '../../lib/i18n'
/**
 * sandboxRunner — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { realpath } from 'node:fs/promises'
import type { IPty } from 'node-pty'
import type { ExecutionSession } from './executionSession'
import { trackCancellationCleanup } from './cancellation'
import { createLogger } from '../../lib/logger'
import { resolveWindowsCmdSpawn } from './windowsCmdArgs'

const logger = createLogger('SandboxRunner')

/** Windows 环境变量名不区分大小写；Worker 中的 process.env 副本可能区分，不能据此漏掉系统变量。 */
export function selectInheritedEnvironment(
  names: string[],
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const normalize = (key: string) => (platform === 'win32' ? key.toLowerCase() : key)
  const keys = new Map(Object.keys(source).map((key) => [normalize(key), key]))
  const selected = new Set<string>()
  const result: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const key = normalize(name)
    const value = source[keys.get(key) ?? name]
    if (value === undefined || selected.has(key)) continue
    result[name] = value
    selected.add(key)
  }
  return result
}

export interface ProcessSpec {
  approvedOutsideWorkspace?: boolean
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  shell?: boolean | string
  signal?: AbortSignal
  cols?: number
  rows?: number
  /** 直接执行参数数组时使用管道，让 Node 完整保留 Windows 参数边界。 */
  preferPipe?: boolean
}

export interface SandboxProcess {
  id: string
  child: ChildProcessWithoutNullStreams
}

export interface ManagedTerminalProcess {
  id: string
  pid: number | null
  backend: 'pty' | 'pipe'
  onData(listener: (data: string) => void): void
  onExit(listener: (code: number | null, signal: string | null) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
}

export interface SandboxRunner {
  readonly kind: string
  createSession(session: ExecutionSession): Promise<void>
  spawn(session: ExecutionSession, spec: ProcessSpec): Promise<SandboxProcess>
  spawnTerminal(session: ExecutionSession, spec: ProcessSpec): Promise<ManagedTerminalProcess>
  terminateProcess(processId: string, force?: boolean): Promise<void>
  disposeSession(sessionId: string): Promise<void>
}

interface ManagedProcessEntry {
  sessionId: string
  pid: number | null
  running: boolean
  disposeAbort?: () => void
  termination?: Promise<void>
  terminatingForce?: boolean
  terminate(force: boolean): Promise<void>
}

/**
 * 本地策略执行器。
 *
 * 终端优先使用 node-pty（Windows ConPTY / Unix PTY），原生模块不可用时自动降级为 pipe。
 * 它仍不是 OS 级强沙箱，所有平台后端都必须继续遵守执行会话的 cwd 与环境策略。
 */
export class LocalPolicyRunner implements SandboxRunner {
  readonly kind = 'local-policy'
  private readonly processes = new Map<string, ManagedProcessEntry>()
  private readonly require = createRequire(import.meta.url)

  async createSession(_session: ExecutionSession): Promise<void> {}

  async spawn(session: ExecutionSession, spec: ProcessSpec): Promise<SandboxProcess> {
    const { cwd, env } = await this.prepareProcess(session, spec)
    spec.signal?.throwIfAborted()
    const windowsCmd = spec.shell ? null : resolveWindowsCmdSpawn(spec.command, spec.args)
    const child = spawn(spec.command, windowsCmd?.args ?? spec.args ?? [], {
      cwd,
      env,
      shell: spec.shell ?? false,
      ...(windowsCmd ? { windowsVerbatimArguments: true } : {}),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const id = `${session.id}:${child.pid ?? Date.now()}`
    this.registerProcess(id, session.id, child.pid ?? null, async (force) => {
      await this.killProcessTree(child.pid, force, child)
    })
    child.once('exit', () => this.markExited(id))
    child.once('error', () => this.markExited(id))
    this.bindAbort(id, spec.signal)
    return { id, child }
  }

  async spawnTerminal(
    session: ExecutionSession,
    spec: ProcessSpec,
  ): Promise<ManagedTerminalProcess> {
    const prepared = await this.prepareProcess(session, spec)
    spec.signal?.throwIfAborted()
    const pty = spec.preferPipe ? null : this.trySpawnPty(spec, prepared.cwd, prepared.env)
    if (pty) return this.wrapPty(session, spec, pty)
    return this.spawnPipeTerminal(session, spec, prepared.cwd, prepared.env)
  }

  async terminateProcess(processId: string, force = false): Promise<void> {
    const entry = this.processes.get(processId)
    if (!entry?.running) return
    // 取消、超时和会话关闭可能同时到达，同一进程树只回收一次。
    if (!entry.termination || (force && !entry.terminatingForce)) {
      entry.terminatingForce = force
      entry.termination = entry.terminate(force)
    }
    try {
      await entry.termination
    } catch (error) {
      // 回收失败不能缓存为已完成，后续会话关闭仍可再次尝试。
      entry.termination = undefined
      throw error
    }
  }

  async disposeSession(sessionId: string): Promise<void> {
    const ids = [...this.processes.entries()]
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([id]) => id)
    await Promise.all(ids.map((id) => this.terminateProcess(id, true)))
  }

  private trySpawnPty(spec: ProcessSpec, cwd: string, env: NodeJS.ProcessEnv): IPty | null {
    try {
      const nodePty = this.require('node-pty') as typeof import('node-pty')
      const windowsCmd = resolveWindowsCmdSpawn(spec.command, spec.args)
      return nodePty.spawn(spec.command, windowsCmd?.commandLine ?? spec.args ?? [], {
        name:
          process.platform === 'win32' ? 'xterm-256color' : process.env.TERM || 'xterm-256color',
        cols: Math.max(20, spec.cols ?? 120),
        rows: Math.max(5, spec.rows ?? 30),
        cwd,
        env,
        // Windows ConPTY 固定使用 UTF-8，传入 encoding 会被 node-pty 拒绝并打印警告。
        ...(process.platform === 'win32' ? {} : { encoding: 'utf8' as const }),
        useConpty: process.platform === 'win32',
      })
    } catch {
      return null
    }
  }

  private wrapPty(session: ExecutionSession, spec: ProcessSpec, pty: IPty): ManagedTerminalProcess {
    const id = `${session.id}:pty:${pty.pid}`
    const exitListeners = new Set<(code: number | null, signal: string | null) => void>()
    const dataListeners = new Set<(data: string) => void>()
    pty.onData((data) => {
      for (const listener of dataListeners) listener(data)
    })
    pty.onExit(({ exitCode, signal }) => {
      this.markExited(id)
      for (const listener of exitListeners) listener(exitCode, signal ? String(signal) : null)
    })
    this.registerProcess(id, session.id, pty.pid, async (force) => {
      if (process.platform === 'win32') {
        await this.killProcessTree(pty.pid, force)
        try {
          pty.kill(force ? 'SIGKILL' : 'SIGTERM')
        } catch {
          /* 进程已退出。 */
        }
      } else {
        const signal = force ? 'SIGKILL' : 'SIGTERM'
        try {
          process.kill(-pty.pid, signal)
        } catch {
          // 优先杀整个进程组，避免 Unix 下幽灵子进程
          pty.kill(signal)
        } // 进程组不可用时退回只杀 pty 主进程
      }
    })
    this.bindAbort(id, spec.signal)
    return {
      id,
      pid: pty.pid,
      backend: 'pty',
      onData: (listener) => dataListeners.add(listener),
      onExit: (listener) => exitListeners.add(listener),
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(Math.max(1, cols), Math.max(1, rows)),
    }
  }

  private async spawnPipeTerminal(
    session: ExecutionSession,
    spec: ProcessSpec,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<ManagedTerminalProcess> {
    const windowsCmd = resolveWindowsCmdSpawn(spec.command, spec.args)
    const child = spawn(spec.command, windowsCmd?.args ?? spec.args ?? [], {
      cwd,
      env,
      shell: false,
      ...(windowsCmd ? { windowsVerbatimArguments: true } : {}),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // 由流解码器保留跨批次 UTF-8 字节，避免中文被截断成替换字符。
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const id = `${session.id}:pipe:${child.pid ?? Date.now()}`
    this.registerProcess(id, session.id, child.pid ?? null, async (force) => {
      await this.killProcessTree(child.pid, force, child)
    })
    child.once('error', () => this.markExited(id))
    this.bindAbort(id, spec.signal)
    return {
      id,
      pid: child.pid ?? null,
      backend: 'pipe',
      onData: (listener) => {
        child.stdout.on('data', (chunk: string) => listener(chunk))
        child.stderr.on('data', (chunk: string) => listener(`\n[stderr] ${chunk}`))
      },
      onExit: (listener) => {
        child.once('error', (error) => listener(1, error.message))
        // 等标准输出与错误流都关闭后再报告退出，避免短进程丢失尾部结果。
        child.once('close', (code, signal) => {
          this.markExited(id)
          listener(code, signal)
        })
      },
      write: (data) => child.stdin.write(data),
      resize: () => undefined,
    }
  }

  private async prepareProcess(session: ExecutionSession, spec: ProcessSpec) {
    spec.signal?.throwIfAborted()
    const activeCount = [...this.processes.values()].filter(
      (entry) => entry.sessionId === session.id && entry.running,
    ).length
    if (activeCount >= session.sandboxProfile.maxProcesses) {
      throw new Error(`执行会话进程数已达到上限 ${session.sandboxProfile.maxProcesses}`)
    }
    const cwd = path.resolve(spec.cwd ?? session.workspaceRoot)
    const roots = session.sandboxProfile.readableRoots
    const allowed =
      spec.approvedOutsideWorkspace === true ||
      session.sandboxProfile.name === 'full-access' ||
      roots.some((root) => {
        const relative = path.relative(path.resolve(root), cwd)
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      })
    if (!allowed) throw new Error(`终端工作目录超出执行会话允许范围: ${cwd}`)
    // 词法路径合法仍可能经 symlink/Junction 指向外部，启动进程前必须校验真实 cwd。
    const actualCwd = await realpath(cwd)
    const realRoots = await Promise.all(
      roots.map(async (root) => realpath(root).catch(() => path.resolve(root))),
    )
    const actualAllowed =
      spec.approvedOutsideWorkspace === true ||
      session.sandboxProfile.name === 'full-access' ||
      realRoots.some((root) => {
        const relative = path.relative(root, actualCwd)
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      })
    if (!actualAllowed) throw new Error(`终端工作目录通过符号链接越出执行会话允许范围: ${cwd}`)
    spec.signal?.throwIfAborted()
    return { cwd: actualCwd, env: this.buildEnvironment(session, spec.env) }
  }

  private registerProcess(
    id: string,
    sessionId: string,
    pid: number | null,
    terminate: (force: boolean) => Promise<void>,
  ): void {
    this.processes.set(id, { sessionId, pid, running: true, terminate })
  }

  private markExited(id: string): void {
    const entry = this.processes.get(id)
    if (entry) {
      entry.running = false
      entry.disposeAbort?.()
    }
    this.processes.delete(id)
  }

  private bindAbort(id: string, signal?: AbortSignal): void {
    if (!signal) return
    const abort = () => {
      const cleanup = this.terminateProcess(id, true)
      trackCancellationCleanup(signal, cleanup)
      void cleanup.catch((error) =>
        logger.error(__t('logs.execution', '取消后回收进程失败: {0}，{1}', [id, String(error)])),
      )
    }
    const entry = this.processes.get(id)
    if (entry) entry.disposeAbort = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }

  private async killProcessTree(
    pid: number | undefined,
    force: boolean,
    child?: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (!pid) return
    if (process.platform === 'win32') {
      // 用 taskkill /T 杀掉整棵进程树，避免 PowerShell 派生的子进程成为幽灵终端。
      const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
      const killer = spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' })
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          resolve()
        }
        // 回收程序自身也有上限，避免退出流程被 taskkill 卡住。
        const timer = setTimeout(() => {
          killer.kill()
          finish()
        }, 3_000)
        killer.once('error', finish)
        killer.once('exit', finish)
      })
      // taskkill 兜底之后，若子进程句柄仍未退出（如 taskkill 缺失），直接对句柄再杀一次。
      if (child && child.pid && child.exitCode === null) {
        try {
          child.kill(force ? 'SIGKILL' : 'SIGTERM')
        } catch {
          /* 进程已退出，忽略 */
        }
      }
    } else {
      try {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        child?.kill(force ? 'SIGKILL' : 'SIGTERM')
      }
    }
    if (force) {
      const until = Date.now() + 1_000
      for (;;) {
        if (child && (child.exitCode !== null || child.signalCode !== null)) return
        try {
          process.kill(pid, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
          throw error
        }
        if (Date.now() >= until) throw new Error(`进程回收后仍未确认退出: ${pid}`)
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
    }
  }

  private buildEnvironment(
    session: ExecutionSession,
    additions?: Record<string, string>,
  ): NodeJS.ProcessEnv {
    const env = selectInheritedEnvironment(session.sandboxProfile.inheritEnv)
    env.PAGER = 'cat'
    env.NO_COLOR = '1'
    env.INFOS_EXECUTION_SESSION_ID = session.id
    env.INFOS_SANDBOX_PROFILE = session.sandboxProfile.name
    for (const [key, value] of Object.entries(additions ?? {})) env[key] = value
    if (!env.HOME && os.homedir()) env.HOME = os.homedir()
    return env
  }
}
