/** 家的后端协议；所有路径均由服务器规范化，sessionId 对应 Thread ID。 */
export interface HomeScope {
  agentId: string
  sessionId: string
  taskId?: string
}
export type HomeAction =
  | 'read'
  | 'write'
  | 'move'
  | 'delete'
  | 'app'
  | 'send'
  | 'pay'
  | 'settings'
  | 'terminal'
export interface HomeIntent {
  action: HomeAction
  paths: string[]
  app?: string
  /** 桌面动作必须绑定完整参数，不能只绑定应用名。 */
  parameters?: Record<string, unknown>
}
export type HomeChoice = 'once' | 'session' | 'permanent' | 'deny'
export interface HomeConfirmation extends HomeScope {
  id: string
  intent: HomeIntent
  reasons: string[]
  choices: HomeChoice[]
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'denied' | 'consumed'
  fingerprint: string
  revision: string
  runtimeId: string
  grantTargets: Array<{ kind: 'folder' | 'app'; target: string; access: 'read' | 'write' }>
  /** 批量确认的数量和范围：一次问清，批准后本任务内同类操作不再逐个问。 */
  summary?: { kind: 'own-delete' | 'create'; count: number; root: string }
}
export interface HomeGrant extends HomeScope {
  id: string
  kind: 'folder' | 'app'
  target: string
  access: 'read' | 'write'
  duration: 'session' | 'permanent'
  runtimeId?: string
}
export interface HomeActivity extends HomeScope {
  id: string
  time: number
  action: string
  objects: string[]
  result: 'success' | 'failed' | 'waiting' | 'conflict'
  checkpointId?: string
  detail?: string
}
export type HomeEvent =
  | { type: 'confirmation'; data: HomeConfirmation }
  | { type: 'activity'; data: HomeActivity }
  | { type: 'card-data'; data: { cardId: string; revision: number; data: Record<string, unknown> } }
  | { type: 'card-message'; data: { cardId: string; messageId: string; sessionId: string } }
export interface HomeSnapshot {
  path: string
  hash: string | null
  size: number
  mode?: number
}
/** Electron 接入契约：原生回收失败必须报错，不能退化为永久删除。 */
export interface HomeNativeTrashPort {
  trashItem(request: {
    path: string
    expectedHash: string
    checkpointId: string
    scope: HomeScope
  }): Promise<{ recycled: true; provider: 'system' }>
}
export interface HomeCheckpoint extends HomeScope {
  id: string
  createdAt: number
  action: 'write' | 'move' | 'delete'
  before: HomeSnapshot[]
  after: HomeSnapshot[]
  state: 'pending' | 'applied' | 'undone' | 'expired' | 'failed'
  provider?: 'system'
}
export interface HomeShelfItem {
  id: string
  agentId: string
  from: 'user' | 'agent'
  to: 'user' | 'agent'
  kind: 'file' | 'image' | 'text' | 'url'
  name: string
  value?: string
  hash?: string
  size: number
  createdAt: number
  deletedAt?: number
}
export interface HomeMapEntry {
  id: string
  agentId: string
  kind: 'app' | 'folder' | 'window'
  name: string
  location: string
  purpose: string
  updatedAt: number
  deletedAt?: number
}
export interface HomeLimits {
  massChangeThreshold: number
  massChangeWindowMs: number
  checkpointRetentionMs: number
  snapshotMaxBytes: number
  fileMaxBytes: number
  shelfMaxBytes: number
  shelfMaxItems: number
}
export const HOME_DEFAULT_LIMITS: HomeLimits = {
  massChangeThreshold: 10,
  massChangeWindowMs: 60_000,
  checkpointRetentionMs: 7 * 24 * 60 * 60_000,
  snapshotMaxBytes: 1024 * 1024 * 1024,
  fileMaxBytes: 32 * 1024 * 1024,
  shelfMaxBytes: 128 * 1024 * 1024,
  shelfMaxItems: 100,
}
export const HOME_SETTINGS_KEY = 'home.settings.v1'
/** 她删除用户文件去哪：system 是 Windows 回收站（默认），infos 是 infOS 回收区。 */
export type HomeDeleteTarget = 'system' | 'infos'
export const HOME_DELETE_TARGET_KEY = 'home.deleteTarget.v1'
export interface HomeSettings extends HomeLimits {
  confirmationTimeoutMs: number
  activityRetentionMs: number
  mapMaxItems: number
  mapBlockedTerms: string[]
}
export const HOME_DEFAULT_SETTINGS: HomeSettings = {
  ...HOME_DEFAULT_LIMITS,
  confirmationTimeoutMs: 120_000,
  activityRetentionMs: 30 * 24 * 60 * 60_000,
  mapMaxItems: 500,
  mapBlockedTerms: [],
}
