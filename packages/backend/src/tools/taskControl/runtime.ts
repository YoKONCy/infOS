import type { TaskControlContext, TaskControlInput, TaskSegmentResult } from '@infos/shared'
import type { ToolContext } from '../../services/agent/toolRegistry'
export interface TaskToolRuntime {
  delegateSocial?(
    input: { group_id: string; intent?: string; platform?: string; account_id?: string },
    context: ToolContext,
  ): Promise<unknown>
  control(
    agentId: string,
    input: TaskControlInput,
    threadId?: string,
    context?: TaskControlContext,
  ): Promise<unknown>
  submitSegment(
    taskId: string,
    executionId: string | undefined,
    result: TaskSegmentResult,
  ): Promise<void>
  beforeTool(
    taskId: string,
    executionId: string | undefined,
    name: string,
    callId: string,
  ): Promise<void>
  afterTool(taskId: string, executionId: string | undefined, callId: string): Promise<void>
}
let runtime: TaskToolRuntime | undefined
export function setTaskToolRuntime(value?: TaskToolRuntime): void {
  runtime = value
}
export function getTaskToolRuntime(): TaskToolRuntime {
  if (!runtime) throw new Error('任务服务尚未初始化')
  return runtime
}
export function optionalTaskToolRuntime(): TaskToolRuntime | undefined {
  return runtime
}
