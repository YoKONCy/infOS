/**
 * applicationRealm — Application Realm 集成层
 *
 * 负责定义该模块的稳定入口、数据边界与错误语义。
 * 调用方通过这里访问领域能力，避免绕过校验直接耦合内部状态。
 */
import { LifecycleScope } from '../kernel/lifecycleScope'
import type { ToolRegistry, ToolHandler } from '../services/agent/toolRegistry'
import type { ToolDefinition } from '../services/pipeline/types'

export interface ApplicationRealmDescriptor {
  realmId: string
  appId: string
  principalId: string
  instanceId: string
}

interface RealmRecord {
  descriptor: ApplicationRealmDescriptor
  scope: LifecycleScope
  tools: Set<string>
  hostTools: Set<string>
  toolDisposers: Map<string, () => Promise<void>>
}

const FORBIDDEN_REALM_IDS = new Set(['stronghold', 'infos.stronghold'])

/** 唯一Kernel内的Application隔离运行域管理器。 */
export class ApplicationRealmManager {
  private readonly realms = new Map<string, RealmRecord>()
  private readonly toolOwners = new Map<string, string>()
  private readonly hostProjections = new Set<string>()

  constructor(private readonly tools: ToolRegistry) {}

  register(descriptor: ApplicationRealmDescriptor): ApplicationRealm {
    if (FORBIDDEN_REALM_IDS.has(descriptor.appId) || FORBIDDEN_REALM_IDS.has(descriptor.realmId)) {
      throw new Error('STRONGHOLD_REALM_FORBIDDEN: Stronghold永久属于主应用内部模块')
    }
    if (this.realms.has(descriptor.realmId)) {
      throw new Error(`APPLICATION_REALM_EXISTS: ${descriptor.realmId}`)
    }
    const record: RealmRecord = {
      descriptor: Object.freeze({ ...descriptor }),
      scope: new LifecycleScope(`application-realm:${descriptor.realmId}`),
      tools: new Set(),
      hostTools: new Set(),
      toolDisposers: new Map(),
    }
    this.realms.set(descriptor.realmId, record)
    return new ApplicationRealm(record, this)
  }

  get(realmId: string): ApplicationRealmDescriptor | undefined {
    return this.realms.get(realmId)?.descriptor
  }

  toolDefinitions(realmId: string): ToolDefinition[] {
    const record = this.require(realmId)
    return this.tools.getDefinitions().filter((definition) => record.tools.has(definition.name))
  }

  allowsTool(realmId: string | undefined, toolName: string): boolean {
    if (!realmId) return !this.toolOwners.has(toolName) || this.hostProjections.has(toolName)
    const record = this.realms.get(realmId)
    return !!record && (record.tools.has(toolName) || record.hostTools.has(toolName))
  }

  /** 仅装配根签发收窄宿主能力，不把授权函数暴露给应用运行时。 */
  grantHostTools(realmId: string, names: readonly string[]): void {
    const record = this.require(realmId)
    for (const name of names) record.hostTools.add(name)
  }

  hasHostToolGrant(realmId: string, name: string): boolean {
    return this.realms.get(realmId)?.hostTools.has(name) ?? false
  }

  ownsTool(toolName: string): boolean {
    return this.toolOwners.has(toolName)
  }

  isHostProjection(toolName: string): boolean {
    return this.hostProjections.has(toolName)
  }

  isPrivateTool(toolName: string): boolean {
    return this.ownsTool(toolName) && !this.isHostProjection(toolName)
  }

  async dispose(realmId: string): Promise<void> {
    const record = this.realms.get(realmId)
    if (!record) return
    this.realms.delete(realmId)
    await record.scope.dispose()
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.realms.keys()].map((realmId) => this.dispose(realmId)))
  }

  registerTool(
    record: RealmRecord,
    definition: ToolDefinition,
    handler: ToolHandler,
    hostProjection = false,
  ): void {
    const owner = this.toolOwners.get(definition.name)
    if (!owner && this.tools.has(definition.name)) {
      throw new Error(`APPLICATION_REALM_TOOL_CONFLICT: ${definition.name}`)
    }
    if (owner) {
      throw new Error(`APPLICATION_REALM_TOOL_CONFLICT: ${definition.name}`)
    }
    this.tools.register(definition, handler)
    this.toolOwners.set(definition.name, record.descriptor.realmId)
    if (hostProjection) this.hostProjections.add(definition.name)
    record.tools.add(definition.name)
    const dispose = record.scope.defer(() => {
      if (this.toolOwners.get(definition.name) === record.descriptor.realmId) {
        this.toolOwners.delete(definition.name)
        this.hostProjections.delete(definition.name)
        record.tools.delete(definition.name)
        this.tools.unregister(definition.name)
      }
      record.toolDisposers.delete(definition.name)
    })
    record.toolDisposers.set(definition.name, dispose)
  }

  async unregisterTool(record: RealmRecord, toolName: string): Promise<boolean> {
    if (this.toolOwners.get(toolName) !== record.descriptor.realmId) return false
    const dispose = record.toolDisposers.get(toolName)
    if (!dispose) return false
    await dispose()
    return true
  }

  private require(realmId: string): RealmRecord {
    const record = this.realms.get(realmId)
    if (!record) throw new Error(`APPLICATION_REALM_NOT_FOUND: ${realmId}`)
    return record
  }
}

export class ApplicationRealm {
  constructor(
    private readonly record: RealmRecord,
    private readonly manager: ApplicationRealmManager,
  ) {}

  get descriptor(): ApplicationRealmDescriptor {
    return this.record.descriptor
  }

  get scope(): LifecycleScope {
    return this.record.scope
  }

  registerTool(
    definition: ToolDefinition,
    handler: ToolHandler,
    options?: { hostProjection?: boolean },
  ): void {
    this.manager.registerTool(this.record, definition, handler, options?.hostProjection)
  }

  unregisterTool(toolName: string): Promise<boolean> {
    return this.manager.unregisterTool(this.record, toolName)
  }

  dispose(): Promise<void> {
    return this.manager.dispose(this.record.descriptor.realmId)
  }
}
