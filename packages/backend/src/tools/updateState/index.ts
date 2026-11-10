import type { BuiltinTool } from '../index'
import { toolFailure, toolSuccess } from '../../services/execution/toolResult'
import { applyCharacterStateUpdate } from '../finishTask'
import { AppError } from '../../lib/appError'

/** 独立更新角色状态与动态台词，不结束ReAct，也不承担用户最终回复。 */
export const updateStateTool: BuiltinTool = {
  name: 'update_state',
  async execute(args, ctx) {
    try {
      const result = await applyCharacterStateUpdate(args, ctx.agentId, ctx)
      return toolSuccess(
        JSON.stringify({
          updated: result.updated,
          agent_id: ctx.agentId,
          thread_id: ctx.threadId,
          text_expires_at: result.textExpiresAt ?? null,
        }),
      )
    } catch (error) {
      return toolFailure(
        'UPDATE_STATE_FAILED',
        error instanceof AppError && error.code === 'CONFLICT'
          ? JSON.stringify({ message: error.message, ...error.data as object })
          : error instanceof Error ? error.message : String(error),
      )
    }
  },
}
