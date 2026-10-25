import { t as __t } from '../lib/i18n'
/**
 * AppManager — Agent 应用生命周期管理
 *
 * 负责：
 * - 应用安装/卸载（注册 Manifest）
 * - 应用实例启动/暂停/恢复/停止
 * - 应用实例状态查询
 * - 应用工具注册到 ToolRegistry（点号前缀隔离）
 * - 应用前端模块注册
 * - 应用事件转发到统一 EventBus
 *
 * 不负责：
 * - 应用内会话管理（由应用自己管理）
 * - 资源授权（由 GrantRegistry 管理）
 * - 上下文编译（由应用自己的 Compiler 负责）
 *
 * 生命周期状态机：
 *   install → installed → launch → launching → running
 *                                              ↓ pause
 *                                            paused
 *                                              ↓ resume
 *                                            running
 *                                              ↓ stop
 *                                            stopped → uninstall
 *
 * @module packages/backend/src/applications/appManager
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { eq, and, inArray } from 'drizzle-orm'
import type { Hono } from 'hono'
import { appRegistry, appInstances, appCheckpoints } from '../database/schema'
import type { DrizzleDb } from '../database'
import { createLogger } from '../lib/logger'
import type { ToolRegistry } from '../services/agent/toolRegistry'
import type { PathResolver } from '../core/pathResolver'
import type { ApplicationRealm, ApplicationRealmManager } from './applicationRealm'
import type { GrantRegistry } from './grantRegistry'
import type { LlmService } from '../services/llm/llmService'
import type { MdpEngine } from '../services/prompt/mdpEngine'
import type { AgentManager } from '../services/agent/agentManager'
import type { ModelConfig } from '../services/llm/llmService'
import type { MemoryStoreRegistry } from '../repositories/storeRegistry'
import type { SocialEventPort, SocialStoragePort } from './socialPorts'
import { registerSocialTransport } from './socialWsBridge'
import type { KernelScheduler } from '../kernel/kernelScheduler'
import type { InboundRouteRepository } from '../repositories/inboundRoute.repo'
import type { ConfigRepository } from '../repositories/config.repo'
import type { FlowStateService } from '../services/flow/flowStateService'
import type { ThreadService } from '../services/thread/threadService'
import type {
  AgentAppManifest,
  AppInstance,
  AppInstallStatus,
  AppCheckpoint,
  AppEvent,
  AppCommandRequest,
  AppCommandResult,
  LaunchAppParams,
  AppTaskContext,
} from './types'
import type {
  AgentAppRuntime,
  AppRuntimeContext,
  AppLogger,
  HostDiaryReaderPort,
} from './appRuntime'

const logger = createLogger('AppManager')

// ─────────────────────────────────────────────
// AppManager 接口
// ─────────────────────────────────────────────

/**
 * AppManager — 应用生命周期管理接口
 */
export interface AppManager {
  // ── 应用安装管理 ──

  /**
   * 安装应用
   *
   * 扫描应用目录，读取 app.manifest.json，注册到系统。
   * 检查 minAiosVersion 和权限声明。
   *
   * @returns appId + 警告信息（如权限声明不完整等）
   */
  install(appDir: string): Promise<{ appId: string; warnings: string[] }>

  /**
   * 卸载应用
   *
   * 仅允许卸载已安装（非 running）的应用。
   * 删除应用注册信息，不删除应用文件（除非 deleteFiles=true）。
   */
  uninstall(appId: string, opts?: { deleteFiles?: boolean }): Promise<boolean>

  /** 列出所有已安装应用 */
  listInstalled(): Promise<Array<AgentAppManifest & { installPath: string }>>

  /** 获取应用 Manifest */
  getManifest(appId: string): Promise<AgentAppManifest | undefined>

  // ── 应用实例管理 ──

  /**
   * 启动应用实例
   *
   * 流程：
   * 1. 校验应用已安装且状态允许启动
   * 2. 校验 hostAgentId 在 supportedAgentRoles 内
   * 3. 校验 requiredPermissions 已被授予
   * 4. 创建 AppInstance 记录
   * 5. 注册应用工具到 ToolRegistry（带 appId 前缀隔离）
   * 6. 加载显式注册的内置Runtime
   * 7. 主 Agent 通过 GrantRegistry 授权资源（如果有 taskContext）
   * 8. 调用 runtime.initialize()
   * 9. 状态变为 running
   *
   * @returns 实例 ID
   */
  launch(params: LaunchAppParams): Promise<string>

  /** 暂停应用实例 */
  pause(instanceId: string): Promise<boolean>

  /** 恢复应用实例 */
  resume(instanceId: string): Promise<boolean>

  /**
   * 停止应用实例
   *
   * 流程：
   * 1. 通知应用保存状态（调用 runtime.onStop() 生成 Checkpoint）
   * 2. 撤销所有 GrantRegistry 授权（revokeByHolder）
   * 3. 注销应用工具（unregisterAppTools）
   * 4. 状态变为 stopped
   */
  stop(instanceId: string): Promise<boolean>

  notifyConfigChanged(keys: readonly string[]): Promise<void>

  /** 获取实例信息 */
  getInstance(instanceId: string): Promise<AppInstance | undefined>

  /** 列出应用实例 */
  listInstances(params: {
    hostAgentId?: string
    appId?: string
    status?: AppInstallStatus
  }): Promise<AppInstance[]>

  executeCommand(params: {
    correlationId?: string
    execution?: import('@infos/shared').KernelExecutionDescriptor
    appId: string
    hostAgentId: string
    action: string
    input: Record<string, unknown>
    taskContext?: AppTaskContext
    communicationBudget?: number
    signal?: AbortSignal
  }): Promise<AppCommandResult>

  // ── 检查点与事件 ──

