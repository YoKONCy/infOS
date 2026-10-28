import { randomUUID } from 'node:crypto'
import type {
  AgentBrowserScope,
  BrowserObserverFrame,
  BrowserObserverSession,
  KernelCapabilityRequirement,
  KernelNodeId,
  WebPageOperation,
} from '@infos/shared'
import type { CapabilityDirectory, BoundCapabilityPort } from '../kernel/capabilityDirectory'
import type { CapabilityHandleRegistry } from '../kernel/capabilityHandleRegistry'
import { LifecycleScope } from '../kernel/lifecycleScope'
import type { ToolContext, ToolRegistry } from '../services/agent/toolRegistry'
import { createBrowserToolContributions } from '../tools/browserControl'
import type { BrowserPreviewResolver } from '../tools/browserControl/navigationTarget'
import { browserToolScope } from '../tools/browserControl/scope'

interface Observation {
  session: BrowserObserverSession
  scope: AgentBrowserScope
  bindingId: string
  providerKey: string
  pending?: Promise<BrowserObserverFrame>
  frame?: BrowserObserverFrame
}

const REQUIREMENT: KernelCapabilityRequirement = {
  requirementId: 'kernel.browser-tools',
  capabilityType: 'web.page',
  contractVersion: '1.0',
  operations: [],
  required: false,
  binding: 'lazy',
  cardinality: 'one',
  placement: {
    executionLocations: ['client-local'],
    providerFacets: ['client', 'capability'],
    requiresClientPresence: true,
    dataResidency: 'device-only',
  },
}

/** 根据 CapabilityDirectory 中的 web.page Offer 管理 Browser Tool ABI。 */
export class BrowserToolRuntime {
  private scope?: LifecycleScope
  private port?: BoundCapabilityPort
  private unsubscribe?: () => void
  private syncing = false
  private syncRequested = false
  private stopped = true
  private previewResolver?: BrowserPreviewResolver
  private readonly observations = new Map<string, Observation>()

  /** 只登记宿主实际执行过的会话，不允许观看端自行指定浏览器作用域。 */
  private present(context: ToolContext, visible?: boolean): void {
    const port = this.port
    if (!port?.offer.operations.includes('observeFrame') || !context.threadId) return
    const scope = browserToolScope(context)
    const key = JSON.stringify([
      context.agentId,
      context.threadId,
      context.taskId,
      scope.profileId,
      scope.sessionId,
    ])
    let observation = this.observations.get(key)
    if (!observation || observation.bindingId !== port.bindingId) {
      observation = {
        scope: { ...scope },
        bindingId: port.bindingId,
        providerKey: this.providerKey(port),
        session: {
          id: randomUUID(),
          agentId: context.agentId,
          threadId: context.threadId,
          taskId: context.taskId,
          requestedVisible: false,
          available: true,
          updatedAt: Date.now(),
        },
      }
      this.observations.set(key, observation)
    }
    observation.session.updatedAt = Date.now()
    if (visible !== undefined) observation.session.requestedVisible = visible
    // 保留最近会话；页面帧只短暂驻留，不写入数据库、消息或模型上下文。
    if (this.observations.size > 128) {
      const oldest = [...this.observations.entries()].sort(
        (a, b) => a[1].session.updatedAt - b[1].session.updatedAt,
      )[0]
      if (oldest) this.observations.delete(oldest[0])
    }
  }

  private providerKey(port: BoundCapabilityPort): string {
    const provider = port.offer.provider
    return JSON.stringify([
      provider.authorityNodeId,
      provider.objectId,
      provider.generation,
      provider.authorityEpoch,
    ])
  }

