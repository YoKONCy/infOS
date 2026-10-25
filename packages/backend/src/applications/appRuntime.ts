/**
 * AgentAppRuntime — 应用运行时接口
 *
 * 内置Social兼容Runtime通过实现此接口接入 AIOS。
 * 自治Application必须通过Application Integration Protocol接入。
 *
 * 设计原则：
 * - 应用自带工具 + 可申请主 Agent 工具
 * - 应用内会话独立于主 Thread（不复用 ThreadService）
 * - 应用有自己的事件流，主 Agent 订阅应用事件走统一 EventBus
 * - 应用编译上下文时统一查询 GrantRegistry 授权（批量高效）
 *
 * @module packages/backend/src/applications/appRuntime
 */

import type { ApplicationRealm } from './applicationRealm'
import type {
  AgentAppManifest,
  AppCheckpoint,
  AppEvent,
  AppSessionPolicy,
  AppCommandRequest,
  AppCommandResult,
} from './types'
import type { GrantRegistry } from './grantRegistry'
import type { LlmService, ModelConfig } from '../services/llm/llmService'
import type { MdpEngine } from '../services/prompt/mdpEngine'
import type { AgentManager } from '../services/agent/agentManager'
import type { SocialEventPort, SocialExecutionPort, SocialStoragePort } from './socialPorts'
import type { SocialWebSocketAdapterPort } from './socialWsBridge'

// ─────────────────────────────────────────────
// 应用运行时上下文
// ─────────────────────────────────────────────

export interface HostDiaryReaderPort {
  list(agentId: string, limit: number): Promise<Array<{ date: string; parts: number }>>
  read(
    agentId: string,
    date?: string,
  ): Promise<{
    date: string
    parts: number
    content: string
    truncated: boolean
  } | null>
}

/**
 * 应用运行时上下文
 *
 * AIOS 在 launch 时注入给应用，应用通过此上下文访问 AIOS 资源。
 * 应用通过 grantRegistry 查询自己的授权，然后从各资源服务读取实际内容。
 *
 * 方案 B（独立编译）所需依赖：
 * - llmService：应用自己的 Compiler 编译后调用 LLM
 * - mdpEngine：复用主 Agent 的模板渲染引擎（纯渲染器，无状态）
 * - agentManager：读取主 Agent 人格投影（受 GrantRegistry 授权约束）
 * - storeRegistry：访问应用自己的记忆图谱（如 social.tdb），不访问主 Agent 的 RAG
 *
 * AIOS 资源隔离原则：
 * - 应用不直接读取主 Agent 的 EventMemory 或自动 RAG
 * - 应用通过 getDailySummaries 向 DailyNotesService 提供当日摘要
 * - memoryProvider 字段仅供应用私有记忆访问（非 Compiler 直接检索）
 */
export interface AppRuntimeContext {
  hostCapabilities?: import('@infos/shared').SocialHostCapabilityPort
  resources?: import('@infos/shared').SocialResourcePort
  creative?: import('@infos/shared').ApplicationCreativePort
  /** 受信任社交应用的状态卡片输出口；仅采集与渲染，不唤醒主 Agent。 */
  statusCards?: import('@infos/shared').SocialStatusCardPort
  /** 任务领域接口仅签发给受信任的内置社交应用。 */
  taskControl?: import('@infos/shared').SocialTaskControlPort
  registerTaskDelivery?: (port: import('@infos/shared').TaskDeliveryPort) => () => void
  /** 实例 ID */
  instanceId: string
  /** 应用 ID */
  appId: string
  /** 主 Agent ID */
  hostAgentId: string
  /** 应用 Manifest */
  manifest: AgentAppManifest
  /** Kernel签发的隔离Application Realm。 */
  realm: ApplicationRealm
  /** 工作区路径（dynamic/fixed 模式有值，none 模式为 undefined） */
  workspacePath?: string
  /** 任务上下文（主 Agent 委派时提供） */
  taskContext?: {
    description: string
    inputs: string[]
    successCriteria: string
    deadline?: string
  }
  /** 授权注册表（应用查询自己的授权） */
  grantRegistry: GrantRegistry
  /** 事件发射器（应用向外部发布事件，由 AppManager 转发到统一 EventBus） */
  emitEvent(event: AppEvent): void
  /** 向宿主 Agent 发起临时通信；请求与回复不写入主 Thread。 */
  communicateWithHost(request: {
    correlationId: string
    mode: 'consult' | 'verify' | 'approval' | 'request_resource' | 'report' | 'clarify' | 'complete'
    summary: string
    context?: Record<string, unknown>
  }): Promise<Record<string, unknown>>
  /** 日志器 */
  logger: AppLogger
  /** 请求主 Agent 审批（requiresApproval 工具调用时使用） */
  requestApproval(action: string, reason: string): Promise<boolean>

