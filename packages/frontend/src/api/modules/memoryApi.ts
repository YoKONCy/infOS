import type {
  EventMemoryGraphSnapshot,
  EventNoteArchiveFilter,
  EventNoteArchiveResult,
  EventNoteDetail,
  EventNote,
  EventNoteManualEditInput,
} from '@infos/shared'
import { apiClient } from '../client'

export interface EventMemorySource {
  available: boolean
  withdrawn?: boolean
  revised?: boolean
  messages: Array<{
    id: number
    role: string
    content: string
    timestamp: string | null
    pairId: string | null
  }>
}
export interface PrivacyCleanupJob {
  id: string
  kind: 'memory' | 'fact' | 'knowledge' | 'reset-memory' | 'social-memory'
  status: 'pending' | 'failed' | 'completed'
  attempts: number
  lastError?: string
  createdAt: string
}

/** 过滤参数 → querystring（数组以逗号拼接，与后端 csv 解析对齐） */
function toSearchParams(filter: Partial<EventNoteArchiveFilter>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue
    const serialized = Array.isArray(value) ? value.join(',') : String(value)
    if (serialized) params.set(key, serialized)
  }
  return params.toString()
}

export const memoryApi = {
  edit: (id: string, input: EventNoteManualEditInput) =>
    apiClient.patch<EventNote>(`/memories/${encodeURIComponent(id)}`, input),
  /** 核心记忆档案：组合过滤 + 分页 + facets + stats */
  archive: (filter: Partial<EventNoteArchiveFilter>) =>
    apiClient.get<EventNoteArchiveResult>(`/memories?${toSearchParams(filter)}`),

  /** 事件详情（含前后事件与关系） */
  detail: (id: string) => apiClient.get<EventNoteDetail>(`/memories/${encodeURIComponent(id)}`),

  /** 事件来源原始对话 */
  source: (id: string) =>
    apiClient.get<EventMemorySource>(`/memories/${encodeURIComponent(id)}/source`),

  /** 将核心记忆移入归档，保留关系图结构 */
  archiveNote: (id: string) => apiClient.post<void>(`/memories/${encodeURIComponent(id)}/archive`),
  restoreNote: (id: string) => apiClient.post<void>(`/memories/${encodeURIComponent(id)}/restore`),
  deleteNote: (id: string) =>
    apiClient.delete<void>(`/memories/${encodeURIComponent(id)}`),
  batch: (ids: string[], action: 'archive' | 'restore' | 'delete') =>
    apiClient.post<void>('/memories/batch', { ids, action }),
  cleanupJobs: () => apiClient.get<PrivacyCleanupJob[]>('/memories/deletions/status'),
  retryCleanup: (id: string) =>
    apiClient.post<void>(`/memories/deletions/${encodeURIComponent(id)}/retry`),

  /** 记忆图谱快照（TDB 批量读取） */
  graph: (agentId: string, includeArchived = false, limit = 300) =>
    apiClient.get<EventMemoryGraphSnapshot>(
      `/memories/graph?agentId=${encodeURIComponent(agentId)}&includeArchived=${includeArchived}&status=${includeArchived ? 'archived' : 'active'}&limit=${limit}`,
    ),
}