  /**
   * 获取应用实例的当前检查点
   *
   * 主 Agent 通过此方法读取应用任务状态，
   * 不需要读取应用内部的所有消息和推理。
   */
  getCheckpoint(instanceId: string): Promise<AppCheckpoint | undefined>

  /**
   * 订阅应用实例的事件流
   *
   * 应用内部有自己的事件流；主 Agent 订阅应用事件走统一 EventBus。
   * 返回取消订阅函数。
   */
  subscribe(instanceId: string, handler: (event: AppEvent) => void): () => void

  // ── 记忆回流 ──

  /**
   * 收集指定主 Agent 下所有运行中应用的当日记忆摘要
   *
   * AIOS 记忆回流通道：DailyNotesService 在每日生成日记时调用此方法，
   * 聚合所有应用的 getDailySummaries() 输出。
   *
   * - 仅遍历 status='running' 且 hostAgentId 匹配的实例
   * - 应用未实现 getDailySummaries 时跳过
   * - 单个应用异常不影响其他应用（catch 后继续）
   *
   * @param hostAgentId 主 Agent ID
   * @param date        ISO 日期字符串（如 "2026-08-08"）
   * @returns 所有应用当日记忆摘要的合并列表
   */
  collectDailySummaries(hostAgentId: string, date: string): Promise<string[]>

  /**
   * 注入主 Hono app 实例，启用 sub app 动态路由挂载
   *
   * 由 startup 在 createApp 后调用。sub app 通过 ctx.mountRouter 注册的
   * HTTP 路由会代理到此实例。必须在 launch 任何需要 HTTP 路由的 sub app 之前调用。
   */
  setHonoApp(app: import('hono').Hono): void

  setHostCommunicator(
    handler: (input: {
      hostAgentId: string
      appId: string
      instanceId: string
      correlationId: string
      mode: string
      summary: string
      context?: Record<string, unknown>
    }) => Promise<Record<string, unknown>>,
  ): void
  setTaskPorts(ports: {
    control: import('@infos/shared').SocialTaskControlPort
    registerDelivery: (port: import('@infos/shared').TaskDeliveryPort) => () => void
  }): void
  setStatusCardPort(port: import('@infos/shared').SocialStatusCardPort): void
  setResourcePort(port: import('@infos/shared').SocialResourcePort): void
  setCreativePort(port: import('@infos/shared').ApplicationCreativePort): void
  setSocialHostCapabilityFactory(
    factory: (realmId: string) => import('@infos/shared').SocialHostCapabilityPort,
  ): void

  /**
   * 注册内置应用 runtime factory
   *
   * 内置应用（如 social）由Backend直接注册factory。
   * 这样在 dev 模式下无需编译 .ts → .js，生产环境也可用同一份代码。
   *
   * @param appId 应用 ID
   * @param factory 创建 AgentAppRuntime 实例的工厂函数
   */
  registerBuiltinRuntime(appId: string, factory: () => AgentAppRuntime): void

  /**
   * 清理孤儿实例（启动时调用）
   *
   * 后端重启后，数据库里可能残留上次运行时的 launching/running/paused 状态实例，
   * 但对应的内存 runtime 已不存在。此方法将这些孤儿实例标记为 stopped。
   *
   * 必须在 autoLaunch 之前调用，否则 listInstances({status:'running'})
   * 会误判旧实例仍在运行，跳过 launch。
   */
  cleanupStaleInstances(): Promise<void>
  shutdown(): Promise<void>
}

// ─────────────────────────────────────────────
// AppManager 实现
// ─────────────────────────────────────────────

/**
 * AppManagerImpl — AppManager 的默认实现
 *
 * 依赖 DrizzleDb + ToolRegistry + PathResolver + GrantRegistry。
 */
export class AppManagerImpl implements AppManager {
  /** 运行中的实例：instanceId → runtime + manifest */
  private runtimes = new Map<
    string,
    { runtime: AgentAppRuntime; manifest: AgentAppManifest; ctx: AppRuntimeContext }
  >()

  /** 事件订阅者：instanceId → Set<handler> */
  private subscribers = new Map<string, Set<(event: AppEvent) => void>>()

  /**
   * 主 Hono app 实例（由 startup 在 createApp 后注入）
   *
   * 用于 sub app 的动态路由挂载：sub app 通过 ctx.mountRouter 注册 HTTP 端点，
   * AppManager 在此代理到主 app 的 app.route(prefix, router)。
   *
   * 可选：未注入时 mountRouter 为 no-op，sub app 的 HTTP 路由不会生效。
   */
  private honoApp?: Hono

  /**
   * 内置应用 runtime factory 注册表
   *
   * 内置应用（如 social）由Backend直接注册factory。
   * key: appId, value: 创建 AgentAppRuntime 实例的工厂函数
   */
  private builtinRuntimes = new Map<string, () => AgentAppRuntime>()

  constructor(
    private db: DrizzleDb,
    private toolRegistry: ToolRegistry,
    private pathResolver: PathResolver,
    private applicationRealms: ApplicationRealmManager,
    private grantRegistry: GrantRegistry,
    /** 方案 B：独立编译所需依赖 */
    private llmService: LlmService,
    private mdpEngine: MdpEngine,
    private agentManager: AgentManager,
    /** 按角色获取表达模型，未指派时回退主模型。 */
    private getAgentModel?: (agentId: string) => Promise<ModelConfig | null>,
    /** 社交记忆整理使用的模型。 */
    private getSocialScorerModel?: () => Promise<ModelConfig | null>,
    /** 记忆存储注册表（社交 Scorer 使用，可选） */
    private storeRegistry?: MemoryStoreRegistry,
    /** 内置Social Realm收窄Port。 */
    private socialStorage?: SocialStoragePort,
    private socialEvents?: SocialEventPort,
    private kernelScheduler?: KernelScheduler,
    /** 入站路由表 Repository（社交路由使用，可选） */
    private inboundRouteRepo?: InboundRouteRepository,
    /** 配置仓库（读取社交绑定配置，可选） */
    private configRepo?: ConfigRepository,
    /** 内置 Social 可用的宿主日记只读端口。 */
    private hostDiaryReader?: HostDiaryReaderPort,
  ) {}

