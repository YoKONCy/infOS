import { getClientCredential } from '../utils/clientCredential'
import { isRemoteConnection } from './clientConnection'
import { createHash } from 'node:crypto'
import { getSteamUser } from './steam'

export interface SyncResult {
  success: boolean
  uploaded: string[]
  downloaded: string[]
  failed: string[]
  errors: string[]
  restartRequired?: boolean
}

/** 后端一致性快照适配器；云端代次、本机检查点与触发时机由自动保存服务统一管理。 */
class CloudSyncService {
  private steamSnapshotKey(): Buffer {
    const user = getSteamUser()
    if (!user?.steamId) throw new Error('STEAM_CLOUD_ACCOUNT_UNAVAILABLE')
    // 相同账户在不同设备上使用相同传输密钥；访问边界由 Steam 账户权限提供。
    return createHash('sha256')
      .update(`infos-steam-full-snapshot:v1:${user.steamId}:4457100`)
      .digest()
  }

  async captureSnapshot(signal = AbortSignal.timeout(60_000)): Promise<Buffer> {
    if (isRemoteConnection()) throw new Error('STEAM_CLOUD_REMOTE_CONNECTION')
    const key = this.steamSnapshotKey()
    const response = await fetch(
      `http://127.0.0.1:${Number(process.env.PERO_PORT ?? 9120)}/api/distributed/snapshot`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getClientCredential()}`,
          'X-Sync-Transfer-Key': key.toString('base64'),
        },
        redirect: 'error',
        signal,
      },
    )
    if (!response.ok) throw new Error(`STEAM_CLOUD_SNAPSHOT_HTTP_${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  /** 恢复必须经过后端校验与暂存，不能覆盖仍在使用的数据库。 */
  async stageSnapshot(bytes: Buffer, signal = AbortSignal.timeout(60_000)): Promise<string> {
    if (isRemoteConnection()) throw new Error('STEAM_CLOUD_REMOTE_CONNECTION')
    const response = await fetch(
      `http://127.0.0.1:${Number(process.env.PERO_PORT ?? 9120)}/api/distributed/snapshot/import`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.infos.full-sync',
          Authorization: `Bearer ${getClientCredential()}`,
          'X-Sync-Transfer-Key': this.steamSnapshotKey().toString('base64'),
        },
        body: new Uint8Array(bytes),
        redirect: 'error',
        signal,
      },
    )
    if (!response.ok) throw new Error(`STEAM_CLOUD_RESTORE_HTTP_${response.status}`)
    const body = (await response.json()) as { data?: { manifest?: { snapshotId?: string } } }
    if (!body.data?.manifest?.snapshotId) throw new Error('STEAM_CLOUD_RESTORE_RECEIPT_MISSING')
    return body.data.manifest.snapshotId
  }

  /** 兼容已有调用，统一经过自动保存队列，避免另写一份过时的单文件存档。 */
  async uploadFullSnapshot(): Promise<SyncResult> {
    const { steamCloudAutoSave } = await import('./cloudAutoSave')
    return steamCloudAutoSave.saveNow('requested', 60_000, true)
  }

  async downloadFullSnapshot(): Promise<SyncResult> {
    const { steamCloudAutoSave } = await import('./cloudAutoSave')
    return steamCloudAutoSave.restoreFromCloud()
  }

  async sync(): Promise<SyncResult> {
    return this.downloadFullSnapshot()
  }

  async clearCloudData(): Promise<boolean> {
    const { steamCloudAutoSave } = await import('./cloudAutoSave')
    return steamCloudAutoSave.clearCloudData()
  }
}

export const cloudSyncService = new CloudSyncService()
