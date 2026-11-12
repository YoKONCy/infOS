/**
 * infOS Internal Surface Protocol。
 *
 * 仅供系统 Projection、Shell 与 Compositor 使用，不属于第三方应用 ABI。
 */

import type { ConversationGenerationStats } from '../tokenUsage'

export type SurfaceId = string & { readonly __surfaceBrand: 'SurfaceId' }
export type SurfaceNodeId = string & { readonly __surfaceNodeBrand: 'SurfaceNodeId' }

export type SurfaceNodeKind =
  | 'markdown'
  | 'native-reasoning'
  | 'model-retry'
  | 'thinking'
  | 'code'
  | 'math'
  | 'mermaid'
  | 'tool-call'
  | 'tool-result'
  | 'status'
  | 'error'
  | 'attachment'
  | 'approval'
  | 'progress'
  | 'input'
  | 'panel'
  | 'table'
  | 'notification'
  | 'document'
  | 'programmable-island'

export type SurfaceNodeLifecycle = 'transient' | 'stable' | 'interactive' | 'heavy'

export interface SurfaceNode<TProps extends object = object> {
  nodeId: SurfaceNodeId
  kind: SurfaceNodeKind
  revision: number
  lifecycle: SurfaceNodeLifecycle
  props: TProps
}

export interface MarkdownSurfaceProps {
  final?: boolean
  source: string
  phase: 'preview' | 'committed'
}

/** 上游重试的持久时间线记录；计数表示已使用的重试次数，不含首次请求。 */
export interface ModelRetryInfo {
  modelId?: string
  fromModelId?: string
  modelLevel?: number
  modelLevels?: number
  modelAttempt?: number
  retryId: string
  state: 'waiting' | 'retrying' | 'recovered' | 'failed' | 'cancelled'
  attempt: number
  maxRetries: number
  delayMs: number
  reason: string
  startedAt: number
  updatedAt: number
  partialResponse: boolean
}

export interface ModelRetrySurfaceProps extends ModelRetryInfo {
  turn: number
}

export interface ThinkingSurfaceProps {
  turn?: number
  source: string
  phase: 'preview' | 'committed'
  durationMs?: number
}

export interface NativeReasoningSurfaceProps {
  turn?: number
  source: string
  phase: 'preview' | 'committed'
  mode: 'stream' | 'non_stream'
  durationMs?: number
}

export interface ToolCallSurfaceProps {
  callId: string
  /** 内部编排调用所属的外层工具。 */
  parentCallId?: string
  name: string
  args: string
  draftId?: string
  argsPreview?: string
  receivedChars?: number
  fileBaseline?: import('../fileMutationPreview').FileWritePreviewBaseline
  previewTruncated?: boolean
  state: 'assembling' | 'calling' | 'completed' | 'failed'
}

export interface ToolResultSurfaceProps {
  automaticApproval?: import('../executionMode').AutomaticApprovalRecord
  callId: string
  result: string
  isError: boolean
  durationMs?: number
}

/** 桌面接管后的持久暂停记录；继续时重新观察，不重放已完成的工具。 */
export interface ConversationExecutionPause {
  kind: 'desktop'
  code: string
  message: string
  toolName: string
  callId: string
  pausedAt: string
}

export interface StatusSurfaceProps {
  contextBudget?: import('../tokenUsage').LiveContextBudget
  state:
    | 'thinking'
    | 'assembling'
    | 'calling'
    | 'generating'
    | 'tool_failed'
    | 'queued'
    | 'running'
    | 'paused'
    | 'waiting_input'
    | 'waiting'
    | 'blocked'
    | 'completed'
    | 'failed'
    | 'cancelled'
  message?: string
  mode?: 'stream' | 'non_stream'
  firstTokenMs?: number
  outputDurationMs?: number
  totalDurationMs?: number
}

export interface ErrorSurfaceProps {
  code: string
  message: string
}

