/**
 * Agent 应用层类型定义
 *
 * 定义内置社交应用兼容运行时的清单、资源授权和生命周期类型。
 * 包含：
 * - AgentAppManifest：应用清单（应用的自描述）
 * - GrantRegistry 类型：资源授权声明
 * - AppManager 类型：应用生命周期管理
 * - AppRuntime 类型：应用运行时接口
 *
 * 设计原则：
 * - 授权的是"资源引用"而非"上下文快照"（活资源，非死快照）
 * - 应用自带工具 + 可申请使用主 Agent 工具（点号前缀隔离）
 *
 * @module packages/backend/src/applications/types
 */

// ─────────────────────────────────────────────
// 应用清单（AgentAppManifest）
// ─────────────────────────────────────────────

/**
 * Agent 应用清单
 *
 * 应用的自描述文件，类比 OS 应用的 package.json + Info.plist。
 * 声明应用的身份、能力、权限、前端入口、上下文需求。
 *
 * 仅供内置Social兼容Runtime使用，自治Application使用ApplicationAdapterManifest。
 */
export interface AgentAppManifest {
  // ── 身份信息 ──
  /** 应用 ID（全局唯一，如 'social'） */
  id: string
  /** 显示名称 */
  name: string
  /** 简短描述 */
  description: string
  /** 版本号（语义化版本，如 '1.0.0'） */
  version: string
  /** 作者 */
  author?: string
  /** 主页 URL */
  homepage?: string
  /** 应用图标路径（相对应用根目录） */
  icon?: string

  // ── 内置兼容入口 ──
  /**
   * 前端入口
   *
   * 仅供内置Social兼容界面保留，自治Application使用Surface Manifest。
   */
  frontendEntry?: string

  // ── 能力声明 ──
  /** 应用向主 Agent 暴露的高层任务动作。主 Agent 只调用 Action，不直接获得应用内部工具。 */
  actions?: AppActionDeclaration[]

  /**
   * 应用提供的工具能力
   *
   * 这些工具注册到 ToolRegistry，但仅在应用内可用。
   * 主 Agent 不自动获得这些工具。
   * 工具名自动加 appId 前缀（如 social.social_group）。
   */
  providesTools?: AppToolDeclaration[]

  /**
   * 应用需要的主 Agent 工具（白名单子集）
   *
   * 应用内的 agent 可使用主 Agent 已有的这些工具，
   * 受 AppToolCapability 约束。
   *
   * 例如社交应用需要：web_search / web_fetch / query_event_notes
   */
  requiresTools?: string[]

  // ── 权限需求 ──
  /**
   * 应用需要的权限
   *
   * AIOS 在安装/启动时检查这些权限是否被授予。
   * 未授予的权限会导致应用启动失败或降级运行。
   */
  requiredPermissions: AppPermission[]

  // ── 兼容性 ──
  /**
   * 支持的主 Agent 角色
   *
   * 空数组或省略表示支持所有 Agent。
   * 非空表示仅列出的 Agent 可使用此应用。
   * 例如某应用仅适合 pero，不适合 nana。
   */
  supportedAgentRoles?: string[]

  /** 支持的 AIOS 最低版本 */
  minAiosVersion?: string

  // ── 上下文与工作区 ──
  /**
   * 应用需要的上下文类型
   *
   * 声明应用需要哪些类型的上下文资源，
   * 由 AIOS 在创建任务时通过 GrantRegistry 授权。
   */
  contextRequirements?: AppContextRequirement[]

  /**
   * 工作区模式
   *
   * - 'fixed'：固定工作区（@data/apps/{appId}/）
   * - 'dynamic'：按授权选择工作区目录
   * - 'none'：无工作区（如纯对话型应用）
   */
  workspaceMode: 'fixed' | 'dynamic' | 'none'

  /**
   * 检查点 schema
   *
   * 声明应用产出的 Checkpoint 结构，
   * 用于主 Agent 读取任务状态。
   */
  checkpointSchema?: AppCheckpointSchema

  // ── 应用内会话 ──
  /**
   * 是否支持应用内多会话
   *
   * true：应用可管理多个独立会话
   * false：应用单会话模式
   */
  supportsMultipleSessions?: boolean

  /**
   * 默认会话上下文策略
   *
   * 应用内会话的默认 ContextPolicy。
   */
  defaultSessionPolicy?: AppSessionPolicy
}

/** 应用向宿主 Agent 暴露的高层任务动作。 */
export interface AppActionDeclaration {
  name: string
  description: string
  mode: 'command' | 'delegate' | 'both'
  parameters?: Record<string, unknown>
  defaultCommunicationBudget?: number
}

/**
 * 应用提供的工具声明
 */
export interface AppToolDeclaration {
  /** 工具名（注册时自动加 appId 前缀，如 social.social_group） */
  name: string
  /** 工具描述 */
  description: string
  /** 参数 schema（JSON Schema 格式） */
  parameters?: Record<string, unknown>
  /**
   * 是否需要主 Agent 批准
   *
   * true：调用时通过消息队列请求主 Agent 审批
   * false：应用内 agent 可直接调用
   */
  requiresApproval?: boolean
}

