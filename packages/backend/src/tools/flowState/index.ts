import type { BuiltinTool } from '../index'
import type { FlowStateService } from '../../services/flow/flowStateService'
import { toolFailure, toolSuccess } from '../../services/execution/toolResult'

let flowStateService: FlowStateService | null = null

export function setFlowStateService(service: FlowStateService): void {
  flowStateService = service
}

/** Agent 主动维护当前 Thread 的私有临时心流。 */
export const updateFlowStateTool: BuiltinTool = {
  name: 'update_flow_state',
  async execute(args, context) {
    if (!flowStateService) return toolFailure('FLOW_SERVICE_UNAVAILABLE', '心流服务尚未初始化')
    if (!context.threadId || !context.agentId) {
      return toolFailure('FLOW_SCOPE_MISSING', '当前执行上下文缺少 Thread 或 Agent 身份')
    }
    const currentGoal = typeof args.current_goal === 'string' ? args.current_goal : undefined
    const privateFacts = typeof args.private_facts === 'string' ? args.private_facts : undefined
    if (currentGoal === undefined && privateFacts === undefined) {
      return toolFailure('FLOW_EMPTY_PATCH', '至少需要提供 current_goal 或 private_facts')
    }
    const state = await flowStateService.update({
      threadId: context.threadId,
      agentId: context.agentId,
      pairId: context.pairId,
      generation: context.generation,
      currentGoal,
      privateFacts,
    })
    return toolSuccess('当前会话心流已更新', {
      revision: state.revision,
      currentGoal: state.currentGoal,
      privateFacts: state.privateFacts,
    })
  },
}