  private threadService?: ThreadService
  private flowStateService?: FlowStateService

  private hostCommunicator?: (input: {
    hostAgentId: string
    appId: string
    instanceId: string
    correlationId: string
    mode: string
    summary: string
    context?: Record<string, unknown>
  }) => Promise<Record<string, unknown>>

  private taskPorts?: {
    control: import('@infos/shared').SocialTaskControlPort
    registerDelivery: (port: import('@infos/shared').TaskDeliveryPort) => () => void
  }
  private statusCardPort?: import('@infos/shared').SocialStatusCardPort
  private resourcePort?: import('@infos/shared').SocialResourcePort
  private creativePort?: import('@infos/shared').ApplicationCreativePort
  private socialHostCapabilityFactory?: (
    realmId: string,
  ) => import('@infos/shared').SocialHostCapabilityPort
  setSocialHostCapabilityFactory(
    factory: NonNullable<AppManagerImpl['socialHostCapabilityFactory']>,
  ): void {
    this.socialHostCapabilityFactory = factory
  }
  setCreativePort(port: import('@infos/shared').ApplicationCreativePort): void {
    this.creativePort = port
  }
  setResourcePort(port: import('@infos/shared').SocialResourcePort): void {
    this.resourcePort = port
  }
  setStatusCardPort(port: import('@infos/shared').SocialStatusCardPort): void {
    this.statusCardPort = port
  }
  setTaskPorts(ports: NonNullable<AppManagerImpl['taskPorts']>): void {
    this.taskPorts = ports
  }

  setHostCommunicator(handler: NonNullable<AppManagerImpl['hostCommunicator']>): void {
    this.hostCommunicator = handler
  }

  /** 社交单实例可切换人格；委派、咨询和记忆回流都读取当前授权，不能沿用启动角色。 */
  private async personaFor(
    appId: string,
    instanceId: string,
    launchAgentId: string,
  ): Promise<string | undefined> {
    if (appId !== 'social') return launchAgentId
    const grants = await this.grantRegistry.queryGrants({ holderId: instanceId, activeOnly: true })
    const ids = new Set(
      grants.flatMap((grant) =>
        grant.resource.kind === 'persona' &&
        grant.permissions.includes('read') &&
        this.agentManager.getAgent(grant.resource.agentId)
          ? [grant.resource.agentId]
          : [],
      ),
    )
    return ids.size === 1 ? [...ids][0] : undefined
  }

  /** 注入需要 Thread 生命周期的会话状态服务，避免扩大应用管理器构造参数。 */
  setConversationStateServices(
    threadService: ThreadService,
    flowStateService: FlowStateService,
  ): void {
    this.threadService = threadService
    this.flowStateService = flowStateService
  }

  /**
   * 注入主 Hono app 实例（由 startup 在 createApp 后调用）
   *
   * sub app 通过 ctx.mountRouter 注册的 HTTP 路由会代理到此实例。
   * 必须在 launch 任何需要 HTTP 路由的 sub app 之前调用。
   */
  setHonoApp(app: Hono): void {
    this.honoApp = app
  }

  /**
   * 注册内置应用 runtime factory
   *
   * 内置应用（如 social）由Backend直接注册factory。
   * 这样在 dev 模式下无需编译 .ts → .js，生产环境也可用同一份代码。
   */
  registerBuiltinRuntime(appId: string, factory: () => AgentAppRuntime): void {
    this.builtinRuntimes.set(appId, factory)
    logger.info(__t('logs.applications', '内置应用 runtime 已注册: {0}', [appId]))
  }

  /**
   * 清理孤儿实例（启动时调用）
   *
   * 后端重启后，数据库里可能残留上次运行时的 launching/running/paused 状态实例，
   * 但对应的内存 runtime 已不存在（this.runtimes Map 是空的）。
   * 此方法将这些孤儿实例标记为 stopped，避免 autoLaunch 误判跳过。
   */
  async cleanupStaleInstances(): Promise<void> {
    // 查询所有"活跃"状态的实例（内存中已不存在 = 孤儿）
    const staleStatuses = ['launching', 'running', 'paused']
    const staleRows = await this.db
      .select({
        instanceId: appInstances.instanceId,
        appId: appInstances.appId,
        status: appInstances.status,
      })
      .from(appInstances)
      .where(inArray(appInstances.status, staleStatuses))
      .all()

    if (staleRows.length === 0) {
      return // 没有孤儿实例
    }

    logger.info(__t('logs.applications', '发现 {0} 个孤儿实例，正在清理...', [staleRows.length]))
    for (const row of staleRows) {
      logger.info(
        __t('logs.applications', '  清理孤儿实例: {0} (appId={1}, 旧状态={2})', [
          row.instanceId,
          row.appId,
          row.status,
        ]),
      )
      await this.db
        .update(appInstances)
        .set({ status: 'stopped', stoppedAt: new Date().toISOString() })
        .where(eq(appInstances.instanceId, row.instanceId))
    }
    logger.info(__t('logs.applications', '孤儿实例清理完成，共清理 {0} 个', [staleRows.length]))
  }

  // ── 应用安装管理 ──

