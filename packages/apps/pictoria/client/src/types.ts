import type { ReferenceUse, VideoContinuation } from '../../src/creativeInputs'
import type { LlmCallOptions } from '../../src/assistantSettings'
export type { ReferenceUse, ReferencePurpose, VideoContinuation } from '../../src/creativeInputs'

export interface Asset {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  createdAt?: string
  meta?: {
    id: string
    revision: number
    title?: string
    favorite?: boolean
    final?: boolean
    tags?: string[]
    origin?: string
    runId?: string
    model?: string
    inputs?: Record<string, unknown>
    createdAt?: string
  }
}
export type OutputPort = 'right' | 'bottom'
export type InputPort = 'left' | 'top'
export interface InputConnection {
  source: string
  field: string
  sourcePort?: OutputPort
  targetPort?: InputPort
}
export interface AssetReference {
  assetId: string
  name: string
  mimeType?: string
  source?: string
}
export interface CanvasEdge extends InputConnection {
  id: string
  target: string
  historical?: boolean
}
export interface Prompt {
  id: string
  revision: number
  title: string
  text: string
  tags: string[]
  usage?: string
}
export interface CanvasItem {
  id: string
  x: number
  y: number
  content: {
    version: 1
    kind: 'text' | 'asset' | 'run' | 'draft' | 'group'
    width: number
    height: number
    text?: string
    comment?: string
    promptText?: string
    name?: string
    assetId?: string
    mimeType?: string
    runId?: string
    state?: string
    error?: string
    outputIds?: string[]
    outputsResolved?: boolean
    step?: Step
    inputs?: Record<string, unknown>
    request?: { fingerprint: string; key: string }
    originId?: string
    groupId?: string
    candidateGroupId?: string
    primaryAssetId?: string
    candidatesExpanded?: boolean
    candidateParentId?: string
    showAdvanced?: boolean
    inputOrder?: Record<string, string[]>
    referenceUses?: ReferenceUse[]
    continuation?: VideoContinuation
  }
}
export interface CanvasCollection {
  id: string
  title: string
  revision: number
}
export interface CreationPreferences {
  stepId: string
  text: string
  inputsByStep: Record<string, Record<string, unknown>>
  referenceUsesByStep?: Record<string, ReferenceUse[]>
}
export interface Project {
  id: string
  title: string
  revision: number
  collectionId?: string | null
  items: CanvasItem[]
  edges?: CanvasEdge[]
  dismissedRunIds?: string[]
  creation?: CreationPreferences
  viewport?: { x: number; y: number; scale: number }
}
export interface FieldSchema {
  [key: string]: unknown
  type?: string
  title?: string
  description?: string
  enum?: unknown[]
  default?: unknown
  minimum?: number
  maximum?: number
  properties?: Record<string, FieldSchema>
  items?: FieldSchema
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  required?: string[]
  additionalProperties?: boolean
}
export interface Step {
  id: string
  name: string
  modelName?: string
  providerName?: string
  revision: number
  usageDescription: string
  available: boolean
  reason?: string
  inputSchema: FieldSchema
  outputSchema?: FieldSchema
  implementation?: {
    kind: 'service' | 'llm' | 'workflow'
    serviceId?: string
    system?: string
    modelId?: string
    outputMode?: 'text' | 'json'
    options?: LlmCallOptions
    workflowId?: string
    revision?: number
  }
}
export interface Run {
  inputs?: Record<string, unknown>
  id: string
  projectId: string
  state: string
  name: string
  error?: string
  result?: Record<string, unknown>
  nodes: Array<{
    id: string
    state: string
    error?: string
    remoteId?: string
    startedAt?: string
    finishedAt?: string
    step?: Step
    inputs?: Record<string, unknown>
    retry?: { phase: string; count: number; firstAt: string; nextAt: string }
    outputs?: Record<string, unknown>
  }>
}
export interface HostStatus {
  ownership: string
  managedRuntimeAvailable: boolean
  managedRuntimeReason?: string
  lastError?: string
  federation: { state: string; lastError?: string }
}
export interface ModelProvider {
  id: string
  revision: number
  name: string
  baseUrl: string
  enabled: boolean
  protocol: 'http' | 'openai'
  defaultModel: string
  modelsPath?: string
  requiresCredential: boolean
  authHeader: string
  authPrefix: string
  hasCredential: boolean
}
export interface ProviderDirectory {
  adapters: Array<{ id: string; name: string; capabilities: string[]; editor: string }>
  providers: ModelProvider[]
}
export interface ServiceProfile {
  id: string
  revision: number
  name: string
  enabled: boolean
  baseUrl: string
  providerId?: string
  adapter?: 'atlascloud' | 'apimodels'
  credentialId?: string
  credentialSourceId?: string
  credentialError?: string
  hasCredential: boolean
  requiresCredential: boolean
  authHeader: string
  authPrefix: string
  headers: Record<string, string>
  submit: {
    path: string
    method: 'GET' | 'POST' | 'PUT'
    bodyFormat: 'json' | 'multipart'
    body: Record<string, unknown>
    fields: Record<string, { from: string; format: string }>
    outputs: Record<string, { path: string; kind: string }>
    taskIdField?: string
  }
  poll?: {
    path: string
    stateField: string
    success: string[]
    failed: string[]
    intervalMs: number
  }
  timeoutMs: number
  requestTimeoutMs?: number
  recoveryWindowMs?: number
  concurrency: number
  idempotencyHeader?: string
  idempotencyWindowMs?: number
  cancel?: { path: string; method: string }
}
export interface Bootstrap {
  agents: Array<{ id: string; name: string }>
  status: HostStatus
}
export interface SurfaceBridge {
  embedded?: boolean
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send?(channel: string, ...args: unknown[]): void
  on?(channel: string, listener: (value: unknown) => void): () => void
}
