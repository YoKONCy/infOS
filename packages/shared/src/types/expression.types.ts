export interface HandbookRule {
  id: string
  agentId: string
  text: string
  score: number
  source: {
    kind: 'mark' | 'chat'
    markId?: string
    threadId?: string
    messageId?: string
    quote: string
    markKind?: 'good' | 'robotic'
  }
  lastMatchedAt: number | null
  createdAt: number
  updatedAt: number
}
export interface HandbookVersion {
  id: string
  agentId: string
  reason: 'learn' | 'manual' | 'rollback'
  summary: string
  createdAt: number
}
/** 一条学习任务的结果；界面按它写大白话。 */
export type ExpressionLearningOutcome =
  | 'learned'
  | 'scored'
  | 'nothing'
  | 'low_confidence'
  | 'evidence'
  | 'forbidden'
  | 'full'
  | 'no_rule'
  | 'rejected'
  | 'model_failed'
  | 'error'
export interface ExpressionLearningRecord {
  id: string
  kind: 'mark' | 'chat'
  /** 批注或聊天原话，太长的截断。 */
  text: string
  /** 被标记的那条回复开头；整条标记没写批注时靠它认出是哪条。 */
  reply?: string
  status: 'pending' | 'done' | 'failed'
  outcome: ExpressionLearningOutcome | null
  ruleTexts: string[]
  at: number
}
export interface ExpressionLearningStatus {
  state: 'idle' | 'waiting' | 'learning' | 'retrying' | 'paused'
  /** 等着学的条数。 */
  pending: number
  /** 下一次学的时间；没有就是 null。 */
  nextAt: number | null
  attempts: number
  recent: ExpressionLearningRecord[]
}
export interface ExpressionSettings {
  learningEnabled: boolean
  /** 停手多少分钟后开始学。 */
  learningIdleMinutes: number
  materials: {
    enabled: boolean
    notes: boolean
    goodQuotes: boolean
    memories: boolean
    repetition: boolean
    activity: boolean
    maxChars: number
  }
  handbookMaxChars: number
}