  async install(appDir: string): Promise<{ appId: string; warnings: string[] }> {
    const warnings: string[] = []

    // 1. 读取 app.manifest.json
    const manifestPath = path.join(appDir, 'app.manifest.json')
    if (!existsSync(manifestPath)) {
      throw new Error(`应用清单文件不存在: ${manifestPath}`)
    }

    let manifest: AgentAppManifest
    try {
      const raw = readFileSync(manifestPath, 'utf-8')
      manifest = JSON.parse(raw) as AgentAppManifest
    } catch (err) {
      throw new Error(`应用清单解析失败: ${err}`)
    }

    if (['stronghold', 'infos.stronghold'].includes(manifest.id)) {
      throw new Error('STRONGHOLD_REALM_FORBIDDEN: Stronghold永久属于主应用内部模块')
    }
    if (!this.builtinRuntimes.has(manifest.id)) {
      throw new Error(`APPLICATION_RUNTIME_UNAVAILABLE: 未注册受信任运行时 ${manifest.id}`)
    }
    const normalizedDir = path.resolve(appDir)
    const trustedBuiltinDir = path.resolve(this.pathResolver.resolve(`@app/apps/${manifest.id}`))
    if (normalizedDir !== trustedBuiltinDir) {
      throw new Error(`APPLICATION_SOURCE_INVALID: ${normalizedDir}`)
    }

    // 2. 校验 Manifest 必填字段
    if (!manifest.id || !manifest.name || !manifest.version) {
      throw new Error('应用清单缺少必填字段: id/name/version')
    }

    // 3. 检查 minAiosVersion（简单版本检查）
    if (manifest.minAiosVersion) {
      // TODO: 实现语义化版本比较，当前仅记录警告
      warnings.push(`minAiosVersion=${manifest.minAiosVersion} 校验待实现`)
    }

    // 4. 校验 requiredPermissions 格式
    if (!manifest.requiredPermissions || manifest.requiredPermissions.length === 0) {
      warnings.push(`应用 ${manifest.id} 未声明任何权限`)
    }

    // 5. 写入数据库（upsert）
    const now = new Date().toISOString()
    const existing = await this.db
      .select()
      .from(appRegistry)
      .where(eq(appRegistry.appId, manifest.id))

    if (existing.length > 0) {
      // 更新
      await this.db
        .update(appRegistry)
        .set({
          name: manifest.name,
          version: manifest.version,
          installPath: path.resolve(appDir),
          manifestJson: JSON.stringify(manifest),
          updatedAt: now,
        })
        .where(eq(appRegistry.appId, manifest.id))
      logger.info(__t('logs.applications', '应用已更新: {0} v{1}', [manifest.id, manifest.version]))
    } else {
      // 新增
      await this.db.insert(appRegistry).values({
        appId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        installPath: path.resolve(appDir),
        manifestJson: JSON.stringify(manifest),
        installedAt: now,
        updatedAt: now,
      })
      logger.info(__t('logs.applications', '应用已安装: {0} v{1}', [manifest.id, manifest.version]))
    }

    return { appId: manifest.id, warnings }
  }

  async uninstall(appId: string, _opts?: { deleteFiles?: boolean }): Promise<boolean> {
    // 检查是否有运行中的实例
    const runningInstances = await this.db
      .select()
      .from(appInstances)
      .where(and(eq(appInstances.appId, appId), eq(appInstances.status, 'running')))

    if (runningInstances.length > 0) {
      throw new Error(`应用 ${appId} 有运行中的实例，无法卸载`)
    }

    // 删除注册记录
    const result = await this.db
      .delete(appRegistry)
      .where(eq(appRegistry.appId, appId))
      .returning({ id: appRegistry.appId })

    // TODO: 如果 opts?.deleteFiles，删除应用文件目录
    // 目前仅删除注册信息，保留文件

    if (result.length > 0) {
      logger.info(__t('logs.applications', '应用已卸载: {0}', [appId]))
      return true
    }
    return false
  }

  async listInstalled(): Promise<Array<AgentAppManifest & { installPath: string }>> {
    const rows = await this.db.select().from(appRegistry)
    return rows.map((row) => {
      const manifest = JSON.parse(row.manifestJson) as AgentAppManifest
      return { ...manifest, installPath: row.installPath }
    })
  }

  async getManifest(appId: string): Promise<AgentAppManifest | undefined> {
    const rows = await this.db.select().from(appRegistry).where(eq(appRegistry.appId, appId))
    if (rows.length === 0) return undefined
    return JSON.parse(rows[0]!.manifestJson) as AgentAppManifest
  }

  // ── 应用实例管理 ──

