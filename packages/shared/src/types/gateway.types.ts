/**
 * Gateway WebSocket 协议类型 (共享包)
 *
 * 前后端共用的 WS 消息信封和 payload schema。
 * 消除后端 gateway/types.ts 和前端 useGateway.ts 中
 * 对 Record<string, unknown> 的松散依赖。
 *
 * @module packages/shared/src/types/gateway.types
 */

// ─────────────────────────────────────────────
// Push Action 目录
// ─────────────────────────────────────────────

import type { DeliveryAudience, KernelEventDurability } from './kernel.types'
import type { DeviceNotificationRequest, NotificationAvailablePayload } from '../notifications'

export const GATEWAY_ACTION_CATALOG = {
  thread_reset: {
    durability: 'ephemeral',
    audience: 'all_principal_clients',
    recovery: 'conversation-projection',
  },
  plan_changed: {
    durability: 'ephemeral',
    audience: 'all_principal_clients',
    recovery: 'task-plan-projection',
  },
  conversation_reply_ready: {
    durability: 'ephemeral',
    audience: 'all_principal_clients',
    recovery: 'conversation-projection',
  },
  state_update: {
    durability: 'ephemeral',
    audience: 'all_principal_clients',
    recovery: 'pet-state-projection',
  },
  surface: {
    durability: 'ephemeral',
    audience: 'thread_subscribers',
    recovery: 'conversation-projection',
  },
  task_progress: {
    durability: 'ephemeral',
    audience: 'execution_subscribers',
    recovery: 'execution-projection',
  },
  notification: { durability: 'ephemeral', audience: 'active_input_seat', recovery: 'none' },
  durable_notification: {
    durability: 'durable',
    audience: 'all_principal_clients',
    recovery: 'notification-projection',
  },
  system_error: { durability: 'ephemeral', audience: 'active_input_seat', recovery: 'none' },
  tool_approval_requested: {
    durability: 'durable',
    audience: 'active_input_seat',
    recovery: 'approval-projection',
  },
  tool_approval_resolved: {
    durability: 'durable',
    audience: 'all_principal_clients',
    recovery: 'approval-projection',
  },
  agent_input_requested: {
    durability: 'durable',
    audience: 'active_input_seat',
    recovery: 'agent-input-projection',
  },
  agent_input_resolved: {
    durability: 'durable',
    audience: 'all_principal_clients',
    recovery: 'agent-input-projection',
  },
  proactive_message: {
    durability: 'durable',
    audience: 'thread_subscribers',
    recovery: 'conversation-projection',
  },
  audio_chunk: { durability: 'ephemeral', audience: 'specific_node', recovery: 'audio-asset' },
  voice_state: { durability: 'ephemeral', audience: 'specific_node', recovery: 'none' },
  voice_error: { durability: 'ephemeral', audience: 'specific_node', recovery: 'none' },
  voice_transcript: {
    durability: 'ephemeral',
    audience: 'thread_subscribers',
    recovery: 'conversation-projection',
  },
} as const satisfies Record<
  string,
  {
    durability: KernelEventDurability
    audience: DeliveryAudience['type']
    recovery: string
  }
>

export type CataloguedGatewayAction = keyof typeof GATEWAY_ACTION_CATALOG

/** 新增业务 Push 必须通过该函数取得显式分类，未登记 Action 会在编译期失败。 */
export function gatewayActionPolicy(action: CataloguedGatewayAction) {
  return GATEWAY_ACTION_CATALOG[action]
}

// ─────────────────────────────────────────────
// 信封 (Envelope)
// ─────────────────────────────────────────────

/** WS 消息类型 */
export type GatewayMessageType =
  // 握手
  | 'hello'
  | 'hello_ack'
  // 心跳
  | 'heartbeat'
  | 'heartbeat_ack'
  // 请求/响应
  | 'request'
  | 'response'
  // 推送 (广播)
  | 'push'
  // 错误
  | 'error'

