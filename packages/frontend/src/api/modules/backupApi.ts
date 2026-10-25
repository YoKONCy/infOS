import { apiClient } from '../client'
import { clientFetch, getWebServerOrigin } from '../transport'
import type { ApiResponse } from '@infos/shared'
import type { BackupPreview, BackupRecord, BackupSelection, ImportPolicy } from '@infos/shared'
import { t } from '../../i18n'

export interface BackupChoice { id: string; label: string; agentId?: string }
export interface BackupCatalogue { agents: BackupChoice[]; threads: BackupChoice[]; documents: BackupChoice[]; facts: BackupChoice[]; tasks: BackupChoice[] }
const endpoint = (path: string) => `${getWebServerOrigin()}/api/backups${path}`
async function responseError(response: Response): Promise<never> {
  const body = await response.json() as ApiResponse<unknown>
  throw new Error(body.message)
}
export const backupApi = {
  catalogue: () => apiClient.get<BackupCatalogue>('/backups/catalogue'),
  list: () => apiClient.get<{ records: BackupRecord[]; pending: { ticket: string; backupId: string } | null; lastImport: { status: 'completed' | 'failed'; id: string; error?: string } | null }>('/backups'),
  create: (selection: BackupSelection, password: string) => apiClient.post<BackupRecord>('/backups', { selection, password }),
  previewSaved: (id: string, password: string) => apiClient.post<BackupPreview>(`/backups/${id}/preview`, { password }),
  commit: (ticket: string, policy: ImportPolicy) => apiClient.post(`/backups/previews/${ticket}/commit`, policy),
  remove: (id: string) => apiClient.delete(`/backups/${id}`),
  cancel: () => apiClient.delete('/backups/pending'),
  async upload(file: File, password: string): Promise<BackupPreview> {
    const response = await clientFetch(endpoint('/previews'), { method: 'POST', headers: { 'Content-Type': 'application/vnd.infos.backup', 'X-Backup-Password': encodeURIComponent(password) }, body: file })
    if (!response.ok) return responseError(response)
    const result = await response.json() as ApiResponse<BackupPreview>
    return result.data!
  },
  async download(id: string, password: string): Promise<void> {
    const response = await apiClient.post<{ url: string }>(`/backups/${id}/download`, { password })
    const url = response.data?.url ?? ''
    if (!/^\/api\/backups\/downloads\/[a-f0-9]{64}$/.test(url)) throw new Error(t('ui.backup', '下载链接无效，请重试'))
    const anchor = document.createElement('a')
    anchor.href = new URL(url, getWebServerOrigin()).href
    anchor.download = `infos-${id}.infos-backup`
    anchor.referrerPolicy = 'no-referrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  },
}
