import type { CapabilityProviderInvoke } from '../../kernel/capabilityDirectory'
import type { TtsRequest, TtsService } from './ttsService'

/** 能力入口以信封主体确定角色绑定，调用取消与 Deadline 同时传入调度层。 */
export function createTtsCapabilityInvoke(service: TtsService): CapabilityProviderInvoke {
  return async (envelope, signal) => {
    if (envelope.payload.operation !== 'generate')
      throw new Error('CAPABILITY_OPERATION_UNSUPPORTED')
    const deadline = envelope.deadline ? Date.parse(envelope.deadline) : NaN
    const deadlineSignal = Number.isFinite(deadline)
      ? AbortSignal.timeout(Math.max(0, Math.min(300000, deadline - Date.now())))
      : undefined
    const signals = [signal, deadlineSignal].filter((item): item is AbortSignal => !!item)
    return service.synthesize({
      ...(envelope.payload.input as TtsRequest),
      agentId: envelope.principalId,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    })
  }
}