/** WS 消息信封 (类 JSON-RPC) */
export interface GatewayEnvelope<T = GatewayPayload> {
  /** 协议版本 */
  protocolVersion?: 1
  /** 消息 ID (UUID) */
  id: string
  /** 消息类型 */
  type: GatewayMessageType
  /** 发送方 ID */
  sourceId: string
  /** 目标 ID；旧 "broadcast" 仅作 Transport 兼容，不表示业务 Audience。 */
  targetId: string
  /** 业务 Push 的投递受众。 */
  audience?: DeliveryAudience
  /** 事件恢复语义。 */
  durability?: KernelEventDurability
  /** Durable Stream 内序号。 */
  sequence?: number
  /** 时间戳 (ms) */
  timestamp: number
  /** 负载 */
  payload: T
}

// ─────────────────────────────────────────────
// Payload 联合类型
// ─────────────────────────────────────────────

/** 所有 Push 推送 Payload 的联合类型 */
export type GatewayPayload =
  | DeviceNotificationRequest
  | NotificationAvailablePayload
  | StateUpdatePayload
  | TaskProgressPayload
  | NotificationPayload
  | SystemErrorPayload
  | HelloPayload
  | HelloAckPayload
  | HeartbeatPayload
  | ChatRequestPayload
  | GenericPayload

// ─────────────────────────────────────────────
// 已定型的 Payload
// ─────────────────────────────────────────────

/** 会话角色状态投影；按 agentId 与 threadId 隔离，revision 防止撤回后被旧推送覆盖。 */
export interface StateUpdatePayload {
  action: 'state_update'
  /** 目标 agent，前端按当前活跃 agent 过滤 */
  agentId?: string
  threadId?: string
  revision?: number
  /** 完整投影替换，撤回时也可清空临时台词。 */
  replace?: boolean
  mood?: string
  vibe?: string
  mind?: string
  /** 点击台词热更新 (按部位) */
  click_messages?: Record<string, string[]>
  /** 空闲台词热更新 */
  idle_messages?: string[]
  /** 回归台词热更新 */
  back_messages?: string[]
  /** 临时台词过期时间 */
  text_expires_at?: string | null
}

/** 任务进度推送 */
export interface TaskProgressPayload {
  action: 'task_progress'
  sessionId: string
  turn: number
  state: 'running' | 'paused' | 'completed' | 'cancelled' | 'error'
  message?: string
}

/** 通知推送 */
export interface NotificationPayload {
  action: 'notification'
  title: string
  body?: string
  level?: 'info' | 'success' | 'warning' | 'error'
  duration?: number
  source?: string
}

/** 系统错误推送 */
export interface SystemErrorPayload {
  action: 'system_error'
  message: string
  title?: string
}

/** Hello 握手请求 */
export interface HelloPayload {
  profile?: 'full' | 'notifications'
  action?: undefined
  token?: string
  deviceName?: string
}

/** Hello 握手确认 */
export interface HelloAckPayload {
  action?: undefined
  nodeId: string
  profile?: 'full' | 'notifications'
  deviceId?: string
  features?: string[]
  latestSequence?: number
}

/** 心跳空 payload */
export interface HeartbeatPayload {
  action?: undefined
  latestSequence?: number
}

/** 聊天请求 payload */
export interface ChatRequestPayload {
  action: 'chat' | 'chat_stream' | 'stop_generation' | 'switch_agent' | 'inject_instruction'
  content?: string
  sessionId?: string
  agentId?: string
  [key: string]: unknown
}

/** 通用兜底 payload (向下兼容) */
export interface GenericPayload {
  action?: string
  [key: string]: unknown
}

// ─────────────────────────────────────────────
// Push Action 枚举 (用于 switch/case)
// ─────────────────────────────────────────────

/** Push 推送的 action 名；新增业务 Push 必须先进入 Action Catalog。 */
export type PushAction = CataloguedGatewayAction

/** Request 请求的 action 名 */
export type RequestAction =
  | 'chat'
  | 'chat_stream'
  | 'stop_generation'
  | 'switch_agent'
  | 'inject_instruction'
