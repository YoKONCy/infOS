/**
 * Capability 协议共享类型定义
 *
 * 第七阶段修复（批次 E2）：把 Daemon 与 Electron 之间的 IPC 消息类型和能力返回格式
 * 提取到 @infos/shared，避免两端各写一套导致不一致（P0-2/P0-3 的根因）。
 *
 * Daemon (capabilityBridge.ts) 和 Electron (capabilityProvider.ts) 都应 import 此模块。
 *
 * @module packages/shared/src/types/capability.types
 */

import type { KernelCapabilityOffer, KernelEnvelope, KernelError } from './kernel.types'
import type { KernelNodeDescriptor, KernelNodeId, KernelNodeSessionId } from './node.types'

export const WEB_PAGE_OPERATIONS = [
  'open',
  'inspect',
  'extract',
  'search',
  'screenshot',
  'elementScreenshot',
  'click',
  'nativeClick',
  'hover',
  'type',
  'sendKeys',
  'setValue',
  'selectOption',
  'check',
  'scroll',
  'back',
  'wait',
  'listTargets',
  'createTarget',
  'switchTarget',
  'closeTarget',
  'domQuery',
  'frameQuery',
  'handleDialog',
  'sourceSearch',
  'networkQuery',
  'networkBody',
  'networkConfigure',
  'downloadConfigure',
  'storage',
  'emulate',
  'evaluate',
  'runtimeStatus',
  'uploadFile',
  'observeFrame',
] as const

export type WebPageOperation = (typeof WEB_PAGE_OPERATIONS)[number]

/** 旁观帧不携带可用于操作的截图引用，也不接受观看端的视口参数。 */
export interface BrowserObserverFrame {
  state: 'live' | 'waiting' | 'closed' | 'paused'
  targetId?: string
  title?: string
  url?: string
  dataUri?: string
  width?: number
  height?: number
  capturedAt?: number
}

export interface BrowserObserverSession {
  id: string
  agentId: string
  threadId: string
  taskId?: string
  requestedVisible: boolean
  available: boolean
  updatedAt: number
}
export const webPageCapabilityName = (operation: WebPageOperation): string =>
  `web.page.${operation}`

// ─────────────────────────────────────────────
// IPC 消息类型（Daemon ↔ 能力节点）
// ─────────────────────────────────────────────

/** Daemon → Node 的统一调用消息。 */
export type DaemonToNodeMessage = { protocolVersion: 1 } & (
  | {
      type: 'capability_invoke'
      invocationId: string
      providerId: string
      envelope: KernelEnvelope<{ operation: string; input: unknown }>
    }
  | {
      type: 'capability_cancel'
      invocationId: string
      reason: string
    }
  | {
      type: 'node_accepted'
      sessionId: KernelNodeSessionId
      leaseExpiresAt: string
    }
  | { type: 'authenticated'; deviceToken?: string }
  | { type: 'error'; message: string }
)

/** Node → Daemon 的统一注册、心跳与调用结果消息。 */
export type NodeToDaemonMessage = { protocolVersion: 1 } & (
  | {
      type: 'node_hello'
      descriptor: KernelNodeDescriptor
      offers: KernelCapabilityOffer[]
    }
  | {
      type: 'heartbeat'
      nodeId: KernelNodeId
      sessionId: KernelNodeSessionId
    }
  | {
      type: 'capability_result'
      invocationId: string
      success: boolean
      output?: unknown
      error?: KernelError
    }
  | { type: 'authenticate'; token: string }
)

export type CapabilityTransportMessage = DaemonToNodeMessage | NodeToDaemonMessage

// ─────────────────────────────────────────────
// 标准化能力返回格式
// ─────────────────────────────────────────────

/**
 * 截图能力返回格式（标准化）
 *
 * reactLoop 的多模态截图注入逻辑按此结构解析 screenshots[].dataUri。
 * 任何提供 screen_capture 能力的节点都必须返回此格式。
 */
export interface ScreenCaptureResult {
  success: boolean
  observationId?: string
  screenshotId?: string
  referenceScreenshotId?: string
  screenshots: Array<{
    /** 截图索引（多显示器场景） */
    index: number
    /** Data URI 格式的图片（data:image/png;base64,...） */
    dataUri: string
    /** 局部图坐标到桌面 DIP 或网页 CSS 视口的映射，由采集客户端签发。 */
    coordinateContext?: {
      coordinateSpace: 'screenshot'
      sourceCoordinateSpace?: 'desktop-dip' | 'viewport-css'
      observationId?: string
      screenshotId?: string
      referenceObservationId?: string
      displayId?: string
      targetId?: string
      generation?: number
      screenshotWidth: number
      screenshotHeight: number
      bounds: { x: number; y: number; width: number; height: number }
      workArea?: { x: number; y: number; width: number; height: number }
      scaleFactor?: number
      viewport?: {
        width: number
        height: number
        scrollX: number
        scrollY: number
        revision: number
        zoomFactor: number
      }
    }
  }>
  /** 人类可读的摘要 */
  message: string
}

/**
 * 剪贴板读取返回格式
 */
export interface ClipboardReadResult {
  text: string
}

/**
 * 剪贴板写入返回格式
 */
export interface ClipboardWriteResult {
  success: boolean
}

/**
 * 活动窗口查询返回格式
 */
export interface ActiveWindowResult {
  title: string
  app?: string
}
