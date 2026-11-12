import type { BuiltinTool } from '../index'
import type { ToolContext } from '../../services/agent/toolRegistry'
import type { LifeScope, StrongholdLifeService } from '../../services/stronghold/strongholdLifeService'
import { t } from '../../lib/i18n'
import { toolFailure, toolSuccess } from '../../services/execution/toolResult'

let service: StrongholdLifeService | undefined
export function setStrongholdLifeService(value: StrongholdLifeService): void { service = value }

function scope(context: ToolContext): LifeScope {
  if (context.channel !== 'group' || !context.sceneRoomId || context.realmId || context.taskId ||
    !context.pairId || !Number.isSafeInteger(context.generation) || !context.toolCallId)
    throw new Error('STRONGHOLD_LIFE_SCOPE_REQUIRED')
  return { agentId: context.agentId, threadId: context.threadId, generation: context.generation!,
    roomId: context.sceneRoomId, pairId: context.pairId, sourceMessageId: context.sceneSourceMessageId, signal: context.signal }
}

async function execute(kind: 'activity' | 'watch', args: Record<string, unknown>, context: ToolContext) {
  try {
    if (!service) throw new Error('STRONGHOLD_LIFE_UNAVAILABLE')
    const current = scope(context)
    const operationId = `${context.pairId}:${context.toolCallId}`
    const result = kind === 'activity'
      ? service.activities.execute(current, operationId, args)
      : service.watches.execute(current, operationId, args)
    return toolSuccess(JSON.stringify({ result }))
  } catch (error) {
    const code = error instanceof Error && /^STRONGHOLD_|^THREAD_/.test(error.message) ? error.message : 'STRONGHOLD_LIFE_OPERATION_FAILED'
    return toolFailure(code, t('server.tools', '据点状态已变化，请查看当前现场并使用最新编号和修订重试。'))
  }
}

export const strongholdActivityTool: BuiltinTool = {
  name: 'stronghold_activity', allowedSources: ['group'], chatEnabled: true,
  execute: (args, context) => execute('activity', args, context),
}
export const strongholdWatchTool: BuiltinTool = {
  name: 'stronghold_watch', allowedSources: ['group'], chatEnabled: true,
  execute: (args, context) => execute('watch', args, context),
}
