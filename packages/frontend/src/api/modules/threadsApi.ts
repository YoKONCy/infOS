/**
 * Threads API 模块
 *
 * 对齐后端 AIOS 第三阶段 Thread + ContextCompiler 架构。
 * 替代旧 sessionsApi，路由前缀 `/chat/threads`（apiClient 自动加 /api）。
 *
 * 注意：threads 路由挂载在 chat router 下，完整路径为 /api/chat/threads。
 * 早期版本误用 /threads 前缀导致 404，已修正。
 */

import type {
  ConversationProjectionSnapshot,
  InteractionMode,
  ExecutionMode,
  ThreadModelSettings,
  ReasoningEffort,
} from '@infos/shared'
import { apiClient } from '../client'

/** Thread 频道类型 */
export type ThreadChannel = 'desktop' | 'group' | 'social'

/** Thread 摘要信息 */
export interface ThreadInfo {
  id: string
  agentId: string
  channel: ThreadChannel
  threadKind: 'main' | 'side'
  generation: number
  canDelete: boolean
  canFork: boolean
  canReset: boolean
  platform?: string
  platformIdentifier?: string
  title: string
  /** 消息总数（含已删除的对话对计数） */
  messageCount: number
  /** 对话对数量 */
  pairCount: number
  /** 最后一条消息时间（ISO 字符串），无消息时为 null */
  lastMessageAt: string | null
  /** Thread 状态：active / archived 等 */
  status: string
  /**
   * ContextPolicy（JSON 序列化的 ChannelPolicy 字符串）
   * null 表示使用 DEFAULT_POLICIES 中该 channel 的默认策略
   */
  contextPolicy: string | null
  /** 本会话明确禁用的工具名。 */
  disabledTools: string[]
  enabledSkills: string[]
  interactionMode: InteractionMode
  /** 本会话开启后，普通工具调用不再逐次请求审批。 */
  executionMode?: ExecutionMode
  autoExecuteTools: boolean
  createdAt: string
  updatedAt: string
}

/** 消息附件 */
export interface ThreadAttachmentInfo {
  id: string
  threadId: string
  messageId: number | null
  kind: 'image' | 'text' | 'pdf' | 'audio' | 'video' | 'file'
  originalName: string
  mimeType: string
  sizeBytes: number
  contextPolicy: 'once'
  status: string
}

/** Thread 内单条消息 */
export interface ThreadMessageInfo {
  /** 消息 ID（数据库自增整数，后端返回 number） */
  id: number
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** Agent 回复的原始内容（含 Thinking/Monologue/NIT 等调试块），仅 assistant 角色可能有值 */
  rawContent?: string | null
  /** 配对 ID (user + assistant 配对) */
  pairId: string | null
  /** 发送者 ID（用户消息可能有，assistant 消息为 null） */
  senderId: string | null
  /** Agent ID（仅 assistant 消息有值） */
  agentId: string | null
  /** 消息状态 */
  status: string
  /** 修订版本号 */
  revision: number
  /** 元数据 JSON 字符串 */
  metadataJson: string
  /** 消息时间戳（ISO 字符串，后端字段名为 timestamp） */
  timestamp: string
  attachments?: ThreadAttachmentInfo[]
}

/** Thread 列表分页数据 */
export interface ThreadListData {
  items: ThreadInfo[]
  total: number
  page: number
  pageSize: number
}

/** Thread 详情数据 */
export interface ThreadDetailData {
  thread: ThreadInfo
  messages: ThreadMessageInfo[]
  total: number
}

export interface ThreadToolSetting {
  name: string
  packageId?: string
  label: string
  description: string
  display?: { label?: string; icon?: string; color?: string; style?: string }
  enabled: boolean
  userEnabled: boolean
  modeAllowed: boolean
  /** 系统协议不可逐项关闭，仍受会话模式限制。 */
  locked?: boolean
}

export interface ThreadToolsData {
  threadId: string
  channel: ThreadChannel
  tools: ThreadToolSetting[]
  disabledTools?: string[]
  executionMode?: ExecutionMode
  autoExecuteTools: boolean
  interactionMode: InteractionMode
}

export interface ThreadSkillsData {
  threadId: string
  enabledSkills: string[]
  skills: Array<{ id: string; name: string; description: string; enabled: boolean }>
}

export interface FlowStateInfo {
  threadId: string
  agentId: string
  currentGoal: string
  privateFacts: string
  revision: number
  updatedAt: string | null
}

export interface TokenBudgetPreview {
  memoryRetrievalDeferred?: boolean
  usedTokens: number
  contextWindowTokens: number
  maxInputTokens: number
  modelId: string
}

/** 创建 Thread 请求体 */
export interface CreateThreadRequest {
  agentId?: string
  channel?: ThreadChannel
  platform?: string
  platformIdentifier?: string
  title?: string
}

/** 获取最新 Thread 请求体 */
export interface GetLatestThreadRequest {
  agentId?: string
  channel?: string
}