/**
 * 应用权限
 *
 * 权限是粗粒度的能力声明，细粒度由 GrantRegistry 控制。
 */
export interface AppPermission {
  /** 权限类型 */
  type:
    | 'memory.read' // 读取主 Agent 记忆
    | 'memory.write' // 写入记忆候选（经 Gate 审核）
    | 'workspace.principal' // 访问主 Agent 工作区
    | 'workspace.dynamic' // 打开任意目录
    | 'terminal.execute' // 执行终端命令
    | 'network.access' // 网络访问
    | 'platform.capability' // 平台能力（截图/通知等）
  /** 权限说明（给用户看） */
  description: string
  /** 是否必须（false=可选，用户可拒绝） */
  required: boolean
}

/**
 * 应用上下文需求
 */
export interface AppContextRequirement {
  /** 上下文类型 */
  type:
    | 'persona' // 主 Agent 人格投影
    | 'memory' // 主 Agent 记忆片段
    | 'messages' // 主 Thread 消息范围
    | 'workspace' // 工作区目录
    | 'task' // 任务描述
    | 'user_profile' // 用户偏好
  /** 是否必须 */
  required: boolean
  /** 描述 */
  description?: string
}

/**
 * 应用检查点 schema
 */
export interface AppCheckpointSchema {
  /** 状态字段定义 */
  fields: AppCheckpointField[]
}

export interface AppCheckpointField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'object'
  description: string
  required: boolean
}

/**
 * 应用会话策略
 */
export interface AppSessionPolicy {
  /** 消息窗口大小 */
  messageWindow?: number
  /** Token 预算 */
  tokenBudget?: number
  /** 是否启用记忆检索 */
  enableMemoryRetrieval?: boolean
  /** 是否注入工具描述 */
  enableToolDescription?: boolean
}

// ─────────────────────────────────────────────
// GrantRegistry 类型（资源授权声明）
// ─────────────────────────────────────────────

/**
 * 资源引用 —— 授权的"是什么资源"
 *
 * 联合类型，每种资源有不同的引用方式。
 * 引用是"指针"，不是"内容"。被授权方在编译时实时读取最新资源内容。
 */
export type ResourceRef =
  | MemoryResourceRef
  | MessageRangeResourceRef
  | WorkspaceResourceRef
  | PersonaResourceRef
  | TaskResourceRef
  | ModelResourceRef

/** 记忆资源引用：授权访问特定主 Agent 记忆 */
export interface MemoryResourceRef {
  kind: 'memory'
  /** 主 Agent ID（记忆归属者） */
  agentId: string
  /** 限定记忆类型（可选，空=所有类型） */
  memoryTypes?: string[]
  /** 限定记忆 ID 列表（可选，空=按类型检索） */
  memoryIds?: string[]
  /** 检索限制（最大返回条数） */
  maxResults?: number
}

/** 消息范围引用：授权访问主 Thread 的特定消息范围 */
export interface MessageRangeResourceRef {
  kind: 'messages'
  threadId: string
  /** 起始消息 ID（可选） */
  fromMessageId?: number
  /** 结束消息 ID（可选） */
  toMessageId?: number
  /** 最近 N 条（可选，与 from/to 二选一） */
  lastN?: number
}

/** 工作区引用：授权访问特定目录 */
export interface WorkspaceResourceRef {
  kind: 'workspace'
  /** 目录绝对路径或路径别名 */
  path: string
  /** 访问模式 */
  access: 'read' | 'readwrite'
  /** 是否递归（子目录） */
  recursive: boolean
}

/** 人格引用：授权使用主 Agent 人格投影 */
export interface PersonaResourceRef {
  kind: 'persona'
  agentId: string
  /** 是否允许应用补丁覆盖 */
  allowAppPatch: boolean
}

/** 任务引用：授权执行特定任务 */
export interface TaskResourceRef {
  kind: 'task'
  taskDescription: string
  taskInputs: string[]
  successCriteria: string
  deadline?: string
}

export interface ModelResourceRef {
  kind: 'model'
  modelConfigId?: number
}

/**
 * 被授权方对资源可执行的操作
 */
export type GrantPermission =
  | 'read' // 读取（编译时加载）
  | 'activate' // 激活（本轮编译包含）
  | 'derive' // 派生（基于此资源创建新资源）
  | 'write' // 写入（仅 workspace 类资源）

/**
 * Grant —— 一条资源授权记录
 *
 * 授权的是"资源引用"，不是"编译后的上下文"。
 * 被授权方在编译时实时读取最新资源内容，确保是"活资源"。
 */
