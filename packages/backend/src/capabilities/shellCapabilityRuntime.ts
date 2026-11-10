/**
 * ShellCapabilityRuntime — 外壳工具对 Electron desktop.shell Capability 的动态绑定（阶段 3）
 *
 * 外壳只操作 infOS 自己的窗口与主题，不占用键盘鼠标（requiresInputSeat 为 false），
 * 也不受「桌面操作」总开关约束；绑定方式参照 DesktopCapabilityRuntime。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 3
 * @module packages/backend/src/capabilities/shellCapabilityRuntime
 */

import {
  DESKTOP_SHELL_OPERATIONS,
  type DesktopShellOperation,
  type KernelCallContext,
  type KernelCapabilityDefinition,
  type KernelCapabilityRequirement,
  type KernelNodeId,
} from '@infos/shared'
import type { CapabilityDirectory, BoundCapabilityPort } from '../kernel/capabilityDirectory'
import type { CapabilityHandleRegistry } from '../kernel/capabilityHandleRegistry'
import { LifecycleScope } from '../kernel/lifecycleScope'

/** desktop.shell 能力定义；在容器中与其他原生能力一起注册。 */
export const DESKTOP_SHELL_CAPABILITY: KernelCapabilityDefinition = {
  capabilityType: 'desktop.shell',
  contractVersion: '1.0',
  operations: Object.fromEntries(
    DESKTOP_SHELL_OPERATIONS.map((operation) => [
      operation,
      operation === 'layout'
        ? { risk: 'read', idempotency: 'safe' }
        : { risk: 'interact', idempotency: 'unsafe' },
    ]),
  ) as KernelCapabilityDefinition['operations'],
}

const REQUIREMENT: KernelCapabilityRequirement = {
  requirementId: 'kernel.shell-tools',
  capabilityType: 'desktop.shell',
  contractVersion: '1.0',
  operations: [],
  required: false,
  binding: 'lazy',
  cardinality: 'one',
  placement: {
    executionLocations: ['client-local'],
    providerFacets: ['client', 'capability'],
    requiresClientPresence: true,
    requiresInputSeat: false,
    dataResidency: 'device-only',
  },
}

export class ShellCapabilityRuntime {
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

  /** 当前是否有在线的桌面客户端提供外壳能力。 */
  isAvailable(): boolean {
    return this.port?.offer.health === 'available'
  }

  async invoke(
    operation: DesktopShellOperation,
    input: unknown,
    context: KernelCallContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const port = this.port
    if (!port || port.offer.health !== 'available' || !port.offer.operations.includes(operation)) {
      throw new Error(`CAPABILITY_UNAVAILABLE: desktop.shell/${operation}`)
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
    const scope = new LifecycleScope('shell-capability-binding')
    const handle = this.handles.issue({
      subjectId: 'kernel.shell-tools',
      issuerNodeId: this.localNodeId,
      subjectNodeId: this.localNodeId,
      providerNodeId: offer.placement?.providerNodeId,
      revocationEpoch: 1,
      resource: offer.provider,
      operations: offer.operations,
      scope: { capabilityType: 'desktop.shell', placement: 'client-local' },
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
