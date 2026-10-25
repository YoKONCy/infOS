import { t as __t } from '../utils/i18n'
import { getClientCredential } from '../utils/clientCredential'
import { isRemoteConnection } from './clientConnection'
/**
 * Steam Cloud 完整快照适配器。
 *
 * 仅响应用户主动操作；不执行文件级合并、时间戳裁决或后台自动同步。
 */
import { createHash } from 'node:crypto'
import { IS_STEAM, getSteamCloudApi, getSteamUser } from './steam'
import { logger } from '../utils/logger'

const SNAPSHOT_KEY = 'infos/full-snapshot.bundle'
const CLOUD_PREFIX = 'infos/'

export interface SyncResult {
  success: boolean
  uploaded: string[]
  downloaded: string[]
  failed: string[]
  errors: string[]
  restartRequired?: boolean
}

export interface CloudSyncStatus {
  enabled: boolean
  isSteam: boolean
  lastSyncTime: number | null
  syncInProgress: boolean
}

class CloudSyncService {
  private lastSyncTime: number | null = null
  private syncInProgress = false
  // steamworks.js 的 Cloud API 没有稳定导出类型。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private steamCloud: any = null

  private ensureSteamCloud(): boolean {
    if (this.steamCloud) return true
    if (!IS_STEAM()) return false
    this.steamCloud = getSteamCloudApi()
    if (!this.steamCloud)
      logger.warn('CloudSync', __t('electron.logs.cloudSync', 'Steam Cloud API 不可用'))
    return Boolean(this.steamCloud)
  }

  getStatus(): CloudSyncStatus {
    return {
      enabled: IS_STEAM() && !isRemoteConnection(),
      isSteam: IS_STEAM(),
      lastSyncTime: this.lastSyncTime,
      syncInProgress: this.syncInProgress,
    }
  }

  private steamSnapshotKey(): Buffer {
    const user = getSteamUser()
    if (!user?.steamId) throw new Error('无法读取 Steam 用户身份')
    // 相同 Steam 账户在不同设备上得到相同传输密钥；Steam Cloud 账户权限是外层访问边界。
    return createHash('sha256')
      .update(`infos-steam-full-snapshot:v1:${user.steamId}:4457100`)
      .digest()
  }

  private writeCloudFile(key: string, content: string): boolean {
    try {
      return this.steamCloud?.writeFile(key, content) === true
    } catch (error) {
      logger.error(
        'CloudSync',
        __t('electron.logs.cloudSync', '写入 Steam Cloud 失败: {0} — {1}', [key, error]),
      )
      return false
    }
  }

  private readCloudFile(key: string): string | null {
    try {
      if (this.steamCloud?.fileExists && !this.steamCloud.fileExists(key)) return null
      const content = this.steamCloud?.readFile(key)
      return typeof content === 'string' ? content : null
    } catch (error) {
      logger.error(
        'CloudSync',
        __t('electron.logs.cloudSync', '读取 Steam Cloud 失败: {0} — {1}', [key, error]),
      )
      return null
    }
  }

  private listCloudFiles(): Array<{ name: string; size: number }> {
    try {
      const files = this.steamCloud?.listFiles?.() ?? []
      return files.map((file: { name: string; size: bigint | number }) => ({
        name: file.name,
        size: Number(file.size),
      }))
    } catch {
      return []
    }
  }

  private deleteCloudFile(key: string): boolean {
    try {
      this.steamCloud?.deleteFile(key)
      return true
    } catch {
      return false
    }
  }

  async uploadFullSnapshot(): Promise<SyncResult> {
    const result = this.initResult()
    if (!this.acquireLock(result)) return result
    try {
      if (!this.ensureSteamCloud()) throw new Error('Steam Cloud API 不可用')
      const key = this.steamSnapshotKey()
      const port = Number(process.env.PERO_PORT ?? 9120)
      const response = await fetch(`http://127.0.0.1:${port}/api/distributed/snapshot`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getClientCredential()}`,
          'X-Sync-Transfer-Key': key.toString('base64'),
        },
      })
      if (!response.ok) throw new Error(`Daemon 返回 HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!this.writeCloudFile(SNAPSHOT_KEY, `base64:${bytes.toString('base64')}`)) {
        throw new Error('Steam Cloud 写入完整快照失败')
      }
      result.uploaded.push('full-snapshot.bundle')
      result.success = true
      this.lastSyncTime = Date.now()
    } catch (error) {
      result.success = false
      result.errors.push(error instanceof Error ? error.message : String(error))
    } finally {
      this.syncInProgress = false
    }
    return result
  }

  async downloadFullSnapshot(): Promise<SyncResult> {
    const result = this.initResult()
    if (!this.acquireLock(result)) return result
    try {
      if (!this.ensureSteamCloud()) throw new Error('Steam Cloud API 不可用')
      const content = this.readCloudFile(SNAPSHOT_KEY)
      if (!content?.startsWith('base64:')) throw new Error('Steam Cloud 中没有完整快照')
      const key = this.steamSnapshotKey()
      const port = Number(process.env.PERO_PORT ?? 9120)
      const response = await fetch(`http://127.0.0.1:${port}/api/distributed/snapshot/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.infos.full-sync',
          Authorization: `Bearer ${getClientCredential()}`,
          'X-Sync-Transfer-Key': key.toString('base64'),
        },
        body: Buffer.from(content.slice(7), 'base64'),
      })
      if (!response.ok) throw new Error(`Daemon 返回 HTTP ${response.status}`)
      result.downloaded.push('full-snapshot.bundle')
      result.success = true
      result.restartRequired = true
      this.lastSyncTime = Date.now()
    } catch (error) {
      result.success = false
      result.errors.push(error instanceof Error ? error.message : String(error))
    } finally {
      this.syncInProgress = false
    }
    return result
  }

  /** 兼容既有 IPC 名称，语义固定为手动下载完整快照。 */
  async sync(): Promise<SyncResult> {
    return this.downloadFullSnapshot()
  }

  async clearCloudData(): Promise<boolean> {
    if (!this.ensureSteamCloud()) return false
    const files = this.listCloudFiles().filter((file) => file.name.startsWith(CLOUD_PREFIX))
    const cleared = files.every((file) => this.deleteCloudFile(file.name))
    if (cleared)
      logger.info(
        'CloudSync',
        __t('electron.logs.cloudSync', '已清除 {0} 个云端快照文件', [files.length]),
      )
    return cleared
  }

  private initResult(): SyncResult {
    return { success: true, uploaded: [], downloaded: [], failed: [], errors: [] }
  }

  private acquireLock(result: SyncResult): boolean {
    if (isRemoteConnection()) {
      result.success = false
      result.errors.push(
        __t(
          'electron.ui.startupSplash',
          '远程模式的业务存档由服务器备份，请在本地模式管理本机 Steam 快照。',
        ),
      )
      return false
    }
    if (this.syncInProgress) {
      result.success = false
      result.errors.push('同步正在进行中')
      return false
    }
    this.syncInProgress = true
    return true
  }
}

export const cloudSyncService = new CloudSyncService()