  async launch(params: LaunchAppParams): Promise<string> {
    const { appId, hostAgentId } = params
    if (['stronghold', 'infos.stronghold'].includes(appId)) {
      throw new Error('STRONGHOLD_REALM_FORBIDDEN: Stronghold永久属于主应用内部模块')
    }
    if (!this.builtinRuntimes.has(appId)) {
      throw new Error(`APPLICATION_RUNTIME_UNAVAILABLE: 未注册受信任运行时 ${appId}`)
    }

    // 1. 获取 Manifest
    const manifest = await this.getManifest(appId)
    if (!manifest) {
      throw new Error(`应用未安装: ${appId}`)
    }

    // 2. 校验 supportedAgentRoles
    if (
      manifest.supportedAgentRoles &&
      manifest.supportedAgentRoles.length > 0 &&
      !manifest.supportedAgentRoles.includes(hostAgentId)
    ) {
      throw new Error(
        `应用 ${appId} 不支持 Agent: ${hostAgentId}（仅支持 ${manifest.supportedAgentRoles.join(', ')}）`,
      )
    }

    // 3. 校验工作区模式
    if (manifest.workspaceMode === 'dynamic' && !params.workspacePath) {
      throw new Error(`应用 ${appId} 需要 dynamic 工作区，必须提供 workspacePath`)
    }

    // 4. 确定工作区路径
    let workspacePath: string | undefined
    if (manifest.workspaceMode === 'dynamic') {
      workspacePath = params.workspacePath
    } else if (manifest.workspaceMode === 'fixed') {
      // 固定工作区：@data/apps/{appId}/
      workspacePath = this.pathResolver.resolve(`@data/apps/${appId}`)
    }
    // none 模式：workspacePath = undefined

    // 5. 创建实例记录
    const instanceId = randomUUID()
    const now = new Date().toISOString()
    await this.db.insert(appInstances).values({
      instanceId,
      appId,
      hostAgentId,
      status: 'launching',
      workspacePath: workspacePath ?? null,
      taskContextJson: params.taskContext ? JSON.stringify(params.taskContext) : null,
      launchedBy: params.launchedBy,
      launchedAt: now,
      stoppedAt: null,
      error: null,
    })

    let realm: ApplicationRealm | undefined
    try {
      // 6.记录应用工具声明；具体Handler由内置Realm Runtime初始化时注册。
      if (manifest.providesTools) {
        for (const tool of manifest.providesTools) {
          logger.debug(__t('logs.applications', '应用工具声明: {0}.{1}', [appId, tool.name]))
        }
      }

      // 7.加载受信任的Builtin Realm Runtime；禁止从安装目录动态import代码。
      let runtime: AgentAppRuntime | undefined
      if (this.builtinRuntimes.has(appId)) {
        try {
          runtime = this.builtinRuntimes.get(appId)!()
          logger.info(__t('logs.applications', '系统应用运行时已加载: {0}', [appId]))
        } catch (err) {
          logger.warn(__t('logs.applications', '系统应用运行时加载失败: {0}, {1}', [appId, err]))
        }
      }

      realm = this.applicationRealms.register({
        realmId: `${appId}:${instanceId}`,
        appId,
        principalId: `application:${appId}`,
        instanceId,
      })
      // 8.构造运行时上下文
      const appLogger = createAppLogger(appId, instanceId)
      const ctx: AppRuntimeContext = {
        instanceId,
        appId,
        hostAgentId,
        manifest,
        realm,
        workspacePath,
        taskContext: params.taskContext,
        grantRegistry: this.grantRegistry,
        emitEvent: (event) => this.emitEvent(instanceId, event),
        communicateWithHost: async (request) => {
          if (!this.hostCommunicator) {
            return { decision: 'host_unavailable', reason: '宿主通信服务尚未初始化' }
          }
          const currentAgentId = await this.personaFor(appId, instanceId, hostAgentId)
          if (!currentAgentId) throw new Error('SOCIAL_PERSONA_BINDING_INVALID')
          return this.hostCommunicator({
            hostAgentId: currentAgentId,
            appId,
            instanceId,
            correlationId: request.correlationId,
            mode: request.mode,
            summary: request.summary,
            context: request.context,
          })
        },
        logger: appLogger,
        requestApproval: async (action, reason) => {
          appLogger.warn(`应用审批被拒绝: action=${action}, reason=${reason}`)
          return false
        },
        // 方案 B：独立编译所需依赖
        llmService: this.llmService,
        mdpEngine: this.mdpEngine,
        agentManager: this.agentManager,
        threadService: this.threadService!,
        resources: appId === 'social' ? this.resourcePort : undefined,
        hostCapabilities:
          appId === 'social'
            ? this.socialHostCapabilityFactory?.(realm.descriptor.realmId)
            : undefined,
        creative: appId === 'social' ? this.creativePort : undefined,
        flowStateService: this.flowStateService!,
        getAgentModel: this.getAgentModel,
        getSocialScorerModel: this.getSocialScorerModel,
        // 社交应用等需要直接访问内核资源的可选依赖
        socialStorage: this.socialStorage,
        socialEvents: this.socialEvents,
        taskControl: appId === 'social' ? this.taskPorts?.control : undefined,
        statusCards: appId === 'social' ? this.statusCardPort : undefined,
        registerTaskDelivery: appId === 'social' ? this.taskPorts?.registerDelivery : undefined,
        registerSocialTransport: appId === 'social' ? registerSocialTransport : undefined,
        socialExecutions: this.kernelScheduler
          ? {
              run: async <T>(input: {
                taskId: string
                class: 'background' | 'resident'
                priority?: number
                resourceKey?: string
                maxDurationMs: number
                signal?: AbortSignal
                run(context: {
                  signal: AbortSignal
                  executionId: string
                  processId: string
                  consume(usage: {
                    llmCalls?: number
                    inputTokens?: number
                    outputTokens?: number
                    toolCalls?: number
                  }): void
                  beginIo(): () => void
                }): Promise<T>
              }) => {
                let output: T | undefined
                let failure: unknown
                input.signal?.throwIfAborted()
                const snapshot = await this.kernelScheduler!.submit({
                  principalId: hostAgentId,
                  taskId: `app:${appId}:${instanceId}:${input.taskId}`,
                  class: input.class,
                  priority: input.priority ?? 3,
                  resourceKey: input.resourceKey ?? `app-instance:${instanceId}`,
                  budget: {
                    maxDurationMs: input.maxDurationMs,
                    maxLlmCalls: 32,
                    maxToolCalls: 64,
                    maxConcurrentIo: 8,
                  },
                  run: async (scheduled) => {
                    try {
                      output = await input.run({
                        signal: scheduled.signal,
                        executionId: scheduled.descriptor.executionId,
                        processId: scheduled.descriptor.processId,
                        consume: scheduled.consume,
                        beginIo: scheduled.beginIo,
                      })
                    } catch (error) {
                      failure = error
                      throw error
                    }
                  },
                })
                const abort = () => {
                  void this.kernelScheduler!.cancel(snapshot.descriptor.executionId).catch(
                    (error) =>
                      logger.warn(
                        __t('logs.applications', '社交执行取消失败: {0}', [String(error)]),
                      ),
                  )
                }
                input.signal?.addEventListener('abort', abort, { once: true })
                if (input.signal?.aborted) abort()
                const terminal = await this.kernelScheduler!.waitForTerminal(
                  snapshot.descriptor.executionId,
                ).finally(() => input.signal?.removeEventListener('abort', abort))
                if (terminal.state !== 'completed') {
                  if (failure !== undefined) throw failure
                  input.signal?.throwIfAborted()
                  throw new Error(`SOCIAL_EXECUTION_${terminal.state.toUpperCase()}`)
                }
                return output as T
              },
            }
          : undefined,
        storeRegistry: this.storeRegistry,
        pathResolver: this.pathResolver,
        inboundRouteRepo: this.inboundRouteRepo,
        configRepo: this.configRepo,
        hostDiaryReader: appId === 'social' ? this.hostDiaryReader : undefined,
        // 动态路由挂载：sub app 通过此方法注册 HTTP 端点到主 app
        // 代理到主 Hono 实例的 app.route(prefix, router)
        mountRouter: (prefix: string, router: Hono) => {
          if (!this.honoApp) {
            appLogger.warn(
              `mountRouter 调用时主 app 未注入，路由 ${prefix} 未挂载（请检查 startup 调用顺序）`,
            )
            return
          }
          this.honoApp.route(prefix, router)
          appLogger.info(`sub app 路由已挂载: ${prefix}`)
        },
      }

      // 9. 初始化运行时
      if (!runtime) {
        throw new Error(`应用运行时加载失败: appId=${appId}（未注册受信任内置Runtime）`)
      }
      const result = await runtime.initialize(ctx)
      if (!result.success) {
        throw new Error(`应用初始化失败: ${result.error ?? '未知错误'}`)
      }
      this.runtimes.set(instanceId, { runtime, manifest, ctx })

      // 10. 更新状态为 running
      await this.db
        .update(appInstances)
        .set({ status: 'running' })
        .where(eq(appInstances.instanceId, instanceId))

      logger.info(
        __t('logs.applications', '应用实例已启动: appId={0}, instanceId={1}, hostAgent={2}', [
          appId,
          instanceId,
          hostAgentId,
        ]),
      )
      return instanceId
    } catch (err) {
      await realm
        ?.dispose()
        .catch((error) =>
          logger.warn(
            __t('logs.applications', '释放启动失败的Application Realm失败: {0}', [error]),
          ),
        )
      //启动失败：更新状态为error
      await this.db
        .update(appInstances)
        .set({ status: 'error', error: String(err) })
        .where(eq(appInstances.instanceId, instanceId))
      throw err
    }
  }

