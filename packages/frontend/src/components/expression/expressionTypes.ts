/** 表达层前后端共用数据的形状。 */
export type {
  ExpressionLearningOutcome,
  ExpressionLearningRecord,
  ExpressionLearningStatus,
  ExpressionMark,
  ExpressionMarkKind,
  ExpressionStatus,
} from '@infos/shared'

/** 一条可以被批改的助手回复。 */
export interface ExpressionTarget {
  agentId: string
  threadId: string
  messageId: string
}

/** 批注和选中文字的长度上限，与后端校验一致。 */
export const EXPRESSION_TEXT_LIMIT = 2000

/*
 * 表达层二期的数据形状，照《表达层二期规格》写。
 * shared 的类型归后端；后端登记之后，这里可以改成从 @infos/shared 导出。
 */
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

export interface ExpressionMaterials {
  enabled: boolean
  notes: boolean
  goodQuotes: boolean
  memories: boolean
  repetition: boolean
  activity: boolean
  maxChars: number
}

export interface ExpressionSettings {
  learningEnabled: boolean
  learningIdleMinutes: number
  materials: ExpressionMaterials
  handbookMaxChars: number
}

export type ExpressionPreviewMode = 'chat' | 'work' | 'minimal'

/** 实际编译后的消息和一份清单；清单的字段后端还在定，先原样显示。 */
export interface ExpressionPreviewResult {
  messages: Array<{
    id?: string
    role: string
    content: unknown
    cacheControl?: { key?: string }
  }>
  manifest?: unknown
  blockIds?: Array<string | null | undefined>
  handbookMessageIndex?: number
  handbookChars?: number
}

export const MATERIALS_CHARS = { min: 100, max: 1000, fallback: 300 }
export const LEARNING_IDLE_MINUTES = { min: 1, max: 120, fallback: 10 }
export const HANDBOOK_CHARS = { min: 300, max: 5000, fallback: 1500 }
