export interface SteamCloudSaveStatus {
  isSteam: boolean
  enabled: boolean
  phase: 'disabled' | 'idle' | 'saving' | 'saved' | 'pending' | 'conflict'
  lastLocalSaveAt: number | null
  lastSteamWriteAt: number | null
  pending: boolean
}
