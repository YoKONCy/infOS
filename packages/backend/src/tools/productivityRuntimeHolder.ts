/**
 * productivityRuntimeHolder — Agent 工具边界
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import path from 'node:path'
import type { ExecutionSessionManager } from '../services/execution/executionSession'
import type { TerminalManager } from '../services/execution/terminalManager'
import type { WorkspaceService } from '../services/workspace/workspaceService'
import type { VirtualWorkspace } from '../services/execution/virtualWorkspace'
import type { ApprovalService } from '../services/execution/approvalService'
import { releaseFileEditReferences } from '../services/execution/fileEditing'
import { releaseToolObservations } from '../services/execution/toolObservation'
import { isNotebookPath } from '../services/memory/notebook'

export interface ProductivityRuntime {
  sessions: ExecutionSessionManager
  terminals: TerminalManager
  workspace: WorkspaceService
  virtualWorkspace: VirtualWorkspace
  approvalService: ApprovalService
}

let runtime: ProductivityRuntime | null = null

export function setProductivityRuntime(next: ProductivityRuntime): void {
  runtime = next
}

export function clearProductivityRuntime(): void {
  releaseFileEditReferences({})
  releaseToolObservations({})
  runtime = null
}

export function getProductivityRuntime(): ProductivityRuntime {
  if (!runtime) throw new Error('生产力执行运行时尚未初始化')
  return runtime
}

/** 记事本受限入口在运行时尚未就绪时关闭，预览与实际执行共用路径判断。 */
export async function isNotebookToolPathAllowed(agentId: string, requested: unknown, directory = false): Promise<boolean> {
  if (!runtime) return false
  return isNotebookPath(runtime.workspace.getWorkspaceRoot(agentId), requested, directory)
}

export function taskTerminals(taskId: string) {
  const session = runtime?.sessions.findByOwner({ taskId })
  return session && runtime ? runtime.terminals.list(session.id, true) : []
}

/** 编译器只读当前所有权状态，不创建终端，也不执行任何命令。 */
export function executionOwnerState(owner: {
  agentId?: string
  threadId?: string
  taskId?: string
}) {
  if (!runtime || !owner.agentId || !owner.threadId) return []
  return runtime.sessions
    .list()
    .filter(
      (session) =>
        session.ownerAgentId === owner.agentId &&
        session.threadId === owner.threadId &&
        session.taskId === owner.taskId,
    )
    .flatMap((session) => runtime!.terminals.list(session.id, true))
    .filter((terminal) => terminal.owner === 'agent' && terminal.status === 'running')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((terminal) => ({
      terminalId: terminal.id,
      status: terminal.status,
      title: terminal.title,
      command: terminal.command,
      cwd: terminal.cwd,
      taskId: terminal.taskId,
    }))
}

export function retainTaskTerminals(taskId: string, terminalIds: string[]): void {
  const session = runtime?.sessions.findByOwner({ taskId })
  if (session && runtime) runtime.terminals.retainResults(session.id, terminalIds)
}

/** 正常轮次结束后解除轮级信号，仍由会话或任务负责停止与回收。 */
export function handoffExecution(
  input: { threadId: string; taskId?: string },
  signal?: AbortSignal,
): void {
  if (!runtime || !signal || signal.aborted) return
  for (const session of runtime.sessions.list())
    if (session.threadId === input.threadId && session.taskId === input.taskId)
      runtime.terminals.handoff(session.id, signal)
}

/** 停止、删除和应用退出共用所有权边界，不按模糊 PID 清理其他进程。 */
export async function disposeExecutionOwner(
  owner: { threadId?: string; agentId?: string; taskId?: string },
  agentOnly = false,
  deleteStored = false,
): Promise<void> {
  releaseFileEditReferences(owner)
  releaseToolObservations(owner, deleteStored)
  const current = runtime
  if (!current) return
  const sessions = current.sessions
    .list()
    .filter(
      (session) =>
        (!owner.threadId || session.threadId === owner.threadId) &&
        (!owner.agentId || session.ownerAgentId === owner.agentId) &&
        (!owner.taskId || session.taskId === owner.taskId),
    )
  const results = await Promise.allSettled(
    sessions.map(async (session) => {
      if (agentOnly) await current.terminals.stopOwned(session.id)
      else {
        await current.terminals.disposeSession(session.id)
        current.approvalService.clearSession(session.threadId ?? session.id)
        current.sessions.close(session.id)
      }
    }),
  )
  const errors = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      '终端所有者回收失败',
    )
}

export async function disposeTaskExecution(
  taskId: string,
  options: { preserveApprovals?: boolean; preserveHistory?: boolean } = {},
): Promise<void> {
  const current = getProductivityRuntime()
  const session = current.sessions.findByOwner({ taskId })
  if (!session) return
  current.sessions.markClosing(session.id)
  const preserveHistory = options.preserveHistory !== false
  await current.terminals.disposeSession(session.id, preserveHistory)
  if (!options.preserveApprovals)
    current.approvalService.clearSession(session.threadId ?? session.id)
  if (preserveHistory) session.state = 'active'
  else current.sessions.close(session.id)
}

/** 按当前工具上下文获取或创建执行会话。 */
export async function resolveExecutionSession(ctx: {
  agentId: string
  threadId: string
  channel: string
  taskId?: string
}) {
  const current = getProductivityRuntime()
  const principalRoot = current.workspace.getWorkspaceRoot(ctx.agentId)
  const workspaceRoot = ctx.taskId
    ? path.join(path.dirname(principalRoot), 'tasks', ctx.taskId, 'workspace')
    : principalRoot
  return current.sessions.getOrCreate({
    ownerAgentId: ctx.agentId,
    threadId: ctx.threadId,
    taskId: ctx.taskId,
    channel: ctx.channel,
    workspaceRoot,
  })
}