export interface AttachmentSurfaceProps {
  id: string
  kind: string
  name: string
  mimeType: string
  sizeBytes: number
  caption?: string
  origin?: import('../resources').ResourceOrigin
}

export interface ProgressSurfaceProps {
  value?: number | null
  stage?: string | null
}

export interface InputSurfaceProps {
  inputId: string
  questions?: import('../agentInput').AgentInputQuestion[]
  inputKind?: 'background_task' | 'agent_question'
  principalId?: string
  title: string
  question: string
  context?: Record<string, unknown> | null
  options?: Array<{ id: string; label: string; description?: string }>
  allowFreeText?: boolean
  required?: boolean
  actions: Array<{ id: string; label: string; tone?: 'primary' | 'danger' | 'neutral' }>
}

export interface ApprovalSurfaceProps {
  approvalId: string
  principalId: string
  threadId?: string
  toolName: string
  title: string
  summary: Record<string, unknown>
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
}

export interface SurfaceDescriptor {
  threadGeneration?: number
  processCollapsed?: boolean
  generationStats?: ConversationGenerationStats
  surfaceId: SurfaceId
  generation: string
  messageId?: string
  threadId: string
  principalId: string
  executionId?: string
  revision: number
  sequence: number
  state: 'open' | 'committed' | 'failed' | 'disposed'
  nodes: SurfaceNode[]
}

/** Conversation首轮兼容别名；Compositor实际消费通用SurfaceDescriptor。 */
export type ConversationSurfaceDescriptor = SurfaceDescriptor

export interface SurfaceProjectionSnapshot {
  protocolVersion: 1
  scopeId: string
  principalId: string
  revision: number
  generatedAt: string
  surfaces: SurfaceDescriptor[]
}

export interface PanelSurfaceProps {
  title: string
  subtitle?: string
  fields: Array<{
    key: string
    label: string
    value: string
    tone?: 'normal' | 'success' | 'warning' | 'danger'
  }>
}

export interface TableSurfaceProps {
  columns: Array<{ key: string; label: string }>
  rows: Array<Record<string, string | number | boolean | null>>
}

export interface NotificationSurfaceProps {
  title: string
  message: string
  level: 'info' | 'success' | 'warning' | 'error'
  createdAt: string
}

export interface DocumentSurfaceProps {
  documentId: string
  revisionId: string
  format: 'markdown' | 'html' | 'presentation'
  contentHash: string
  content: unknown
}

export interface ProgrammableIslandSurfaceProps {
  runtime: 'worker' | 'iframe' | 'wasm'
  sourceBlobId: string
  sourceHash: string
  entrypoint: string
  permissions: readonly string[]
  network: 'none'
  sandboxId: string
}

export type SurfaceOperation =
  | {
      type: 'surface.open'
      processCollapsed?: boolean
      threadId: string
      principalId: string
      nodes?: SurfaceNode[]
    }
  | {
      type: 'surface.append-text'
      nodeId: SurfaceNodeId
      delta: string
    }
  | {
      type: 'surface.append-tool-arguments'
      nodeId: SurfaceNodeId
      nameDelta?: string
      argumentsDelta?: string
      receivedChars: number
      previewTruncated: boolean
    }
  | {
      type: 'surface.upsert-node'
      node: SurfaceNode
    }
  | {
      type: 'surface.patch-node'
      nodeId: SurfaceNodeId
      patch: Record<string, unknown>
    }
  | {
      type: 'surface.commit'
      snapshot: ConversationProjectionSnapshot
      message: ConversationMessageProjection
      surface: ConversationSurfaceDescriptor
    }
  | {
      type: 'surface.publish' | 'surface.settled'
      snapshot: ConversationProjectionSnapshot
    }
  | {
      type: 'surface.fail'
      code: string
      message: string
      content?: string
    }
  | {
      type: 'surface.dispose'
    }

/** 单条实时 Surface 帧；sequence 在同一 generation 内严格递增。 */
export interface SurfaceFrame {
  threadId?: string
  threadGeneration?: number
  protocolVersion: 1
  surfaceId: SurfaceId
  generation: string
  revision: number
  sequence: number
  executionId?: string
  operationId: string
  operation: SurfaceOperation
}

