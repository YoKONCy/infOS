import type { BuiltinTool } from '../index'
import type { RuntimeDebugService } from '../../services/debug/runtimeDebugService'
import { toolSuccess, toolFailure } from '../../services/execution/toolResult'
import { t } from '../../lib/i18n'
let service: RuntimeDebugService | undefined
export function setRuntimeDebugService(value: RuntimeDebugService | undefined) {
  service = value
}
export const runtimeDebugTool: BuiltinTool = {
  name: 'runtime_debug',
  allowedSources: ['desktop'],
  async execute(args, context) {
    if (!service) throw new Error('DEBUG_UNAVAILABLE')
    if (
      (args.code !== undefined && typeof args.code !== 'string') ||
      (args.timeoutMs !== undefined &&
        (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs)))
    )
      throw new Error('DEBUG_ARGUMENT_INVALID')
    if (
      context.realmId ||
      context.taskId ||
      (context.capabilityScope && context.capabilityScope !== 'default')
    )
      throw new Error('DEBUG_SCOPE_DENIED')
    try {
      const result = await service.execute({
        threadId: context.threadId,
        agentId: context.agentId,
        code: typeof args.code === 'string' ? args.code : undefined,
        approved: !!context.approvedSensitiveAction,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        signal: context.signal,
      })
      return toolSuccess(JSON.stringify(result), { kind: 'runtime-debug' })
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(-2000)
      const code = detail.match(/\bDEBUG_[A-Z_]+\b/)?.[0] ?? 'DEBUG_EXECUTION_FAILED'
      return toolFailure(
        code,
        JSON.stringify({ code, message: t('server.runtime-debug', '调试执行失败：{0}', [detail]) }),
        { kind: 'runtime-debug' },
      )
    }
  },
}
