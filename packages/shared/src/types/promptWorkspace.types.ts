export type PromptRole = 'system' | 'user' | 'assistant'
export type PromptKind = 'slot' | 'component' | 'task'
export type PromptFormat = 'infos' | 'sillytavern' | 'custom'
export type PromptGenerationType =
  | 'normal'
  | 'continue'
  | 'impersonate'
  | 'swipe'
  | 'regenerate'
  | 'quiet'

export interface PromptDocument {
  id: string
  name: string
  kind: PromptKind
  body: string
  role: PromptRole
  enabled: boolean
  builtin?: boolean
  /** 保存时所依据的内置正文指纹，用于升级未改动的内置模板。 */
  builtinBodyHash?: string
  variables: string[]
}

export interface PromptBinding {
  name: string
  kind: 'template' | 'capabilities' | 'persona'
  source?: string
  template?: string
  when?: string
}

export interface PromptBlock {
  id: string
  name: string
  kind: 'template' | 'history' | 'marker'
  role: PromptRole
  enabled: boolean
  source?: string
  template?: string
  when?: string
  marker?: string
  position?: 'relative' | 'in_chat'
  depth?: number
  order?: number
  /** 保留未知触发类型，发布校验会阻止启用不支持的类型。 */
  triggers?: string[]
  stIdentifier?: string
  forbidOverrides?: boolean
}

export interface PromptFramework {
  id: string
  name: string
  builtin?: boolean
  format?: PromptFormat
  overrides?: Record<string, string>
  bindings: PromptBinding[]
  blocks: PromptBlock[]
  sillyTavern?: {
    markerBindings: Record<string, string>
    values: Record<string, string>
    sourcePreset?: Record<string, unknown>
    orderProfile?: number
    utility?: Partial<Record<StUtilityKey, string>>
    characters?: Record<string, StCharacterPrompt>
  }
}

export type StUtilityKey =
  | 'new_chat_prompt'
  | 'new_group_chat_prompt'
  | 'new_example_chat_prompt'
  | 'group_nudge_prompt'
  | 'continue_nudge_prompt'
  | 'impersonation_prompt'
  | 'send_if_empty'
  | 'scenario_format'
  | 'personality_format'
export interface StCharacterPrompt {
  main?: string
  postHistory?: string
  description?: string
  personality?: string
  scenario?: string
  examples?: string
  firstMessage?: string
  creatorNotes?: string
  version?: string
  authorsNote?: string
}
export interface PromptVariableState {
  local: Record<string, string>
  global: Record<string, string>
}
export interface PromptVariableEffects {
  local: Array<{ name: string; before?: string; after?: string; write: boolean }>
  global: Array<{ name: string; before?: string; after?: string; write: boolean }>
}
export interface PromptVariableCommit {
  id: string
  scope: string
  epoch?: number
  effects: PromptVariableEffects
}

/** 按全局、频道、角色、角色频道的顺序覆盖；空字段表示继承。 */
export interface PromptAssignment {
  agentId: string
  channel: string
  frameworkId: string
  overrides: Record<string, string>
}

export interface PromptBundle {
  documents: PromptDocument[]
  frameworks: PromptFramework[]
  assignments: PromptAssignment[]
}

/** 可独立分享的框架预设；只携带依赖正文，不携带本机角色与频道指派。 */
export interface PromptPreset {
  format: 'infos-prompt-preset'
  version: 1
  name: string
  exportedAt: string
  framework: PromptFramework
  documents: PromptDocument[]
}

export interface PromptRelease {
  id: string
  createdAt: string
  note: string
  bundle: PromptBundle
}

export interface PromptIssue {
  level: 'error' | 'warning'
  source: string
  message: string
}

export interface PromptPreviewSegment {
  id: string
  source: string
  role: PromptRole
  content: string
  tokens: number
  originalRole?: PromptRole
}

export interface PromptPreview {
  requestPlan?: import('../contentMode').CompiledPromptPlan
  frameworkId: string
  revision: string
  segments: PromptPreviewSegment[]
  tokens: number
  issues: PromptIssue[]
}

export interface SillyTavernImport {
  framework: PromptFramework
  issues: PromptIssue[]
  orderProfiles: Array<{ value: number; label: string }>
}

export interface PromptWorkspaceView {
  recoveryError?: string
  revision: number
  activeReleaseId: string
  draft: PromptBundle
  defaults: PromptBundle
  releases: Array<Omit<PromptRelease, 'bundle'>>
  variables: Array<{ name: string; label: string }>
}
