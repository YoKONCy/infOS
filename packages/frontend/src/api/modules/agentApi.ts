/**
 * Agent API 模块
 *
 */

import type { AgentPublicProfile } from '@infos/shared'
import { apiClient } from '../client'

/** Agent 列表项 */
export interface AgentListItem {
  id: string
  name: string
  description: string
  ownerAppellation: string
  isActive: boolean
  isEnabled: boolean
  /** 用户创建的角色；false 为内置角色 */
  isUser: boolean
  /** 头像 URL (/api/agents/:id/avatar) */
  avatarUrl?: string
}

export type AgentChannel = 'desktop' | 'social' | 'group'

export interface AgentSocialBinding {
  enabled: boolean
  qq_id: string
}

export interface AgentDetail extends AgentListItem {
  publicProfile: AgentPublicProfile
  systemPrompt: string
  channelPatches: Partial<Record<AgentChannel, string>>
  waifuTexts: Record<string, unknown> | null
}

export interface AgentCreatePayload {
  id: string
  name: string
  description?: string
  ownerAppellation?: string
  systemPrompt?: string
}

export type AgentUpdatePayload = Pick<
  AgentDetail,
  | 'name'
  | 'description'
  | 'publicProfile'
  | 'ownerAppellation'
  | 'systemPrompt'
  | 'channelPatches'
  | 'waifuTexts'
>

/** 工具显示元数据（后端 manifest display 字段透传，前端 ReAct 轨迹区渲染用） */
export interface AgentToolDisplay {
  label?: string
  icon?: string
  color?: string
  style?: string
  signature?: import('@infos/shared').ToolVisualSignatureMeta
}

export interface AgentTool {
  name: string
  description: string
  category?: string
  channels?: AgentChannel[]
  locked?: boolean
  display?: AgentToolDisplay
  /** 子应用工具的来源；仅子应用工具管理层登记的工具携带。 */
  source?: { kind: 'application'; appId: string; appName: string }
  /** 子应用工具当前是否在线；离线时只可提前配置，主 Agent 不可调用。 */
  available?: boolean
}

export interface AgentSkillOption {
  id: string
  name: string
  description: string
}

/** 单个 channel 的能力配置 */
export interface ChannelCapabilityModel {
  tools: string[]
  skills: string[]
  promptFragments: string[]
}

export interface AgentCapabilities {
  channels: Record<string, ChannelCapabilityModel>
  skills?: AgentSkillOption[]
}

export interface AgentPackageExport {
  format: 'infos.agent-package'
  version: 1
  agentId: string
  name: string
  fileName: string
  exportedAt: string
  files: Array<{ path: string; contentBase64: string }>
}

export const agentApi = {
  /** 获取所有 Agent */
  list: () => apiClient.get<AgentListItem[]>('/agents'),

  /** 获取完整 Agent 配置 */
  get: (agentId: string) => apiClient.get<AgentDetail>(`/agents/${agentId}`),

  /** 创建自定义 Agent */
  create: (payload: AgentCreatePayload) => apiClient.post<AgentDetail>('/agents', payload),

  /** 更新 Agent 配置 */
  update: (agentId: string, payload: AgentUpdatePayload) =>
    apiClient.put<AgentDetail>(`/agents/${agentId}`, payload),

  /** 删除自定义 Agent */
  remove: (agentId: string) => apiClient.delete<void>(`/agents/${agentId}`),

  /** 获取服务端生成的版本化角色资源包。 */
  exportPackage: (agentId: string) =>
    apiClient.get<AgentPackageExport>(`/agents/${agentId}/export`),

  /** 上传客户端裁切后的 PNG 头像，由服务端写入 Agent 资源目录。 */
  uploadAvatar: (agentId: string, avatar: Blob) => {
    const data = new FormData()
    data.append('avatar', avatar, 'avatar.png')
    return apiClient.post<{ avatarUrl: string }>(`/agents/${agentId}/avatar`, data)
  },

  /** 获取能力矩阵 */
  getCapabilities: (agentId: string) =>
    apiClient.get<AgentCapabilities>(`/agents/${agentId}/capabilities`),

  /** 更新能力矩阵 */
  updateCapabilities: (agentId: string, payload: AgentCapabilities) =>
    apiClient.put<AgentCapabilities>(`/agents/${agentId}/capabilities`, payload.channels),

  /** 获取可用工具 */
  listTools: (options?: { includeAdvanced?: boolean }) =>
    apiClient.get<AgentTool[]>(
      options?.includeAdvanced ? '/agents/tools?includeAdvanced=true' : '/agents/tools',
    ),

  /** 获取后端权威的全局活跃角色。 */
  getActive: () => apiClient.get<{ agentId: string; id: string; name: string }>('/agents/active'),

  /** 启用 Agent */
  enable: (agentId: string) => apiClient.post<void>(`/agents/${agentId}/enable`),

  /** 禁用 Agent */
  disable: (agentId: string) => apiClient.post<void>(`/agents/${agentId}/disable`),

  /** 重载所有 Agent 配置 */
  reload: () => apiClient.post<void>('/agents/reload'),

  /** 获取 Agent 看板娘台词 (静态 + 动态合并) */
  getTexts: (agentId: string, threadId?: string) =>
    apiClient.get<Record<string, unknown>>(
      `/agents/${agentId}/texts${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`,
    ),

  /** 获取指定会话的角色状态与动态台词；不跨会话继承。 */
  getPetState: (agentId: string, threadId?: string) =>
    apiClient.get<PetStateResponse>(
      `/agents/${agentId}/pet-state${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`,
    ),

  /** 批量获取所有角色的陪伴调度只读状态，供任务中心统一展示。 */
  listCompanionStates: () => apiClient.get<CompanionStateResponse[]>('/agents/companion-states'),

  /** 获取角色陪伴调度的真实运行状态。 */
  getCompanionState: (agentId: string) =>
    apiClient.get<CompanionStateResponse>(`/agents/${agentId}/companion`),

  /** 启用或关闭角色的主动陪伴调度。 */
  setCompanionState: (agentId: string, enabled: boolean) =>
    apiClient.put<CompanionStateResponse>(`/agents/${agentId}/companion`, { enabled }),
}

/** 角色陪伴调度状态。 */
export interface CompanionStateResponse {
  agentId: string
  enabled: boolean
}

/** 角色实时状态响应 (GET /agents/:id/pet-state) */
export interface PetStateResponse {
  agentId: string
  threadId?: string | null
  revision?: number
  mood: string
  vibe: string
  mind: string
  clickMessages: Record<string, string[]>
  idleMessages: string[]
  backMessages: string[]
  textExpiresAt: string | null
  updatedAt: string | null
}
