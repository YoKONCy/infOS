import { t as __t } from '../lib/i18n'
/**
 * applicationToolManager — 子应用工具管理层
 *
 * 链路：子应用内部声明 → 子应用自身适配器 → infOS 侧适配器 → 本管理层 → CapabilityGate。
 * 所有子应用声明暴露给主 Agent 的工具都在这里统一登记目录、按在线状态上下线。
 * 本层只回答“有哪些、属于谁、此刻是否在线”，能否调用一律交给通用 CapabilityGate，
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

/** 目录条目：离线时仍保留声明，供能力配置提前勾选；但不进入主 Agent 可见工具。 */
export interface ApplicationToolEntry {
  name: string
  appId: string
  appName: string
  definition: ToolDefinition
  projection: ApplicationToolProjection
  available: boolean
}

interface DeclaredTool {
  entry: ApplicationToolEntry
  realm: ApplicationRealm
}

export class ApplicationToolManager {
  private readonly tools = new Map<string, DeclaredTool>()
  private readonly apps = new Set<string>()

  /**
   * infOS 侧适配器装配时登记该子应用声明的全部工具。
   * 同一子应用只能登记一次；工具名与其他子应用冲突时整体拒绝，避免半登记。
   */
  declare(
    realm: ApplicationRealm,
    manifest: ApplicationAdapterManifest,
  ): ApplicationToolDeclaration {
    const appId = realm.descriptor.appId
    if (this.apps.has(appId)) throw new Error(`APPLICATION_TOOLS_ALREADY_DECLARED: ${appId}`)
    const accepted: ApplicationToolProjection[] = []
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
      if (this.tools.has(projection.name)) {
        throw new Error(`APPLICATION_TOOL_NAME_CONFLICT: ${projection.name}`)
      }
      accepted.push(projection)
    }
    this.apps.add(appId)
    for (const projection of accepted) {
      this.tools.set(projection.name, {
        realm,
        entry: {
          name: projection.name,
          appId,
          appName: manifest.name,
          projection,
          available: false,
          definition: {
            name: projection.name,
            // 同一子应用的工具在会话工具菜单中按包相邻展示。
            packageId: `application:${appId}`,
            description: projection.description,
            parameters: projection.parameters,
            display: projection.display,
            requiresApproval: projection.requiresApproval,
          },
        },
      })
    }
    const declaration = new ApplicationToolDeclaration(
      this,
      appId,
      accepted.map((projection) => projection.name),
    )
    // Realm 释放时目录随之撤销，避免残留指向已销毁运行域的条目。
    realm.scope.defer(() => this.forget(appId))
    return declaration
  }

  /** 全部已登记的子应用工具（含离线），供能力配置界面展示。 */
  list(): ApplicationToolEntry[] {
    return [...this.tools.values()].map(({ entry }) => ({ ...entry }))
  }

  get(name: string): ApplicationToolEntry | undefined {
    const tool = this.tools.get(name)
    return tool ? { ...tool.entry } : undefined
  }

  /** @internal 由 ApplicationToolDeclaration 调用；同步完成，保证同一次同步中的工具同时可见。 */
  setOnline(appId: string, name: string, handler: ToolHandler): boolean {
    const tool = this.owned(appId, name)
    if (tool.entry.available) return true
    try {
      // 实际注册仍经 Realm，保留宿主投影与私有工具的隔离判定。
      tool.realm.registerTool(tool.entry.definition, handler, { hostProjection: true })
    } catch (error) {
      logger.warn(
        __t('logs.applications', '子应用工具 {0} 上线失败: {1}', [
          name,
          error instanceof Error ? error.message : String(error),
        ]),
      )
      return false
    }
    tool.entry.available = true
    logger.info(__t('logs.applications', '子应用工具已上线: {0} ({1})', [name, appId]))
    return true
  }

  /** @internal 由 ApplicationToolDeclaration 调用。 */
  async setOffline(appId: string, name: string): Promise<void> {
    const tool = this.owned(appId, name)
    if (!tool.entry.available) return
    tool.entry.available = false
    await tool.realm.unregisterTool(name)
    logger.info(__t('logs.applications', '子应用工具已下线: {0} ({1})', [name, appId]))
  }

  private owned(appId: string, name: string): DeclaredTool {
    const tool = this.tools.get(name)
    if (!tool || tool.entry.appId !== appId) {
      throw new Error(`APPLICATION_TOOL_UNDECLARED: ${name}`)
    }
    return tool
  }

  private forget(appId: string): void {
    this.apps.delete(appId)
    for (const [name, tool] of this.tools) {
      if (tool.entry.appId === appId) this.tools.delete(name)
    }
  }
}

/** 单个子应用的工具登记凭据；infOS 侧适配器只能上下线自己声明过的工具。 */
export class ApplicationToolDeclaration {
  constructor(
    private readonly manager: ApplicationToolManager,
    readonly appId: string,
    readonly names: readonly string[],
  ) {}

  has(name: string): boolean {
    return this.names.includes(name)
  }

  isOnline(name: string): boolean {
    return this.manager.get(name)?.available === true
  }

  online(name: string, handler: ToolHandler): boolean {
    return this.manager.setOnline(this.appId, name, handler)
  }

  offline(name: string): Promise<void> {
    return this.manager.setOffline(this.appId, name)
  }

  /** 应用停止时下线全部工具；目录条目保留，便于配置界面继续展示。 */
  async offlineAll(): Promise<void> {
    for (const name of this.names) await this.offline(name)
  }
}
