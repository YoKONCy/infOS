import { t as __t } from '../../lib/i18n'
/**
 * terminalManager — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ExecutionSession, ExecutionSessionManager } from './executionSession'
import type { SandboxRunner } from './sandboxRunner'
import { trackCancellationCleanup, waitForCancellationCleanup } from './cancellation'
import { createLogger } from '../../lib/logger'
import { realpath } from 'node:fs/promises'
import { executeReadOnlyTerminal, type ReadOnlyTerminalGrant } from './readOnlyTerminal'

const logger = createLogger('TerminalManager')

export type TerminalStatus = 'running' | 'exited' | 'killed' | 'failed'

export interface TerminalSnapshot {
  id: string
  executionSessionId: string
  title: string
  command?: string
  argv?: string[]
  cwd: string
  pid: number | null
  status: TerminalStatus
  startedAt: string
  exitedAt?: string
  exitCode?: number | null
  signal?: string | null
  outputLength: number
  backend: 'pty' | 'pipe'
  cols: number
  rows: number
  owner: 'agent' | 'user'
  ownerAgentId: string
  threadId?: string
  taskId?: string
  pinned: boolean
  archivedAt?: string
  exitReason?: 'exit' | 'timeout' | 'cancelled' | 'killed'
}

interface TerminalRecord extends TerminalSnapshot {
  processId: string
  output: string
  writeInput: (data: string) => void
  resizeTerminal: (cols: number, rows: number) => void
  maxOutputBytes: number
  /** 当前缓冲区首字符在完整输出流中的绝对偏移。 */
  bufferStartOffset: number
  /** 完整输出流累计字符数（单调递增）。 */
  absoluteOutputLength: number
  sourceSignal?: AbortSignal
  detachSignal: () => void
  releaseProcess: () => void
}

export interface TerminalRunResult {
  terminal: TerminalSnapshot
  output: string
  truncated: boolean
}

/** 失败仍携带输出与历史句柄，工具层可以返回可继续读取的结构化结果。 */
export class TerminalRunError extends Error {
  constructor(
    readonly code: 'TERMINAL_TIMEOUT' | 'TERMINAL_FAILED' | 'TERMINAL_CANCELLED',
    message: string,
    readonly result: TerminalRunResult,
  ) {
    super(message)
  }
}

export interface CreateTerminalInput {
  approvedOutsideWorkspace?: boolean
  readOnly?: ReadOnlyTerminalGrant
  executionSessionId: string
  /** 为空时启动当前平台的交互式系统 Shell。 */
  command?: string
  /** 提供参数数组时直接启动可执行文件，参数不经过 Shell 解析。 */
  argv?: string[]
  cwd?: string
  title?: string
  signal?: AbortSignal
  cols?: number
  rows?: number
  owner?: 'agent' | 'user'
}