export interface Grant {
  /** Grant ID（唯一） */
  id: string
  /** 授权方（通常是主 Agent ID） */
  ownerAgentId: string
  /** 被授权方（应用实例 ID 或应用内会话 ID） */
  holderId: string
  /** 被授权方类型 */
  holderType: 'app' | 'app_session'
  /** 授权的资源 */
  resource: ResourceRef
  /** 授予的权限 */
  permissions: GrantPermission[]
  /** 创建时间 */
  createdAt: string
  /** 过期时间（可选，超时自动失效） */
  expiresAt?: string
  /** 是否已撤销 */
  revoked: boolean
  /** 撤销时间 */
  revokedAt?: string
  /** 来源（谁授权的，通常是主 Agent 或用户） */
  grantedBy: 'host_agent' | 'user' | 'auto'
  /** 备注 */
  note?: string
}

// ─────────────────────────────────────────────
// AppManager 类型（应用生命周期管理）
// ─────────────────────────────────────────────

/** 应用安装状态 */
export type AppInstallStatus =
  | 'installed'
  | 'launching'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'error'

/** 应用实例信息 */
export interface AppInstance {
  /** 实例 ID（每次启动生成新 ID） */
  instanceId: string
  /** 应用 ID */
  appId: string
  /** 启动此实例的主 Agent ID */
  hostAgentId: string
  /** 当前状态 */
  status: AppInstallStatus
  /** 启动时间 */
  launchedAt: string
  /** 工作区路径（dynamic 模式下用户指定，fixed 模式下默认） */
  workspacePath?: string
  /** 任务上下文（主 Agent 委派时提供） */
  taskContext?: AppTaskContext
  /** 错误信息（status='error' 时有值） */
  error?: string
}

/** 应用任务上下文（主 Agent 委派时提供） */
export interface AppTaskContext {
  description: string
  inputs: string[]
  successCriteria: string
  deadline?: string
}

/** 应用启动参数 */
export interface LaunchAppParams {
  /** 应用 ID */
  appId: string
  /** 启动应用的主 Agent ID */
  hostAgentId: string
  /** 工作区路径（dynamic 模式必填） */
  workspacePath?: string
  /** 任务上下文（可选，主 Agent 委派时提供） */
  taskContext?: AppTaskContext
  /** 启动来源：用户手动 / 主 Agent 委派 / 系统自动启动（内置应用） */
  launchedBy: 'user' | 'host_agent' | 'system-autostart'
}

// ─────────────────────────────────────────────
// 检查点与事件
// ─────────────────────────────────────────────

export interface AppCommandRequest {
  /** 宿主填写的真实调用主体，模型输入不能覆盖。 */
  agentId?: string
  correlationId: string
  signal?: AbortSignal
  executionId?: import('@infos/shared').KernelExecutionId
  processId?: import('@infos/shared').KernelProcessId
  action: string
  input: Record<string, unknown>
  taskContext?: AppTaskContext
  communicationBudget: number
}

export interface AppCommandResult {
  correlationId: string
  status: 'completed' | 'waiting' | 'failed'
  summary: string
  output?: Record<string, unknown>
  error?: string
}

/**
 * 应用检查点
 *
 * 主 Agent 读取应用状态的结构化摘要。
 * 具体字段由 Manifest.checkpointSchema 定义。
 */
export interface AppCheckpoint {
  /** 实例 ID */
  instanceId: string
  /** 应用 ID */
  appId: string
  /** 任务状态 */
  status: 'running' | 'waiting' | 'completed' | 'failed'
  /** 摘要（人类可读） */
  summary: string
  /** 完成进度（0-1） */
  progress: number
  /** 检查点字段（按 Manifest.checkpointSchema） */
  fields: Record<string, unknown>
  /** 修改的产出物列表 */
  changedArtifacts: string[]
  /** 阻塞问题 */
  blockers: string[]
  /** 下一步行动 */
  nextActions: string[]
  /** 更新时间 */
  updatedAt: string
}

/**
 * 应用事件
 *
 * 应用向外部发布的事件，主 Agent 和前端可订阅。
 * 应用内部有自己的事件流，主 Agent 订阅应用事件走统一 EventBus。
 */
export type AppEvent =
  | {
      type: 'progress'
      instanceId: string
      progress: number
      message: string
      timestamp: string
    }
  | {
      type: 'tool_call'
      instanceId: string
      toolName: string
      args: Record<string, unknown>
      timestamp: string
    }
  | {
      type: 'approval_request'
      instanceId: string
      action: string
      reason: string
      timestamp: string
    }
  | {
      type: 'artifact_changed'
      instanceId: string
      path: string
      change: 'created' | 'modified' | 'deleted'
      timestamp: string
    }
  | {
      type: 'task_complete'
      instanceId: string
      summary: string
      artifacts: string[]
      timestamp: string
    }
  | { type: 'task_failed'; instanceId: string; error: string; timestamp: string }
  | {
      type: 'checkpoint_updated'
      instanceId: string
      checkpoint: AppCheckpoint
      timestamp: string
    }
