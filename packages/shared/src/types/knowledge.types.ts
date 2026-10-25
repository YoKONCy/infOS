export type KnowledgeSourceKind = 'text' | 'file' | 'url' | 'workspace'
/** 共享资料的自动召回独立于事件记忆配置，默认均关闭。 */
export interface KnowledgeRecallSettings {
  documentAutoRecall: boolean
  factAutoRecall: boolean
}
export type KnowledgeDocumentStatus = 'queued' | 'processing' | 'ready' | 'failed'
export type KnowledgeVectorStatus = 'skipped' | 'pending' | 'ready' | 'failed' | 'stale'

export interface KnowledgeDocumentInfo {
  id: string
  title: string
  sourceKind: KnowledgeSourceKind
  source: string
  tokenCount: number
  revision: number
  status: KnowledgeDocumentStatus
  vectorStatus: KnowledgeVectorStatus
  partCount: number
  modelName: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface KnowledgePartInfo {
  id: string
  documentId: string
  ordinal: number
  title: string
  summary: string
  keywords: string[]
  tokenCount: number
  startOffset: number
  endOffset: number
}

export interface KnowledgeDocumentDetail extends KnowledgeDocumentInfo {
  parts: KnowledgePartInfo[]
}

export interface KnowledgeDocumentList {
  items: KnowledgeDocumentInfo[]
  total: number
  page: number
  pageSize: number
  stats: {
    documentCount: number
    readyCount: number
    pendingCount: number
    partCount: number
    indexingCount: number
  }
}

export interface KnowledgeSearchInput {
  keywords?: string[]
  regex?: string
  limit?: number
  expand?: boolean
  partIds?: string[]
  documentId?: string
  /** 展开单个片段时的字符游标，使用上次返回的 nextOffset。 */
  offset?: number
}

export interface KnowledgeSearchHit extends KnowledgePartInfo {
  documentTitle: string
  source: string
  revision: number
  score: number
  matchedBy: Array<'bm25' | 'vector' | 'regex' | 'id'>
  excerpt: string
  content?: string
  contentOffset?: number
  nextOffset?: number
  truncated: boolean
}

export interface KnowledgeSearchResult {
  version: string
  items: KnowledgeSearchHit[]
  total: number
  limit: number
  expanded: boolean
  truncated: boolean
  warnings: string[]
}
