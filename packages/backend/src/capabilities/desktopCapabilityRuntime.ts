import type { KernelCallContext, KernelCapabilityRequirement, KernelNodeId } from '@infos/shared'
import type { CapabilityDirectory, BoundCapabilityPort } from '../kernel/capabilityDirectory'
import type { CapabilityHandleRegistry } from '../kernel/capabilityHandleRegistry'
import { LifecycleScope } from '../kernel/lifecycleScope'

type DesktopOperation =
  | 'runtimeDiagnostics'
  | 'control'
  | 'statusCard'
  | 'screenCapture'
  | 'clipboardRead'
  | 'clipboardWrite'
  | 'activeWindow'
  | 'listWindows'
  | 'activateWindow'
  | 'applicationLaunch'
  | 'mousePosition'
  | 'mouseAction'
  | 'keyboardAction'

const REQUIREMENT: KernelCapabilityRequirement = {
  requirementId: 'kernel.desktop-tools',
  capabilityType: 'desktop.environment',
  contractVersion: '1.0',
  operations: [],
  required: false,
  binding: 'lazy',
  cardinality: 'one',
  placement: {
    executionLocations: ['client-local'],
    providerFacets: ['client', 'capability'],
    requiresClientPresence: true,
    requiresInputSeat: true,
    dataResidency: 'device-only',
  },
}

/** 桌面工具对 Electron desktop.environment Capability 的动态绑定。 */
export class DesktopCapabilityRuntime {
  private scope?: LifecycleScope
  private port?: BoundCapabilityPort
  private unsubscribe?: () => void

  constructor(
    private readonly directory: CapabilityDirectory,
    private readonly handles: CapabilityHandleRegistry,
    private readonly localNodeId: KernelNodeId,
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.directory.subscribe(() => this.sync())
    await this.sync()
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.release()
  }

  /** 当前是否有在线客户端提供指定桌面操作。 */
  isOperationAvailable(operation: DesktopOperation): boolean {
    return this.port?.offer.health === 'available' && this.port.offer.operations.includes(operation)
  }

  async invoke(
    operation: DesktopOperation,
    input: unknown,
    context: KernelCallContext,
    signal?: AbortSignal,
  ) {
    const port = this.port
    if (!port || port.offer.health !== 'available' || !port.offer.operations.includes(operation)) {
      throw new Error(`CAPABILITY_UNAVAILABLE: desktop.environment/${operation}`)
    }
    return port.invoke(operation, input, context, signal)
  }

  private async sync(): Promise<void> {
    const offer = this.directory
      .listOffers({ ...REQUIREMENT, operations: [] })
      .find((candidate) => candidate.health === 'available')
    if (!offer) {
      await this.release()
      return
    }
    if (this.port?.offer.offerId === offer.offerId) return
    await this.release()
    const scope = new LifecycleScope('desktop-capability-binding')
    const handle = this.handles.issue({
      subjectId: 'kernel.desktop-tools',
      issuerNodeId: this.localNodeId,
      subjectNodeId: this.localNodeId,
      providerNodeId: offer.placement?.providerNodeId,
      revocationEpoch: 1,
      resource: offer.provider,
      operations: offer.operations,
      scope: { capabilityType: 'desktop.environment', placement: 'client-local' },
      revocable: true,
    })
    scope.defer(() => {
      this.handles.revoke(handle.handleId)
    })
    this.port = this.directory.bind({
      requirement: {
        ...REQUIREMENT,
        operations: offer.operations,
        placement: { ...REQUIREMENT.placement, preferredNodeId: offer.placement?.providerNodeId },
      },
      handleId: handle.handleId,
      scope,
      principalId: 'system',
    })
    this.scope = scope
  }

  private async release(): Promise<void> {
    const scope = this.scope
    this.scope = undefined
    this.port = undefined
    await scope?.dispose()
  }
}
