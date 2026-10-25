import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { DrizzleDb } from '../../database'
import type { MemoryStoreRegistry } from '../../repositories/storeRegistry'
import type { AgentManager } from '../agent/agentManager'
import { managedStoreBase, TRIVIUM_FORMAT, TRIVIUM_VERSION } from '../../repositories/triviumFiles'
import { fileDigest, readBackupArchive, readBackupRows, safeBackupPath, writeBackupArchive } from './backupArchive'
import { atomicBackupJson, BACKUP_STATE, snapshotOfflineTree, excludedBackupPath, installBackupTree, recoverBackupRestore, LOCAL_FILES } from './backupStorage'
import { hasTable, mergeBackupRecords, MODULE_TABLES, prepareRestoredDatabase, readTable, recordConflicts, redactBackupRow, redactBackupValue, sanitizeRestoredDatabase, selectBackupRecords, SOCIAL_TABLE, TABLES, validateSocialBackup } from './backupRecords'
import type { BackupManifest, BackupPreview, BackupRecord, BackupRow, BackupSelection, ImportPolicy } from './backupTypes'

const MAX_UPLOAD = 20 * 1024 ** 3
const APP_VERSION = '0.9.6'
const UUID = /^[a-f0-9-]{36}$/i
const AGENT = /^[a-z0-9][a-z0-9_-]{0,79}$/
const emptySelection = (): BackupSelection => ({ level: 'full', modules: [], agentIds: [], threadIds: [], documentIds: [], factIds: [], taskIds: [], includeSecrets: true })

interface Dependencies {
  dataDir: string
  db: DrizzleDb
  stores: MemoryStoreRegistry
  agents: AgentManager
  sourceServerId: string
  assertIdle: (applications: boolean) => void
}

/** 备份、局部迁移和恢复使用同一包格式；运行中的数据库从不直接导入。 */
export class BackupService {
  readonly root: string
  private busy = false
  private activeWrites = 0
  constructor(private readonly deps: Dependencies) { this.root = path.join(deps.dataDir, BACKUP_STATE) }
  /** HTTP 写入完成后才允许同步捕获，避免异步文件写入与快照复制交错。 */
  beginWrite(): () => void {
    this.activeWrites++
    let released = false
    return () => { if (!released) { released = true; this.activeWrites-- } }
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('BACKUP_STORAGE_INVALID')
    for (const name of ['archives', 'work', 'previews']) await mkdir(path.join(this.root, name), { recursive: true, mode: 0o700 })
    // 未确认预览不跨服务重启保留，解密后的临时资料及时清理。
    const pending = await this.pending()
    for (const entry of await readdir(path.join(this.root, 'previews'))) if (entry !== pending?.ticket) await rm(path.join(this.root, 'previews', entry), { recursive: true, force: true })
    await rm(path.join(this.root, 'work'), { recursive: true, force: true })
    await mkdir(path.join(this.root, 'work'), { mode: 0o700 })
  }

  catalogue() {
    const db = this.client()
    return {
      agents: this.deps.agents.listAgents().map(({ id, name }) => ({ id, label: name })),
      threads: db.prepare('SELECT id,title AS label,agent_id AS agentId FROM threads ORDER BY updated_at DESC LIMIT 1000').all(),
      documents: db.prepare('SELECT id,title AS label FROM knowledge_documents ORDER BY updated_at DESC LIMIT 1000').all(),
      facts: db.prepare('SELECT id,standard_name AS label FROM fact_objects ORDER BY created_at DESC LIMIT 1000').all(),
      tasks: db.prepare('SELECT id,title AS label,agent_id AS agentId FROM background_tasks ORDER BY created_at DESC LIMIT 1000').all(),
    }
  }

