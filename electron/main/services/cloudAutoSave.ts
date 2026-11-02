import { dialog } from 'electron'
import { createHash } from 'node:crypto'
import { watch, type Dirent, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SteamCloudSaveStatus } from '@infos/shared'
import { paths } from '../utils/env'
import { getClientCredential } from '../utils/clientCredential'
import { t } from '../utils/i18n'
import { logger } from '../utils/logger'
import { isRemoteConnection } from './clientConnection'
import { IS_STEAM, getSteamCloudApi, getSteamUser } from './steam'
import { cloudSyncService, type SyncResult } from './cloudSync'
import { CloudSnapshotStore, type CloudSnapshot, type LocalCloudState } from './cloudSnapshotStore'

const IGNORED_ROOTS = new Set([
  '.backup-state',
  'resource-versions',
  'logs',
  'temp',
  'cache',
  'cloud-cache',
  'sync',
  '.store-upgrades',
])
const MACHINE_FILES = new Set([
  'client-access.json',
  'client-access.json.tmp',
  'gateway_token.json',
  'jwt_secret.key',
  'kernel/nodes.json',
  'kernel/node-identity.json',
  'kernel/trust.json',
  'kernel/capability-device-tokens.json',
  'distributed/server-credentials.key',
  'distributed/servers.json',
  'distributed/last-sync.json',
  'electron-node-id.txt',
])
const ui = (source: string) => t('electron.ui.cloudSync', source)
const EMPTY_FINGERPRINT = createHash('sha256').update('').digest('hex')
const AUTO_SAVE_INTERVAL_MS = 2 * 60_000

/** 监测范围跟随完整快照；WAL 必须计入变化检测，不能等数据库主文件更新才保存。 */
export function isCloudSaveChange(relative: string): boolean {
  const normalized = relative.replaceAll('\\', '/')
  const parts = normalized.split('/')
  return Boolean(
    normalized &&
    !IGNORED_ROOTS.has(parts[0]!) &&
    !MACHINE_FILES.has(normalized) &&
    !parts.some((part) => part.startsWith('.resource-') || part.startsWith('.index-')) &&
    !/(?:-shm|\.lock)$/.test(normalized) &&
    !(
      parts[0] === 'applications' &&
      /(?:^|\/)(?:discovery\.json|host-bridge\.key)$/.test(normalized)
    ),
  )
}