  // ── Builtin Compatibility Ports ──
  // 仅受信任的内置Social Realm在迁移期使用；社区Application不得获得这些Kernel Service。
  // 后续必须按Social真实需求逐项收敛为领域Port，不得向该区域添加新依赖。

  /** LLM 服务（应用 Compiler 编译后调用 LLM 生成回复） */
  llmService: LlmService
  /** MDP 模板引擎（复用主 Agent 的模板渲染，纯渲染器无状态） */
  mdpEngine: MdpEngine
  /** Thread 服务：需要持久会话状态的应用按 Channel 建立真实 Thread。 */
  threadService: import('../services/thread/threadService').ThreadService
  /** 心流服务：应用 Compiler 只读取当前 Thread × Agent 的私有临时状态。 */
  flowStateService: import('../services/flow/flowStateService').FlowStateService
  /** Agent 管理器（读取主 Agent 人格投影，受 GrantRegistry 授权约束） */
  agentManager: AgentManager
  /** 按角色获取表达模型，未指派时回退主模型。 */
  getAgentModel?: (agentId: string) => Promise<ModelConfig | null>
  /** 社交记忆整理使用的模型。 */
  getSocialScorerModel?: () => Promise<ModelConfig | null>

  // ── 社交应用等需要直接访问内核资源的可选依赖 ──

  /** 内置Social Realm的收窄领域Port；社区应用不会获得。 */
  socialStorage?: SocialStoragePort
  socialEvents?: SocialEventPort
  socialExecutions?: SocialExecutionPort
  /** 宿主签发的社交传输入口；返回该次注册的释放函数，跨 bundle 共享宿主权威。 */
  registerSocialTransport?: (adapter: SocialWebSocketAdapterPort, platform?: string) => () => void
  /** 只允许读取宿主 Agent 的 Workspace 日记，不暴露通用文件系统能力。 */
  hostDiaryReader?: HostDiaryReaderPort
  /**
   * 记忆存储注册表（访问应用自己的记忆图谱，如 social.tdb）
   *
   * AIOS 隔离：每个 Agent 有独立的 store（data/agent_{agentId}/{mode}.tdb），
   * 应用通过此注册表访问自己被授权的 store，不越界访问主 Agent 的 main.tdb。
   */
  storeRegistry?: import('../repositories/storeRegistry').MemoryStoreRegistry
  /** 路径解析器（社交图片缓存目录等使用） */
  pathResolver?: import('../core/pathResolver').PathResolver
  /** 入站路由表 Repository（社交路由使用） */
  inboundRouteRepo?: import('../repositories/inboundRoute.repo').InboundRouteRepository
  /** 配置仓库（读取社交绑定配置） */
  configRepo?: import('../repositories/config.repo').ConfigRepository

  // ── 动态路由挂载（sub app HTTP 端点注册） ──

  /**
   * 动态挂载 HTTP 路由到主 app
   *
   * sub app 在 initialize() 中调用此方法，将自己的 HTTP 路由注册到主 app。
   * AppManager 会将此调用代理到主 Hono 实例的 app.route(prefix, router)。
   *
   * 这是 AIOS sub app 路由动态挂载机制的标准入口：
   * - sub app 不直接接触主 app 实例（隔离原则）
   * - 路由前缀必须以 /api/ 开头，建议使用 /api/{appId} 命名空间
   * - 重复挂载同一前缀会覆盖，sub app 应避免在多次 initialize 中重复挂载
   *
   * @param prefix 路由前缀，如 '/api/social'
   * @param router Hono 路由实例
   */
  mountRouter?: (prefix: string, router: import('hono').Hono) => void
}

/**
 * 应用日志器接口
 *
 * 复用主 Agent 的日志系统，但加 appId 前缀。
 */
export interface AppLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  debug(msg: string, meta?: Record<string, unknown>): void
}

// ─────────────────────────────────────────────
// 应用运行时接口
// ─────────────────────────────────────────────

