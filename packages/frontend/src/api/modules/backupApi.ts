import { apiClient } from '../client'
import { clientFetch, getClientToken, getWebServerOrigin } from '../transport'
import type { ApiResponse } from '@infos/shared'
import type {
  BackupImportProgress,
  BackupPreview,
  BackupRecord,
  BackupSelection,
  ImportPolicy,
} from '@infos/shared'
import { t } from '../../i18n'
import { getLocale } from '@infos/shared/i18n'

export interface BackupChoice {
  id: string
  label: string
  agentId?: string
}
export interface BackupCatalogue {
  agents: BackupChoice[]
  threads: BackupChoice[]
  documents: BackupChoice[]
  facts: BackupChoice[]
  tasks: BackupChoice[]
}
const endpoint = (path: string) => `${getWebServerOrigin()}/api/backups${path}`
async function responseError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as ApiResponse<unknown> | null
  throw new Error(body?.message || t('ui.backup', '备份请求失败，请检查网络和服务器状态'))
}
export const backupApi = {
  catalogue: () => apiClient.get<BackupCatalogue>('/backups/catalogue'),
  list: () =>
    apiClient.get<{
      records: BackupRecord[]
      pending: { ticket: string; backupId: string } | null
      lastImport: { status: 'completed' | 'failed'; id: string; error?: string } | null
      activeImport: BackupImportProgress | null
    }>('/backups'),
  create: (selection: BackupSelection, password: string) =>
    apiClient.post<BackupRecord>('/backups', { selection, password }),
  previewSaved: (id: string, password: string) =>
    apiClient.post<BackupPreview>(`/backups/${id}/preview`, { password }),
  commit: (ticket: string, policy: ImportPolicy) =>
    apiClient.post(`/backups/previews/${ticket}/commit`, policy),
  remove: (id: string) => apiClient.delete(`/backups/${id}`),
  cancel: () => apiClient.delete('/backups/pending'),
  beginImport: (file: File, password: string) =>
    apiClient.post<BackupImportProgress>('/backups/imports', { size: file.size, password }),
  beginSavedImport: (id: string, password: string) =>
    apiClient.post<BackupImportProgress>(`/backups/${id}/import`, { password }),
  importProgress: (id: string) => apiClient.get<BackupImportProgress>(`/backups/imports/${id}`),
  cancelImport: (id: string) => apiClient.delete<BackupImportProgress>(`/backups/imports/${id}`),
  /** XHR 提供实际上传进度；解包进度从服务端操作记录读取，不用上传百分比伪装校验。 */
  uploadImport(
    file: File,
    id: string,
    signal: AbortSignal,
    onProgress: (bytes: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const abort = () => xhr.abort()
      const cleanup = () => signal.removeEventListener('abort', abort)
      xhr.open('PUT', endpoint(`/imports/${id}/content`))
      xhr.withCredentials = true
      xhr.timeout = 60 * 60_000
      xhr.setRequestHeader('Content-Type', 'application/vnd.infos.backup')
      xhr.setRequestHeader('Accept-Language', getLocale())
      const token = getClientToken()
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (event) => onProgress(event.loaded)
      xhr.onload = () => {
        cleanup()
        if (xhr.status === 401) window.dispatchEvent(new Event('infos:unauthorized'))
        try {
          const body = JSON.parse(xhr.responseText) as ApiResponse<unknown>
          if (xhr.status < 200 || xhr.status >= 300 || body.code !== 'OK')
            throw new Error(body.message || t('ui.backup', '备份请求失败，请检查网络和服务器状态'))
          resolve()
        } catch (error) {
          const failure =
            error instanceof SyntaxError
              ? new Error(
                  t('ui.backup', '上传失败（HTTP {0}），请检查反向代理与上传限制', [xhr.status]),
                )
              : error instanceof Error
                ? error
                : new Error(t('ui.backup', '备份请求失败，请检查网络和服务器状态'))
          reject(Object.assign(failure, { httpStatus: xhr.status }))
        }
      }
      xhr.onerror = xhr.ontimeout = () => {
        cleanup()
        reject(new Error(t('ui.backup', '上传连接中断，正在查询服务端进度')))
      }
      xhr.onabort = () => {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        cleanup()
        reject(signal.reason)
        return
      }
      xhr.send(file)
    })
  },
  async upload(file: File, password: string): Promise<BackupPreview> {
    const response = await clientFetch(endpoint('/previews'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.infos.backup',
        'X-Backup-Password': encodeURIComponent(password),
      },
      body: file,
    })
    if (!response.ok) return responseError(response)
    const result = (await response.json()) as ApiResponse<BackupPreview>
    return result.data!
  },
  async download(id: string, password: string): Promise<void> {
    const response = await apiClient.post<{ url: string }>(`/backups/${id}/download`, { password })
    const url = response.data?.url ?? ''
    if (!/^\/api\/backups\/downloads\/[a-f0-9]{64}$/.test(url))
      throw new Error(t('ui.backup', '下载链接无效，请重试'))
    const anchor = document.createElement('a')
    anchor.href = new URL(url, getWebServerOrigin()).href
    anchor.download = `infos-${id}.infos-backup`
    anchor.referrerPolicy = 'no-referrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  },
}
