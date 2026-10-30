import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile, copyFile, cp } from 'node:fs/promises'
import path from 'node:path'
import { BACKUP_STATE, installBackupTree, snapshotOfflineTree } from '../backup/backupStorage'
import { BackupService } from '../backup/backupService'
import { safeBackupPath } from '../backup/backupArchive'
import { prepareRestoredDatabase } from '../backup/backupRecords'
import type { DrizzleDb } from '../../database'
import type { MemoryStoreRegistry } from '../../repositories/storeRegistry'
import {
  managedStoreBase,
  TRIVIUM_BACKUP_DIRECTORY,
  TRIVIUM_FORMAT,
  TRIVIUM_VERSION,
} from '../../repositories/triviumFiles'

const APP_VERSION = '0.9.10'
const BUNDLE_VERSION = 2
const SCHEMA_VERSION = 1
const MAX_FILE_COUNT = 100_000
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024
const MACHINE_PATHS = new Set([
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
const EXCLUDED_ROOTS = new Set([
  BACKUP_STATE,
  'resource-versions',
  'logs',
  'temp',
  'cache',
  'cloud-cache',
  'sync',
  TRIVIUM_BACKUP_DIRECTORY,
])

function validateStorageVersion(manifest: FullSyncManifest): void {
  if (!manifest) throw new Error('SYNC_BUNDLE_INVALID')
  if (![1, BUNDLE_VERSION].includes(manifest.bundleVersion))
    throw new Error('SYNC_BUNDLE_VERSION_UNSUPPORTED')
  if (!/^[a-f0-9-]{36}$/i.test(manifest.snapshotId)) throw new Error('SYNC_SNAPSHOT_ID_INVALID')
  const format = manifest.triviumFormat
  if (
    manifest.bundleVersion === 2 &&
    (typeof format !== 'number' || !Number.isInteger(format) || format < 5)
  )
    throw new Error('同步快照缺少有效的数据库格式版本')
  if ((manifest.triviumFormat ?? 7) > TRIVIUM_FORMAT)
    throw new Error('同步快照使用了更新的数据库格式，请先升级应用')
}

export interface FullSyncManifest {
  bundleVersion: number
  schemaVersion: number
  snapshotId: string
  sourceServerId: string
  appVersion: string
  triviumFormat?: number
  triviumVersion?: string
  createdAt: string
  files: Array<{ path: string; sizeBytes: number; sha256: string }>
  totalBytes: number
}

interface FullSyncBundle {
  manifest: FullSyncManifest
  files: Record<string, string>
}

interface SavedServer {
  serverId: string
  displayName: string
  endpoint: string
  tokenCiphertext: string
  certificateFingerprint?: string
  savedAt: string
  lastConnectedAt?: string
}

export interface PublicServerRecord {
  serverId: string
  displayName: string
  endpoint: string
  certificateFingerprint?: string
  savedAt: string
  lastConnectedAt?: string
}

/** 多 Server 手动全量快照、远程 Server 列表与重启边界原子导入。 */
export class DistributedSyncService {
  private readonly syncRoot: string
  private readonly serversFile: string
  private readonly keyFile: string

  constructor(
    private readonly dataDir: string,
    private readonly db: DrizzleDb,
    private readonly localServerId: string,
    private readonly stores?: Pick<MemoryStoreRegistry, 'captureSnapshot'>,
    private readonly capture?: (destination: string) => void,
  ) {
    this.syncRoot = path.join(dataDir, BACKUP_STATE, 'sync')
    this.serversFile = path.join(dataDir, 'distributed', 'servers.json')
    this.keyFile = path.join(dataDir, 'distributed', 'server-credentials.key')
  }

  identity(): { serverId: string; displayName: string; appVersion: string } {
    return {
      serverId: this.localServerId,
      displayName: process.env.INFOS_SERVER_NAME ?? this.localServerId,
      appVersion: APP_VERSION,
    }
  }

  async listServers(): Promise<PublicServerRecord[]> {
    return (await this.loadServers()).map((record) => ({
      serverId: record.serverId,
      displayName: record.displayName,
      endpoint: record.endpoint,
      certificateFingerprint: record.certificateFingerprint,
      savedAt: record.savedAt,
      lastConnectedAt: record.lastConnectedAt,
    }))
  }

  async probe(
    endpoint: string,
    token: string,
  ): Promise<{
    serverId: string
    displayName: string
    endpoint: string
    appVersion: string
    latencyMs: number
  }> {
    const normalized = this.normalizeEndpoint(endpoint)
    const startedAt = Date.now()
    const response = await fetch(`${normalized}/api/distributed/identity`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`REMOTE_SERVER_UNAVAILABLE: HTTP ${response.status}`)
    const body = (await response.json()) as {
      data?: { serverId?: string; displayName?: string; appVersion?: string }
    }
    const data = body.data
    if (!data?.serverId) throw new Error('REMOTE_SERVER_INVALID: 缺少 Server ID')
    return {
      serverId: data.serverId,
      displayName: data.displayName ?? data.serverId,
      endpoint: normalized,
      appVersion: data.appVersion ?? 'unknown',
      latencyMs: Date.now() - startedAt,
    }
  }

  async saveServer(input: {
    endpoint: string
    token: string
    displayName?: string
  }): Promise<PublicServerRecord> {
    const probe = await this.probe(input.endpoint, input.token)
    if (probe.serverId === this.localServerId) {
      throw new Error('REMOTE_SERVER_SELF: 不能把当前 Server 保存为远程来源')
    }
    const records = await this.loadServers()
    const record: SavedServer = {
      serverId: probe.serverId,
      displayName: input.displayName?.trim() || probe.displayName,
      endpoint: probe.endpoint,
      tokenCiphertext: await this.encryptLocal(input.token),
      savedAt:
        records.find((item) => item.serverId === probe.serverId)?.savedAt ??
        new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
    }
    const next = records.filter((item) => item.serverId !== record.serverId)
    next.push(record)
    await this.saveServers(next)
    return {
      serverId: record.serverId,
      displayName: record.displayName,
      endpoint: record.endpoint,
      certificateFingerprint: record.certificateFingerprint,
      savedAt: record.savedAt,
      lastConnectedAt: record.lastConnectedAt,
    }
  }

  async removeServer(serverId: string): Promise<boolean> {
    const records = await this.loadServers()
    const next = records.filter((item) => item.serverId !== serverId)
    if (next.length === records.length) return false
    await this.saveServers(next)
    return true
  }

  async createEncryptedSnapshot(transferKeyBase64: string): Promise<Buffer> {
    const transferKey = Buffer.from(transferKeyBase64, 'base64')
    if (transferKey.length !== 32) throw new Error('SYNC_TRANSFER_KEY_INVALID')
    const bundle = await this.createBundle()
    return this.encrypt(Buffer.from(JSON.stringify(bundle)), transferKey)
  }

  async stageEncryptedSnapshot(
    encrypted: Buffer,
    transferKeyBase64: string,
    expectedSourceServerId?: string,
  ): Promise<FullSyncManifest> {
    if (
      existsSync(path.join(this.dataDir, BACKUP_STATE, 'pending.json')) ||
      (await this.pending()) ||
      existsSync(path.join(this.syncRoot, 'rollback.json'))
    )
      throw new Error('BACKUP_PENDING_IMPORT')
    const transferKey = Buffer.from(transferKeyBase64, 'base64')
    if (transferKey.length !== 32) throw new Error('SYNC_TRANSFER_KEY_INVALID')
    const bundle = JSON.parse(
      this.decrypt(encrypted, transferKey).toString('utf8'),
    ) as FullSyncBundle
    this.validateBundle(bundle, expectedSourceServerId ?? bundle.manifest.sourceServerId)
    await mkdir(this.syncRoot, { recursive: true })
    const localKey = await this.getLocalKey()
    await writeFile(
      path.join(this.syncRoot, 'pending.bundle'),
      this.encrypt(Buffer.from(JSON.stringify(bundle)), localKey),
      { mode: 0o600 },
    )
    await writeFile(
      path.join(this.syncRoot, 'pending.json'),
      JSON.stringify({
        snapshotId: bundle.manifest.snapshotId,
        sourceServerId: bundle.manifest.sourceServerId,
      }),
      'utf8',
    )
    return bundle.manifest
  }

  async stageFromServer(serverId: string): Promise<FullSyncManifest> {
    const record = (await this.loadServers()).find((item) => item.serverId === serverId)
    if (!record) throw new Error('REMOTE_SERVER_NOT_FOUND')
    const token = await this.decryptLocal(record.tokenCiphertext)
    const transferKey = randomBytes(32)
    const response = await fetch(`${record.endpoint}/api/distributed/snapshot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Sync-Transfer-Key': transferKey.toString('base64'),
      },
      signal: AbortSignal.timeout(10 * 60_000),
    })
    if (!response.ok) throw new Error(`SYNC_DOWNLOAD_FAILED: HTTP ${response.status}`)
    const encrypted = Buffer.from(await response.arrayBuffer())
    return this.stageEncryptedSnapshot(encrypted, transferKey.toString('base64'), serverId)
  }

  async pending(): Promise<{ snapshotId: string; sourceServerId: string } | null> {
    try {
      return JSON.parse(await readFile(path.join(this.syncRoot, 'pending.json'), 'utf8')) as {
        snapshotId: string
        sourceServerId: string
      }
    } catch {
      return null
    }
  }

  async lastSync(): Promise<(FullSyncManifest & { backupPath: string }) | null> {
    try {
      return JSON.parse(
        await readFile(path.join(this.dataDir, 'distributed', 'last-sync.json'), 'utf8'),
      ) as FullSyncManifest & { backupPath: string }
    } catch {
      return null
    }
  }

  async stageRollback(): Promise<boolean> {
    if (existsSync(path.join(this.dataDir, BACKUP_STATE, 'pending.json')) || (await this.pending()))
      throw new Error('BACKUP_PENDING_IMPORT')
    const lastSync = await this.lastSync()
    if (!lastSync?.backupPath) return false
    const backupPath = path.resolve(lastSync.backupPath)
    const relative = path.relative(path.resolve(this.syncRoot), backupPath)
    const legacyRelative = path.relative(
      path.join(path.dirname(this.dataDir), '.infos-sync'),
      backupPath,
    )
    if (
      ((relative.startsWith('..') || path.isAbsolute(relative)) &&
        (legacyRelative.startsWith('..') || path.isAbsolute(legacyRelative))) ||
      !existsSync(backupPath)
    ) {
      throw new Error('SYNC_BACKUP_INVALID')
    }
    await mkdir(this.syncRoot, { recursive: true })
    await writeFile(
      path.join(this.syncRoot, 'rollback.json'),
      JSON.stringify({ backupPath, requestedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
    return true
  }

  private async createBundle(): Promise<FullSyncBundle> {
    const snapshotId = randomUUID()
    const snapshotRoot = path.join(this.dataDir, BACKUP_STATE, 'work', `export-${snapshotId}`)
    const databaseSnapshot = path.join(snapshotRoot, 'infos.db')
    await mkdir(snapshotRoot, { recursive: true })
    try {
      const client = (
        this.db as unknown as {
          $client?: {
            backup?(target: string): Promise<unknown>
            prepare?(sql: string): { run(target: string): unknown }
          }
        }
      ).$client
      if (this.capture) this.capture(snapshotRoot)
      else if (this.stores) {
        const prepare = client?.prepare?.bind(client)
        if (!prepare) throw new Error('同步快照缺少同步数据库备份入口')
        this.stores.captureSnapshot(snapshotRoot, () => {
          prepare('VACUUM INTO ?').run(databaseSnapshot)
        })
      } else {
        if (!client?.backup) throw new Error('SYNC_DATABASE_BACKUP_UNAVAILABLE')
        await client.backup(databaseSnapshot)
      }

      const files: Record<string, string> = {}
      const descriptors: FullSyncManifest['files'] = []
      let totalBytes = 0
      const add = async (relativePath: string, physicalPath: string) => {
        if (descriptors.length >= MAX_FILE_COUNT) throw new Error('SYNC_FILE_COUNT_LIMIT_EXCEEDED')
        const bytes = await readFile(physicalPath)
        if (bytes.length > MAX_FILE_BYTES)
          throw new Error(`SYNC_FILE_SIZE_LIMIT_EXCEEDED: ${relativePath}`)
        if (totalBytes + bytes.length > MAX_TOTAL_BYTES)
          throw new Error('SYNC_TOTAL_SIZE_LIMIT_EXCEEDED')
        files[relativePath] = bytes.toString('base64')
        descriptors.push({
          path: relativePath,
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
        totalBytes += bytes.length
      }
      await this.walkData(snapshotRoot, '', add)
      if (!this.capture)
        await this.walkData(this.dataDir, '', async (relativePath, physicalPath) => {
          if (relativePath === 'infos.db') return
          if (managedStoreBase(relativePath)) {
            if (!this.stores) throw new Error('存在向量数据库，必须通过 Store 快照协调器导出')
            return
          }
          await add(relativePath, physicalPath)
        })
      return {
        manifest: {
          bundleVersion: BUNDLE_VERSION,
          schemaVersion: SCHEMA_VERSION,
          snapshotId,
          sourceServerId: this.localServerId,
          appVersion: APP_VERSION,
          triviumVersion: TRIVIUM_VERSION,
          triviumFormat: TRIVIUM_FORMAT,
          createdAt: new Date().toISOString(),
          files: descriptors.sort((left, right) => left.path.localeCompare(right.path)),
          totalBytes,
        },
        files,
      }
    } finally {
      await rm(snapshotRoot, { recursive: true, force: true })
    }
  }

  private async walkData(
    root: string,
    relative: string,
    visit: (relativePath: string, physicalPath: string) => Promise<void>,
  ): Promise<void> {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name
      const normalized = next.replaceAll('\\', '/')
      if (MACHINE_PATHS.has(normalized)) continue
      if (!relative && EXCLUDED_ROOTS.has(entry.name)) continue
      if (!relative && entry.name.startsWith('.resource-')) continue
      // 重建暂存区不是业务数据，不能将回滚用的旧正文带进同步快照。
      if (
        (/^agent_[\w-]+$/.test(relative) || relative === 'knowledge') &&
        /^\.index-[a-f0-9-]+$/i.test(entry.name)
      )
        continue
      if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm') || entry.isSymbolicLink())
        continue
      if (entry.isDirectory()) await this.walkData(root, normalized, visit)
      else if (entry.isFile()) await visit(normalized, path.join(root, normalized))
    }
  }

  private validateBundle(bundle: FullSyncBundle, sourceServerId: string): void {
    if (!bundle?.manifest || !bundle.files || typeof bundle.files !== 'object') {
      throw new Error('SYNC_BUNDLE_INVALID')
    }
    validateStorageVersion(bundle.manifest)
    if (bundle.manifest.schemaVersion !== SCHEMA_VERSION)
      throw new Error('SYNC_SCHEMA_VERSION_UNSUPPORTED')
    if (bundle.manifest.files.length > MAX_FILE_COUNT)
      throw new Error('SYNC_FILE_COUNT_LIMIT_EXCEEDED')
    if (bundle.manifest.totalBytes > MAX_TOTAL_BYTES)
      throw new Error('SYNC_TOTAL_SIZE_LIMIT_EXCEEDED')
    if (bundle.manifest.sourceServerId !== sourceServerId)
      throw new Error('SYNC_SOURCE_ID_MISMATCH')
    const uniquePaths = new Set<string>()
    let totalBytes = 0
    for (const descriptor of bundle.manifest.files) {
      const safePath = this.safeRelative(descriptor.path)
      if (MACHINE_PATHS.has(safePath)) throw new Error('同步快照不能包含本机凭据')
      if (uniquePaths.has(safePath)) throw new Error(`SYNC_FILE_DUPLICATED: ${safePath}`)
      uniquePaths.add(safePath)
      if (descriptor.sizeBytes > MAX_FILE_BYTES)
        throw new Error(`SYNC_FILE_SIZE_LIMIT_EXCEEDED: ${safePath}`)
      totalBytes += descriptor.sizeBytes
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('SYNC_TOTAL_SIZE_LIMIT_EXCEEDED')
      const encoded = bundle.files[safePath]
      if (!encoded) throw new Error(`SYNC_FILE_MISSING: ${safePath}`)
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length !== descriptor.sizeBytes)
        throw new Error(`SYNC_FILE_SIZE_MISMATCH: ${safePath}`)
      if (createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) {
        throw new Error(`SYNC_FILE_CHECKSUM_MISMATCH: ${safePath}`)
      }
    }
    if (totalBytes !== bundle.manifest.totalBytes) throw new Error('SYNC_TOTAL_SIZE_MISMATCH')
  }

  private safeRelative(value: string): string {
    try {
      return safeBackupPath(value.replaceAll('\\', '/'))
    } catch {
      throw new Error(`SYNC_PATH_INVALID: ${value}`)
    }
  }

  private normalizeEndpoint(value: string): string {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('REMOTE_ENDPOINT_INVALID')
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  }

  private async loadServers(): Promise<SavedServer[]> {
    try {
      const parsed = JSON.parse(await readFile(this.serversFile, 'utf8')) as {
        version: 1
        servers: SavedServer[]
      }
      return parsed.version === 1 && Array.isArray(parsed.servers) ? parsed.servers : []
    } catch {
      return []
    }
  }

  private async saveServers(servers: SavedServer[]): Promise<void> {
    await mkdir(path.dirname(this.serversFile), { recursive: true })
    await writeFile(this.serversFile, JSON.stringify({ version: 1, servers }, null, 2), {
      mode: 0o600,
    })
  }

  private async getLocalKey(): Promise<Buffer> {
    await mkdir(path.dirname(this.keyFile), { recursive: true })
    if (existsSync(this.keyFile)) return Buffer.from(await readFile(this.keyFile, 'utf8'), 'base64')
    const key = randomBytes(32)
    await writeFile(this.keyFile, key.toString('base64'), { mode: 0o600 })
    return key
  }

  private async encryptLocal(value: string): Promise<string> {
    return this.encrypt(Buffer.from(value), await this.getLocalKey()).toString('base64')
  }

  private async decryptLocal(value: string): Promise<string> {
    return this.decrypt(Buffer.from(value, 'base64'), await this.getLocalKey()).toString('utf8')
  }

  private encrypt(value: Buffer, key: Buffer): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }

  private decrypt(value: Buffer, key: Buffer): Buffer {
    if (value.length < 28) throw new Error('SYNC_CIPHERTEXT_INVALID')
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()])
  }

  /** 数据库打开前应用暂存包，保留当前机器身份并生成完整回滚目录。 */
  static async applyPending(dataDir: string): Promise<boolean> {
    const currentRoot = path.join(dataDir, BACKUP_STATE, 'sync')
    const legacyRoot = path.join(path.dirname(dataDir), '.infos-sync')
    const syncRoot = ['pending.bundle', 'rollback.json'].some((file) =>
      existsSync(path.join(currentRoot, file)),
    )
      ? currentRoot
      : ['pending.bundle', 'rollback.json'].some((file) => existsSync(path.join(legacyRoot, file)))
        ? legacyRoot
        : currentRoot
    const rollbackInfo = path.join(syncRoot, 'rollback.json')
    if (existsSync(rollbackInfo)) {
      const rollback = JSON.parse(await readFile(rollbackInfo, 'utf8')) as { backupPath?: string }
      const backupPath = rollback.backupPath ? path.resolve(rollback.backupPath) : ''
      const relative = backupPath ? path.relative(path.resolve(syncRoot), backupPath) : '..'
      const legacyRelative = backupPath ? path.relative(path.resolve(legacyRoot), backupPath) : '..'
      if (
        !backupPath ||
        ((relative.startsWith('..') || path.isAbsolute(relative)) &&
          (legacyRelative.startsWith('..') || path.isAbsolute(legacyRelative))) ||
        !existsSync(backupPath)
      ) {
        throw new Error('SYNC_BACKUP_INVALID')
      }
      const incoming = path.join(dataDir, BACKUP_STATE, 'sync', `rollback-${randomUUID()}`)
      const before = path.join(dataDir, BACKUP_STATE, 'sync', `before-rollback-${randomUUID()}`)
      await snapshotOfflineTree(dataDir, before)
      await BackupService.createRecoveryPoint(dataDir, before)
      await cp(backupPath, incoming, { recursive: true, dereference: false })
      prepareRestoredDatabase(path.join(incoming, 'infos.db'), path.join(before, 'infos.db'))
      await installBackupTree(dataDir, incoming)
      await rm(rollbackInfo, { force: true })
      await rm(before, { recursive: true, force: true })
      return true
    }
    const pendingBundle = path.join(syncRoot, 'pending.bundle')
    const pendingInfo = path.join(syncRoot, 'pending.json')
    if (!existsSync(pendingBundle) || !existsSync(pendingInfo)) return false
    const keyFile = path.join(dataDir, 'distributed', 'server-credentials.key')
    if (!existsSync(keyFile)) throw new Error('SYNC_LOCAL_KEY_MISSING')
    const key = Buffer.from(await readFile(keyFile, 'utf8'), 'base64')
    const encrypted = await readFile(pendingBundle)
    const iv = encrypted.subarray(0, 12)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(encrypted.subarray(12, 28))
    const bundle = JSON.parse(
      Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8'),
    ) as FullSyncBundle

    validateStorageVersion(bundle.manifest)

    const incoming = path.join(currentRoot, `incoming-${bundle.manifest.snapshotId}`)
    const backup = path.join(currentRoot, `backup-${randomUUID()}`)
    await rm(incoming, { recursive: true, force: true })
    await mkdir(incoming, { recursive: true })
    for (const descriptor of bundle.manifest.files) {
      const normalized = safeBackupPath(descriptor.path.replaceAll('\\', '/'))
      // 资源恢复记录属于本机，不能导入远端的启动标记、锁或待执行操作。
      if (
        normalized.split('/')[0] === 'resource-versions' ||
        normalized.split('/')[0]?.startsWith('.resource-')
      )
        continue
      if (MACHINE_PATHS.has(normalized)) throw new Error('同步快照不能包含本机凭据')
      if (
        !normalized ||
        normalized.startsWith('/') ||
        normalized.includes('../') ||
        path.isAbsolute(normalized)
      ) {
        throw new Error(`SYNC_PATH_INVALID: ${descriptor.path}`)
      }
      const bytes = Buffer.from(bundle.files[normalized] ?? '', 'base64')
      if (createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) {
        throw new Error(`SYNC_FILE_CHECKSUM_MISMATCH: ${normalized}`)
      }
      const target = path.join(incoming, normalized)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    for (const machinePath of MACHINE_PATHS) {
      const source = path.join(dataDir, machinePath)
      if (!existsSync(source)) continue
      const target = path.join(incoming, machinePath)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(source, target)
    }
    const localVersions = path.join(dataDir, 'resource-versions')
    if (existsSync(localVersions))
      await cp(localVersions, path.join(incoming, 'resource-versions'), {
        recursive: true,
        dereference: false,
        filter: (file) => path.basename(file) !== 'state.lock',
      })
    await mkdir(path.dirname(backup), { recursive: true })
    await snapshotOfflineTree(dataDir, backup)
    await BackupService.createRecoveryPoint(dataDir, backup)
    prepareRestoredDatabase(path.join(incoming, 'infos.db'), path.join(backup, 'infos.db'))
    {
      await installBackupTree(dataDir, incoming)
      await rm(pendingBundle, { force: true })
      await rm(pendingInfo, { force: true })
      await mkdir(path.join(dataDir, 'distributed'), { recursive: true })
      await writeFile(
        path.join(dataDir, 'distributed', 'last-sync.json'),
        JSON.stringify({ ...bundle.manifest, backupPath: backup }, null, 2),
        'utf8',
      )
      return true
    }
  }
}
