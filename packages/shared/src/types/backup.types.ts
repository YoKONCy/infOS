export type BackupModule =
  | 'settings'
  | 'agents'
  | 'conversations'
  | 'memory'
  | 'facts'
  | 'knowledge'
  | 'tasks'
  | 'workspace'
  | 'applications'
export type BackupLevel = 'settings' | 'agent' | 'content' | 'full'
export interface BackupSelection {
  level: BackupLevel
  modules: BackupModule[]
  agentIds: string[]
  threadIds: string[]
  documentIds: string[]
  factIds: string[]
  taskIds: string[]
  includeSecrets: boolean
}
export type BackupRow = Record<string, string | number | null>
export interface BackupManifest {
  format: 'infos.backup'
  version: 1
  id: string
  appVersion: string
  createdAt: string
  sourceServerId: string
  triviumFormat?: number
  triviumVersion?: string
  selection: BackupSelection
  tables: Record<string, number>
  summary?: Record<string, number>
  files: Array<{ path: string; size: number; sha256: string; mode?: number }>
  warnings: string[]
}
export interface BackupRecord {
  id: string
  createdAt: string
  level: BackupLevel
  size: number
  encrypted: boolean
  protection: 'none' | 'password' | 'local'
  reason: 'manual' | 'before-import'
  manifest: BackupManifest
}
export interface ImportPolicy {
  conflict: 'skip' | 'replace' | 'duplicate'
  agentTargets: Record<string, string>
}
export interface BackupPreview {
  ticket: string
  manifest: BackupManifest
  counts: Record<string, number>
  conflicts: Record<string, number>
  warnings: string[]
  alreadyImported: boolean
  expiresAt: string
}