  async pause(instanceId: string): Promise<boolean> {
    const entry = this.runtimes.get(instanceId)
    if (!entry) {
      logger.warn(__t('logs.applications', '暂停失败：实例未运行或无 runtime: {0}', [instanceId]))
      return false
    }

    try {
      await entry.runtime.onPause()
      await this.db
        .update(appInstances)
        .set({ status: 'paused' })
        .where(eq(appInstances.instanceId, instanceId))
      logger.info(__t('logs.applications', '应用实例已暂停: {0}', [instanceId]))
      return true
    } catch (err) {
      logger.error(__t('logs.applications', '暂停应用实例失败: {0}, {1}', [instanceId, err]))
      return false
    }
  }

  async resume(instanceId: string): Promise<boolean> {
    const entry = this.runtimes.get(instanceId)
    if (!entry) {
      logger.warn(__t('logs.applications', '恢复失败：实例未运行或无 runtime: {0}', [instanceId]))
      return false
    }

    try {
      await entry.runtime.onResume()
      await this.db
        .update(appInstances)
        .set({ status: 'running' })
        .where(eq(appInstances.instanceId, instanceId))
      logger.info(__t('logs.applications', '应用实例已恢复: {0}', [instanceId]))
      return true
    } catch (err) {
      logger.error(__t('logs.applications', '恢复应用实例失败: {0}, {1}', [instanceId, err]))
      return false
    }
  }

  async stop(instanceId: string): Promise<boolean> {
    const entry = this.runtimes.get(instanceId)
    const now = new Date().toISOString()

    try {
      // 1. 通知应用保存状态（生成 Checkpoint）
      if (entry) {
        const checkpoint = await entry.runtime.onStop()
        if (checkpoint) {
          await this.saveCheckpoint(instanceId, checkpoint)
        }
      }

      // 2. 撤销所有 GrantRegistry 授权
      await this.grantRegistry.revokeByHolder(instanceId)

      // 3. 注销应用工具（清理 ToolRegistry 中的应用工具）
      if (entry) {
        this.toolRegistry.unregisterAppTools(entry.manifest.id)
        await entry.ctx.realm.dispose()
      }

      // 4. 更新状态为 stopped
      await this.db
        .update(appInstances)
        .set({ status: 'stopped', stoppedAt: now })
        .where(eq(appInstances.instanceId, instanceId))

      // 5. 清理运行时引用
      this.runtimes.delete(instanceId)

      // 6. 清理事件订阅者
      this.subscribers.delete(instanceId)

      logger.info(__t('logs.applications', '应用实例已停止: {0}', [instanceId]))
      return true
    } catch (err) {
      await entry?.ctx.realm
        .dispose()
        .catch((error) =>
          logger.warn(
            __t('logs.applications', '释放异常停止的Application Realm失败: {0}', [error]),
          ),
        )
      logger.error(__t('logs.applications', '停止应用实例失败: {0}, {1}', [instanceId, err]))
      // 即使失败也标记为 stopped
      await this.db
        .update(appInstances)
        .set({ status: 'stopped', stoppedAt: now, error: String(err) })
        .where(eq(appInstances.instanceId, instanceId))
      this.runtimes.delete(instanceId)
      this.subscribers.delete(instanceId)
      return false
    }
  }

