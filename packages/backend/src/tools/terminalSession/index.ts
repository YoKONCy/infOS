import type { BuiltinTool } from '../index'
import { getProductivityRuntime, resolveExecutionSession } from '../productivityRuntimeHolder'
import { toolSuccess } from '../../services/execution/toolResult'

async function withSession(ctx: Parameters<BuiltinTool['execute']>[1]) {
  const session = await resolveExecutionSession(ctx)
  return { runtime: getProductivityRuntime(), session }
}

export const terminalCreateTool: BuiltinTool = {
  name: 'terminal_create',
  async execute(args, ctx) {
    if (!ctx.approvedSensitiveAction && !ctx.readOnlyTerminal)
      throw new Error('创建终端缺少本次用户审批凭证')
    const command = String(args.command ?? '').trim()
    if (!command) throw new Error('command 不能为空')
    const { runtime, session } = await withSession(ctx)
    const terminal = await runtime.terminals.create({
      approvedOutsideWorkspace: ctx.approvedOutsideWorkspace,
      readOnly: ctx.readOnlyTerminal,
      executionSessionId: session.id,
      command,
      argv: args.argv as string[] | undefined,
      cwd: args.cwd ? String(args.cwd) : undefined,
      title: args.title ? String(args.title) : undefined,
      signal: ctx.signal,
    })
    return toolSuccess(JSON.stringify(terminal), { terminalId: terminal.id })
  },
}

export const terminalListTool: BuiltinTool = {
  name: 'terminal_list',
  async execute(args, ctx) {
    const { runtime, session } = await withSession(ctx)
    return toolSuccess(
      JSON.stringify(runtime.terminals.list(session.id, args.include_archived === true)),
    )
  },
}

export const terminalGetTool: BuiltinTool = {
  name: 'terminal_get',
  async execute(args, ctx) {
    const { runtime, session } = await withSession(ctx)
    return toolSuccess(JSON.stringify(runtime.terminals.get(String(args.terminal_id), session.id)))
  },
}

export const terminalReadTool: BuiltinTool = {
  name: 'terminal_read',
  async execute(args, ctx) {
    const { runtime, session } = await withSession(ctx)
    return toolSuccess(
      JSON.stringify(
        runtime.terminals.read(
          String(args.terminal_id),
          session.id,
          Number(args.cursor ?? 0),
          Number(args.limit ?? 8_000),
        ),
      ),
    )
  },
}

export const terminalWaitTool: BuiltinTool = {
  name: 'terminal_wait',
  async execute(args, ctx) {
    const { runtime, session } = await withSession(ctx)
    const result = await runtime.terminals.wait(String(args.terminal_id), session.id, {
      cursor: Number(args.cursor ?? 0),
      pattern: args.pattern ? String(args.pattern) : undefined,
      timeoutMs: Number(args.timeout_ms ?? 30_000),
      exitOnly: args.until === 'exit',
      signal: ctx.signal,
    })
    return toolSuccess(JSON.stringify(result))
  },
}

export const terminalWriteTool: BuiltinTool = {
  name: 'terminal_write',
  async execute(args, ctx) {
    if (!ctx.approvedSensitiveAction) throw new Error('终端输入缺少本次用户审批凭证')
    const { runtime, session } = await withSession(ctx)
    runtime.terminals.write(String(args.terminal_id), session.id, String(args.data ?? ''))
    return toolSuccess('已写入终端')
  },
}

export const terminalResizeTool: BuiltinTool = {
  name: 'terminal_resize',
  async execute(args, ctx) {
    const { runtime, session } = await withSession(ctx)
    runtime.terminals.resize(
      String(args.terminal_id),
      session.id,
      Number(args.cols),
      Number(args.rows),
    )
    return toolSuccess('终端尺寸已调整')
  },
}

export const terminalInterruptTool: BuiltinTool = {
  name: 'terminal_interrupt',
  async execute(args, ctx) {
    const { runtime, session } = await withSession(ctx)
    await runtime.terminals.interrupt(String(args.terminal_id), session.id)
    return toolSuccess('已发送中断信号')
  },
}

export const terminalKillTool: BuiltinTool = {
  name: 'terminal_kill',
  async execute(args, ctx) {
    const { runtime, session } = await withSession(ctx)
    await runtime.terminals.kill(String(args.terminal_id), session.id)
    return toolSuccess('终端进程树已终止')
  },
}

export const terminalCloseTool: BuiltinTool = {
  name: 'terminal_close',
  async execute(args, ctx) {
    const { runtime, session } = await withSession(ctx)
    await runtime.terminals.close(String(args.terminal_id), session.id)
    return toolSuccess('终端已关闭')
  },
}
