/**
 * attachmentsApi — API 契约适配层
 *
 * 集中管理该领域的数据转换、状态边界与外部交互。
 * 调用方依赖这里的稳定契约，不直接耦合底层传输或运行时实现。
 */
import { apiClient } from '../client'
import { getApiResourceUrl } from '../transport'
import type { AudioMetadata } from '@infos/shared'

export interface AttachmentInfo {
  id: string
  threadId: string
  messageId: number | null
  kind: 'image' | 'text' | 'pdf' | 'audio' | 'video' | 'file'
  originalName: string
  mimeType: string
  sizeBytes: number
  contextPolicy: 'once'
  status: string
  error?: string
  contextMode?: 'inline' | 'reference'
  audio?: AudioMetadata
}

export const attachmentsApi = {
  capabilities: () =>
    apiClient.get<{ pdf: boolean; maxPdfBytes: number; sourceName: string | null }>(
      '/attachments/capabilities',
    ),
  get: (id: string) => apiClient.get<AttachmentInfo>(`/attachments/${encodeURIComponent(id)}`),
  retry: (id: string) =>
    apiClient.post<AttachmentInfo>(`/attachments/${encodeURIComponent(id)}/retry`),
  upload: (
    file: File,
    threadId: string,
    options: { referenceOnly?: boolean; signal?: AbortSignal } = {},
  ) => {
    const form = new FormData()
    form.append('file', file)
    form.append('threadId', threadId)
    if (options.referenceOnly) form.append('contextMode', 'reference')
    return apiClient.request<AttachmentInfo>('/attachments', {
      method: 'POST',
      body: form,
      signal: options.signal,
    })
  },

  contentUrl: (id: string, download = false) =>
    getApiResourceUrl(
      `/attachments/${encodeURIComponent(id)}/content`,
      new URLSearchParams(download ? { download: '1' } : {}),
    ),

  removeUnbound: (id: string) => apiClient.delete<void>(`/attachments/${encodeURIComponent(id)}`),
}
