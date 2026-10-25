/**
 * Social API 模块 — 社交适配器
 *
 * 对接后端 /api/social/* 路由 + /api/configs/social 配置端点。
 * 通过 ApiClient 统一信封，禁止直接 fetch。
 *
 * @module packages/frontend/src/api/modules/socialApi
 */

import type {
  SurfaceProjectionSnapshot,
  StatusCardDesign,
  StatusCardImage,
  SocialTurnListItem,
  SocialBotMark,
  SocialSchedulerConfig,
  SocialTurnKind,
} from '@infos/shared'
import { apiClient } from '../client'
import { configApi } from './configApi'

/** 适配器状态 */
export interface AdapterStatus {
  platform: string
  connected: boolean
  displayName?: string
  error?: string
}

export interface SocialManagementSnapshot {
  accounts: Array<{
    id: string
    name: string
    connected: boolean
    error?: string
    fullGroupMessages?: boolean
  }>
  ownerId?: string
  login?: { id: string; qrText: string; status: string }
}
export interface SocialPlatform {
  type: string
  platform: string
}
export interface SocialConnection {
  id: string
  adapter: string
  platform: string
  name: string
  ownerId?: string
  accounts: string[]
  capabilities: string[]
}

/** 社交状态响应 */
export interface SocialStatusData {
  adapters: AdapterStatus[]
}

export interface SocialModeConfig extends SocialSchedulerConfig {
  strangerPolicy: 'allow' | 'ignore'
  groupWhitelist: string[]
  groupBlacklist: string[]
  userBlacklist: string[]
  ownerPrivateOnlyAgentIds: string[]
  loopGuard: {
    knownBotIds: string[]
    trustedHumanIds: string[]
    botMarks?: SocialBotMark[]
    maxBotTurns: number
    maxTurnsPerWindow: number
    windowSeconds: number
    maxModelRequests: number
    maxSends: number
    cooldownSeconds: number
  }
}

/** 社交配置（存储在 configs 表的 'social' key，JSON 字符串） */
export interface SocialConfig {
  connections?: Array<{
    id: string
    adapter: string
    enabled?: boolean
    ownerId?: string
    [key: string]: unknown
  }>
  ownerId?: string
  /** 单实例 Social 负责自主社交的角色 */
  agentId?: string
  /** 主人的 QQ 号（用于权限识别 + prompt 注入） */
  ownerQq?: string
  /** QQ Bot 账号 → Agent 映射 */
  bindings?: Array<{
    adapter: string
    accountId: string
    agentId: string
  }>
  mode?: Partial<SocialModeConfig>
}

export interface SocialContactImpression {
  platform: string
  userId: string
  displayName: string
  identity?: string
  impression: string
  sourceChannelId?: string | null
  updatedAt: string
}

export type SocialClearScope =
  | 'channel'
  | 'contact_impression'
  | 'all_messages'
  | 'long_memory'
  | 'all_social_data'

export interface SocialSticker {
  id: string
  description: string
}
export interface SocialStickerPage {
  accountId: string
  stickers: SocialSticker[]
  total: number
  offset: number
  hasMore: boolean
  truncated: boolean
}