/** 文件元数据用于保守检测修改；真正的数据一致性由后端快照协调器保证。 */
export async function cloudDataFingerprint(root: string, signal?: AbortSignal): Promise<string> {
  const entries: string[] = []
  const walk = async (relative: string): Promise<void> => {
    let children: Dirent[]
    try {
      children = await readdir(path.join(root, relative), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const child of children) {
      signal?.throwIfAborted()
      const name = relative ? `${relative}/${child.name}` : child.name
      if (!isCloudSaveChange(name) || child.isSymbolicLink()) continue
      if (child.isDirectory()) await walk(name)
      else if (child.isFile()) {
        try {
          const info = await stat(path.join(root, name))
          entries.push(`${name}\0${info.size}\0${info.mtimeMs}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }
  await walk('')
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex')
}

export class SteamCloudAutoSave {
  private store?: CloudSnapshotStore
  private state?: LocalCloudState
  private accountId = ''
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setInterval>
  private changeSequence = 0
  private savedChangeSequence = 0
  private running?: Promise<SyncResult>
  private controller?: AbortController
  private restore?: CloudSnapshot
  private paused = false
  private ready = false
  private stopping = false
  private phase: SteamCloudSaveStatus['phase'] = 'idle'
  private lastSteamWriteAt: number | null = null

  constructor(private readonly root = process.env.PERO_DATA_DIR || paths.data) {}

  getStatus(): SteamCloudSaveStatus {
    return {
      isSteam: IS_STEAM(),
      enabled: this.canWriteCloud() && !this.paused,
      phase: !IS_STEAM() || isRemoteConnection() ? 'disabled' : this.phase,
      lastLocalSaveAt:
        this.state?.lastLocalSaveAt ?? this.state?.checkpoint?.snapshot.createdAt ?? null,
      lastSteamWriteAt: this.lastSteamWriteAt,
      pending: this.state?.checkpoint?.pending ?? false,
    }
  }

  private currentAccount(): boolean {
    return Boolean(
      this.store &&
      IS_STEAM() &&
      !isRemoteConnection() &&
      this.accountId === getSteamUser()?.steamId,
    )
  }

  private canWriteCloud(): boolean {
    if (!this.currentAccount()) return false
    try {
      const api = getSteamCloudApi()
      return Boolean(api?.isEnabledForApp() && api.isEnabledForAccount?.() !== false)
    } catch {
      return false
    }
  }

  /** 在本机后端打开前比较云端代次；有分叉时保留两份数据，由用户选择恢复方向。 */
  async prepareStartup(signal?: AbortSignal): Promise<void> {
    if (this.store || !IS_STEAM() || isRemoteConnection()) return
    const account = getSteamUser()?.steamId
    if (!account) return
    this.accountId = account
    this.store = new CloudSnapshotStore(this.root, account, () =>
      getSteamUser()?.steamId === account && !isRemoteConnection() ? getSteamCloudApi() : null,
    )
    try {
      this.state = await this.store.readState()
      if (this.state.restoring) return
      const cloud = this.store.current()
      if (!cloud) {
        this.state.baseRevision = null
        await this.store.saveState(this.state)
        return
      }
      if (this.state.checkpoint?.pending && this.state.checkpoint.snapshot.id === cloud.id) {
        await this.store.publish(this.state)
      }
      this.lastSteamWriteAt = cloud.createdAt > 1 ? cloud.createdAt : null
      if (cloud.id === this.state.baseRevision) return
      const fingerprint = await cloudDataFingerprint(this.root, signal)
      const hasLocalData = fingerprint !== EMPTY_FINGERPRINT
      if (!hasLocalData || this.state.fingerprint === fingerprint) {
        this.restore = cloud
        return
      }
      signal?.throwIfAborted()
      const choice = await dialog.showMessageBox({
        type: 'question',
        title: ui('云存档冲突'),
        message: ui('本机和云端都有不同的存档。'),
        detail: ui('恢复云端前会保留本机恢复点；保留本机时会保留上一代云存档。'),
        buttons: [ui('恢复云端'), ui('保留本机'), ui('暂不同步')],
        defaultId: 2,
        cancelId: 2,
      })
      if (!this.currentAccount()) return
      if (choice.response === 0) this.restore = cloud
      else if (choice.response === 1) {
        this.state.baseRevision = cloud.id
        this.state.fingerprint = null
        await this.store.saveState(this.state)
      } else {
        this.paused = true
        this.phase = 'conflict'
      }
    } catch (error) {
      // 云不可达仍生成本机快照；清单或本机回执损坏时禁止覆盖远端。
      if (!(error instanceof Error) || error.message !== 'STEAM_CLOUD_UNAVAILABLE')
        this.paused = true
      this.state ??= { version: 1, baseRevision: null, fingerprint: null }
      this.phase = this.paused ? 'conflict' : 'pending'
      this.warn('云存档初始化未完成：{0}', error)
    }
  }

  /** 校验暂存后只重启本应用拥有的 Daemon；主窗口尚未出现，不覆盖运行中的数据库。 */
  async restoreAtStartup(
    canRestart: boolean,
    restart: () => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.currentAccount() || !this.store || !this.state) return true
    if (!this.restore && !this.state.restoring) return true
    try {
      if (this.state.restoring && (await this.restoreApplied())) return true
      if (!canRestart) throw new Error('STEAM_CLOUD_BACKEND_NOT_OWNED')
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
      if (this.restore) {
        let selected = this.restore
        let bytes: Buffer
        try {
          bytes = await this.store.readRemote(selected, timeout)
        } catch (error) {
          const previous = this.store.previous()
          if (!previous) throw error
          const choice = await dialog.showMessageBox({
            type: 'warning',
            title: ui('云存档恢复'),
            message: ui('最新云存档不完整，是否恢复上一份完整存档？'),
            buttons: [ui('恢复上一份'), ui('暂不同步')],
            defaultId: 1,
            cancelId: 1,
          })
          if (choice.response !== 0) throw error
          selected = previous
          bytes = await this.store.readRemote(selected, timeout)
        }
        timeout.throwIfAborted()
        const snapshotId = await cloudSyncService.stageSnapshot(bytes, timeout)
        this.state.restoring = {
          revision: selected.id,
          snapshotId,
          fingerprint: await cloudDataFingerprint(this.root),
        }
        await this.store.saveState(this.state)
        if (selected.id !== this.restore.id) this.store.adoptPrevious(selected)
        this.restore = undefined
      }
      signal.throwIfAborted()
      if (!(await restart())) return false
      if (!(await this.restoreApplied())) throw new Error('STEAM_CLOUD_RESTORE_NOT_APPLIED')
      return true
    } catch (error) {
      this.paused = true
      this.phase = 'conflict'
      this.warn('云存档恢复未完成：{0}', error)
      if (!signal.aborted)
        await dialog.showMessageBox({
          type: 'warning',
          title: ui('云存档恢复'),
          message: ui('云存档尚未恢复，本机数据保持保留。'),
          detail: ui('本次暂停云端写入，请检查连接或重启应用后重试。'),
          buttons: [ui('继续')],
        })
      return !this.state.restoring
    }
  }

  private async restoreApplied(): Promise<boolean> {
    if (!this.store || !this.state?.restoring) return false
    const response = await fetch(
      `http://127.0.0.1:${Number(process.env.PERO_PORT ?? 9120)}/api/distributed/pending`,
      {
        headers: { Authorization: `Bearer ${getClientCredential(true)}` },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      },
    )
    if (!response.ok) throw new Error('STEAM_CLOUD_RESTORE_STATUS_UNAVAILABLE')
    const body = (await response.json()) as { data?: { lastSync?: { snapshotId?: string } } }
    if (body.data?.lastSync?.snapshotId !== this.state.restoring.snapshotId) return false
    this.state.baseRevision = this.state.restoring.revision
    this.state.fingerprint = await cloudDataFingerprint(this.root)
    this.state.lastLocalSaveAt = Date.now()
    delete this.state.restoring
    delete this.state.checkpoint
    await this.store.saveState(this.state)
    this.paused = false
    this.phase = 'saved'
    return true
  }

  start(): void {
    if (this.ready || !this.currentAccount() || !this.state) return
    this.ready = true
    this.stopping = false
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename || isCloudSaveChange(String(filename))) this.markChanged()
      })
      this.watcher.on('error', (error) => this.warn('云存档文件监测暂不可用：{0}', error))
    } catch (error) {
      this.warn('云存档文件监测暂不可用：{0}', error)
    }
    // 常规保存统一使用两分钟周期，文件变化只标记待保存，避免多个定时器重复触发。
    this.timer = setInterval(() => {
      void this.saveNow('periodic', 60_000, this.changeSequence !== this.savedChangeSequence)
    }, AUTO_SAVE_INTERVAL_MS)
    this.timer.unref()
    void this.saveNow('startup')
  }

  /** 兼容已有恢复入口；先暂停自动写入，暂存完成后等待正常的重启流程。 */
  async restoreFromCloud(): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      uploaded: [],
      downloaded: [],
      failed: [],
      errors: [],
    }
    if (!this.currentAccount() || !this.store || !this.state) return result
    this.paused = true
    const wasReady = this.ready
    this.ready = false
    this.controller?.abort()
    await this.running
    try {
      const snapshot = this.store.current()
      if (!snapshot) throw new Error('STEAM_CLOUD_SNAPSHOT_MISSING')
      const signal = AbortSignal.timeout(60_000)
      const bytes = await this.store.readRemote(snapshot, signal)
      const snapshotId = await cloudSyncService.stageSnapshot(bytes, signal)
      this.state.restoring = {
        revision: snapshot.id,
        snapshotId,
        fingerprint: await cloudDataFingerprint(this.root),
      }
      await this.store.saveState(this.state)
      result.success = true
      result.restartRequired = true
      result.downloaded.push('full-snapshot.bundle')
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
    this.ready = wasReady && !this.state.restoring
    this.phase = 'conflict'
    return result
  }

  async clearCloudData(): Promise<boolean> {
    if (!this.currentAccount() || !this.store || !this.state) return false
    this.paused = true
    const wasReady = this.ready
    this.ready = false
    this.controller?.abort()
    await this.running
    try {
      const api = getSteamCloudApi()
      if (!api?.isEnabledForApp()) return false
      for (const file of api.listFiles()) {
        if (!this.currentAccount()) return false
        if (file.name.startsWith('infos/') && !api.deleteFile(file.name)) return false
      }
      this.state.baseRevision = null
      if (this.state.checkpoint) this.state.checkpoint.pending = true
      await this.store.saveState(this.state)
      return true
    } catch (error) {
      this.warn('自动云存档暂未完成，将保留本机数据并重试：{0}', error)
      return false
    } finally {
      this.ready = wasReady
      this.phase = 'conflict'
    }
  }

  private markChanged(): void {
    if (this.stopping || !this.ready) return
    this.changeSequence++
  }

  saveNow(reason = 'requested', timeoutMs = 60_000, force = false): Promise<SyncResult> {
    if (this.running) return this.running
    if (!this.ready || !this.currentAccount())
      return Promise.resolve({
        success: false,
        uploaded: [],
        downloaded: [],
        failed: [],
        errors: ['STEAM_CLOUD_NOT_READY'],
      })
    this.controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)])
    this.running = this.save(reason, signal, force).finally(() => {
      this.running = undefined
      this.controller = undefined
    })
    return this.running
  }

  private async save(reason: string, signal: AbortSignal, force: boolean): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      uploaded: [],
      downloaded: [],
      failed: [],
      errors: [],
    }
    if (!this.store || !this.state) return result
    this.phase = 'saving'
    try {
      const capturedChangeSequence = this.changeSequence
      const fingerprint = await cloudDataFingerprint(this.root, signal)
      const latest = this.state.checkpoint?.fingerprint ?? this.state.fingerprint
      if (force || latest !== fingerprint) {
        let bytes: Buffer
        try {
          bytes = await cloudSyncService.captureSnapshot(signal)
        } catch (error) {
          // 后端异常时仍将已落盘的上一份完整快照交给 Steam，不依赖退出时临时生成。
          if (this.state.checkpoint?.pending && !this.paused && this.currentAccount())
            await this.store.publish(this.state, signal)
          throw error
        }
        signal.throwIfAborted()
        if (!this.currentAccount()) throw new Error('STEAM_CLOUD_ACCOUNT_CHANGED')
        await this.store.checkpoint(bytes, fingerprint, this.state)
        // 捕获期间的新修改留给下一轮，不能被本次保存清除。
        this.savedChangeSequence = capturedChangeSequence
      }
      signal.throwIfAborted()
      if (!this.paused && !this.state.restoring) {
        await this.store.publish(this.state, signal)
        this.lastSteamWriteAt = this.state.checkpoint?.snapshot.createdAt ?? this.lastSteamWriteAt
      }
      this.phase = this.paused || this.state.restoring ? 'conflict' : 'saved'
      result.success = !this.paused && !this.state.restoring
      if (result.success) result.uploaded.push('full-snapshot.bundle')
    } catch (error) {
      if (error instanceof Error && error.message === 'STEAM_CLOUD_CONFLICT') this.paused = true
      this.phase = this.paused ? 'conflict' : 'pending'
      result.errors.push(error instanceof Error ? error.message : String(error))
      this.warn('自动云存档暂未完成，将保留本机数据并重试：{0}', `${reason}: ${result.errors[0]}`)
    }
    return result
  }

  /** 先取消旧请求，再限时请求最后一次快照，完成后才交还后端退出清理。 */
  async stopAndSave(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.timer)
    this.watcher?.close()
    this.watcher = undefined
    this.controller?.abort()
    await this.running
    if (this.ready) await this.saveNow('exit', 20_000, true)
    this.ready = false
  }

  private warn(source: string, error: unknown): void {
    logger.warn('CloudSync', t('electron.logs.cloudSync', source, [String(error)]))
  }
}

export const steamCloudAutoSave = new SteamCloudAutoSave()
