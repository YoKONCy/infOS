export const RUNTIME_DEBUG_TOOL = 'runtime_debug'
export interface RuntimeDebugStatus {
  enabled: boolean
  sessionId?: string
  threadId: string
  agentId: string
  workspace?: string
  loaded: Array<{ id: string; entry: string; kind: string; digest: string }>
  prepared?: Array<{ id: string; entry: string; kind: string; digest: string }>
}