  listObservations(agentId: string, threadId?: string): BrowserObserverSession[] {
    return [...this.observations.values()]
      .filter(
        ({ session }) =>
          session.agentId === agentId && (!threadId || session.threadId === threadId),
      )
      .map(({ session, bindingId }) => ({
        ...session,
        available: this.port?.bindingId === bindingId,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async observe(id: string, agentId: string, threadId: string): Promise<BrowserObserverFrame> {
    const observation = [...this.observations.values()].find(
      ({ session }) =>
        session.id === id && session.agentId === agentId && session.threadId === threadId,
    )
    const port = this.port
    if (!observation || !port || observation.bindingId !== port.bindingId)
      return { state: 'paused' }
    if (observation.frame?.capturedAt && Date.now() - observation.frame.capturedAt < 750)
      return observation.frame
    if (!observation.pending) {
      const pending = port
        .invoke<unknown, BrowserObserverFrame>(
          'observeFrame',
          { __browserScope: { ...observation.scope, principalId: agentId } },
          {
            principalId: agentId,
            correlationId: randomUUID(),
            deadline: new Date(Date.now() + 5_000).toISOString(),
          },
          AbortSignal.timeout(5_000),
        )
        .then((frame): BrowserObserverFrame => {
          // 只接受有界 JPEG，不能把节点返回的任意协议或截图引用送进旁观组件。
          if (this.port !== port || !['live', 'waiting', 'closed', 'paused'].includes(frame?.state))
            return { state: 'paused' }
          if (frame.state !== 'live') return { state: frame.state }
          if (
            !frame.dataUri ||
            frame.dataUri.length > 512_100 ||
            !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(frame.dataUri)
          )
            return { state: 'paused' }
          const safe: BrowserObserverFrame = {
            state: 'live',
            dataUri: frame.dataUri,
            targetId: frame.targetId,
            title: frame.title,
            url: frame.url,
            width: frame.width,
            height: frame.height,
            capturedAt: Date.now(),
          }
          observation.frame = safe
          const expiry = setTimeout(() => {
            if (observation.frame === safe) observation.frame = undefined
          }, 1_000)
          expiry.unref()
          return safe
        })
        .catch((): BrowserObserverFrame => ({ state: 'paused' }))
      observation.pending = pending
      void pending.then(() => {
        if (observation.pending === pending) observation.pending = undefined
      })
    }
    return observation.pending
  }

  setPreviewResolver(resolver: BrowserPreviewResolver): void {
    this.previewResolver = resolver
  }

  constructor(
    private readonly directory: CapabilityDirectory,
    private readonly handles: CapabilityHandleRegistry,
    private readonly tools: ToolRegistry,
    private readonly localNodeId: KernelNodeId,
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    this.unsubscribe = this.directory.subscribe(() => this.sync())
    await this.sync()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.syncRequested = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.unregister()
  }

  private async sync(): Promise<void> {
    if (this.stopped) return
    this.syncRequested = true
    if (this.syncing) return
    this.syncing = true
    try {
      // 释放旧端口期间到达的重连不能丢失，逐次排空最新目录状态。
      while (this.syncRequested && !this.stopped) {
        this.syncRequested = false
        const offer = this.directory
          .listOffers(REQUIREMENT)
          .find((candidate) => candidate.health === 'available')
        if (offer?.offerId === this.port?.offer.offerId) continue
        await this.unregister()
        if (offer && !this.stopped) await this.register(offer.provider.authorityNodeId)
      }
    } finally {
      this.syncing = false
    }
  }

  private async register(providerNodeId?: KernelNodeId): Promise<void> {
    const scope = new LifecycleScope('browser-tool-binding')
    const offer = this.directory
      .listOffers(REQUIREMENT)
      .find((candidate) => candidate.health === 'available')
    if (!offer) return
    const handle = this.handles.issue({
      subjectId: 'kernel.browser-tools',
      issuerNodeId: this.localNodeId,
      subjectNodeId: this.localNodeId,
      providerNodeId,
      revocationEpoch: 1,
      resource: offer.provider,
      operations: offer.operations,
      scope: { capabilityType: 'web.page', placement: 'client-local' },
      revocable: true,
    })
    scope.defer(() => {
      this.handles.revoke(handle.handleId)
    })
    const requirement: KernelCapabilityRequirement = {
      ...REQUIREMENT,
      operations: offer.operations,
      placement: { ...REQUIREMENT.placement, preferredNodeId: providerNodeId },
    }
    const port = this.directory.bind({
      requirement,
      handleId: handle.handleId,
      scope,
      principalId: 'system',
    })
    for (const contribution of createBrowserToolContributions(
      port,
      offer.operations as WebPageOperation[],
      undefined,
      (source, context) => {
        if (!this.previewResolver)
          throw new Error('BROWSER_PREVIEW_UNAVAILABLE: 工作区网页预览尚未就绪')
        return this.previewResolver(source, context)
      },
      (context, visible) => this.present(context, visible),
    )) {
      this.tools.register(contribution.definition, contribution.handler)
      scope.defer(() => {
        this.tools.unregister(contribution.definition.name)
      })
    }
    this.scope = scope
    this.port = port
    // 同一节点重连后恢复已有旁观；切换到其他节点不能借用旧会话标识。
    const providerKey = this.providerKey(port)
    for (const observation of this.observations.values()) {
      if (observation.providerKey !== providerKey) continue
      observation.bindingId = port.bindingId
      observation.pending = undefined
      observation.frame = undefined
    }
  }

  private async unregister(): Promise<void> {
    const scope = this.scope
    this.scope = undefined
    this.port = undefined
    for (const observation of this.observations.values()) observation.frame = undefined
    await scope?.dispose()
  }
}