/**
 * 多终端管理器（第一期 pipe backend）。
 *
 * 每次创建立即返回句柄，长时命令不会占住 ReAct 工具调用；后续可无缝把底层替换为 node-pty。
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly pendingCreates = new Set<Promise<TerminalSnapshot>>()
  private readonly ownerEpochs = new Map<string, number>()
  private readonly retainedResults = new Map<string, Set<string>>()
  private closed = false
  private readonly sweepTimer: ReturnType<typeof setInterval>

  constructor(
    private readonly sessions: ExecutionSessionManager,
    private readonly runner: SandboxRunner,
    private readonly retention = {
      archiveAfterMs: 30_000,
      historyMs: 24 * 60 * 60_000,
      perSession: 50,
      total: 200,
    },
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), 15_000)
    this.sweepTimer.unref?.()
  }

  create(input: CreateTerminalInput): Promise<TerminalSnapshot> {
    const operation = this.createTerminal(input)
    this.pendingCreates.add(operation)
    const done = () => {
      this.pendingCreates.delete(operation)
    }
    void operation.then(done, done)
    return operation
  }

  private async createTerminal(input: CreateTerminalInput): Promise<TerminalSnapshot> {
    if (this.closed) throw new Error('终端管理器已关闭')
    input.signal?.throwIfAborted()
    const session = this.requireSession(input.executionSessionId)
    const ownerEpoch = this.ownerEpochs.get(session.id) ?? 0
    const terminalId = randomUUID()
    // 终端工具的相对 cwd 永远基于当前 Agent 的执行会话 workspace，而非后端进程 cwd。
    // 缺省或 "." 均指向 workspace 根目录；绝对路径仍交给 SandboxRunner 做范围校验。
    const requestedCwd = input.cwd?.trim()
    const cwd = requestedCwd
      ? path.isAbsolute(requestedCwd)
        ? path.normalize(requestedCwd)
        : path.resolve(session.workspaceRoot, requestedCwd)
      : session.workspaceRoot
    if (input.readOnly) return this.createReadOnlyTerminal(input, session, ownerEpoch)
    const shell = this.resolveShell(input.command, input.argv)
    // 信号的桥接可以在正常轮次结束时解绑；终端随后由 Thread/Task 生命周期接管。
    const controller = new AbortController()
    const abort = () => {
      controller.abort(input.signal?.reason)
      const cleanup = waitForCancellationCleanup(controller.signal)
      if (input.signal) trackCancellationCleanup(input.signal, cleanup)
      void cleanup.catch((error) =>
        logger.error(__t('logs.execution', '取消终端时进程回收失败'), { terminalId, error }),
      )
    }
    const detachSignal = () => input.signal?.removeEventListener('abort', abort)
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
    let process: Awaited<ReturnType<SandboxRunner['spawnTerminal']>>
    try {
      process = await this.runner.spawnTerminal(session, {
        approvedOutsideWorkspace: input.approvedOutsideWorkspace,
        command: shell.command,
        args: shell.args,
        cwd,
        signal: controller.signal,
        cols: input.cols,
        rows: input.rows,
        preferPipe: input.argv !== undefined,
      })
    } catch (error) {
      detachSignal()
      throw error
    }
    const now = new Date().toISOString()
    const record: TerminalRecord = {
      id: terminalId,
      executionSessionId: session.id,
      title: input.title?.trim() || shell.title,
      command: input.command,
      argv: input.argv ? [...input.argv] : undefined,
      cwd,
      pid: process.pid,
      status: 'running',
      startedAt: now,
      outputLength: 0,
      backend: process.backend,
      cols: input.cols ?? 120,
      rows: input.rows ?? 30,
      owner: input.owner ?? 'agent',
      ownerAgentId: session.ownerAgentId,
      threadId: session.threadId,
      taskId: session.taskId,
      pinned: input.owner === 'user',
      sourceSignal: input.signal,
      detachSignal,
      releaseProcess: () => {
        detachSignal()
        record.sourceSignal = undefined
        record.detachSignal = () => {}
        record.writeInput = () => {}
        record.resizeTerminal = () => {}
        record.releaseProcess = () => {}
      },
      processId: process.id,
      output: '',
      writeInput: (data) => process.write(data),
      resizeTerminal: (cols, rows) => process.resize(cols, rows),
      maxOutputBytes: session.sandboxProfile.maxOutputBytes,
      bufferStartOffset: 0,
      absoluteOutputLength: 0,
    }
    this.terminals.set(terminalId, record)
    const append = (chunk: Buffer | string) => {
      const text = chunk.toString()
      record.output += text
      record.absoluteOutputLength += text.length
      if (Buffer.byteLength(record.output, 'utf8') > record.maxOutputBytes) {
        const before = record.output.length
        record.output = Buffer.from(record.output)
          .subarray(-record.maxOutputBytes)
          .toString('utf8')
          .replace(/^\uFFFD+/, '')
        record.bufferStartOffset += before - record.output.length
      }
      record.outputLength = record.absoluteOutputLength
      this.notify(terminalId)
    }
    process.onData(append)
    process.onExit((code, signal) => {
      record.status =
        record.status === 'killed' ||
        controller.signal.aborted ||
        (record.exitReason && record.exitReason !== 'exit')
          ? 'killed'
          : code === 0
            ? 'exited'
            : 'failed'
      record.exitCode = code
      record.signal = signal
      record.exitedAt = new Date().toISOString()
      record.exitReason ??= controller.signal.aborted ? 'cancelled' : 'exit'
      record.releaseProcess()
      this.notify(terminalId)
    })
    if (input.signal?.aborted) {
      await this.kill(terminalId, session.id, 'cancelled')
      this.archive(terminalId, session.id)
      input.signal.throwIfAborted()
    }
    if (this.closed || session.state !== 'active') {
      await this.close(terminalId, session.id)
      throw new Error('创建终端期间执行会话已关闭')
    }
    if (input.owner !== 'user' && ownerEpoch !== (this.ownerEpochs.get(session.id) ?? 0)) {
      await this.kill(terminalId, session.id, 'cancelled')
      this.archive(terminalId, session.id)
      throw new Error('创建终端期间所有者已请求停止')
    }
    return this.snapshot(record)
  }

  /** 只读查询沿用终端历史与游标，不创建系统进程或可写的交互会话。 */
  private async createReadOnlyTerminal(
    input: CreateTerminalInput,
    session: ExecutionSession,
    ownerEpoch: number,
  ): Promise<TerminalSnapshot> {
    const startedAt = new Date().toISOString()
    let output: string,
      exitCode = 0
    try {
      if ((await realpath(session.workspaceRoot)) !== input.readOnly!.root)
        throw new Error(
          __t('errors.terminal-readonly', 'READ_ONLY_CONTEXT_CHANGED: 只读查询参数或工作区已变化'),
        )
      const roots = await Promise.all(
        session.sandboxProfile.readableRoots.map((root) => realpath(root)),
      )
      const grant = input.readOnly!
      output = await executeReadOnlyTerminal(
        {
          ...grant,
          checkPath: (target) => {
            const allowed =
              session.sandboxProfile.name === 'full-access' ||
              roots.some((root) => {
                const relative = path.relative(root, target)
                return (
                  relative === '' ||
                  (relative !== '..' &&
                    !relative.startsWith(`..${path.sep}`) &&
                    !path.isAbsolute(relative))
                )
              })
            return allowed && grant.checkPath(target)
          },
        },
        {
          command: input.command,
          argv: input.argv,
          cwd: input.cwd,
        },
        input.signal,
      )
    } catch (error) {
      input.signal?.throwIfAborted()
      exitCode = 1
      output = error instanceof Error ? error.message : String(error)
    }
    input.signal?.throwIfAborted()
    if (
      this.closed ||
      session.state !== 'active' ||
      ownerEpoch !== (this.ownerEpochs.get(session.id) ?? 0)
    )
      throw new Error('TERMINAL_CANCELLED')
    const buffer = Buffer.from(output)
    const retained = buffer
      .subarray(-session.sandboxProfile.maxOutputBytes)
      .toString('utf8')
      .replace(/^\uFFFD+/, '')
    const record: TerminalRecord = {
      id: randomUUID(),
      executionSessionId: session.id,
      processId: '',
      pid: null,
      title: input.title?.trim() || input.command?.slice(0, 80) || '',
      command: input.command,
      argv: input.argv,
      cwd: input.readOnly!.cwd,
      status: exitCode === 0 ? 'exited' : 'failed',
      startedAt,
      exitedAt: new Date().toISOString(),
      exitCode,
      exitReason: 'exit',
      output: retained,
      outputLength: output.length,
      backend: 'pipe',
      cols: input.cols ?? 120,
      rows: input.rows ?? 30,
      owner: input.owner ?? 'agent',
      ownerAgentId: session.ownerAgentId,
      threadId: session.threadId,
      taskId: session.taskId,
      pinned: false,
      maxOutputBytes: session.sandboxProfile.maxOutputBytes,
      bufferStartOffset: output.length - retained.length,
      absoluteOutputLength: output.length,
      writeInput: () => {},
      resizeTerminal: () => {},
      detachSignal: () => {},
      releaseProcess: () => {},
    }
    this.terminals.set(record.id, record)
    this.notify(record.id)
    this.sweep()
    return this.snapshot(record)
  }

  async run(
    input: CreateTerminalInput & { timeoutMs?: number; outputLimit?: number },
  ): Promise<TerminalRunResult> {
    const terminal = await this.create(input)
    const timeoutMs = this.duration(input.timeoutMs, 30_000, 100)
    try {
      const waited = await this.wait(terminal.id, terminal.executionSessionId, {
        timeoutMs,
        exitOnly: true,
        signal: input.signal,
      })
      if (waited.timedOut) {
        await this.kill(terminal.id, terminal.executionSessionId, 'timeout')
        throw new TerminalRunError(
          'TERMINAL_TIMEOUT',
          `命令执行超时 (${timeoutMs}ms)，进程已终止，输出已保留`,
          this.runResult(terminal.id, terminal.executionSessionId, input.outputLimit),
        )
      }
      input.signal?.throwIfAborted()
      const result = this.runResult(terminal.id, terminal.executionSessionId, input.outputLimit)
      if (result.terminal.status !== 'exited') {
        const quotingHint =
          process.platform === 'win32' &&
          input.argv === undefined &&
          input.command?.includes('\\"') &&
          /JSON\.parse|SyntaxError/.test(result.output)
            ? '\nWindows PowerShell 不使用反斜杠转义双引号。请用 argv 数组传递原始参数，或将 JSON 写入文件后传入文件路径。'
            : ''
        throw new TerminalRunError(
          result.terminal.status === 'killed' ? 'TERMINAL_CANCELLED' : 'TERMINAL_FAILED',
          `命令执行失败 (exitCode=${result.terminal.exitCode ?? 'unknown'})${quotingHint}`,
          result,
        )
      }
      return result
    } finally {
      // 短命令总是回收进程；结果进入有界历史，超时输出不再随句柄一起丢失。
      if (this.terminals.has(terminal.id)) {
        if (this.get(terminal.id, terminal.executionSessionId).status === 'running')
          await this.kill(
            terminal.id,
            terminal.executionSessionId,
            input.signal?.aborted ? 'cancelled' : 'killed',
          )
        this.archive(terminal.id, terminal.executionSessionId)
      }
    }
  }

  private runResult(id: string, sessionId: string, outputLimit = 20_000): TerminalRunResult {
    const record = this.requireTerminal(id, sessionId)
    const limit = Math.max(1, Math.min(outputLimit, 128_000))
    const truncated = record.bufferStartOffset > 0 || record.output.length > limit
    const output =
      record.output.length > limit
        ? `${record.output.slice(0, Math.floor(limit / 2))}\n...[输出已截断，可用 terminal_read 继续读取保留窗口]...\n${record.output.slice(-Math.floor(limit / 2))}`
        : record.output
    return { terminal: this.snapshot(record), output: output || '(无输出)', truncated }
  }

  list(executionSessionId: string, includeArchived = false): TerminalSnapshot[] {
    this.sweep()
    return [...this.terminals.values()]
      .filter(
        (record) =>
          record.executionSessionId === executionSessionId &&
          (includeArchived || !record.archivedAt),
      )
      .map((record) => this.snapshot(record))
  }

  get(terminalId: string, executionSessionId: string): TerminalSnapshot {
    return this.snapshot(this.requireTerminal(terminalId, executionSessionId))
  }

  read(terminalId: string, executionSessionId: string, cursor = 0, limit = 8_000) {
    const record = this.requireTerminal(terminalId, executionSessionId)
    const requestedCursor = Math.max(0, Number.isFinite(cursor) ? Math.floor(cursor) : 0)
    const safeCursor = Math.max(
      record.bufferStartOffset,
      Math.min(requestedCursor, record.absoluteOutputLength),
    )
    const localCursor = safeCursor - record.bufferStartOffset
    const safeLimit = Math.max(
      1,
      Math.min(Number.isFinite(limit) ? Math.floor(limit) : 8_000, 32_000),
    )
    const output = record.output.slice(localCursor, localCursor + safeLimit)
    const nextCursor = safeCursor + output.length
    return {
      output,
      cursor: safeCursor,
      nextCursor,
      droppedChars: Math.max(0, record.bufferStartOffset - requestedCursor),
      hasMore: nextCursor < record.absoluteOutputLength,
      status: record.status,
      exitCode: record.exitCode,
    }
  }

  async wait(
    terminalId: string,
    executionSessionId: string,
    options: {
      cursor?: number
      pattern?: string
      timeoutMs?: number
      exitOnly?: boolean
      signal?: AbortSignal
    },
  ) {
    options.signal?.throwIfAborted()
    const record = this.requireTerminal(terminalId, executionSessionId)
    const cursor = Math.max(0, Number.isFinite(options.cursor) ? options.cursor! : 0)
    const matched = () =>
      !!options.pattern &&
      record.output.slice(Math.max(0, cursor - record.bufferStartOffset)).includes(options.pattern)
    const condition = (): 'exit' | 'pattern' | 'output' | undefined => {
      if (record.status !== 'running') return 'exit'
      if (options.exitOnly) return
      if (options.pattern) return matched() ? 'pattern' : undefined
      return record.absoluteOutputLength > cursor ? 'output' : undefined
    }
    let reason: 'exit' | 'pattern' | 'output' | 'timeout' | undefined = condition()
    if (!reason) {
      reason = await new Promise<'exit' | 'pattern' | 'output' | 'timeout'>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
          this.waiters.get(terminalId)?.delete(callback)
        }
        const finish = (value: 'exit' | 'pattern' | 'output' | 'timeout') => {
          if (settled) return
          cleanup()
          resolve(value)
        }
        const abort = () => {
          if (settled) return
          cleanup()
          reject(options.signal?.reason ?? new Error('终端等待已取消'))
        }
        const callback = () => {
          const value = condition()
          if (value) finish(value)
        }
        const timer = setTimeout(() => finish('timeout'), this.duration(options.timeoutMs, 30_000))
        const set = this.waiters.get(terminalId) ?? new Set()
        set.add(callback)
        this.waiters.set(terminalId, set)
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
        else callback()
      })
    }
    options.signal?.throwIfAborted()
    // 超时只结束等待，不能据此声称命令成功或杀死静默的长任务。
    return {
      ...this.read(terminalId, executionSessionId, cursor),
      terminalId,
      waitReason: reason,
      timedOut: reason === 'timeout',
      matched: matched(),
      completed: record.status !== 'running',
      exitReason: record.exitReason,
    }
  }

  write(terminalId: string, executionSessionId: string, data: string): void {
    const record = this.requireTerminal(terminalId, executionSessionId)
    if (record.status !== 'running') throw new Error('终端已退出，无法写入')
    record.writeInput(data)
  }

  resize(terminalId: string, executionSessionId: string, cols: number, rows: number): void {
    const record = this.requireTerminal(terminalId, executionSessionId)
    record.resizeTerminal(cols, rows)
    record.cols = cols
    record.rows = rows
  }

  async interrupt(terminalId: string, executionSessionId: string): Promise<void> {
    const record = this.requireTerminal(terminalId, executionSessionId)
    if (record.status !== 'running') throw new Error('终端已退出，无法中断')
    if (process.platform === 'win32') await this.runner.terminateProcess(record.processId, false)
    else if (record.pid) process.kill(-record.pid, 'SIGINT')
  }

  async kill(
    terminalId: string,
    executionSessionId: string,
    reason: TerminalSnapshot['exitReason'] = 'killed',
  ): Promise<void> {
    const record = this.requireTerminal(terminalId, executionSessionId)
    if (record.status !== 'running') return
    record.exitReason = reason
    await this.runner.terminateProcess(record.processId, true)
    record.status = 'killed'
    record.exitedAt ??= new Date().toISOString()
    record.releaseProcess()
    this.notify(terminalId)
  }

  /** 关闭运行进程并归档；归档后的 ID 仍可读取，显式会话删除才清除历史。 */
  async close(terminalId: string, executionSessionId: string): Promise<void> {
    await this.kill(terminalId, executionSessionId)
    this.archive(terminalId, executionSessionId)
  }

  archive(terminalId: string, executionSessionId: string): void {
    const record = this.requireTerminal(terminalId, executionSessionId)
    if (record.status === 'running') throw new Error('运行中的终端不能归档，请先停止')
    record.pinned = false
    record.archivedAt ??= new Date().toISOString()
    // 历史只保存有限日志尾部，不持有进程闭包。
    record.releaseProcess()
    const tail = record.output.slice(-128_000)
    record.bufferStartOffset += record.output.length - tail.length
    record.output = tail
  }

  pin(terminalId: string, executionSessionId: string, pinned: boolean): TerminalSnapshot {
    const record = this.requireTerminal(terminalId, executionSessionId)
    record.pinned = pinned
    if (pinned) record.archivedAt = undefined
    return this.snapshot(record)
  }

  /** 正常结束模型轮次后交给持久所有者；NIT 的独立子信号不会被解绑。 */
  handoff(executionSessionId: string, signal: AbortSignal): void {
    for (const record of this.terminals.values()) {
      if (
        record.executionSessionId === executionSessionId &&
        record.sourceSignal === signal &&
        !signal.aborted
      ) {
        record.detachSignal()
        record.detachSignal = () => {}
        record.sourceSignal = undefined
      }
    }
  }

  async stopOwned(executionSessionId: string): Promise<void> {
    this.ownerEpochs.set(executionSessionId, (this.ownerEpochs.get(executionSessionId) ?? 0) + 1)
    await Promise.allSettled([...this.pendingCreates])
    const records = [...this.terminals.values()].filter(
      (record) =>
        record.executionSessionId === executionSessionId &&
        record.owner === 'agent' &&
        record.status === 'running',
    )
    const results = await Promise.allSettled(
      records.map((record) => this.kill(record.id, executionSessionId, 'cancelled')),
    )
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        '部分终端未能停止',
      )
  }

  archiveCompleted(executionSessionId: string): void {
    for (const record of this.terminals.values())
      if (
        record.executionSessionId === executionSessionId &&
        record.status !== 'running' &&
        !record.pinned
      )
        this.archive(record.id, executionSessionId)
    this.sweep()
  }

  /** 后台任务等待跨段执行时保留待观察的退出结果，避免误判为重启丢失进程。 */
  retainResults(executionSessionId: string, terminalIds: string[]): void {
    this.retainedResults.set(executionSessionId, new Set(terminalIds))
  }

  /** 自动收起已退出终端；不按静默时间误杀仍在计算、等待或提供服务的进程。 */
  sweep(now = Date.now()): void {
    for (const record of this.terminals.values()) {
      if (record.status === 'running' || record.pinned || this.waiters.get(record.id)?.size)
        continue
      if (
        !record.archivedAt &&
        record.exitedAt &&
        now - Date.parse(record.exitedAt) >= this.retention.archiveAfterMs
      )
        this.archive(record.id, record.executionSessionId)
    }
    const histories = [...this.terminals.values()]
      .reverse()
      .filter(
        (record) =>
          record.archivedAt &&
          !this.waiters.get(record.id)?.size &&
          !this.retainedResults.get(record.executionSessionId)?.has(record.id),
      )
      .sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!))
    const counts = new Map<string, number>()
    histories.forEach((record, index) => {
      const count = (counts.get(record.executionSessionId) ?? 0) + 1
      counts.set(record.executionSessionId, count)
      if (
        count > this.retention.perSession ||
        index >= this.retention.total ||
        now - Date.parse(record.archivedAt!) > this.retention.historyMs
      ) {
        this.terminals.delete(record.id)
        this.waiters.delete(record.id)
      }
    })
  }

  async disposeSession(executionSessionId: string, preserveHistory = false): Promise<void> {
    // 先挡住正在创建的进程，再统一等待和回收，避免创建/删除竞态留下孤儿。
    this.sessions.markClosing(executionSessionId)
    this.retainedResults.delete(executionSessionId)
    await Promise.allSettled([...this.pendingCreates])
    const records = [...this.terminals.values()].filter(
      (record) => record.executionSessionId === executionSessionId,
    )
    const results = await Promise.allSettled(
      records.map(async (record) => {
        await this.close(record.id, executionSessionId)
        if (!preserveHistory) this.terminals.delete(record.id)
      }),
    )
    await this.runner.disposeSession(executionSessionId)
    this.ownerEpochs.delete(executionSessionId)
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        '执行会话终端回收失败',
      )
  }

  async dispose(): Promise<void> {
    this.closed = true
    clearInterval(this.sweepTimer)
    await Promise.allSettled([...this.pendingCreates])
    const results = await Promise.allSettled(
      this.sessions.list().map((session) => this.disposeSession(session.id)),
    )
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        '终端管理器释放失败',
      )
  }

  private duration(value: number | undefined, fallback: number, minimum = 1): number {
    return Math.max(minimum, Math.min(Number.isFinite(value) ? value! : fallback, 600_000))
  }

  private resolveShell(
    command?: string,
    argv?: string[],
  ): { command: string; args: string[]; title: string } {
    const requestedCommand = command?.trim()
    if (argv !== undefined) {
      if (!requestedCommand) throw new Error('直接执行时 command 必须是可执行文件')
      if (
        !Array.isArray(argv) ||
        argv.some((value) => typeof value !== 'string' || value.includes('\0'))
      )
        throw new Error('argv 必须是无空字符的字符串数组')
      return {
        command: requestedCommand,
        args: [...argv],
        title: `${requestedCommand} ${JSON.stringify(argv)}`.slice(0, 80),
      }
    }
    if (process.platform === 'win32') {
      // 中文 Windows 下 PowerShell 默认输出 GBK，而 ConPTY/pipe 后端按 UTF-8 解码，
      // 会导致中文乱码。这里强制把控制台输入/输出与管道输出统一为 UTF-8（无 BOM）。
      const utf8Init =
        '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); ' +
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ' +
        '$OutputEncoding = [System.Text.UTF8Encoding]::new();'
      if (!requestedCommand) {
        // 交互式系统 Shell：先初始化 UTF-8，再用 -NoExit 保持交互供用户/Agent 持续使用。
        return {
          command: 'powershell.exe',
          args: ['-NoLogo', '-NoExit', '-Command', utf8Init],
          title: 'PowerShell',
        }
      }
      return {
        command: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `${utf8Init} ${requestedCommand}`,
        ],
        title: requestedCommand.slice(0, 80),
      }
    }
    const systemShell = process.env.SHELL || '/bin/sh'
    return requestedCommand
      ? {
          command: systemShell,
          args: ['-lc', requestedCommand],
          title: requestedCommand.slice(0, 80),
        }
      : { command: systemShell, args: ['-l'], title: systemShell.split('/').pop() || 'Shell' }
  }

  private requireSession(id: string): ExecutionSession {
    const session = this.sessions.get(id)
    if (!session || session.state !== 'active') throw new Error(`执行会话不存在或已关闭: ${id}`)
    return session
  }

  private requireTerminal(id: string, executionSessionId: string): TerminalRecord {
    const record = this.terminals.get(id)
    if (!record || record.executionSessionId !== executionSessionId)
      throw new Error(`终端不存在或无权访问: ${id}`)
    return record
  }

  private notify(terminalId: string): void {
    for (const callback of this.waiters.get(terminalId) ?? []) callback()
  }

  private snapshot(record: TerminalRecord): TerminalSnapshot {
    return {
      id: record.id,
      executionSessionId: record.executionSessionId,
      title: record.title,
      command: record.command,
      argv: record.argv,
      cwd: record.cwd,
      pid: record.pid,
      status: record.status,
      startedAt: record.startedAt,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      outputLength: record.outputLength,
      backend: record.backend,
      cols: record.cols,
      rows: record.rows,
      owner: record.owner,
      ownerAgentId: record.ownerAgentId,
      threadId: record.threadId,
      taskId: record.taskId,
      pinned: record.pinned,
      archivedAt: record.archivedAt,
      exitReason: record.exitReason,
    }
  }
}
