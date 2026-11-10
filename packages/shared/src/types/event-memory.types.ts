/**
 * 新版事件记忆与共享知识合同
 */

export type EventNoteStatus = 'active' | 'archived'
export type EventNoteOriginMode = 'active' | 'background'
export type EventNoteWriteScope = 'current_execution' | 'uncovered_sources' | 'current_pair' | 'current_uncovered_segment'
export type EventNoteRelation =
  | 'temporal_next'
  | 'temporal_prev'
  | 'caused_by'
  | 'same_event'
  | 'same_topic'
  | 'involves_person'
  | 'involves_place'
  | 'involves_object'

export interface EventNoteAffect {
  tones: string[]
  valence: number
  arousal: number
}

export interface EventNoteOrigin {
  mode: EventNoteOriginMode
  threadId: string
  pairIds: string[]
  messageIds: string[]
  channel: string
  experienceIds?: string[]
  sourceWithdrawn?: boolean
  generation?: number
  messageRevisions?: Record<string, number>
  sources?: Array<Omit<EventNoteOrigin, 'sources'>>
  manualEdit?: { actor: 'user'; previousId: string; editedAt: string }
}

export interface EventNoteManualEditInput extends Omit<EventNoteDraftInput, 'scope'> {
  expectedStatus: EventNoteStatus
  regenerateVector: boolean
  operationId: string
}

export interface FactManualEditInput {
  statement: string
  source?: string
  confidence?: number
  operationId: string
}

export interface EventNote {
  id: string
  agentId: string
  narrative: string
  eventAt: string
  createdAt: string
  importance: number
  affect: EventNoteAffect
  participants: string[]
  places: string[]
  objects: string[]
  topics: string[]
  origin: EventNoteOrigin
  status: EventNoteStatus
}

export interface EventNoteDraftInput {
  narrative: string
  importance: number
  affect: EventNoteAffect
  participants?: string[]
  places?: string[]
  objects?: string[]
  topics?: string[]
  scope?: EventNoteWriteScope
}

export interface EventNoteRelationView {
  sourceId: string
  targetId: string
  relation: EventNoteRelation
  weight: number
}

export interface EventNoteDetail extends EventNote {
  previous?: EventNote
  next?: EventNote
  relations: EventNoteRelationView[]
}

export interface ConversationCoverage {
  id: string
  agentId: string
  threadId: string
  /** 主线存储 message:ID@revision 来源键，旧会话保留原配对键。 */
  pairIds: string[]
  messageIds: string[]
  outcome: 'event_recorded' | 'reviewed_no_event'
  eventNoteIds: string[]
  mode: EventNoteOriginMode
  coveredAt: string
}

export type EventNoteQueryDirection = 'outgoing' | 'incoming' | 'both'

export interface EventNoteQuery {
  agentId: string
  query?: string
  mode?:
    | 'recent'
    | 'time_range'
    | 'semantic'
    | 'same_event'
    | 'entity'
    | 'logical'
    | 'affective'
    | 'mixed'
  from?: string
  to?: string
  includeArchived?: boolean
  limit?: number
  maxDepth?: number
  maxNodes?: number
  maxReturnTokens?: number
  edgeLabels?: EventNoteRelation[]
  direction?: EventNoteQueryDirection
}

export interface EventNoteQueryPathEdge extends EventNoteRelationView {
  fromEventId: string
  toEventId: string
  fromKind: 'event_note' | 'event_entity'
  toKind: 'event_note' | 'event_entity'
}

export interface EventNoteQueryPath {
  targetId: string
  edges: EventNoteQueryPathEdge[]
}

export interface EventNoteQueryEntity {
  id: string
  entityType: 'person' | 'place' | 'object'
  name: string
}

export interface EventNoteQueryResult {
  notes: EventNote[]
  entities: EventNoteQueryEntity[]
  paths: EventNoteQueryPath[]
  truncated: boolean
  returnedTokens: number
}