export const threadsApi = {
  reset: (threadId: string) => apiClient.post<{ thread: ThreadInfo }>(`/chat/threads/${encodeURIComponent(threadId)}/reset`, {}),
  experiences: (threadId: string) => apiClient.get<{ items: AgentExperience[] }>(`/chat/threads/${encodeURIComponent(threadId)}/experiences`),
  fork: (threadId: string, messageId: number) =>
    apiClient.post<{ thread: ThreadInfo }>(`/chat/threads/${encodeURIComponent(threadId)}/fork`, {
      messageId,
    }),
  getModelSettings: (threadId: string) =>
    apiClient.get<ThreadModelSettings>(
      `/chat/threads/${encodeURIComponent(threadId)}/model-settings`,
    ),
  updateModelSettings: (
    threadId: string,
    settings: { modelConfigId: number | null; reasoningEffort: ReasoningEffort | null },
  ) =>
    apiClient.put<ThreadModelSettings>(
      `/chat/threads/${encodeURIComponent(threadId)}/model-settings`,
      settings,
    ),
  /** 分页获取 Thread 列表 */
  list: (params?: {
    agentId?: string
    channel?: string
    purpose?: 'conversation' | 'background_task' | 'app_internal'
    page?: number
    pageSize?: number
  }) => {
    const query = new URLSearchParams()
    if (params?.agentId) query.set('agentId', params.agentId)
    if (params?.channel) query.set('channel', params.channel)
    if (params?.purpose) query.set('purpose', params.purpose)
    if (params?.page) query.set('page', String(params.page))
    if (params?.pageSize) query.set('pageSize', String(params.pageSize))
    const qs = query.toString()
    return apiClient.get<ThreadListData>(`/chat/threads${qs ? `?${qs}` : ''}`)
  },

  /** 获取 Thread 详情（含消息列表） */
  get: (threadId: string, params?: { page?: number; pageSize?: number; debug?: boolean }) => {
    const query = new URLSearchParams()
    if (params?.page) query.set('page', String(params.page))
    if (params?.pageSize) query.set('pageSize', String(params.pageSize))
    // 对话日志需要模型请求副本；普通聊天列表不请求这些调试字段。
    if (params?.debug) query.set('debug', '1')
    const qs = query.toString()
    return apiClient.get<ThreadDetailData>(`/chat/threads/${threadId}${qs ? `?${qs}` : ''}`)
  },

  /** 获取 Conversation 权威 Projection 与 committed Surfaces。 */
  getProjection: (threadId: string, params: { beforeCursor?: string; pageSize?: number } = {}) => {
    const query = new URLSearchParams()
    if (params.beforeCursor) query.set('beforeCursor', params.beforeCursor)
    if (params.pageSize) query.set('pageSize', String(params.pageSize))
    const suffix = query.toString()
    return apiClient.get<ConversationProjectionSnapshot>(
      `/chat/threads/${encodeURIComponent(threadId)}/projection${suffix ? `?${suffix}` : ''}`,
    )
  },

  /** 创建新 Thread */
  create: (data: CreateThreadRequest) =>
    apiClient.post<{ thread: ThreadInfo }>('/chat/threads', data),

  /** 修改会话标题；空字符串在界面中显示为“未命名会话”。 */
  rename: (threadId: string, title: string) =>
    apiClient.patch<void>(`/chat/threads/${encodeURIComponent(threadId)}`, { title }),

  /** 软删除整条 Thread；长期记忆和定时任务不会被删除。 */
  delete: (threadId: string) =>
    apiClient.delete<void>(`/chat/threads/${encodeURIComponent(threadId)}`),

  /** 获取当前会话心流；group 可返回多个 Agent。 */
  getFlowState: (threadId: string, agentId?: string) => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
    return apiClient.get<FlowStateInfo[]>(
      `/chat/threads/${encodeURIComponent(threadId)}/flow-state${query}`,
    )
  },

  /** 清空当前会话中指定 Agent 的心流。 */
  clearFlowState: (threadId: string, agentId?: string) => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
    return apiClient.delete<FlowStateInfo>(
      `/chat/threads/${encodeURIComponent(threadId)}/flow-state${query}`,
    )
  },

  previewTokenBudget: (threadId: string, input: { agentId?: string; content?: string }) =>
    apiClient.post<TokenBudgetPreview>(
      `/chat/threads/${encodeURIComponent(threadId)}/token-budget-preview`,
      input,
    ),

  /** 获取当前 Channel 可配置工具及本会话启用状态。 */
  getTools: (threadId: string) =>
    apiClient.get<ThreadToolsData>(`/chat/threads/${encodeURIComponent(threadId)}/tools`),

  getSkills: (threadId: string) =>
    apiClient.get<ThreadSkillsData>(`/chat/threads/${encodeURIComponent(threadId)}/skills`),

  updateSkills: (threadId: string, enabledSkills: string[]) =>
    apiClient.put<ThreadSkillsData>(`/chat/threads/${encodeURIComponent(threadId)}/skills`, {
      enabledSkills,
    }),

  /** 持久化本会话禁用工具集合；后端会再次校验 Channel 白名单。 */
  updateTools: (threadId: string, disabledTools: string[]) =>
    apiClient.put<ThreadToolsData>(`/chat/threads/${encodeURIComponent(threadId)}/tools`, {
      disabledTools,
    }),

  updateExecutionMode: (threadId: string, executionMode: ExecutionMode) =>
    apiClient.put<{ threadId: string; executionMode: ExecutionMode; autoExecuteTools: boolean }>(
      `/chat/threads/${encodeURIComponent(threadId)}/execution-mode`,
      { executionMode },
    ),

  updateInteractionMode: (threadId: string, interactionMode: InteractionMode) =>
    apiClient.put<ThreadToolsData>(
      `/chat/threads/${encodeURIComponent(threadId)}/interaction-mode`,
      { interactionMode },
    ),

  /** 获取指定 Agent/Channel 的最新 Thread */
  getLatest: (data: GetLatestThreadRequest) =>
    apiClient.post<{ thread: ThreadInfo }>('/chat/threads/latest', data),
}

export interface AgentExperience {
  id: number
  sourceMessageId: number
  roomId: string
  roomName: string | null
  senderId: string
  content: string
  timestamp: string
}
