/**
 * Capability Gate 类型定义
 *
 * (Agent, Channel) → ResolvedCapability 的类型体系。
 *
 * AIOS 改造说明：
 * - Mode 概念已废弃，改为 Channel（Thread 持久属性）
 * - ModeCapability → ChannelCapability
 * - AgentCapabilityConfig.modes → channels
 *
 * @module packages/backend/src/capabilities/types
 */

/** 单个 Channel 的能力配置 (YAML 中的一个 channel 块) */
export interface ChannelCapability {
  /** 该 channel 下可用的工具 ID 列表 */
  tools: string[]
  /** 该 channel 下可用的 Skill ID 列表 */
  skills: string[]
  /** 需要注入的 prompt 片段路径 */
  prompt_fragments: string[]
  /**
   * 工具权限配置（第六阶段 #6: Resource Scope）
   *
   * key 为工具名，value 为该工具在本 channel 下的资源范围与参数策略。
   * 缺失 key 表示该工具无额外资源范围限制（仍受 CapabilityGate 白名单约束）。
   */
  tool_permissions?: Record<string, ToolPermission>
}

/** 单个 Agent 的完整能力配置 (capabilities.yaml) */
export interface AgentCapabilityConfig {
  /** Agent ID */
  agent: string
  /** 各 channel 的能力配置 */
  channels: Record<string, ChannelCapability>
}

// ─────────────────────────────────────────────
// Resource Scope（第六阶段 #6）
// ─────────────────────────────────────────────

/**
 * 资源范围
 *
 * 描述工具可操作的文件系统根目录与禁止路径。
 * ToolExecutor 在调用涉及文件操作的工具前，会校验路径参数是否落在 allowedRoots 内
 * 且不命中 deniedPaths。
 */
export interface ResourceScope {
  /** 允许操作的根目录列表（绝对路径或相对 workspace 的别名，空数组表示不限制） */
  allowedRoots: string[]
  /** 禁止的路径列表（绝对路径或 glob，命中即拒绝） */
  deniedPaths: string[]
  /** 范围类型：principal_workspace=Agent 工作区 / user_authorized=用户授权目录 / system=系统级（不限制） */
  scope: 'principal_workspace' | 'user_authorized' | 'system'
}

/**
 * 参数策略。
 *
 * PolicyEngine 在 Hook 修改参数后执行这些规则，避免扩展通过改写参数绕过策略。
 */
export interface ParamPolicy {
  /** 内容最大长度（字符数） */
  maxContentLength?: number
  /** 允许的命令列表（如 terminal_execute 的命令白名单） */
  allowedCommands?: string[]
  /** 禁止的命令/参数模式（正则字符串） */
  deniedPatterns?: string[]
}

/**
 * 工具权限
 *
 * 描述单个工具在特定 (Agent, Channel) 下的资源范围、参数策略与审批要求。
 */
export interface ToolPermission {
  /** 工具名（与 ToolRegistry definition.name 一致） */
  toolName: string
  /** 资源范围（路径白/黑名单） */
  resourceScope: ResourceScope
  /** 参数策略（预留，第一版不实现） */
  paramPolicy?: ParamPolicy
  /** 是否需要审批（预留，第一版不实现审批层） */
  requiresApproval: boolean
}

/** Skill 清单 (SKILL.md 的 frontmatter) */
export interface SkillManifest {
  /** Skill ID (目录名) */
  id: string
  /** Skill 名称 */
  name: string
  /** Skill 描述，供选择器及技能说明展示。 */
  description: string
  /** 依赖的工具 ID 列表，只作能力需求声明。 */
  requiredTools: string[]
  /** 分类标签 (如 "productivity", "creative") */
  category: string
  /** 标签列表 (便于搜索和筛选) */
  tags: string[]
  /** 可接收的参数定义 (参数名 → 描述) */
  parameters: Record<string, string>
  /** 依赖的子 Skill ID 列表 (嵌套调用) */
  dependsOnSkills: string[]
  license?: string
  compatibility?: string
  metadata: Record<string, string>
  allowedTools: string[]
  rootPath: string
}

/** 请求级能力作用域；只能在 Channel 权限基础上继续收窄，不能扩权。 */
export type CapabilityScope = 'default' | 'ambient' | 'follow_up' | 'perception'

/** 解析后的完整能力上下文 (Gate 输出) */
export interface ResolvedCapability {
  /** Dispatcher 白名单 */
  allowedTools: Set<string>
  /** 省略会话选择时为候选清单，否则为当前会话已选技能。 */
  enabledSkills: SkillManifest[]
  /** 需要渲染的 prompt 片段路径 */
  promptFragments: string[]
  /** 已过滤的工具描述文本 */
  toolsDescription: string
  /** 会话已选技能的完整指引；仅查询可选清单时为空。 */
  skillMenuText: string
  /**
   * 工具权限表（第六阶段 #6: Resource Scope）
   * key 为工具名，value 为该工具在本 (Agent, Channel) 下的资源范围与参数策略。
   * 缺失 key 表示该工具无额外资源范围限制。
   */
  toolPermissions: Map<string, ToolPermission>
}
