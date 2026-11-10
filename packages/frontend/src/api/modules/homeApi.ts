/**
 * 「共同的家」管理接口（/api/home，仅管理员）。
 *
 * 设置页「桌面与家」用它读写保险设置、查看和收回授权、翻看活动记录、
 * 列出会话改动并撤回，以及用户手动清空后端回收区。
 *
 * @see .docs/home/electron-integration.md
 */

import type {
  HomeActivity,
  HomeCheckpoint,
  HomeGrant,
  HomeScope,
  HomeSettings,
  HomeSnapshot,
} from '@infos/shared'
import { apiClient } from '../client'

export interface HomeSettingsData {
  key: string
  values: HomeSettings
  defaults: HomeSettings
}
export interface HomeActivityPage {
  items: HomeActivity[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}
export type HomeDiffSnapshot = HomeSnapshot & { text?: string | null; binary: boolean }
export interface HomeCheckpointDiff extends Omit<HomeCheckpoint, 'before' | 'after'> {
  before: HomeDiffSnapshot[]
  after: HomeDiffSnapshot[]
}
export interface HomeRecycleSummary {
  items: number
  bytes: number
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') search.set(key, String(value))
  const text = search.toString()
  return text ? `?${text}` : ''
}
const id = (value: string) => encodeURIComponent(value)
const data = async <T>(request: Promise<{ data?: T }>) => (await request).data as T

export const homeApi = {
  settings: () => data(apiClient.get<HomeSettingsData>('/home/settings')),
  updateSettings: (patch: Partial<HomeSettings>) =>
    data(apiClient.put<HomeSettings>('/home/settings', patch)),
  resetSettings: () => data(apiClient.delete<HomeSettings>('/home/settings')),

  grants: (agentId: string) =>
    data(apiClient.get<HomeGrant[]>(`/home/grants${query({ agentId })}`)),
  grant: (agentId: string, grantId: string) =>
    data(apiClient.get<HomeGrant>(`/home/grants/${id(grantId)}${query({ agentId })}`)),
  revokeGrant: (agentId: string, grantId: string) =>
    apiClient.delete(`/home/grants/${id(grantId)}${query({ agentId })}`),

  activities: (params: {
    agentId?: string
    sessionId?: string
    action?: string
    from?: number
    to?: number
    page?: number
    pageSize?: number
  }) => data(apiClient.get<HomeActivityPage>(`/home/activities${query(params)}`)),
  activity: (agentId: string, activityId: string) =>
    data(apiClient.get<HomeActivity>(`/home/activities/${id(activityId)}${query({ agentId })}`)),
  removeActivity: (agentId: string, activityId: string) =>
    apiClient.delete(`/home/activities/${id(activityId)}${query({ agentId })}`),

  checkpoints: (scope: HomeScope) =>
    data(apiClient.post<HomeCheckpoint[]>('/home/checkpoints/list', { scope })),
  diff: (scope: HomeScope, checkpointId: string) =>
    data(
      apiClient.post<HomeCheckpointDiff>('/home/checkpoints/diff', { scope, input: checkpointId }),
    ),
  /** 省略 checkpointId 时撤回整个会话（后端先整体预检，冲突时一条也不撤）。 */
  undo: (scope: HomeScope, checkpointId?: string) =>
    data(
      apiClient.post<{ undone: string[] }>('/home/checkpoints/undo', {
        scope,
        ...(checkpointId ? { input: checkpointId } : {}),
      }),
    ),
  reconcile: (scope: HomeScope, checkpointId: string) =>
    data(
      apiClient.post<HomeCheckpoint>('/home/checkpoints/reconcile', { scope, input: checkpointId }),
    ),
  recycleSummary: (agentId: string) =>
    data(apiClient.get<HomeRecycleSummary>(`/home/recycle/summary${query({ agentId })}`)),
  /** 用户手动清空后端回收区：永久删除，必须带固定确认词。 */
  purgeRecycle: (agentId: string) =>
    data(
      apiClient.post<HomeRecycleSummary>('/home/recycle/purge', {
        confirm: 'PURGE_RECYCLE',
        agentId,
      }),
    ),
}