/**
 * AgentAppRuntime — 应用运行时接口
 *
 * 应用实现此接口，AIOS 在生命周期各阶段调用对应方法。
 *
 * 生命周期：
 *   launch → initialize() → running
 *   pause  → onPause()    → paused
 *   resume → onResume()   → running
 *   stop   → onStop()     → stopped
 */
export interface AgentAppRuntime {
  /**
   * 初始化（launch 时调用）
   *
   * 应用在此：
   * - 初始化内部状态
   * - 创建默认会话（如果 supportsMultipleSessions=false）
   * - 注册应用工具（通过 ToolRegistry，由 AppManager 转发）
   *
   * @returns 初始化结果（success=false 时 AppManager 将状态置为 error）
   */
  initialize(ctx: AppRuntimeContext): Promise<{ success: boolean; error?: string }>

  /**
   * 暂停（pause 时调用）
   *
   * 应用在此保存当前状态，停止内部 agent 会话。
   */
  onPause(): Promise<void>

  /**
   * 恢复（resume 时调用）
   *
   * 应用恢复运行。
   */
  onResume(): Promise<void>

  /**
   * 停止（stop 时调用）
   *
   * 应用在此：
   * - 生成最终 Checkpoint
   * - 清理资源
   * - 保存状态
   *
   * @returns 最终检查点（主 Agent 读取此结果）
   */
  onStop(): Promise<AppCheckpoint | undefined>

  /** 宿主配置保存后通知仍存活的应用，由应用自行更新内部状态。 */
  onConfigChanged?(keys: readonly string[]): Promise<void>

  /**
   * 获取当前检查点
   *
   * 主 Agent 随时调用此方法读取应用状态。
   * 应用应维护最新的检查点，此处直接返回缓存值。
   */
  getCheckpoint(): AppCheckpoint | undefined

  // ── 会话管理（仅 supportsMultipleSessions=true 时）──

  /**
   * 创建应用内会话
   *
   * 应用内会话独立于主 Thread，由应用自己管理。
   * 主 Agent 和用户都可创建。
   *
   * @returns 会话 ID
   */
  createSession(params?: { title?: string; policy?: AppSessionPolicy }): Promise<string>

  /** 列出应用内会话 */
  listSessions(): Promise<Array<{ id: string; title: string; status: string }>>

  /** 关闭应用内会话 */
  closeSession(sessionId: string): Promise<boolean>

  /**
   * 向应用内会话发送消息
   *
   * 用户或主 Agent 都可调用。
   * 应用内会话用自己的 Compiler 编译上下文（基于 GrantRegistry 授权）。
   */
  sendMessage(sessionId: string, content: string): Promise<void>

  /**
   * 订阅应用内会话的事件流
   *
   * 应用内部有自己的事件流。
   * 返回取消订阅函数。
   */
  subscribeSession(sessionId: string, handler: (event: AppEvent) => void): () => void

  // ── 记忆回流（可选）──

  /** 执行主 Agent 委派的一次性高层动作；内部推理不持久化，真实副作用由应用自行审计。 */
  executeCommand?(request: AppCommandRequest): Promise<AppCommandResult>

  /**
   * 获取应用在某日产生的记忆摘要列表
   *
   * AIOS 记忆回流通道：应用实现此方法后，主 Agent 的 DailyNotesService
   * 会在每日生成日记时调用此接口，聚合所有应用的当日记忆摘要，
   * 与 EventNote 和已审阅原始互动统一生成 Workspace Markdown 日记。
   *
   * 设计目的：
   * - 解耦主 Agent 与 subagent 的记忆存储（主 Agent 不直接读 social.tdb 等）
   * - 应用自己决定如何读取自己的 store（如 social.tdb 的零向量 Event 节点）
   * - 主 Agent 只消费应用输出的"摘要字符串列表"，不知道也不关心存储细节
   *
   * @param date ISO 日期字符串（如 "2026-08-08"）
   * @returns 当日记忆摘要列表（每条是一个人类可读的短文本）
   */
  getDailySummaries?(date: string): Promise<string[]>
}

// ─────────────────────────────────────────────
// 内置兼容应用运行时工厂
// ─────────────────────────────────────────────

/**
 * 应用运行时工厂函数类型
 *
 * 仅由Backend显式注册的受信任内置应用使用。
 */
export type AppRuntimeFactory = () => AgentAppRuntime
