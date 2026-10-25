import type {
  ApplicationAdapterManifest,
  ApplicationToolProjection,
  KernelCallContext,
  KernelNodeId,
} from '@infos/shared'
import type { ApplicationToolDeclaration } from './applicationToolManager'
import type { CapabilityDirectory, BoundCapabilityPort } from '../kernel/capabilityDirectory'
import type { CapabilityHandleRegistry } from '../kernel/capabilityHandleRegistry'
import { LifecycleScope } from '../kernel/lifecycleScope'
import type { ToolContext } from '../services/agent/toolRegistry'

type Caller = (operation: string, value: unknown, context: KernelCallContext) => Promise<unknown>
export interface ApplicationRuntimeOptions {
  prepareInput?: (input: unknown) => unknown
  enabled?: () => boolean
  preferredNode?: () => KernelNodeId | undefined
  toolInvocation?: (
    projection: ApplicationToolProjection,
    args: Record<string, unknown>,
    context: ToolContext,
    invoke: Caller,
  ) => Promise<string>
}

/** 按声明绑定在线能力；业务适配只通过公开回调扩展。 */
export class ApplicationCapabilityRuntime {
  private readonly bindings = new Map<
    string,
    { scope: LifecycleScope; port: BoundCapabilityPort }
  >()
  private unsubscribe?: () => void
  private synchronizing?: Promise<void>
  private changed = false
  private stopped = true
  constructor(
    private readonly directory: CapabilityDirectory,
    private readonly handles: CapabilityHandleRegistry,
    private readonly tools: ApplicationToolDeclaration,
    private readonly localNodeId: KernelNodeId,
    private readonly manifest: ApplicationAdapterManifest,
    private readonly options: ApplicationRuntimeOptions = {},
  ) {}
  async start(): Promise<void> {
    this.stopped = false
    this.unsubscribe = this.directory.subscribe(() => this.refresh())
    await this.refresh()
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.synchronizing?.catch(() => undefined)
    await this.tools.offlineAll()
    for (const binding of this.bindings.values()) await binding.scope.dispose()
    this.bindings.clear()
  }
  available(): boolean {
    return this.bindings.size > 0
  }
  async refresh(): Promise<void> {
    this.changed = true
    if (this.synchronizing) return this.synchronizing
    this.synchronizing = this.sync().finally(() => {
      this.synchronizing = undefined
    })
    return this.synchronizing
  }
  async invoke<T = unknown>(
    operation: string,
    value: unknown,
    context?: KernelCallContext,
  ): Promise<T> {
    const offer = this.manifest.offeredCapabilities.find((candidate) =>
      candidate.operations.includes(operation),
    )
    const binding = offer ? this.bindings.get(offer.endpointId) : undefined
    if (!binding) throw new Error('APPLICATION_CAPABILITY_UNAVAILABLE: 应用未就绪或操作未声明')
    return binding.port.invoke(
      operation,
      this.options.prepareInput?.(value) ?? value,
      context ?? {
        principalId: `application:${this.manifest.id}`,
        correlationId: `${this.manifest.id}:${operation}:${Date.now()}`,
      },
    ) as Promise<T>
  }
  private async sync(): Promise<void> {
    do {
      this.changed = false
      for (const offered of this.manifest.offeredCapabilities) {
        const requirement = {
          requirementId: `${this.manifest.id}:${offered.endpointId}`,
          capabilityType: offered.capabilityType,
          contractVersion: offered.contractVersion,
          operations: [...offered.operations],
          required: false,
          binding: 'lazy' as const,
          cardinality: 'one' as const,
        }
        const preferredNode = this.options.preferredNode?.()
        const offer =
          this.stopped || (this.options.preferredNode && !preferredNode)
            ? undefined
            : this.directory
                .listOffers(requirement)
                .find(
                  (candidate) =>
                    candidate.health === 'available' &&
                    (!preferredNode || candidate.placement?.providerNodeId === preferredNode),
                )
        const previous = this.bindings.get(offered.endpointId)
        if (
          previous &&
          (!offer ||
            offer.offerId !== previous.port.offer.offerId ||
            offer.provider.generation !== previous.port.offer.provider.generation ||
            offer.provider.objectId !== previous.port.offer.provider.objectId)
        ) {
          this.bindings.delete(offered.endpointId)
          await previous.scope.dispose()
        }
        if (offer && !this.bindings.has(offered.endpointId)) {
          const scope = new LifecycleScope(`application:${this.manifest.id}:${offered.endpointId}`)
          try {
            const handle = this.handles.issue({
              subjectId: `application:${this.manifest.id}`,
              issuerNodeId: this.localNodeId,
              subjectNodeId: this.localNodeId,
              providerNodeId: offer.placement?.providerNodeId,
              revocationEpoch: 1,
              resource: offer.provider,
              operations: [...offered.operations],
              scope: { capabilityType: offered.capabilityType },
              revocable: true,
            })
            scope.defer(() => {
              this.handles.revoke(handle.handleId)
            })
            const port = this.directory.bind({
              requirement: {
                ...requirement,
                placement: { preferredNodeId: offer.placement?.providerNodeId },
              },
              handleId: handle.handleId,
              scope,
              principalId: `application:${this.manifest.id}`,
            })
            this.bindings.set(offered.endpointId, { scope, port })
          } catch (error) {
            await scope.dispose()
            throw error
          }
        }
      }
      // 只同步子应用工具管理层已接受的声明；不支持的调用语义在登记时已被跳过。
      for (const projection of this.manifest.toolProjections ?? []) {
        if (!this.tools.has(projection.name)) continue
        const ready =
          !this.stopped &&
          this.options.enabled?.() !== false &&
          this.bindings.has(projection.endpointId)
        const online = this.tools.isOnline(projection.name)
        if (!ready && online) {
          await this.tools.offline(projection.name)
        } else if (ready && !online) {
          this.tools.online(projection.name, async (args, context) => {
            if (this.options.toolInvocation)
              return this.options.toolInvocation(
                projection,
                args,
                context,
                (operation, value, caller) => this.invoke(operation, value, caller),
              )
            try {
              const result = await this.invoke(projection.operation, args, {
                principalId: context.agentId,
                correlationId: context.toolCallId ?? `${this.manifest.id}:${Date.now()}`,
                executionId: context.executionId,
                processId: context.processId,
                deadline: context.deadline,
                idempotencyKey: context.toolCallId,
              })
              return JSON.stringify({ success: true, result })
            } catch (error) {
              return JSON.stringify({
                error: error instanceof Error ? error.message : '应用调用失败',
              })
            }
          })
        }
      }
    } while (this.changed && !this.stopped)
  }
}
