import type { TaskControlInput } from '@infos/shared'
import type { BuiltinTool } from '../index'
import { getTaskToolRuntime } from './runtime'
export const manageTaskTool: BuiltinTool = {
  name: 'manage_task',
  allowedSources: ['desktop'],
  async execute(args, ctx) {
    return JSON.stringify(
      await getTaskToolRuntime().control(
        ctx.agentId,
        args as unknown as TaskControlInput,
        ctx.threadId,
        {
          taskId: ctx.taskId,
          executionId: ctx.executionId,
          callId: ctx.toolCallId,
          requestedBy: ctx.requestedBy,
        },
      ),
    )
  },
}
