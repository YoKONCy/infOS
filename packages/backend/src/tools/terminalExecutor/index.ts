/**
 * terminal_execute — 受管短命令执行工具
 *
 * 复用 ExecutionSession + TerminalManager；命令超时、任务取消或会话回收时会终止受管进程树。
 * 长时服务器应使用 terminal_create，避免阻塞单次 ReAct 工具调用。
 */

import type { BuiltinTool } from '../index'
import { getProductivityRuntime, resolveExecutionSession } from '../productivityRuntimeHolder'
import { toolSuccess, toolFailure } from '../../services/execution/toolResult'
import { TerminalRunError } from '../../services/execution/terminalManager'

const DEFAULT_TIMEOUT_MS = 30_000

export const terminalExecutorTool: BuiltinTool = {
  name: 'terminal_execute',

  async execute(args, ctx) {
    if (!ctx.approvedSensitiveAction && !ctx.readOnlyTerminal)
      throw new Error('终端命令缺少本次用户审批凭证')
    const command = String(args.command ?? '').trim()
    if (!command) throw new Error('command 不能为空')
    const timeout = Math.max(100, Math.min(Number(args.timeout ?? DEFAULT_TIMEOUT_MS), 10 * 60_000))
    const session = await resolveExecutionSession(ctx)
    try {
      const result = await getProductivityRuntime().terminals.run({
        approvedOutsideWorkspace: ctx.approvedOutsideWorkspace,
        readOnly: ctx.readOnlyTerminal,
        executionSessionId: session.id,
        command,
        argv: args.argv as string[] | undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
        title: command.slice(0, 80),
        timeoutMs: timeout,
        signal: ctx.signal,
      })
      return toolSuccess(result.output, {
        exitCode: result.terminal.exitCode,
        truncated: result.truncated,
        executionSessionId: session.id,
        terminalId: result.terminal.id,
        exitReason: result.terminal.exitReason,
      })
    } catch (error) {
      if (!(error instanceof TerminalRunError)) throw error
      return toolFailure(error.code, `${error.message}\n${error.result.output}`, {
        terminalId: error.result.terminal.id,
        executionSessionId: session.id,
        exitCode: error.result.terminal.exitCode,
        exitReason: error.result.terminal.exitReason,
        timedOut: error.code === 'TERMINAL_TIMEOUT',
        truncated: error.result.truncated,
      })
    }
  },
}
