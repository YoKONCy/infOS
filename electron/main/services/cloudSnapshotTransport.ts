import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getClientCredential } from '../utils/clientCredential'
import { isRemoteConnection } from './clientConnection'
import { getSteamUser } from './steam'

/** 仅负责后端一致性快照的传输，云存档调度由自动保存服务持有。 */
class CloudSnapshotTransport {
  private steamSnapshotKey(): Buffer {
    const user = getSteamUser()
    if (!user?.steamId) throw new Error('STEAM_CLOUD_ACCOUNT_UNAVAILABLE')
    // 相同账户在不同设备上使用相同传输密钥，访问边界由 Steam 账户权限提供。
    return createHash('sha256')
      .update(`infos-steam-full-snapshot:v1:${user.steamId}:4457100`)
      .digest()
  }

  async captureSnapshot(signal = AbortSignal.timeout(60_000)): Promise<Buffer> {
    if (isRemoteConnection()) throw new Error('STEAM_CLOUD_REMOTE_CONNECTION')
    const key = this.steamSnapshotKey()
    while (true) {
      signal.throwIfAborted()
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
      if (response.ok) return Buffer.from(await response.arrayBuffer())
      const body = await response.json().catch(() => null) as { code?: unknown } | null
      signal.throwIfAborted()
      // 客户端取消先于后端清理完成，沿用本次截止时间等待旧导出释放占用。
      if (body?.code === 'RESOURCE_BUSY') {
        await delay(250, undefined, { signal })
        continue
      }
      const code = typeof body?.code === 'string' ? `:${body.code}` : ''
      throw new Error(`STEAM_CLOUD_SNAPSHOT_HTTP_${response.status}${code}`)
    }
  }

  /** 恢复经过后端校验与暂存，应用时机由自动保存队列决定。 */
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
}

export const cloudSnapshotTransport = new CloudSnapshotTransport()
