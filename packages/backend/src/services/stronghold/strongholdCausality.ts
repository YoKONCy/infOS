/** 同一交流在安静窗口后，才可随新的空闲机会承接独立话题。 */
export const STRONGHOLD_QUIET_WINDOW_MS = 60_000

export interface StrongholdResponseContext {
  phase: 'response' | 'settlement'
  openingMessageId: number
  initiatorId: string
}

export interface StrongholdReplyOptions {
  kind?: 'natural' | 'summon' | 'invitation' | 'watch' | 'wait'
  watchIds?: string[]
}

export interface StrongholdReplyAdmission {
  mode: 'immediate' | 'idle'
  response?: StrongholdResponseContext
}
