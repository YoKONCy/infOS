export type TokenUsagePeriod = 'today' | '7d' | '30d'

/** 当前 ReAct 模型请求的输入占用，不能与累计调用消费混用。 */
export interface LiveContextBudget {
  usedTokens: number
  maxInputTokens: number
  contextWindowTokens: number
  modelId: string
  turn: number
  estimated: boolean
  updatedAt: number
}

/** 一次完整 ReAct 对话的主模型输出；不包含独立后台模型调用。 */
export interface ConversationGenerationStats {
  outputTokens: number
  modelDurationMs: number
  modelCalls: number
  estimated: boolean
}
export type TokenUsagePurpose =
  | 'conversation'
  | 'companion'
  | 'task'
  | 'memory'
  | 'knowledge'
  | 'vision'
  | 'system'

export interface TokenUsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  /** 以下缓存指标仅统计输入与缓存读取均有效上报的同一批请求。 */
  cacheHitTokens: number
  cacheMissTokens: number
  cacheReportedRequests: number
  cacheHitRequests: number
  reasoningTokens: number
  requests: number
  reportedRequests: number
  inputReportedRequests: number
  outputReportedRequests: number
  incompleteRequests: number
  unreportedRequests: number
  failedRequests: number
}

export interface TokenUsageGroup extends TokenUsageTotals {
  key: string
  provider?: string
  modelId?: string
}

export interface TokenUsageFilters {
  threadId?: string
  provider?: string
  modelId?: string
}
export interface TokenUsageFilterOptions {
  threads: Array<{ id: string; title: string | null; threadKind?: 'main' | 'side' | null }>
  models: Array<{ provider: string; modelId: string }>
}

export interface TokenUsageStatistics {
  period: TokenUsagePeriod
  timeZone: string
  from: string
  to: string
  firstRecordedAt: string | null
  generatedAt: string
  totals: TokenUsageTotals
  buckets: Array<TokenUsageTotals & { key: string; label: string }>
  models: TokenUsageGroup[]
  purposes: TokenUsageGroup[]
  channels?: TokenUsageGroup[]
}