  async list(): Promise<BackupRecord[]> {
    const records: BackupRecord[] = []
    for (const file of await readdir(path.join(this.root, 'archives'))) {
      if (!/^[a-f0-9-]{36}\.json$/i.test(file)) continue
      const record = JSON.parse(await readFile(path.join(this.root, 'archives', file), 'utf8')) as BackupRecord
      if (existsSync(this.archivePath(record.id))) records.push(record)
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  archivePath(id: string): string {
    if (!UUID.test(id)) throw new Error('BACKUP_ID_INVALID')
    return path.join(this.root, 'archives', `${id}.infos-backup`)
  }
  async record(id: string): Promise<BackupRecord> {
    this.archivePath(id)
    return JSON.parse(await readFile(path.join(this.root, 'archives', `${id}.json`), 'utf8')) as BackupRecord
  }
  async remove(id: string): Promise<void> {
    const pending = await this.pending()
    if (pending?.backupId === id) throw new Error('BACKUP_PENDING_IMPORT')
    await rm(this.archivePath(id), { force: true })
    await rm(path.join(this.root, 'archives', `${id}.json`), { force: true })
  }
  async pending(): Promise<{ ticket: string; backupId: string; kind?: 'sync' } | null> {
    const file = path.join(this.root, 'pending.json')
    if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'))
    for (const directory of [path.join(this.root, 'sync'), path.join(path.dirname(this.deps.dataDir), '.infos-sync')]) {
      if (existsSync(path.join(directory, 'pending.json'))) {
        const sync = JSON.parse(await readFile(path.join(directory, 'pending.json'), 'utf8'))
        return { ticket: '', backupId: sync.snapshotId, kind: 'sync' }
      }
      if (existsSync(path.join(directory, 'rollback.json'))) return { ticket: '', backupId: 'rollback', kind: 'sync' }
    }
    return null
  }
  async lastResult(): Promise<{ status: 'completed' | 'failed'; id: string; error?: string } | null> {
    const file = path.join(this.root, 'last-import.json')
    return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null
  }
  async cancelPending(): Promise<void> {
    const pending = await this.pending()
    if (!pending) return
    if (pending.kind === 'sync') {
      for (const directory of [path.join(this.root, 'sync'), path.join(path.dirname(this.deps.dataDir), '.infos-sync')]) for (const name of ['pending.json', 'pending.bundle', 'rollback.json']) await rm(path.join(directory, name), { force: true })
      return
    }
    await rm(path.join(this.root, 'pending.json'))
    await rm(path.join(this.root, 'previews', pending.ticket), { recursive: true, force: true })
  }

  async create(selection: BackupSelection, password = ''): Promise<BackupRecord> {
    if (this.busy) throw new Error('BACKUP_BUSY')
    if (selection.includeSecrets && password.length < 8) throw new Error('BACKUP_PASSWORD_TOO_SHORT')
    this.busy = true
    const id = randomUUID(), directory = path.join(this.root, 'work', id)
    const snapshot = path.join(directory, 'snapshot')
    try {
      await mkdir(snapshot, { recursive: true, mode: 0o700 })
      // 检查与同步复制在同一事件循环内执行，主进程写入不能穿插其间。
      this.deps.assertIdle(selection.level === 'full' || selection.modules.includes('applications'))
      if (this.activeWrites) throw new Error('BACKUP_ACTIVE_WRITES')
      const social = this.capture(snapshot, selection)
      const db = new Database(path.join(snapshot, 'infos.db'))
      let records: Map<string, BackupRow[]>
      const summary: Record<string, number> = {}
      try {
        records = selection.level === 'full' ? new Map() : selectBackupRecords(db, selection)
        if (selection.modules.includes('memory') && selection.level !== 'full') records.set(SOCIAL_TABLE, social)
        if (Buffer.byteLength(JSON.stringify([...records])) > 256 * 1024 ** 2) throw new Error('BACKUP_RECORD_LIMIT')
        if (selection.level === 'full' && !selection.includeSecrets) this.redactDatabase(db)
        if (selection.level === 'full') sanitizeRestoredDatabase(db)
        if (selection.level === 'full') for (const table of TABLES) if (hasTable(db, table)) summary[table] = (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
      } finally { db.close() }
      const manifest: BackupManifest = { format: 'infos.backup', version: 1, id, appVersion: APP_VERSION, sourceServerId: this.deps.sourceServerId, createdAt: new Date().toISOString(), selection, tables: Object.fromEntries([...records].map(([table, rows]) => [table, rows.length])), files: [], warnings: [] }
      if (selection.level === 'full') Object.assign(manifest, { triviumFormat: TRIVIUM_FORMAT, triviumVersion: TRIVIUM_VERSION })
      if (selection.level === 'full') manifest.summary = summary
      const needsAgents = selection.modules.some((module) => ['agents', 'conversations', 'memory', 'tasks', 'workspace'].includes(module))
      const agentIds = new Set(needsAgents ? selection.agentIds : [])
      for (const rows of records.values()) for (const row of rows) if (row.agent_id) agentIds.add(String(row.agent_id))
      if (needsAgents && !agentIds.size && (selection.modules.includes('agents') || selection.modules.includes('workspace'))) for (const agent of this.deps.agents.listAgents()) agentIds.add(agent.id)
      if (selection.level !== 'full' && needsAgents) manifest.selection = { ...selection, agentIds: [...agentIds] }
      if (selection.level === 'full' || agentIds.size) for (const agentId of selection.level === 'full' ? this.deps.agents.listAgents().map((agent) => agent.id) : agentIds) {
        const profile = this.deps.agents.getAgent(agentId)
        if (!profile) { manifest.warnings.push('AGENT_DEFINITION_MISSING'); continue }
        const target = path.join(snapshot, 'agents', agentId)
        if (!existsSync(target)) await cp(path.dirname(profile.configPath), target, { recursive: true, filter: async (file) => !(await lstat(file)).isSymbolicLink() && path.basename(file) !== 'workspace' })
        if (profile.avatarPath && existsSync(profile.avatarPath)) {
          const name = path.basename(profile.avatarPath)
          for (const old of ['avatar.png', 'avatar.jpg', 'avatar.webp']) if (old !== name) await rm(path.join(target, old), { force: true })
          await cp(profile.avatarPath, path.join(target, name))
        }
      }
      const attachments = new Set((records.get('message_attachments') ?? []).map((row) => String(row.storage_key)))
      for (const row of records.get('message_attachments') ?? []) if (row.status !== 'deleted' && !row.deleted_at && !existsSync(path.join(snapshot, 'attachments', String(row.storage_key)))) manifest.warnings.push('ATTACHMENTS_MISSING')
      const wanted = (relative: string): boolean => {
        if (selection.level === 'full') return true
        const parts = relative.split('/')
        if (parts[0] === 'agents') return agentIds.has(parts[1]!)
        if (selection.modules.some((module) => module === 'workspace' || module === 'tasks') && parts[0] === 'principals') return !agentIds.size || agentIds.has(parts[1]!)
        if (selection.modules.includes('settings') && (parts[0] === 'prompts' || relative.startsWith('custom/prompts/'))) return true
        if (selection.modules.includes('applications') && parts[0] === 'applications') return true
        if (parts[0] === 'attachments') return attachments.has(parts.slice(1).join('/')) || attachments.has(relative)
        return false
      }
      await this.walk(snapshot, async (relative, file) => {
        if (!wanted(relative)) return
        if (!selection.includeSecrets) {
          if (/(?:^|\/)(?:credentials|secrets|tokens|sessions)(?:[./]|$)/i.test(relative)) { manifest.warnings.push('CREDENTIALS_EXCLUDED'); return }
          if (relative.endsWith('.json') && /(?:agent|config|settings|connection|model)/i.test(path.basename(relative))) {
            const value = JSON.parse(await readFile(file, 'utf8'))
            await writeFile(file, JSON.stringify(redactBackupValue(value)))
          }
          if (/\.(?:sqlite|db)$/.test(relative) && relative !== 'infos.db') {
            const child = new Database(file)
            try {
              if (hasTable(child, 'secrets')) child.exec('DELETE FROM secrets')
              if (hasTable(child, 'configs')) this.redactDatabase(child)
            } finally { child.close() }
          }
        }
        const info = await stat(file)
        manifest.files.push({ path: relative, size: info.size, mode: info.mode & 0o777, sha256: await fileDigest(file) })
      })
      if (selection.modules.includes('memory')) manifest.warnings.push('MEMORY_INDEX_REBUILD')
      if (!selection.includeSecrets) manifest.warnings.push('CREDENTIALS_EXCLUDED')
      manifest.warnings.push('EXTERNAL_WORKSPACES_EXCLUDED')
      if (selection.modules.includes('tasks') && !selection.modules.includes('applications')) manifest.warnings.push('APPLICATION_RESULTS_EXCLUDED')
      if (selection.modules.includes('conversations') && !selection.modules.includes('tasks')) manifest.warnings.push('TASK_RECORDS_EXCLUDED')
      if (selection.modules.includes('memory') && (selection.threadIds.length || !selection.modules.includes('conversations'))) manifest.warnings.push('MEMORY_SOURCES_EXTERNAL')
      if (!manifest.files.length && ![...records.values()].some((rows) => rows.length)) throw new Error('BACKUP_EMPTY')
      async function* rows() { for (const [table, entries] of records) for (const row of entries) yield { table, row } }
      const output = this.archivePath(id)
      await writeBackupArchive(output, manifest, snapshot, rows(), password)
      const record: BackupRecord = { id, createdAt: manifest.createdAt, level: selection.level, size: (await stat(output)).size, encrypted: Boolean(password), protection: password ? 'password' : 'none', reason: 'manual', manifest }
      await atomicBackupJson(path.join(this.root, 'archives', `${id}.json`), record)
      return record
    } catch (error) {
      await rm(this.archivePath(id), { force: true })
      throw error
    } finally { this.busy = false; await rm(directory, { recursive: true, force: true }) }
  }

  async previewFile(input: string, password = ''): Promise<BackupPreview> {
    const ticket = randomUUID(), directory = path.join(this.root, 'previews', ticket)
    await mkdir(directory, { mode: 0o700 })
    try {
      const manifest = await readBackupArchive(input, directory, password)
      this.validateManifest(manifest)
      if (manifest.selection.level === 'full') {
        const check = new Database(path.join(directory, 'files', 'infos.db'), { readonly: true, fileMustExist: true })
        try { if (check.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('BACKUP_DATABASE_INVALID') }
        finally { check.close() }
      }
      const counts: Record<string, number> = {}, conflicts: Record<string, number> = {}
      for (const table of Object.keys(manifest.tables)) {
        const rows: BackupRow[] = []
        for await (const row of readBackupRows(directory, table)) rows.push(row)
        counts[table] = rows.length
        if (table === SOCIAL_TABLE) {
          validateSocialBackup(rows)
          conflicts[table] = [...new Set(rows.map((row) => String(row.agent_id)))].reduce((sum, agentId) => sum + this.deps.stores.exportSocialBackup(agentId).length, 0)
        } else conflicts[table] = recordConflicts(this.client(), table, rows)
      }
      for (const file of manifest.files) {
        const root = file.path.split('/')[0]!
        if (['agents', 'principals', 'applications'].includes(root)) {
          const scope = file.path.split('/').slice(0, 2).join('/')
          if (existsSync(path.join(this.deps.dataDir, scope))) conflicts[scope] = 1
        }
      }
      const imported = await this.importHistory()
      const preview: BackupPreview = { ticket, manifest, counts: manifest.summary ?? counts, conflicts, warnings: [...new Set(manifest.warnings)], alreadyImported: manifest.selection.level !== 'full' && imported.includes(manifest.id), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }
      const recordDigests: Record<string, string> = {}
      for (const [table, count] of Object.entries(manifest.tables)) if (count > 0) recordDigests[table] = await fileDigest(path.join(directory, 'records', `${table}.jsonl`))
      await atomicBackupJson(path.join(directory, 'preview.json'), { ...preview, recordDigests })
      this.expirePreview(ticket, 60 * 60_000)
      return preview
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  }
  async previewSaved(id: string, password = ''): Promise<BackupPreview> {
    const record = await this.record(id)
    return this.previewFile(this.archivePath(id), record.protection === 'local' ? await this.localKey() : password)
  }
  async download(id: string, password = ''): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const record = await this.record(id)
    if (record.protection !== 'local') return { path: this.archivePath(id), cleanup: async () => {} }
    if (password.length < 8) throw new Error('BACKUP_LOCAL_DOWNLOAD')
    const directory = path.join(this.root, 'work', randomUUID())
    await mkdir(directory, { mode: 0o700 })
    const output = path.join(directory, 'download.infos-backup')
    try {
      const manifest = await readBackupArchive(this.archivePath(id), directory, await this.localKey())
      async function* rows() { for (const table of Object.keys(manifest.tables)) for await (const row of readBackupRows(directory, table)) yield { table, row } }
      await writeBackupArchive(output, manifest, path.join(directory, 'files'), rows(), password)
      return { path: output, cleanup: () => rm(directory, { recursive: true, force: true }) }
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  }
  async stage(ticket: string, policy: ImportPolicy): Promise<void> {
    if (this.busy) throw new Error('BACKUP_BUSY')
    this.busy = true
    try {
    if (!UUID.test(ticket) || await this.pending() || existsSync(path.join(this.root, 'sync', 'pending.bundle'))) throw new Error('BACKUP_PENDING_IMPORT')
    const preview = await BackupService.verifiedPreview(path.join(this.root, 'previews', ticket))
    if (new Date(preview.expiresAt).getTime() < Date.now()) throw new Error('BACKUP_PREVIEW_EXPIRED')
    if (preview.manifest.selection.level !== 'full' && (preview.alreadyImported || (await this.importHistory()).includes(preview.manifest.id))) throw new Error('BACKUP_ALREADY_IMPORTED')
    if (preview.manifest.selection.level === 'full' && policy.conflict !== 'replace') throw new Error('BACKUP_FULL_REPLACE_REQUIRED')
    if (policy.conflict === 'duplicate' && preview.manifest.files.some((file) => file.path.startsWith('applications/'))) throw new Error('BACKUP_APPLICATION_DUPLICATE_UNSUPPORTED')
    for (const [source, target] of Object.entries(policy.agentTargets)) if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(source) || !AGENT.test(target)) throw new Error('BACKUP_AGENT_INVALID')
    if (new Set(Object.values(policy.agentTargets)).size !== Object.values(policy.agentTargets).length) throw new Error('BACKUP_AGENT_INVALID')
    for (const [source, target] of Object.entries(policy.agentTargets)) if (source !== target && policy.conflict !== 'replace' && (existsSync(path.join(this.deps.dataDir, 'agents', target)) || this.deps.agents.getAgent(target))) throw new Error('BACKUP_AGENT_INVALID')
    if (path.resolve(this.client().name) !== path.resolve(this.deps.dataDir, 'infos.db')) throw new Error('BACKUP_DATABASE_LOCATION_UNSUPPORTED')
    // 先在真实 SQLite 副本上验证所选策略，唯一约束或关联错误在暂存前返回。
    if (preview.manifest.selection.level !== 'full') {
      const temporary = path.join(this.root, 'work', `${randomUUID()}.sqlite`)
      try {
        await this.client().backup(temporary)
        const db = new Database(temporary)
        try {
          const tables = new Map<string, BackupRow[]>()
          for (const table of Object.keys(preview.manifest.tables)) {
            const rows: BackupRow[] = []
            for await (const row of readBackupRows(path.join(this.root, 'previews', ticket), table)) rows.push(row)
            tables.set(table, rows)
          }
          mergeBackupRecords(db, tables, policy, preview.manifest.id)
          if (policy.conflict !== 'replace') {
            const targets = new Map<string, Map<number, { type?: unknown; content?: unknown }>>()
            for (const row of tables.get(SOCIAL_TABLE) ?? []) {
              const payload = JSON.parse(String(row.payload_json)) as { type?: unknown; content?: unknown }
              if (payload.type !== 'feature') continue
              const target = policy.agentTargets[String(row.agent_id)] ?? String(row.agent_id)
              let nodes = targets.get(target)
              if (!nodes) {
                nodes = new Map(this.deps.stores.exportSocialBackup(target).map((entry) => [entry.id, JSON.parse(entry.payload_json)]))
                targets.set(target, nodes)
              }
              const previous = nodes.get(Number(row.id))
              if (previous && (previous.type !== 'feature' || previous.content !== payload.content)) throw new Error('BACKUP_SOCIAL_FEATURE_CONFLICT')
            }
          }
        } finally { db.close() }
      } finally { for (const suffix of ['', '-wal', '-shm']) await rm(temporary + suffix, { force: true }) }
    }
    await atomicBackupJson(path.join(this.root, 'pending.json'), { ticket, backupId: preview.manifest.id, policy, existingAgents: this.deps.agents.listAgents().map((agent) => agent.id) })
    } finally { this.busy = false }
  }
  async receive(input: ReadableStream<Uint8Array>, password: string): Promise<BackupPreview> {
    const file = path.join(this.root, 'work', `${randomUUID()}.upload`)
    const handle = await import('node:fs/promises').then((fs) => fs.open(file, 'wx', 0o600))
    const reader = input.getReader()
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > MAX_UPLOAD) throw new Error('BACKUP_SIZE_INVALID')
        await handle.writeFile(chunk.value)
      }
      await handle.close()
      return await this.previewFile(file, password)
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await handle.close().catch(() => {}); await rm(file, { force: true }) }
  }

  private client(): Database.Database { return (this.deps.db as unknown as { $client: Database.Database }).$client }
  captureForSync(destination: string): void {
    this.deps.assertIdle(true)
    if (this.activeWrites) throw new Error('BACKUP_ACTIVE_WRITES')
    this.capture(destination, emptySelection())
  }
  private async localKey(): Promise<string> {
    const file = path.join(this.root, 'local.key')
    if (!existsSync(file)) await writeFile(file, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 })
    return readFile(file, 'utf8')
  }
  private async importHistory(): Promise<string[]> {
    const file = path.join(this.root, 'imported.json')
    return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : []
  }
  private static async verifiedPreview(directory: string): Promise<BackupPreview> {
    const preview = JSON.parse(await readFile(path.join(directory, 'preview.json'), 'utf8')) as BackupPreview & { recordDigests?: Record<string, string> }
    for (const file of preview.manifest.files) {
      const source = path.join(directory, 'files', safeBackupPath(file.path))
      if ((await stat(source)).size !== file.size || await fileDigest(source) !== file.sha256) throw new Error('BACKUP_FILE_CORRUPT')
    }
    for (const [table, count] of Object.entries(preview.manifest.tables)) {
      if (!/^[a-z][a-z_]*$/.test(table)) throw new Error('BACKUP_TABLE_UNSUPPORTED')
      const file = path.join(directory, 'records', `${table}.jsonl`)
      if (count > 0) {
        if (!preview.recordDigests?.[table] || await fileDigest(file) !== preview.recordDigests[table]) throw new Error('BACKUP_FILE_CORRUPT')
      } else if (existsSync(file) && (await stat(file)).size) throw new Error('BACKUP_RECORD_INVALID')
    }
    return preview
  }
  private expirePreview(ticket: string, delay: number): void {
    const timer = setTimeout(() => {
      // 确认导入正在写入计划时延后清理，已经确认的预览保留至应用或取消。
      if (this.busy) { this.expirePreview(ticket, 60_000); return }
      void this.pending().then(async (pending) => {
        if (this.busy) { this.expirePreview(ticket, 60_000); return }
        if (pending?.ticket !== ticket) await rm(path.join(this.root, 'previews', ticket), { recursive: true, force: true })
      }).catch(() => { this.expirePreview(ticket, 60_000) })
    }, delay)
    timer.unref()
  }
  private validateManifest(manifest: BackupManifest): void {
    if (!manifest.selection || !['settings', 'agent', 'content', 'full'].includes(manifest.selection.level) || !Array.isArray(manifest.selection.modules)) throw new Error('BACKUP_FORMAT_INVALID')
    const modules = new Set(['settings', 'agents', 'conversations', 'memory', 'facts', 'knowledge', 'tasks', 'workspace', 'applications'])
    if (manifest.selection.modules.some((module) => !modules.has(module)) || typeof manifest.selection.includeSecrets !== 'boolean' || !Array.isArray(manifest.warnings) || manifest.warnings.some((warning) => typeof warning !== 'string') || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('BACKUP_FORMAT_INVALID')
    for (const key of ['agentIds', 'threadIds', 'documentIds', 'factIds', 'taskIds'] as const) {
      const values = manifest.selection[key]
      if (!Array.isArray(values) || values.length > 1000 || values.some((value) => typeof value !== 'string' || !value || value.length > 200)) throw new Error('BACKUP_FORMAT_INVALID')
    }
    if (manifest.summary && (typeof manifest.summary !== 'object' || Array.isArray(manifest.summary) || Object.entries(manifest.summary).some(([table, count]) => (!TABLES.has(table) && table !== SOCIAL_TABLE) || !Number.isSafeInteger(count) || count < 0))) throw new Error('BACKUP_FORMAT_INVALID')
    if (manifest.triviumFormat !== undefined && (!Number.isInteger(manifest.triviumFormat) || manifest.triviumFormat > TRIVIUM_FORMAT)) throw new Error('BACKUP_VERSION_UNSUPPORTED')
    if (manifest.selection.level === 'full' && !manifest.files.some((file) => file.path === 'infos.db')) throw new Error('BACKUP_DATABASE_MISSING')
    const version = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(manifest.appVersion)
    if (!version) throw new Error('BACKUP_VERSION_UNSUPPORTED')
    const actual = version.slice(1).map(Number), supported = APP_VERSION.split('-')[0]!.split('.').map(Number)
    for (let index = 0; index < supported.length; index++) {
      if (actual[index]! > supported[index]!) throw new Error('BACKUP_VERSION_UNSUPPORTED')
      if (actual[index]! < supported[index]!) break
    }
    for (const table of Object.keys(manifest.tables)) if (table !== SOCIAL_TABLE && (!TABLES.has(table) || !hasTable(this.client(), table))) throw new Error('BACKUP_TABLE_UNSUPPORTED')
    for (const file of manifest.files) {
      safeBackupPath(file.path)
      if (excludedBackupPath(file.path) || LOCAL_FILES.has(file.path)) throw new Error('BACKUP_PATH_INVALID')
      if (manifest.selection.level !== 'full' && !['agents', 'principals', 'attachments', 'prompts', 'custom', 'applications'].includes(file.path.split('/')[0]!)) throw new Error('BACKUP_PATH_INVALID')
    }
  }
  private capture(root: string, selection: BackupSelection): BackupRow[] {
    const full = selection.level === 'full'
    const social: BackupRow[] = []
    const roots = new Set<string>(['agents'])
    if (selection.modules.includes('settings')) { roots.add('prompts'); roots.add('custom') }
    if (selection.modules.some((module) => ['conversations', 'memory', 'tasks'].includes(module))) roots.add('attachments')
    if (selection.modules.some((module) => module === 'workspace' || module === 'tasks')) roots.add('principals')
    if (selection.modules.includes('applications')) roots.add('applications')
    const copy = () => {
      this.client().prepare('VACUUM INTO ?').run(path.join(root, 'infos.db'))
      if (!full && selection.modules.includes('memory')) {
        const agents = selection.agentIds.length ? selection.agentIds : [...new Set([...this.deps.agents.listAgents().map((agent) => agent.id), ...this.deps.stores.listStoredAgentIds()])]
        for (const id of agents) for (const row of this.deps.stores.exportSocialBackup(id)) social.push(row)
      }
      const walk = (directory: string, prefix = '') => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name
          if (!full && !roots.has(relative.split('/')[0]!)) continue
          if (excludedBackupPath(relative) || relative === 'infos.db' || managedStoreBase(relative) || entry.isSymbolicLink()) continue
          const source = path.join(directory, entry.name), target = path.join(root, relative)
          if (entry.isDirectory()) { mkdirSync(target, { recursive: true }); walk(source, relative) }
          else if (entry.isFile()) {
            if (/\.(?:db|sqlite)$/.test(relative)) {
              const child = new Database(source, { fileMustExist: true })
              try { child.prepare('VACUUM INTO ?').run(target) } finally { child.close() }
            } else copyFileSync(source, target)
          }
        }
      }
      walk(this.deps.dataDir)
    }
    if (full) this.deps.stores.captureSnapshot(root, copy)
    else copy()
    return social
  }
  private redactDatabase(db: Database.Database): void {
    const foreignKeys = db.pragma('foreign_keys', { simple: true })
    db.pragma('foreign_keys = OFF')
    try {
    for (const table of MODULE_TABLES.settings ?? []) {
      if (!hasTable(db, table)) continue
      const rows = readTable(db, table)
      const names = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name)
      db.transaction(() => {
        db.exec(`DELETE FROM "${table}"`)
        for (const row of rows) {
          const clean = redactBackupRow(table, row)
          if (clean) db.prepare(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((name) => clean[name]))
        }
      })()
    }
    } finally { db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`) }
  }
  private async walk(root: string, visit: (relative: string, file: string) => Promise<void>, prefix = ''): Promise<void> {
    for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (excludedBackupPath(relative)) continue
      if (entry.isSymbolicLink()) throw new Error('BACKUP_SYMLINK_UNSUPPORTED')
      if (entry.isDirectory()) await this.walk(root, visit, relative)
      else if (entry.isFile()) await visit(relative, path.join(root, relative))
    }
  }

  static async createRecoveryPoint(dataDir: string, snapshot: string): Promise<BackupRecord> {
    const root = path.join(dataDir, BACKUP_STATE), id = randomUUID()
    await mkdir(path.join(root, 'archives'), { recursive: true, mode: 0o700 })
    const files: BackupManifest['files'] = []
    const databaseFile = path.join(snapshot, 'infos.db')
    const empty = !existsSync(databaseFile)
    const database = new Database(databaseFile)
    const summary: Record<string, number> = {}
    try {
      if (empty) database.pragma('user_version = 0')
      for (const table of TABLES) if (hasTable(database, table)) summary[table] = (database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
    } finally { database.close() }
    const walk = async (directory: string, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative)
        else if (entry.isFile()) {
          const file = path.join(directory, entry.name), info = await stat(file)
          files.push({ path: relative, size: info.size, mode: info.mode & 0o777, sha256: await fileDigest(file) })
        }
      }
    }
    await walk(snapshot)
    const manifest: BackupManifest = { format: 'infos.backup', version: 1, id, appVersion: APP_VERSION, sourceServerId: 'local', createdAt: new Date().toISOString(), selection: emptySelection(), tables: {}, files, warnings: [] }
    Object.assign(manifest, { triviumFormat: TRIVIUM_FORMAT, triviumVersion: TRIVIUM_VERSION })
    manifest.summary = summary
    const keyFile = path.join(root, 'local.key')
    if (!existsSync(keyFile)) await writeFile(keyFile, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' })
    async function* noRows() {}
    const output = path.join(root, 'archives', `${id}.infos-backup`)
    try { await writeBackupArchive(output, manifest, snapshot, noRows(), await readFile(keyFile, 'utf8')) }
    catch (error) { await rm(output, { force: true }); throw error }
    const record: BackupRecord = { id, createdAt: manifest.createdAt, level: 'full', size: (await stat(output)).size, encrypted: true, protection: 'local', reason: 'before-import', manifest }
    await atomicBackupJson(path.join(root, 'archives', `${id}.json`), record)
    return record
  }

  /** 在数据库和服务启动前处理已确认的导入，恢复点在实际覆盖前创建。 */
  static async applyPending(dataDir: string): Promise<void> {
    const root = path.join(dataDir, BACKUP_STATE), pendingFile = path.join(root, 'pending.json')
    if (!existsSync(pendingFile)) return
    const pending = JSON.parse(await readFile(pendingFile, 'utf8')) as { ticket: string; backupId: string; policy: ImportPolicy; existingAgents?: string[] }
    if (!UUID.test(pending.ticket) || !UUID.test(pending.backupId)) throw new Error('BACKUP_FORMAT_INVALID')
    const directory = path.join(root, 'previews', pending.ticket)
    const receiptFile = path.join(root, 'install-receipt.json')
    const finish = async (reindex: unknown) => {
      if (reindex) await atomicBackupJson(path.join(root, 'reindex.json'), reindex)
      const historyFile = path.join(root, 'imported.json')
      const imported = existsSync(historyFile) ? JSON.parse(await readFile(historyFile, 'utf8')) as string[] : []
      await atomicBackupJson(historyFile, [...new Set([...imported, pending.backupId])])
      await atomicBackupJson(path.join(root, 'last-import.json'), { status: 'completed', id: pending.backupId })
      await rm(pendingFile)
      await rm(directory, { recursive: true, force: true })
    }
    if (existsSync(receiptFile)) {
      const receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
      if (receipt.ticket === pending.ticket) { await finish(receipt.reindex); return }
    }
    const work = path.join(root, 'work', randomUUID()), incoming = path.join(work, 'incoming')
    await mkdir(work, { recursive: true })
    try {
      // 同时校验文件与逻辑记录，避免暂存资料丢失后静默导入不完整数据。
      const preview = await BackupService.verifiedPreview(directory)
      const manifest = preview.manifest
      if (manifest.id !== pending.backupId) throw new Error('BACKUP_FORMAT_INVALID')
      // 此时没有业务数据库句柄；复制当前状态作为覆盖前可恢复备份。
      const snapshot = path.join(work, 'before')
      await snapshotOfflineTree(dataDir, snapshot)
      await BackupService.createRecoveryPoint(dataDir, snapshot)
      let reindex: { agents: string[]; facts: boolean; knowledge: boolean; socialFile?: string; policy?: ImportPolicy; importId?: string } | undefined
      if (manifest.selection.level === 'full') await cp(path.join(directory, 'files'), incoming, { recursive: true })
      else {
        await cp(snapshot, incoming, { recursive: true })
        const tables = new Map<string, BackupRow[]>()
        for (const table of Object.keys(manifest.tables)) {
          const rows: BackupRow[] = []
          for await (const row of readBackupRows(directory, table)) rows.push(row)
          tables.set(table, rows)
        }
        const db = new Database(path.join(incoming, 'infos.db'))
        try { mergeBackupRecords(db, tables, pending.policy, manifest.id) } finally { db.close() }
        const preparedAgents = new Set<string>()
        for (const file of manifest.files) {
          const parts = file.path.split('/')
          if (['agents', 'principals'].includes(parts[0]!)) parts[1] = pending.policy.agentTargets[parts[1]!] ?? parts[1]!
          if (parts[0] === 'agents') {
            const source = file.path.split('/')[1]!, targetAgent = parts[1]!
            if (source === targetAgent && pending.existingAgents?.includes(targetAgent) && pending.policy.conflict !== 'replace') continue
            if (pending.policy.conflict === 'replace' && !preparedAgents.has(targetAgent)) {
              await rm(path.join(incoming, 'agents', targetAgent), { recursive: true, force: true })
              preparedAgents.add(targetAgent)
            }
          }
          const target = path.join(incoming, ...parts)
          if (existsSync(target) && pending.policy.conflict !== 'replace') continue
          await mkdir(path.dirname(target), { recursive: true })
          await cp(path.join(directory, 'files', file.path), target)
          const sourceAgent = file.path.split('/')[1]!
          if (parts[0] === 'agents' && sourceAgent !== parts[1]) {
            if (/\/(?:agent|config)\.json$/.test(file.path)) {
              const config = JSON.parse(await readFile(target, 'utf8'))
              for (const key of ['id', 'agentId', 'agent_id']) if (config[key] === sourceAgent) config[key] = parts[1]
              await writeFile(target, JSON.stringify(config, null, 2))
            } else if (file.path.endsWith('/capabilities.yaml')) {
              const content = await readFile(target, 'utf8')
              await writeFile(target, content.replace(new RegExp(`^agent:\\s*["']?${sourceAgent}["']?\\s*$`, 'm'), `agent: ${parts[1]}`))
            }
          }
        }
        reindex = { agents: [...new Set((tables.get('event_notes') ?? []).map((row) => pending.policy.agentTargets[String(row.agent_id)] ?? String(row.agent_id)))], facts: tables.has('fact_records'), knowledge: tables.has('knowledge_parts') }
        if (tables.get(SOCIAL_TABLE)?.length) {
          const socialFile = `social-import-${pending.ticket}.jsonl`
          await cp(path.join(directory, 'records', `${SOCIAL_TABLE}.jsonl`), path.join(root, socialFile))
          Object.assign(reindex, { socialFile, policy: pending.policy, importId: pending.ticket })
        }
      }
      if (!existsSync(path.join(incoming, 'infos.db'))) throw new Error('BACKUP_DATABASE_MISSING')
      if (manifest.selection.level === 'full') prepareRestoredDatabase(path.join(incoming, 'infos.db'), path.join(snapshot, 'infos.db'))
      else {
        const check = new Database(path.join(incoming, 'infos.db'))
        try {
          if (check.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('BACKUP_DATABASE_INVALID')
        } finally { check.close() }
      }
      await installBackupTree(dataDir, incoming, { ticket: pending.ticket, backupId: manifest.id, reindex })
      await finish(reindex)
    } catch (error) {
      // 恢复失败时业务数据已由安装日志回退；取消待执行计划，允许原服务继续启动。
      await recoverBackupRestore(dataDir)
      const receipt = existsSync(receiptFile) ? JSON.parse(await readFile(receiptFile, 'utf8')) : null
      if (receipt?.ticket === pending.ticket) { await finish(receipt.reindex); return }
      await rm(path.join(root, `social-import-${pending.ticket}.jsonl`), { force: true })
      await atomicBackupJson(path.join(root, 'last-import.json'), { status: 'failed', id: pending.backupId, error: (error as Error).message })
      await rm(pendingFile, { force: true })
    } finally { await rm(work, { recursive: true, force: true }) }
  }
}
