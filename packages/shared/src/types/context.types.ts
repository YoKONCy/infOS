/**
 * context.types — 跨包共享协议层
 *
 * 负责定义该模块的稳定入口、数据边界与错误语义。
 * 调用方通过这里访问领域能力，避免绕过校验直接耦合内部状态。
 */
import type { KernelObjectRef } from './kernel.types'
import type { InteractionMode } from './api.types'

export type ContextRegionKind =
  | 'identity'
  | 'rules'
  | 'state'
  | 'capability'
  | 'memory'
  | 'flow'
  | 'continuity'
  | 'thread'
  | 'user'
  | 'summary'
  | 'observer'
  | 'custom'

export type ContextRegionTrust = 'system' | 'principal' | 'authority' | 'derived' | 'external'
export type ContextRegionDelivery = 'manifest-only' | 'system' | 'conversation'

export interface ContextTokenizer {
  tokenizerId: string
  countTokens(content: string): number
}

export type ContextRegionMaterializer = () => string | Promise<string>

export interface ContextRegion {
  regionId: string
  providerId: string
  kind: ContextRegionKind
  trust: ContextRegionTrust
  priority: number
  required: boolean
  tokenEstimate: number
  contentHash: string
  sourceGeneration?: string | number
  content: string
  /** 正文无法放入预算时使用的来源信息，仍由统一选择器计费。 */
  fallbackContent?: string
  materialize?: ContextRegionMaterializer
  delivery: ContextRegionDelivery
  sourceObjectRefs: readonly KernelObjectRef[]
  provenance: Readonly<Record<string, unknown>>
  validUntil?: string
  deduplicationKey?: string
}

export interface ContextRegionRequest {
  agentId: string
  threadId: string
  channel: string
  /** 宿主提供的只读场景快照；可选以兼容旧的请求构造方。 */
  readonly interactionMode?: InteractionMode
  readonly background?: boolean
  readonly realmExecution?: boolean
  readonly taskId?: string
  tokenBudget: number
  retrievalQuery?: string
  enabledKinds?: readonly ContextRegionKind[]
  limits?: Readonly<Record<string, number>>
  now: string
}

export interface ContextRegionProvider {
  providerId: string
  provide(
    request: ContextRegionRequest,
  ): Promise<readonly ContextRegion[]> | readonly ContextRegion[]
}

export interface ContextRegionManifestEntry {
  providerId: string
  regionId: string
  kind: ContextRegionKind
  trust: ContextRegionTrust
  priority: number
  required: boolean
  tokenEstimate: number
  contentHash: string
  sourceGeneration: string | number
  sourceObjectRefs: readonly KernelObjectRef[]
  selected: boolean
  reason: 'selected' | 'fallback' | 'duplicate' | 'expired' | 'budget_exceeded' | 'empty'
}

export interface ContextRegionCompilation {
  snapshotId: string
  selected: readonly Readonly<ContextRegion>[]
  manifest: readonly Readonly<ContextRegionManifestEntry>[]
  usedTokens: number
  budget: number
}
