/**
 * 共享类型汇总导出
 *
 * @module packages/shared/src/types
 */

export * from './social-ports.types'
export * from './application.types'
export * from './event-memory.types'

export type {
  SurfaceId,
  SurfaceNodeId,
  SurfaceNodeKind,
  ModelRetryInfo,
  ModelRetrySurfaceProps,
  SurfaceNodeLifecycle,
  SurfaceNode,
  MarkdownSurfaceProps,
  NativeReasoningSurfaceProps,
  ThinkingSurfaceProps,
  ToolCallSurfaceProps,
  ToolResultSurfaceProps,
  StatusSurfaceProps,
  ConversationExecutionPause,
  ErrorSurfaceProps,
  AttachmentSurfaceProps,
  ProgressSurfaceProps,
  InputSurfaceProps,
  ApprovalSurfaceProps,
  SurfaceDescriptor,
  SurfaceProjectionSnapshot,
  PanelSurfaceProps,
  TableSurfaceProps,
  NotificationSurfaceProps,
  DocumentSurfaceProps,
  ProgrammableIslandSurfaceProps,
  ConversationSurfaceDescriptor,
  SurfaceOperation,
  SurfaceFrame,
  ConversationContentBlock,
  ConversationMessageProjection,
  ConversationProjectionSnapshot,
  SurfaceInput,
  BackgroundTaskProjectionSnapshot,
  StrongholdMessageProjection,
  StrongholdProjectionSnapshot,
} from './surface.types'

export type {
  KernelId,
  KernelObjectId,
  KernelExecutionId,
  KernelProcessId,
  KernelEventId,
  KernelCapabilityId,
  KernelObjectRef,
  KernelExecutionClass,
  KernelExecutionState,
  KernelExecutionWaitReason,
  KernelExecutionUsage,
  KernelExecutionSnapshot,
  KernelExecutionBudget,
  KernelExecutionDescriptor,
  KernelExitStatus,
  KernelCapabilityRisk,
  KernelCapabilityOperationDefinition,
  KernelCapabilityDefinition,
  KernelCapabilityOffer,
  KernelCapabilityRequirement,
  KernelCapabilityHandle,
  KernelEventDurability,
  KernelCarrier,
  DeliveryAudience,
  DurableStreamCursor,
  DurableStreamSnapshot,
  DurableStreamDescriptor,
  KernelCallContext,
  KernelError,
  KernelEnvelope,
  KernelEventEnvelope,
  KernelExecutionEvent,
  ConversationKernelEvent,
  KernelEvent,
  KernelOutboxEventInput,
} from './kernel.types'

export type {
  ApiResponse,
  PaginatedData,
  PaginationParams,
  SseEventType,
  ThreadChannel,
  InteractionMode,
} from './api.types'
export type { SseDoneEvent, SseErrorEvent, SseEvent } from './api.types'

export type {
  MemoryType,
  MemorySource,
  Sentiment,
  MemoryDto,
  CreateMemoryDto,
} from './memory.types'

export type {
  AgentRole,
  ModeCapability,
  SkillManifest,
  ResolvedCapability,
  AgentPublicProfile,
  AgentProfileDto,
  PetStateDto,
  UpdatePetStateDto,
} from './agent.types'

export type { ChatRole, ConversationLogDto, AnalysisStatus, AiModelConfigDto } from './chat.types'

// 第七阶段修复（批次 E2）：能力协议共享类型
export { WEB_PAGE_OPERATIONS, webPageCapabilityName } from './capability.types'
export type {
  WebPageOperation,
  BrowserObserverFrame,
  BrowserObserverSession,
  DaemonToNodeMessage,
  NodeToDaemonMessage,
  CapabilityTransportMessage,
  ScreenCaptureResult,
  ClipboardReadResult,
  ClipboardWriteResult,
  ActiveWindowResult,
} from './capability.types'

export type {
  PackagePermission,
  PackageTrustLevel,
  PackageContributionKind,
  PackageContribution,
  PackageWebUiDefinition,
  PackageCapabilityRequirement,
  PackageSignature,
  PackageManifest,
  ToolDisplayMeta,
  ToolVisualSignatureMeta,
  PlatformId,
} from './package.types'

export type {
  ContextRegionKind,
  ContextRegionTrust,
  ContextRegionDelivery,
  ContextTokenizer,
  ContextRegionMaterializer,
  ContextRegion,
  ContextRegionRequest,
  ContextRegionProvider,
  ContextRegionManifestEntry,
  ContextRegionCompilation,
} from './context.types'

export type {
  KernelNodeId,
  KernelNodeSessionId,
  KernelInputSeatId,
  KernelNodeFacet,
  KernelNodeTrust,
  KernelNodeHealth,
  KernelExecutionPlacement,
  KernelDataResidency,
  KernelNodePlatform,
  KernelNodeDescriptor,
  NodeDescriptor,
  KernelNodeSession,
  NodeSession,
  KernelNodePlacement,
  KernelPlacementRequirement,
  KernelInputSeat,
  InputSeatLease,
  KernelResourceAuthority,
  KernelNodeRoute,
} from './node.types'

export type {
  WebEvidenceKind,
  WebTrustLevel,
  WebSideEffectClass,
  WebInteractionHandle,
  WebSceneEvidence,
  WebSceneAffordance,
  WebSceneObject,
  WebInjectionFinding,
  WebInteractionScene,
  WebExpectedEffect,
  WebObservedEffect,
  WebActionIntent,
  WebActionReceipt,
  WebSiteModel,
  WebTaskCheckpoint,
} from './web-agent.types'

export type {
  KernelAssetId,
  KernelFileHandleId,
  KernelTransferId,
  KernelCredentialId,
  KernelCredentialHandleId,
  KernelAssetObject,
  KernelFileOperation,
  KernelFileHandle,
  KernelTransferDirection,
  KernelTransferState,
  KernelTransferObject,
  KernelRuntimeEvent,
  KernelCredentialObject,
  KernelCredentialHandle,
} from './resource.types'
export { createResourceObjectRef } from './resource.types'

export type {
  RuntimeIdentity,
  RuntimeStableHandle,
  RuntimeSnapshot,
  RuntimeAdapterRequest,
  RuntimeAdapterResult,
  RuntimeAdapter,
} from './runtime.types'

export type {
  GatewayMessageType,
  GatewayEnvelope,
  GatewayPayload,
  StateUpdatePayload,
  TaskProgressPayload,
  NotificationPayload,
  SystemErrorPayload,
  HelloPayload,
  HelloAckPayload,
  HeartbeatPayload,
  ChatRequestPayload,
  GenericPayload,
  PushAction,
  RequestAction,
  CataloguedGatewayAction,
} from './gateway.types'
export { GATEWAY_ACTION_CATALOG, gatewayActionPolicy } from './gateway.types'
