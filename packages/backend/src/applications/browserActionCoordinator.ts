import type { BoundCapabilityPort } from '../kernel/capabilityDirectory'
import type { KernelCallContext } from '@infos/shared'

export interface BrowserRecoverableAction {
  action: 'hover' | 'click'
  target?: string
  handle?: string
  allowOccluded?: boolean
  screenshotId?: string
  x?: number
  y?: number
}

/** Browser Application 层的单次、受限恢复协调器。 */
export class BrowserActionCoordinator {
  constructor(private readonly port: BoundCapabilityPort) {}

  async execute(
    action: BrowserRecoverableAction,
    context: KernelCallContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const operation = action.action === 'hover' ? 'hover' : 'nativeClick'
    try {
      return await this.port.invoke(operation, action, context, signal)
    } catch (error) {
      signal?.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      if (!/WEB_ELEMENT_(NOT_FOUND|OCCLUDED)/.test(message)) throw error
      if (!action.target || action.allowOccluded) throw error
      await this.port.invoke('inspect', {}, context, signal)
      await this.port.invoke(
        'evaluate',
        {
          world: 'isolated',
          expression: `document.querySelector(${JSON.stringify(action.target)})?.scrollIntoView({ block: 'center', inline: 'center' })`,
        },
        context,
        signal,
      )
      return this.port.invoke(operation, action, context, signal)
    }
  }
}
