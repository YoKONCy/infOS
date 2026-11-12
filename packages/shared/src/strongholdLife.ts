export type StrongholdPosture = 'available' | 'listening' | 'conversing' | 'occupied' | 'resting'
export type StrongholdSpeechPurpose = 'share' | 'question' | 'answer' | 'acknowledge' | 'close'

/** 一次执行的参与决定随正式发言或静默结算提交。 */
export interface StrongholdParticipationResult {
  state: StrongholdPosture
  purpose?: StrongholdSpeechPurpose
  addressedTo?: string[]
  exchangeId?: string
  activityId?: string
  expectedRevision?: number
}

export interface StrongholdMemberRef {
  agentId: string
  threadId: string
  generation: number
}

export interface StrongholdParticipation extends StrongholdMemberRef {
  id: string
  roomId: string
  revision: number
  state: StrongholdPosture
  exchangeId?: string
  activityId?: string
}

export interface StrongholdActivity {
  id: string
  roomId: string
  revision: number
  creatorId: string
  title: string
  description: string
  progress: string
  status: 'active' | 'paused' | 'ended'
  members: Array<StrongholdMemberRef & { status: 'participating' | 'observing' | 'away' | 'left' }>
  sourceWithdrawn?: boolean
}

export interface StrongholdInvitation {
  id: string
  roomId: string
  revision: number
  activityId: string
  inviterId: string
  recipient: StrongholdMemberRef
  status: 'pending' | 'accepted' | 'declined' | 'later' | 'cancelled' | 'expired'
  expiresAt: number
}

export interface StrongholdWatchCondition {
  kind: 'message' | 'mentioned' | 'arrival' | 'departure' | 'environment' | 'invitation' | 'activity' | 'time'
  actorId?: string
  objectId?: string
  key?: string
  at?: number
}

export interface StrongholdWatch {
  id: string
  roomId: string
  revision: number
  intent: string
  condition: StrongholdWatchCondition
  status: 'active' | 'queued' | 'completed' | 'cancelled' | 'expired' | 'failed'
  expiresAt: number
  continuous: boolean
  afterMessageId: number
  pendingMessageIds: number[]
  requestMessageId?: number
}

export interface StrongholdExchange {
  id: string
  roomId: string
  revision: number
  status: 'active' | 'quiet' | 'closed'
  participantIds: string[]
  lastSpeakerId: string
  lastMessageId: number
  quietAt: number
  closesAt: number
}

export interface StrongholdLifeSnapshot {
  userPresent: boolean
  participants: StrongholdParticipation[]
  exchanges: StrongholdExchange[]
  activities: StrongholdActivity[]
  invitations: StrongholdInvitation[]
}

export function parseStrongholdParticipation(value: unknown): StrongholdParticipationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STRONGHOLD_PARTICIPATION_INVALID')
  const input = value as Record<string, unknown>
  if (!['available', 'listening', 'conversing', 'occupied', 'resting'].includes(String(input.state)) ||
    (input.purpose !== undefined && !['share', 'question', 'answer', 'acknowledge', 'close'].includes(String(input.purpose))) ||
    (input.addressedTo !== undefined && (!Array.isArray(input.addressedTo) || input.addressedTo.length > 5 || input.addressedTo.some((id) => typeof id !== 'string'))) ||
    (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) ||
    ['exchangeId', 'activityId'].some((key) => input[key] !== undefined && typeof input[key] !== 'string'))
    throw new Error('STRONGHOLD_PARTICIPATION_INVALID')
  return {
    state: input.state as StrongholdPosture,
    purpose: input.purpose as StrongholdSpeechPurpose | undefined,
    addressedTo: input.addressedTo as string[] | undefined,
    exchangeId: input.exchangeId as string | undefined,
    activityId: input.activityId as string | undefined,
    expectedRevision: input.expectedRevision as number | undefined,
  }
}
