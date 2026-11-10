import { steamCloudAutoSave } from './cloudAutoSave'
import { cloudSnapshotTransport } from './cloudSnapshotTransport'

export interface SyncResult {
  success: boolean
  uploaded: string[]
  downloaded: string[]
  failed: string[]
  errors: string[]
  restartRequired?: boolean
}

/** 既有云存档调用的兼容入口，统一委托保存队列与快照传输层。 */
class CloudSyncService {
  async captureSnapshot(signal = AbortSignal.timeout(60_000)): Promise<Buffer> {
    return cloudSnapshotTransport.captureSnapshot(signal)
  }

  /** 恢复必须经过后端校验与暂存，不能覆盖仍在使用的数据库。 */
  async stageSnapshot(bytes: Buffer, signal = AbortSignal.timeout(60_000)): Promise<string> {
    return cloudSnapshotTransport.stageSnapshot(bytes, signal)
  }

  /** 兼容已有调用，统一经过自动保存队列，避免另写一份过时的单文件存档。 */
  async uploadFullSnapshot(): Promise<SyncResult> {
    return steamCloudAutoSave.saveNow('requested', 60_000, true)
  }

  async downloadFullSnapshot(): Promise<SyncResult> {
    return steamCloudAutoSave.restoreFromCloud()
  }

  async sync(): Promise<SyncResult> {
    return this.downloadFullSnapshot()
  }

  async clearCloudData(): Promise<boolean> {
    return steamCloudAutoSave.clearCloudData()
  }
}

export const cloudSyncService = new CloudSyncService()