export const socialApi = {
  getPlatforms: () => apiClient.get<{ platforms: SocialPlatform[] }>('/social/platforms'),
  enablePlatform: (type: string) =>
    apiClient.post<void>(`/social/platforms/${encodeURIComponent(type)}/enable`),
  getConnectionManagement: (id: string, signal?: AbortSignal) =>
    apiClient.request<SocialManagementSnapshot>(
      `/social/connections/${encodeURIComponent(id)}/management`,
      { signal },
    ),
  manageConnection: (
    id: string,
    action: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) =>
    apiClient.request<SocialManagementSnapshot>(
      `/social/connections/${encodeURIComponent(id)}/management`,
      { method: 'POST', body: JSON.stringify({ action, input }), signal },
    ),
  getConnections: () => apiClient.get<{ connections: SocialConnection[] }>('/social/connections'),
  saveConnectionOwner: (id: string, ownerId: string) =>
    apiClient.put<void>(`/social/connections/${encodeURIComponent(id)}/owner`, { ownerId }),
  acknowledgeTurn: (id: string) =>
    apiClient.post<void>(`/social/turns/${encodeURIComponent(id)}/acknowledge`),
  acknowledgeTurns: (agentId: string, ids: string[]) =>
    apiClient.post<void>(`/social/turns/${encodeURIComponent(agentId)}/acknowledge-all`, { ids }),
  getStickerAccounts: () =>
    apiClient.get<{
      accounts: string[]
      connections: Array<{ platform: string; accountId: string }>
    }>('/social/stickers/accounts'),
  getStickers: (accountId: string, query: string, offset = 0, refresh = false, platform?: string) =>
    apiClient.get<SocialStickerPage>(
      `/social/stickers/${encodeURIComponent(accountId)}?${new URLSearchParams({ query, offset: String(offset), limit: '30', refresh: String(refresh), ...(platform ? { platform } : {}) })}`,
    ),
  getStickerImage: (accountId: string, stickerId: string, platform?: string) =>
    apiClient.get<{ dataUrl: string }>(
      `/social/stickers/${encodeURIComponent(accountId)}/${encodeURIComponent(stickerId)}/image${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`,
    ),
  describeSticker: (accountId: string, stickerId: string, description: string, platform?: string) =>
    apiClient.post<SocialSticker>(
      `/social/stickers/${encodeURIComponent(accountId)}${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`,
      {
        action: 'describe',
        stickerId,
        description,
      },
    ),
  deleteSticker: (accountId: string, stickerId: string, platform?: string) =>
    apiClient.post<{ removed: string }>(
      `/social/stickers/${encodeURIComponent(accountId)}${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`,
      {
        action: 'delete',
        stickerId,
      },
    ),
  getStatusCardDesign: () => apiClient.get<StatusCardDesign>('/social/status-card/design'),
  saveStatusCardDesign: (design: StatusCardDesign) =>
    apiClient.put<StatusCardDesign>('/social/status-card/design', design),
  previewStatusCard: (design: StatusCardDesign) =>
    apiClient.post<StatusCardImage>('/social/status-card/preview', design),
  /** 获取所有适配器连接状态 */
  getStatus: () => apiClient.get<SocialStatusData>('/social/status'),

  /** 发送调试消息 */
  send: (content: string) => apiClient.post('/social/send', { content }),

  getModeConfig: () => apiClient.get<SocialModeConfig>('/social/mode-config'),
  turns: (agentId: string, kind?: SocialTurnKind) =>
    apiClient.get<SocialTurnListItem[]>(
      `/social/turns/${encodeURIComponent(agentId)}${kind ? `?kind=${kind}` : ''}`,
    ),
  cancelTurn: (id: string) =>
    apiClient.post<void>(`/social/turns/${encodeURIComponent(id)}/cancel`),
  allowLimitedConversation: (
    accountId: string,
    channelType: 'private' | 'group',
    channelId: string,
    platform?: string,
  ) => apiClient.post('/social/loop-guard/allow', { platform, accountId, channelType, channelId }),
  saveModeConfig: (config: SocialModeConfig) =>
    apiClient.put<SocialModeConfig>('/social/mode-config', config),

  getAgentConfig: () => apiClient.get<{ agentId: string }>('/social/agent-config'),
  saveAgentConfig: (agentId: string) =>
    apiClient.put<{ agentId: string; closedSessions: number }>('/social/agent-config', { agentId }),

  getContacts: (agentId: string) =>
    apiClient.get<{ contacts: SocialContactImpression[] }>(
      `/social/contacts/${encodeURIComponent(agentId)}`,
    ),
  getProjection: (agentId: string) =>
    apiClient.get<SurfaceProjectionSnapshot>(`/social/projection/${encodeURIComponent(agentId)}`),

  syncHistory: (platform: string) =>
    apiClient.post(`/social/history-sync/${encodeURIComponent(platform)}`),

  clearData: (input: {
    agentId: string
    scope: SocialClearScope
    platform?: string
    accountId?: string
    channelType?: 'private' | 'group'
    channelId?: string
    userId?: string
    confirmAgentName?: string
  }) => apiClient.post('/social/data/clear', input),

  /**
   * 读取社交配置
   *
   * 从 /api/configs/social 获取并解析 JSON。
   * 未配置时返回空对象。
   */
  async getConfig(): Promise<SocialConfig> {
    const res = await configApi.get<{ key: string; value: string | null }>('social')
    const raw = res.data?.value
    if (!raw) return {}
    try {
      return JSON.parse(raw) as SocialConfig
    } catch {
      return {}
    }
  },

  /**
   * 保存社交配置（整体覆盖）
   *
   * 将 SocialConfig 序列化为 JSON 字符串写入 /api/configs/social。
   * 注意：后端 configRepo.set 只支持 string，所以这里手动 JSON.stringify。
   */
  async saveConfig(config: SocialConfig): Promise<void> {
    await configApi.set('social', JSON.stringify(config))
  },
}
