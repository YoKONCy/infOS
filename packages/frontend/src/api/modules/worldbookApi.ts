/**
 * 世界书 API 模块
 *
 * 书库、全局激活设置、角色绑定与命中测试。世界书保存后立即生效，不经过提示词草稿发布。
 */

import type {
  Worldbook,
  WorldbookActivation,
  WorldbookBinding,
  WorldbookEntry,
  WorldbookSettings,
  WorldbookSummary,
  WorldbookTestRequest,
} from '@infos/shared'
import { apiClient } from '../client'

export interface WorldbookLibrary {
  books: WorldbookSummary[]
  settings: WorldbookSettings
}

export const worldbookApi = {
  /** 书库列表与全局激活设置。 */
  list: () => apiClient.get<WorldbookLibrary>('/worldbooks'),

  /** 新建世界书；导入时同时携带条目。重名返回 DUPLICATE_NAME。 */
  create: (payload: { name: string; entries?: WorldbookEntry[] }) =>
    apiClient.post<Worldbook>('/worldbooks', payload),

  get: (bookId: string) => apiClient.get<Worldbook>(`/worldbooks/${encodeURIComponent(bookId)}`),

  /** 保存名称与条目；`revision` 与服务端不一致时返回 CONFLICT，避免覆盖其他窗口的修改。 */
  save: (bookId: string, payload: { name: string; entries: WorldbookEntry[]; revision: number }) =>
    apiClient.put<Worldbook>(`/worldbooks/${encodeURIComponent(bookId)}`, payload),

  duplicate: (bookId: string, name: string) =>
    apiClient.post<Worldbook>(`/worldbooks/${encodeURIComponent(bookId)}/duplicate`, { name }),

  /** 删除世界书，同时移出全局启用列表与所有角色绑定。 */
  remove: (bookId: string) => apiClient.delete<void>(`/worldbooks/${encodeURIComponent(bookId)}`),

  /** 只保存扫描深度与 Token 上限；全局列表用下面的单本增删接口，避免覆盖其他窗口的修改。 */
  saveSettings: (settings: Pick<WorldbookSettings, 'scanDepth' | 'tokenBudget'>) =>
    apiClient.put<WorldbookSettings>('/worldbooks/settings', settings),

  addGlobalBook: (bookId: string) =>
    apiClient.post<WorldbookSettings>(
      `/worldbooks/settings/global-books/${encodeURIComponent(bookId)}`,
      {},
    ),

  removeGlobalBook: (bookId: string) =>
    apiClient.delete<WorldbookSettings>(
      `/worldbooks/settings/global-books/${encodeURIComponent(bookId)}`,
    ),

  /** 所有角色的绑定，键为角色 ID。 */
  listBindings: () => apiClient.get<Record<string, WorldbookBinding>>('/worldbooks/bindings'),

  getBinding: (agentId: string) =>
    apiClient.get<WorldbookBinding>(`/worldbooks/bindings/${encodeURIComponent(agentId)}`),

  /** `expected` 为编辑前看到的绑定；服务端已被其他窗口修改时返回 CONFLICT。 */
  saveBinding: (agentId: string, binding: WorldbookBinding, expected?: WorldbookBinding) =>
    apiClient.put<WorldbookBinding>(`/worldbooks/bindings/${encodeURIComponent(agentId)}`, {
      ...binding,
      ...(expected ? { expected } : {}),
    }),

  /** 用未保存的条目和一段模拟输入测试命中结果，按全局激活设置计算。 */
  test: (payload: WorldbookTestRequest) =>
    apiClient.post<WorldbookActivation>('/worldbooks/test', payload),
}
