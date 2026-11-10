/** 标记列表每页上限；后端按它校验，前端按它分页，两边不能各写各的。 */
export const EXPRESSION_MARKS_MAX_PAGE_SIZE = 100

/** 按渲染文字识别同一句批注，兼容 Markdown 与选区空白差异。 */
export function normalizeExpressionQuote(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:[-+*]|\d+\.)[ \t]+/gm, '')
    .replace(/[\s*_~`#>|\\\u200b-\u200d\ufeff]/g, '')
}
export type ExpressionMarkKind = 'good' | 'robotic'
export interface ExpressionMarkLearning {
  state: 'none' | 'pending' | 'learned' | 'skipped' | 'failed'
  ruleText?: string
}
export interface ExpressionMark {
  /** 只有列表接口带：这条批注学得怎么样。 */
  learning?: ExpressionMarkLearning
  id: string
  agentId: string
  threadId: string
  threadTitle?: string
  threadKind?: 'main' | 'side' | null
  messageId: string
  /** 标记时的原消息修订，旧服务端响应可以省略。 */
  sourceRevision?: number
  /** 原消息仍有效且修订相符时为真。 */
  sourceAvailable?: boolean
  kind: ExpressionMarkKind
  quote: string
  note: string
  ruleVersion: string
  createdAt: number
  updatedAt: number
}
export interface ExpressionStatus {
  ruleVersion: string
  enabled: boolean
  counts: { good: number; robotic: number }
}