  async getInstance(instanceId: string): Promise<AppInstance | undefined> {
    const rows = await this.db
      .select()
      .from(appInstances)
      .where(eq(appInstances.instanceId, instanceId))
    if (rows.length === 0) return undefined
    return rowToInstance(rows[0]!)
  }

  async shutdown(): Promise<void> {
    const instanceIds = [...this.runtimes.keys()]
    for (const instanceId of instanceIds.reverse()) {
      try {
        await this.stop(instanceId)
      } catch (error) {
        logger.error(
          __t('logs.applications', '停止Application Realm实例失败: instanceId={0}, error={1}', [
            instanceId,
            error,
          ]),
        )
      }
    }
    this.subscribers.clear()
    logger.info(
      __t('logs.applications', 'Application Realm宿主已停止，共关闭{0}个实例', [
        instanceIds.length,
      ]),
    )
  }

  async listInstances(params: {
    hostAgentId?: string
    appId?: string
    status?: AppInstallStatus
  }): Promise<AppInstance[]> {
    const conditions = []
    if (params.hostAgentId) {
      conditions.push(eq(appInstances.hostAgentId, params.hostAgentId))
    }
    if (params.appId) {
      conditions.push(eq(appInstances.appId, params.appId))
    }
    if (params.status) {
      conditions.push(eq(appInstances.status, params.status))
    }

    const query =
      conditions.length > 0
        ? this.db
            .select()
            .from(appInstances)
            .where(and(...conditions))
        : this.db.select().from(appInstances)

    const rows = await query
    return rows.map(rowToInstance)
  }

  async executeCommand(params: {
    correlationId?: string
    execution?: import('@infos/shared').KernelExecutionDescriptor
    appId: string
    hostAgentId: string
    action: string
    input: Record<string, unknown>
    taskContext?: AppTaskContext
    communicationBudget?: number
    signal?: AbortSignal
  }): Promise<AppCommandResult> {
    const manifest = await this.getManifest(params.appId)
    if (!manifest) throw new Error(`应用未安装: ${params.appId}`)
    const action = manifest.actions?.find((item) => item.name === params.action)
    if (!action || (action.mode !== 'command' && action.mode !== 'both')) {
      throw new Error(`应用 ${params.appId} 未声明一次性动作: ${params.action}`)
    }
    const candidates = [...this.runtimes.entries()].filter(
      ([, entry]) => entry.manifest.id === params.appId,
    )
    let instance: (typeof candidates)[number] | undefined
    for (const candidate of candidates) {
      // 查询和取消按原任务主体校验，不需要唤醒或借用应用当前人格。
      const taskControl =
        params.appId === 'social' && ['get_task', 'cancel_task'].includes(params.action)
      if (
        !taskControl &&
        (await this.personaFor(params.appId, candidate[0], candidate[1].ctx.hostAgentId)) !==
          params.hostAgentId
      )
        continue
      instance = candidate
      break
    }
    if (!instance) throw new Error(`应用未运行: ${params.appId}`)
    const [instanceId, entry] = instance
    if (!entry.runtime.executeCommand) throw new Error(`应用不支持主 Agent 委派: ${params.appId}`)
    const invoke = async (
      execution?: import('@infos/shared').KernelExecutionDescriptor,
      signal?: AbortSignal,
    ): Promise<AppCommandResult> => {
      params.signal?.throwIfAborted()
      const request: AppCommandRequest = {
        agentId: params.hostAgentId,
        correlationId: params.correlationId ?? execution?.executionId ?? crypto.randomUUID(),
        executionId: execution?.executionId,
        processId: execution?.processId,
        action: params.action,
        input: params.input,
        taskContext: params.taskContext,
        communicationBudget: params.communicationBudget ?? action.defaultCommunicationBudget ?? 8,
        signal:
          signal && params.signal
            ? AbortSignal.any([signal, params.signal])
            : (signal ?? params.signal),
      }
      logger.info(
        __t(
          'logs.applications',
          '执行应用命令: app={0}, instance={1}, action={2}, correlation={3}',
          [params.appId, instanceId, params.action, request.correlationId],
        ),
      )
      return entry.runtime.executeCommand!(request)
    }
    if (params.execution) return invoke(params.execution, params.signal)
    if (!this.kernelScheduler) return invoke()
    let result: AppCommandResult | undefined
    const terminal = await this.kernelScheduler.submitAndWait({
      principalId: params.hostAgentId,
      taskId: `app-command:${params.appId}:${params.action}`,
      class: 'foreground',
      priority: 7,
      resourceKey: `app-instance:${instanceId}`,
      budget: { maxDurationMs: 10 * 60_000, maxLlmCalls: 24, maxToolCalls: 64, maxConcurrentIo: 8 },
      run: async ({ descriptor, signal }) => {
        result = await invoke(descriptor, signal)
        if (result.status === 'failed' && !['get_task', 'cancel_task'].includes(params.action))
          throw new Error(result.error ?? result.summary)
      },
    })
    if (!result) throw new Error(`应用命令未返回结果: ${terminal.state}`)
    return result
  }

  // ── 检查点与事件 ──

  async getCheckpoint(instanceId: string): Promise<AppCheckpoint | undefined> {
    // 优先从运行时获取最新检查点
    const entry = this.runtimes.get(instanceId)
    if (entry) {
      const liveCheckpoint = entry.runtime.getCheckpoint()
      if (liveCheckpoint) return liveCheckpoint
    }

    // 回退到数据库
    const rows = await this.db
      .select()
      .from(appCheckpoints)
      .where(eq(appCheckpoints.instanceId, instanceId))
    if (rows.length === 0) return undefined
    return rowToCheckpoint(rows[0]!)
  }

