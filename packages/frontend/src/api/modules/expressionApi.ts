/**
 * 表达层接口：标记、红笔批注与规则状态。
 * 路径前缀 /api/expression（apiClient 自动加 /api）。
 */
import { apiClient } from '../client'
import { ApiError } from '../errors'
import type {
  ExpressionMark,
  ExpressionLearningStatus,
  ExpressionMarkKind,
  ExpressionPreviewMode,
  ExpressionPreviewResult,
  ExpressionSettings,
  ExpressionStatus,
  HandbookRule,
  HandbookVersion,
} from '../../components/expression/expressionTypes'

export interface ExpressionMarkQuery {
  agentId: string
  threadId?: string
  messageId?: string
  kind?: ExpressionMarkKind
  learning?: 'none' | 'pending' | 'learned' | 'skipped' | 'failed'
  page?: number
  pageSize?: number
}

export interface ExpressionMarkPage {
  items: ExpressionMark[]
  total: number
}

export interface CreateExpressionMark {
  agentId: string
  threadId: string
  messageId: string
  kind: ExpressionMarkKind
  quote?: string
  note?: string
}

function queryString(query: ExpressionMarkQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== '') params.set(key, String(value))
  return params.toString()
}

export const expressionApi = {
  listMarks: (query: ExpressionMarkQuery) =>
    apiClient.get<ExpressionMarkPage>(`/expression/marks?${queryString(query)}`),
  createMark: (input: CreateExpressionMark) =>
    apiClient.post<ExpressionMark>('/expression/marks', input),
  updateMark: (id: string, patch: { kind?: ExpressionMarkKind; note?: string }) =>
    apiClient.patch<ExpressionMark>(`/expression/marks/${encodeURIComponent(id)}`, patch),
  deleteMark: (id: string) =>
    apiClient.delete<{ ok: true }>(`/expression/marks/${encodeURIComponent(id)}`),
  relearnMark: (id: string) =>
    apiClient.post<{ ok: true }>(`/expression/marks/${encodeURIComponent(id)}/relearn`, {}),
  getStatus: (agentId: string) =>
    apiClient.get<ExpressionStatus>(`/expression/status?agentId=${encodeURIComponent(agentId)}`),
  getLearningStatus: (agentId: string) =>
    apiClient.get<ExpressionLearningStatus>(
      `/expression/handbook/learning?agentId=${encodeURIComponent(agentId)}`,
    ),
  learnNow: (agentId: string) =>
    apiClient.post<{ pending: number }>('/expression/handbook/learn-now', { agentId }),
  getHandbook: (agentId: string) =>
    apiClient.get<{
      rules: HandbookRule[]
      usedChars: number
      maxChars: number
      learningFailures?: number
    }>(
      `/expression/handbook?agentId=${encodeURIComponent(agentId)}`,
    ),
  addHandbookRule: (agentId: string, text: string) =>
    apiClient.post<HandbookRule>('/expression/handbook/rules', { agentId, text }),
  updateHandbookRule: (id: string, text: string) =>
    apiClient.patch<HandbookRule>(`/expression/handbook/rules/${encodeURIComponent(id)}`, { text }),
  deleteHandbookRule: (id: string) =>
    apiClient.delete<{ ok: true }>(`/expression/handbook/rules/${encodeURIComponent(id)}`),
  listHandbookVersions: (agentId: string) =>
    apiClient.get<{ items: HandbookVersion[] }>(
      `/expression/handbook/versions?agentId=${encodeURIComponent(agentId)}`,
    ),
  restoreHandbookVersion: (id: string, agentId: string) =>
    apiClient.post<{ rules: HandbookRule[] }>(
      `/expression/handbook/versions/${encodeURIComponent(id)}/restore`,
      { agentId },
    ),
  getSettings: (agentId: string) =>
    apiClient.get<ExpressionSettings>(
      `/expression/settings?agentId=${encodeURIComponent(agentId)}`,
    ),
  updateSettings: (agentId: string, patch: Partial<ExpressionSettings>) =>
    apiClient.patch<ExpressionSettings>('/expression/settings', { agentId, ...patch }),
  preview: (input: { agentId: string; mode: ExpressionPreviewMode; message: string }) =>
    apiClient.post<ExpressionPreviewResult>('/expression/preview', input),
}

/** 接口不存在（后端版本旧）或没有权限：界面隐藏入口或提示，不算故障。 */
export function isExpressionApiMissing(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'METHOD_NOT_ALLOWED'].includes(error.code))
    return true
  // 非 JSON 的 HTTP 错误由 Transport 包成 NETWORK_ERROR，正文里只有状态码。
  return error.code === 'NETWORK_ERROR' && /\bHTTP 40[1345]\b/.test(error.message)
}
