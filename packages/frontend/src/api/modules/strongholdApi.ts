/**
 * Stronghold API 模块 — 据点/群聊管理
 *
 * 对接后端 /api/stronghold/* 路由。
 * 遵循统一信封规范 (ApiResponse<T>)。
 *
 * @module packages/frontend/src/api/modules/strongholdApi
 */

import type { StrongholdLifeSnapshot, StrongholdProjectionSnapshot } from '@infos/shared'
import { apiClient } from '../client'

// ── 类型定义 ──

export interface Facility {
  id: number
  name: string
  icon?: string
  description?: string
  roomCount?: number
}

export interface Room {
  id: string
  facilityId?: number
  name: string
  description?: string
  environmentJson?: string
  /** 后端附带的 Agent ID 列表 */
  agents?: string[]
}

export interface RoomMember {
  agentId: string
  role?: string
}

export interface AgentLocation {
  agentId: string
  roomId: string
  roomName?: string
}

export type GroupMessageRole = 'user' | 'assistant' | 'system'

export interface GroupMessage {
  id: number
  roomId: string
  senderId: string
  content: string
  role: GroupMessageRole
  timestamp?: string
  /** Agent 可见输出的总 Token。 */
  outputTokens?: number
}

export interface SendStrongholdMessageOptions {
  senderId?: string
  role: GroupMessageRole
  /** 被 @ 的 Agent ID 列表；'@all' 表示 @全体成员。 */
  mentions?: string[]
}

/** 据点消息提交后的调度结果。 */
export interface StrongholdMessageDispatch {
  message: GroupMessage
  replyQueued: boolean
  roundId?: string
  agentId?: string
  agentIds?: string[]
  /** @全体成员 时返回的打乱后的回复顺序（agentId='@all' 时存在）。 */
  allAgentIds?: string[]
  reason: string
}

/** 据点消息级联删除结果。 */
export interface StrongholdMessageDeleteResult {
  deletedCount: number
  deletedMessageIds: number[]
}

export interface ButlerConfig {
  id: number
  name: string
  enabled: boolean
  persona?: string
}

export interface ButlerCommandResult {
  action:
    | 'status'
    | 'inspect_environment'
    | 'summon_all'
    | 'move_agent'
    | 'create_room'
    | 'update_environment'
  message: string
  data?: unknown
}

export type ButlerAction =
  | { type: 'status' }
  | { type: 'inspect_environment' }
  | { type: 'summon_all' }
  | { type: 'move_agent'; agentId: string; targetRoomId?: string }
  | {
      type: 'create_room'
      room: {
        facilityId: number
        name: string
        description?: string
        allowedAgents?: string[]
        environment?: Record<string, unknown>
      }
    }
  | { type: 'update_environment'; key: string; value: unknown; targetRoomId?: string }

// ── API ──

export const strongholdApi = {
  setPresence: (roomId: string, present: boolean, operationId: string) =>
    apiClient.post<StrongholdLifeSnapshot>(`/stronghold/rooms/${roomId}/presence`, { present, operationId }),

  activity: (roomId: string, command: StrongholdActivityCommand, operationId: string) =>
    apiClient.post<unknown>(`/stronghold/rooms/${roomId}/activities`, { command, operationId }),
  // ═══ 设施 ═══

  /** 获取所有设施 */
  listFacilities: () => apiClient.get<Facility[]>('/stronghold/facilities'),

  /** 创建设施 */
  createFacility: (data: { name: string; icon?: string; description?: string }) =>
    apiClient.post<Facility>('/stronghold/facilities', data),

  // ═══ 房间 ═══

  /** 获取房间列表 (可按设施过滤) */
  listRooms: (facilityId?: number) =>
    apiClient.get<Room[]>(`/stronghold/rooms${facilityId ? `?facilityId=${facilityId}` : ''}`),

  /** 创建房间 */
  createRoom: (data: { facilityId: number; name: string; description?: string }) =>
    apiClient.post<Room>('/stronghold/rooms', data),

  /** 更新房间 */
  updateRoom: (roomId: string, data: { name?: string; description?: string }) =>
    apiClient.put<Room>(`/stronghold/rooms/${roomId}`, data),

  /** 删除房间 */
  deleteRoom: (roomId: string) => apiClient.delete<void>(`/stronghold/rooms/${roomId}`),

  // ═══ Agent 位置 ═══

  /** 移动 Agent 到指定房间 */
  moveAgent: (agentId: string, roomId: string) =>
    apiClient.post<AgentLocation>('/stronghold/locations/move', { agentId, roomId }),

  /** 获取 Agent 当前位置 */
  getAgentLocation: (agentId: string) =>
    apiClient.get<Room | null>(`/stronghold/locations/${agentId}`),

  // ═══ 群聊消息 ═══

  /** 获取房间成员、消息 Shell 与 committed Surfaces。 */
  getProjection: (roomId: string, limit = 100) =>
    apiClient.get<StrongholdProjectionSnapshot>(
      `/stronghold/rooms/${roomId}/projection?limit=${limit}`,
    ),

  /** 获取房间消息历史 */
  getMessages: (roomId: string, limit = 50) =>
    apiClient.get<GroupMessage[]>(`/stronghold/rooms/${roomId}/messages?limit=${limit}`),

  /** 获取房间消息总数（对话日志列表展示用，轻量计数）。 */
  getMessageCount: (roomId: string) =>
    apiClient.get<{ count: number }>(`/stronghold/rooms/${roomId}/message-count`),

  /** 发送消息 */
  sendMessage: (
    roomId: string,
    content: string,
    { senderId = 'user', role, mentions }: SendStrongholdMessageOptions = { role: 'user' },
  ) =>
    apiClient.post<StrongholdMessageDispatch>(`/stronghold/rooms/${roomId}/messages`, {
      content,
      senderId,
      role,
      mentions,
    }),

  /** 级联删除本轮群聊消息（用户发言与全部关联回复）。 */
  deleteMessage: (roomId: string, messageId: number) =>
    apiClient.delete<StrongholdMessageDeleteResult>(
      `/stronghold/rooms/${roomId}/messages/${messageId}`,
    ),

  /** 获取房间成员 */
  getRoomMembers: (roomId: string) =>
    apiClient.get<RoomMember[]>(`/stronghold/rooms/${roomId}/members`),

  /** 添加成员到房间 */
  addMember: (roomId: string, agentId: string, role?: string) =>
    apiClient.post<void>(`/stronghold/rooms/${roomId}/members`, { agentId, role }),

  // ═══ 管家 ═══

  /** 执行管家命令 */
  callButler: (roomId: string, command: string, action?: ButlerAction) =>
    apiClient.post<ButlerCommandResult>(`/stronghold/rooms/${roomId}/butler-command`, {
      command,
      action,
    }),

  /** 获取管家配置 */
  getButlerConfig: () => apiClient.get<ButlerConfig>('/stronghold/butler'),

  /** 切换管家启用状态 */
  toggleButler: (enabled: boolean) => apiClient.put<void>('/stronghold/butler/toggle', { enabled }),
}

export interface StrongholdActivityCommand {
  action: 'create' | 'update' | 'join' | 'leave' | 'pause' | 'resume' | 'end' | 'invite' | 'respond'
  id?: string
  revision?: number
  title?: string
  agentIds?: string[]
  response?: 'accepted' | 'declined' | 'later' | 'cancelled'
}
