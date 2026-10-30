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
import { inspectBackupFile } from './backupFile'

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
function uploadImportPart(
  file: Blob,
  id: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  range?: string,
): Promise<BackupImportProgress> {
  return new Promise<BackupImportProgress>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const cleanup = () => signal.removeEventListener('abort', abort)
    xhr.open('PUT', endpoint(`/imports/${id}/content`))
    xhr.withCredentials = true
    xhr.timeout = range ? 120_000 : 60 * 60_000
    xhr.setRequestHeader('Content-Type', 'application/vnd.infos.backup')
    xhr.setRequestHeader('Accept-Language', getLocale())
    if (range) xhr.setRequestHeader('Content-Range', range)
    const token = getClientToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (event) => onProgress(event.loaded)
    xhr.onload = () => {
      cleanup()
      if (xhr.status === 401) window.dispatchEvent(new Event('infos:unauthorized'))
      try {
        const body = JSON.parse(xhr.responseText) as ApiResponse<BackupImportProgress>
        if (xhr.status < 200 || xhr.status >= 300 || body.code !== 'OK')
          throw new Error(body.message || t('ui.backup', '备份请求失败，请检查网络和服务器状态'))
        if (!body.data) throw new Error(t('ui.backup', '备份上传进度无效，请重新选择文件'))
        resolve(body.data)
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
}

export const backupApi = {
  catalogue: () => apiClient.get<BackupCatalogue>('/backups/catalogue'),
  list: () =>
    apiClient.get<{
      records: BackupRecord[]
      pending: { ticket: string; backupId: string } | null
      lastImport: { status: 'completed' | 'failed'; id: string; error?: string } | null
      activeImport: BackupImportProgress | null
      runtime?: 'docker' | 'server'
    }>('/backups'),
  create: (selection: BackupSelection, password: string) =>
    apiClient.post<BackupRecord>('/backups', { selection, password }),
  previewSaved: (id: string, password: string) =>
    apiClient.post<BackupPreview>(`/backups/${id}/preview`, { password }),
  commit: (ticket: string, policy: ImportPolicy) =>
    apiClient.post<{ restartRequired: boolean }>(`/backups/previews/${ticket}/commit`, policy),
  remove: (id: string) => apiClient.delete(`/backups/${id}`),
  cancel: () => apiClient.delete('/backups/pending'),
  async beginImport(file: File, password: string) {
    const { encrypted, prefix } = await inspectBackupFile(file)
    if (encrypted && !password)
      throw new Error(t('ui.backup', '这份备份已加密，请先输入导出时设置的口令'))
    return apiClient.post<BackupImportProgress>('/backups/imports', {
      size: file.size,
      password: encrypted ? password : '',
      prefix,
    })
  },
  beginSavedImport: (id: string, password: string) =>
    apiClient.post<BackupImportProgress>(`/backups/${id}/import`, { password }),
  importProgress: (id: string) => apiClient.get<BackupImportProgress>(`/backups/imports/${id}`),
  cancelImport: (id: string) => apiClient.delete<BackupImportProgress>(`/backups/imports/${id}`),
  /** 服务端逐片确认；丢失确认响应时先查询位置，续传不重复追加已确认的数据。 */
  async uploadImport(
    file: File,
    id: string,
    signal: AbortSignal,
    onProgress: (bytes: number) => void,
    chunkBytes?: number,
  ): Promise<void> {
    if (chunkBytes === undefined) {
      await uploadImportPart(file, id, signal, onProgress)
      return
    }
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0)
      throw new Error(t('ui.backup', '备份上传进度无效，请重新选择文件'))
    const limit = Math.min(1024 ** 2, chunkBytes)
    let offset = 0
    let failures = 0
    const cursor = (state?: BackupImportProgress) => {
      if (
        !state ||
        state.uploadBytes !== file.size ||
        !Number.isSafeInteger(state.receivedBytes) ||
        state.receivedBytes < 0 ||
        state.receivedBytes > file.size
      )
        throw new Error(t('ui.backup', '备份上传进度无效，请重新选择文件'))
      if (['failed', 'cancelled', 'cancelling'].includes(state.phase))
        throw new Error(state.error || t('ui.backup', '备份请求失败，请检查网络和服务器状态'))
      return state.receivedBytes
    }
    while (offset < file.size) {
      signal.throwIfAborted()
      try {
        const end = Math.min(file.size, offset + limit)
        const start = offset
        const state = await uploadImportPart(
          file.slice(start, end),
          id,
          signal,
          (bytes) => onProgress(start + bytes),
          `bytes ${start}-${end - 1}/${file.size}`,
        )
        const confirmed = cursor(state)
        if (confirmed < end) throw new Error(t('ui.backup', '备份上传进度无效，请重新选择文件'))
        offset = confirmed
        onProgress(offset)
        failures = 0
      } catch (error) {
        signal.throwIfAborted()
        const status = (error as { httpStatus?: number })?.httpStatus
        if (status && status >= 400 && ![408, 409, 429].includes(status)) throw error
        if (++failures > 3)
          throw Object.assign(
            new Error(t('ui.backup', '上传多次中断，已停止本次导入，请检查网络或反向代理后重试')),
            { uploadExhausted: true },
          )
        await new Promise((resolve) => setTimeout(resolve, failures * 500))
        signal.throwIfAborted()
        let state: BackupImportProgress | undefined
        try {
          state = (await backupApi.importProgress(id)).data
        } catch {
          // 状态查询本身也可能断线；重试相同片，由服务端幂等确认。
          continue
        }
        const confirmed = cursor(state)
        if (confirmed > offset) failures = 0
        offset = confirmed
        onProgress(offset)
      }
    }
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
