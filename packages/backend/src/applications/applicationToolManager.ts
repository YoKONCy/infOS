import { t as __t } from '../lib/i18n'
/**
 * applicationToolManager — 子应用工具管理层
 *
 * 链路：子应用内部声明 → 子应用自身适配器 → infOS 侧适配器 → 本管理层 → CapabilityGate。
 * 子应用工具只在子应用启动、Endpoint 就绪后动态注册；下线即整条移除，不常驻工具列表。
 * 本层只回答“当前有哪些子应用工具在线、各属于谁”，能否调用一律交给通用 CapabilityGate，
 * 不为子应用工具开设任何旁路。
 */
import type { ApplicationAdapterManifest, ApplicationToolProjection } from '@infos/shared'
import type { ApplicationRealm } from './applicationRealm'
import type { ToolHandler } from '../services/agent/toolRegistry'
import type { ToolDefinition } from '../services/pipeline/types'
import { createLogger } from '../lib/logger'

const logger = createLogger('ApplicationToolManager')

/** 宿主当前能承接的调用语义；open_session 需要独立会话通道，尚未实现。 */
const SUPPORTED_INVOCATIONS: ReadonlySet<ApplicationToolProjection['invocation']> = new Set([
  'invoke',
  'submit_task',
])

/** 当前在线的子应用工具。 */
export interface ApplicationToolEntry {
  name: string
  appId: string
  appName: string
  definition: ToolDefinition
}

interface OnlineTool {
  entry: ApplicationToolEntry
  realm: ApplicationRealm
}

export class ApplicationToolManager {
  private readonly online = new Map<string, OnlineTool>()
  private readonly apps = new Set<string>()
  /** 上线失败的工具；同步会反复重试，只在首次失败时记日志，避免刷屏。 */
  private readonly failed = new Set<string>()

  /**
   * infOS 侧适配器装配时接入，得到只能上下线本子应用工具的凭据。
   * 此时不登记、不注册任何工具；子应用启动且 Endpoint 就绪后才由 online() 动态注册。
   */
  declare(
    realm: ApplicationRealm,
    manifest: ApplicationAdapterManifest,
  ): ApplicationToolDeclaration {
    const appId = realm.descriptor.appId
    if (this.apps.has(appId)) throw new Error(`APPLICATION_TOOLS_ALREADY_DECLARED: ${appId}`)
    const accepted = new Map<string, ApplicationToolProjection>()
    for (const projection of manifest.toolProjections ?? []) {
      if (!SUPPORTED_INVOCATIONS.has(projection.invocation)) {
        logger.warn(
          __t('logs.applications', '子应用工具 {0} 使用尚未支持的调用语义 {1}，已跳过', [
            projection.name,
            projection.invocation,
          ]),
        )
        continue
      }
      accepted.set(projection.name, projection)
    }
    this.apps.add(appId)
    // Realm 释放时一并撤销接入记录与在线工具。
    realm.scope.defer(() => this.forget(appId, [...accepted.keys()]))
    return new ApplicationToolDeclaration(this, realm, manifest.name, accepted)
  }

  /** 当前在线的子应用工具；未启动或已断开的子应用不会出现在这里。 */
  list(): ApplicationToolEntry[] {
    return [...this.online.values()].map(({ entry }) => ({ ...entry }))
  }

  get(name: string): ApplicationToolEntry | undefined {
    const tool = this.online.get(name)
    return tool ? { ...tool.entry } : undefined
  }

  /** 工具是否为在线子应用工具；供工具排序把动态工具放到末尾。 */
  has(name: string): boolean {
    return this.online.has(name)
  }

  /** @internal 由 ApplicationToolDeclaration 调用；同步完成，保证同一次同步中的工具同时可见。 */
  register(
    realm: ApplicationRealm,
    appName: string,
    projection: ApplicationToolProjection,
    handler: ToolHandler,
  ): boolean {
    const appId = realm.descriptor.appId
    const current = this.online.get(projection.name)
    if (current) return current.realm === realm
    const definition: ToolDefinition = {
      name: projection.name,
      // 同一子应用的工具在会话工具菜单中按包相邻展示。
      packageId: `application:${appId}`,
      description: projection.description,
      parameters: projection.parameters,
      display: projection.display,
      requiresApproval: projection.requiresApproval,
    }
    try {
      // 实际注册仍经 Realm，保留宿主投影与私有工具的隔离判定；重名由 Realm 拒绝。
      realm.registerTool(definition, handler, { hostProjection: true })
    } catch (error) {
      if (!this.failed.has(projection.name)) {
        this.failed.add(projection.name)
        logger.warn(
          __t('logs.applications', '子应用工具 {0} 上线失败: {1}', [
            projection.name,
            error instanceof Error ? error.message : String(error),
          ]),
        )
      }
      return false
    }
    this.failed.delete(projection.name)
    this.online.set(projection.name, {
      realm,
      entry: { name: projection.name, appId, appName, definition },
    })
    logger.info(__t('logs.applications', '子应用工具已上线: {0} ({1})', [projection.name, appId]))
    return true
  }

  /** @internal 由 ApplicationToolDeclaration 调用。 */
  async unregister(realm: ApplicationRealm, name: string): Promise<void> {
    const tool = this.online.get(name)
    if (!tool || tool.realm !== realm) return
    // 先注销再移出目录：注销失败时仍记为在线，下次同步可以重试，状态不与注册表脱节。
    await realm.unregisterTool(name)
    this.online.delete(name)
    logger.info(__t('logs.applications', '子应用工具已下线: {0} ({1})', [name, tool.entry.appId]))
  }

  private forget(appId: string, names: readonly string[]): void {
    this.apps.delete(appId)
    for (const name of names) this.failed.delete(name)
    for (const [name, tool] of this.online) {
      if (tool.entry.appId === appId) this.online.delete(name)
    }
  }
}

/** 单个子应用的接入凭据；infOS 侧适配器只能上下线自己 manifest 中声明过的工具。 */
export class ApplicationToolDeclaration {
  constructor(
    private readonly manager: ApplicationToolManager,
    private readonly realm: ApplicationRealm,
    private readonly appName: string,
    private readonly projections: ReadonlyMap<string, ApplicationToolProjection>,
  ) {}

  get appId(): string {
    return this.realm.descriptor.appId
  }

  /** 允许动态注册的工具名（已剔除不支持的调用语义）。 */
  get names(): string[] {
    return [...this.projections.keys()]
  }

  has(name: string): boolean {
    return this.projections.has(name)
  }

  isOnline(name: string): boolean {
    return this.manager.get(name)?.appId === this.appId
  }

  /** 子应用启动且 Endpoint 就绪后调用，动态注册该工具。 */
  online(name: string, handler: ToolHandler): boolean {
    const projection = this.projections.get(name)
    if (!projection) throw new Error(`APPLICATION_TOOL_UNDECLARED: ${name}`)
    return this.manager.register(this.realm, this.appName, projection, handler)
  }

  offline(name: string): Promise<void> {
    return this.manager.unregister(this.realm, name)
  }

  /** 子应用停止时注销全部工具；单个失败不影响其余工具下线，最后汇总抛出。 */
  async offlineAll(): Promise<void> {
    const results = await Promise.allSettled(this.names.map((name) => this.offline(name)))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}