/** 核心记忆档案页的组合过滤条件（关键词档案检索，不触发语义 RAG） */
export interface EventNoteArchiveFilter {
  agentId: string
  /** 多角色过滤；存在时优先于 agentId */
  agentIds?: string[]
  /** 关键词：匹配叙事、主题、人物、地点、物品 */
  query?: string
  /** 来源 Channel 白名单 */
  channels?: string[]
  /** 状态白名单；缺省 = 活跃 + 归档 */
  statuses?: EventNoteStatus[]
  /** 记录模式白名单（active=主动写入 / background=后台炼化） */
  modes?: EventNoteOriginMode[]
  importanceMin?: number
  importanceMax?: number
  /** 情感基调关键词 */
  tones?: string[]
  participants?: string[]
  places?: string[]
  objects?: string[]
  topics?: string[]
  /** 事件时间范围（ISO 前缀比较） */
  eventAtFrom?: string
  eventAtTo?: string
  /** 记录时间范围 */
  createdAtFrom?: string
  createdAtTo?: string
  sort?: 'eventAt' | 'createdAt' | 'importance'
  order?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

/** 单个 facet 聚合项 */
export interface EventNoteFacetValue {
  value: string
  count: number
}

/** 档案页 facet 聚合（基于当前过滤结果统计，供筛选器提供真实可选项） */
export interface EventNoteArchiveFacets {
  channels: EventNoteFacetValue[]
  statuses: EventNoteFacetValue[]
  modes: EventNoteFacetValue[]
  tones: EventNoteFacetValue[]
  participants: EventNoteFacetValue[]
  places: EventNoteFacetValue[]
  objects: EventNoteFacetValue[]
  topics: EventNoteFacetValue[]
}

/** 档案页分区统计（有效记忆与归档分别汇总）。 */
export interface EventNoteArchiveStats {
  active: number
  archived: number
  averageImportance: number
  topicCount: number
}

/** 档案分页查询结果 */
export interface EventNoteArchiveResult {
  items: EventNote[]
  page: number
  pageSize: number
  total: number
  pageCount: number
  facets: EventNoteArchiveFacets
  stats: EventNoteArchiveStats
}

/** 记忆图谱快照（TDB 批量读取，无 N+1） */
export interface EventMemoryGraphSnapshot {
  nodes: EventNote[]
  edges: EventNoteRelationView[]
  truncated: boolean
}

export interface KnowledgeQuery {
  query: string
  limit?: number
}

export interface KnowledgeRecord {
  id: string
  title: string
  content: string
  source?: string
}

export interface KnowledgeStorePort {
  query(input: KnowledgeQuery): Promise<KnowledgeRecord[]>
}

export interface FactRecord {
  id: string
  objectId: string
  objectName: string
  statement: string
  status: 'active' | 'superseded' | 'retracted'
  observedAt: string
  createdAt: string
  source?: string
  confidence?: number
  createdByAgentId: string
}

export interface FactArchiveRecord extends FactRecord {
  supersededBy?: string
}

export interface FactArchiveObject {
  objectId: string
  standardName: string
  aliases: string[]
  activeFacts: FactArchiveRecord[]
  historicalFacts: FactArchiveRecord[]
  retractedFacts: FactArchiveRecord[]
}

export interface FactArchiveResult {
  items: FactArchiveObject[]
  total: number
  stats: {
    objectCount: number
    activeFactCount: number
    historicalFactCount: number
    retractedFactCount: number
  }
}

export interface FactObjectCandidate {
  objectId: string
  standardName: string
  aliases: string[]
  matchType: 'exact' | 'alias' | 'text'
  score: number
  activeFacts: FactRecord[]
}

export interface FactQueryPathEdge {
  fromId: string
  toId: string
  label: 'has_fact' | 'fact_of' | 'superseded_by' | 'supersedes'
  weight: number
}

export interface FactQueryPath {
  nodes: Array<{
    id: string
    kind: 'fact_object' | 'fact'
    name: string
  }>
  edges: FactQueryPathEdge[]
}

export interface FactQueryResult {
  exactMatch?: FactObjectCandidate
  candidates: FactObjectCandidate[]
  requiresSelection: boolean
  paths: FactQueryPath[]
}