  subscribe(instanceId: string, handler: (event: AppEvent) => void): () => void {
    let subs = this.subscribers.get(instanceId)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(instanceId, subs)
    }
    subs.add(handler)
    return () => subs!.delete(handler)
  }

  /** 配置通知只通过运行时协议传递，宿主不直接修改子应用内部字段。 */
  async notifyConfigChanged(keys: readonly string[]): Promise<void> {
    for (const entry of this.runtimes.values()) {
      await entry.runtime.onConfigChanged?.(keys)
    }
  }

  // ── 记忆回流 ──

  async collectDailySummaries(hostAgentId: string, date: string): Promise<string[]> {
    const allSummaries: string[] = []

    // 遍历所有运行中的实例（通过 runtimes Map，已过滤 stopped 实例）
    for (const [instanceId, entry] of this.runtimes) {
      // 仅收集指定主 Agent 下的应用
      if (
        (await this.personaFor(entry.manifest.id, instanceId, entry.ctx.hostAgentId)) !==
        hostAgentId
      )
        continue

      // 应用未实现 getDailySummaries 时跳过
      const runtime = entry.runtime
      if (!runtime.getDailySummaries) continue

      try {
        const summaries = await runtime.getDailySummaries(date)
        if (summaries.length > 0) {
          allSummaries.push(...summaries)
          logger.debug(
            __t('logs.applications', '应用 {0} (instance={1}) ', [
              entry.manifest.id,
              instanceId.slice(0, 8),
            ]) + __t('logs.applications', '贡献 {0} 条当日记忆摘要', [summaries.length]),
          )
        }
      } catch (err) {
        // 单个应用异常不影响其他应用
        logger.warn(
          __t('logs.applications', '应用 {0} (instance={1}) ', [
            entry.manifest.id,
            instanceId.slice(0, 8),
          ]) + __t('logs.applications', '获取当日记忆摘要失败: {0}', [err]),
        )
      }
    }

    return allSummaries
  }

  // ── 内部方法 ──

  /** 内部事件发射（转发给订阅者） */
  private emitEvent(instanceId: string, event: AppEvent): void {
    const subs = this.subscribers.get(instanceId)
    if (!subs) return
    for (const handler of subs) {
      try {
        handler(event)
      } catch (err) {
        logger.warn(
          __t('logs.applications', '事件处理器异常: instanceId={0}, {1}', [instanceId, err]),
        )
      }
    }
  }

  /** 保存检查点到数据库 */
  private async saveCheckpoint(instanceId: string, checkpoint: AppCheckpoint): Promise<void> {
    const now = checkpoint.updatedAt
    // upsert（实例只有一个检查点）
    const existing = await this.db
      .select()
      .from(appCheckpoints)
      .where(eq(appCheckpoints.instanceId, instanceId))

    const values = {
      instanceId,
      status: checkpoint.status,
      summary: checkpoint.summary,
      progress: checkpoint.progress,
      fieldsJson: JSON.stringify(checkpoint.fields),
      changedArtifactsJson: JSON.stringify(checkpoint.changedArtifacts),
      blockersJson: JSON.stringify(checkpoint.blockers),
      nextActionsJson: JSON.stringify(checkpoint.nextActions),
      updatedAt: now,
    }

    if (existing.length > 0) {
      await this.db
        .update(appCheckpoints)
        .set(values)
        .where(eq(appCheckpoints.instanceId, instanceId))
    } else {
      await this.db.insert(appCheckpoints).values(values)
    }
  }
}

// ─────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────

/** 创建应用日志器（加 appId 前缀） */
function createAppLogger(appId: string, instanceId: string): AppLogger {
  const inner = createLogger(`App:${appId}:${instanceId.slice(0, 8)}`)
  return {
    info: (msg, meta) => inner.info(msg, meta),
    warn: (msg, meta) => inner.warn(msg, meta),
    error: (msg, meta) => inner.error(msg, meta),
    debug: (msg, meta) => inner.debug(msg, meta),
  }
}

/** DB 行 → AppInstance 领域对象 */
type AppInstanceRow = typeof appInstances.$inferSelect

function rowToInstance(row: AppInstanceRow): AppInstance {
  let taskContext: AppTaskContext | undefined
  if (row.taskContextJson) {
    try {
      taskContext = JSON.parse(row.taskContextJson) as AppTaskContext
    } catch {
      // JSON 解析失败，忽略
    }
  }
  return {
    instanceId: row.instanceId,
    appId: row.appId,
    hostAgentId: row.hostAgentId,
    status: (row.status ?? 'stopped') as AppInstallStatus,
    launchedAt: row.launchedAt ?? new Date().toISOString(),
    workspacePath: row.workspacePath ?? undefined,
    taskContext,
    error: row.error ?? undefined,
  }
}

/** DB 行 → AppCheckpoint 领域对象 */
type AppCheckpointRow = typeof appCheckpoints.$inferSelect

function rowToCheckpoint(row: AppCheckpointRow): AppCheckpoint {
  const parseArray = (json: string | null): string[] => {
    if (!json) return []
    try {
      const arr = JSON.parse(json)
      return Array.isArray(arr) ? arr : []
    } catch {
      return []
    }
  }
  let fields: Record<string, unknown> = {}
  try {
    fields = JSON.parse(row.fieldsJson)
  } catch {
    // 解析失败用空对象
  }
  return {
    instanceId: row.instanceId,
    appId: '', // 检查点表不存 appId，由调用方补充
    status: row.status as 'running' | 'waiting' | 'completed' | 'failed',
    summary: row.summary,
    progress: row.progress ?? 0,
    fields,
    changedArtifacts: parseArray(row.changedArtifactsJson),
    blockers: parseArray(row.blockersJson),
    nextActions: parseArray(row.nextActionsJson),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
  }
}