export type ConversationContentBlock =
  | {
      blockId: string
      sequence: number
      kind: 'model_retry'
      turn: number
      retry: ModelRetryInfo
    }
  | {
      blockId: string
      sequence: number
      kind: 'narration'
      turn: number
      phase: 'progress' | 'final'
      content: string
    }
  | {
      blockId: string
      sequence: number
      kind: 'thinking'
      turn: number
      content: string
      durationMs?: number
    }
  | {
      blockId: string
      sequence: number
      kind: 'native_reasoning'
      turn: number
      content: string
      mode: 'stream' | 'non_stream'
      durationMs?: number
    }
  | {
      blockId: string
      sequence: number
      kind: 'tool'
      parentCallId?: string
      automaticApproval?: import('../executionMode').AutomaticApprovalRecord
      turn: number
      callId: string
      name: string
      args: string
      result?: string
      isError?: boolean
      durationMs?: number
    }

export interface ConversationMessageProjection {
  executionRecord?: boolean
  sourceMessages?: import('../conversation').ConversationSource[]
  publicationId?: string | null
  executionId?: string | null
  executionPause?: ConversationExecutionPause
  generationStats?: ConversationGenerationStats
  messageId: string
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** 独立口语答复；不得用完整正文作为语音回退。 */
  spokenReply?: string
  rawContent?: string | null
  pairId?: string | null
  senderId?: string | null
  agentId?: string | null
  revision: number
  imageTranscription: boolean
  status: string
  failureMessage?: string
  timestamp: string
  /** Assistant 可见输出的本地 Token 计数；用户消息不提供。 */
  outputTokens?: number
  contentBlocks: ConversationContentBlock[]
  toolCalls: Array<{
    parentCallId?: string
    automaticApproval?: import('../executionMode').AutomaticApprovalRecord
    callId?: string
    name: string
    args: string
    result?: string
    isError?: boolean
    durationMs?: number
  }>
  attachments: AttachmentSurfaceProps[]
}

export interface SurfaceInput {
  surfaceId: SurfaceId
  nodeId: SurfaceNodeId
  generation: string
  seat?: {
    seatId: string
    sessionId: string
    windowId: string
    epoch: number
  }
  action: 'approval.resolve' | 'agent-input.resolve' | 'background-task.submit-input'
  payload: Record<string, unknown>
}

export interface BackgroundTaskProjectionSnapshot {
  protocolVersion: 1
  taskId: string
  threadId: string
  principalId: string
  revision: number
  generatedAt: string
  surfaces: ConversationSurfaceDescriptor[]
}

export interface StrongholdMessageProjection {
  messageId: string
  roomId: string
  senderId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  pairId?: string | null
  timestamp?: string | null
  /** Assistant 可见输出的本地 Token 计数；用户消息不提供。 */
  outputTokens?: number
  surfaceId: SurfaceId
}

export interface StrongholdProjectionSnapshot {
  life?: import('../strongholdLife').StrongholdLifeSnapshot
  protocolVersion: 1
  roomId: string
  roomName: string
  revision: number
  generatedAt: string
  members: Array<{ agentId: string; role?: string | null }>
  messages: StrongholdMessageProjection[]
  surfaces: ConversationSurfaceDescriptor[]
}

/** 从领域表重建的权威 Conversation 读模型快照。 */
export interface ConversationProjectionSnapshot {
  /** 独立撤回的墓碑用于同步客户端已经加载的较早历史。 */
  deletedMessageIds?: string[]
  threadGeneration?: number
  protocolVersion: 1
  threadId: string
  principalId: string
  revision: number
  generatedAt: string
  messages: ConversationMessageProjection[]
  surfaces: ConversationSurfaceDescriptor[]
  totalMessages?: number
  pageSize?: number
  hasMoreBefore?: boolean
  beforeCursor?: string
}
