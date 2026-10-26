import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

export const BACKUP_STATE = '.backup-state'
export const LOCAL_FILES = new Set([
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
export const TRANSIENT_ROOTS = new Set([
  BACKUP_STATE,
  'resource-versions',
  'logs',
  'temp',
  'cache',
  'cloud-cache',
  'sync',
  '.store-upgrades',
])

export async function atomicBackupJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flush: true })
  await rename(temporary, file)
}

export function excludedBackupPath(relative: string): boolean {
  const parts = relative.split('/')
  if (
    (/^agent_[\w-]+$/.test(parts[0] ?? '') || parts[0] === 'knowledge') &&
    parts.some((part) => /^\.index-[a-f0-9-]+$/i.test(part))
  )
    return true
  return (
    LOCAL_FILES.has(relative) ||
    TRANSIENT_ROOTS.has(parts[0]!) ||
    parts.some((part) => part.startsWith('.resource-') || part.startsWith('.startup-check-')) ||
    /(?:-wal|-shm|\.lock)$/.test(relative) ||
    (parts[0] === 'applications' && /(?:^|\/)(?:discovery\.json|host-bridge\.key)$/.test(relative))
  )
}

export async function copyBackupTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 })
  // 暂存区位于数据目录内，逐项复制，避免 fs.cp 拒绝将根目录复制到其子目录。
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excludedBackupPath(entry.name) || entry.isSymbolicLink()) continue
    await cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      dereference: false,
      filter: async (file) => {
        const relative = path.relative(source, file).replaceAll('\\', '/')
        return (!relative || !excludedBackupPath(relative)) && !(await lstat(file)).isSymbolicLink()
      },
    })
  }
}

/** 停机快照也使用 SQLite 备份接口，包含异常退出后仍在 WAL 中的已提交记录。 */
export async function snapshotOfflineTree(source: string, target: string): Promise<void> {
  await copyBackupTree(source, target)
  const walk = async (directory: string, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink() || excludedBackupPath(relative)) continue
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative)
      else if (entry.isFile() && /\.(?:db|sqlite)$/.test(relative)) {
        const output = path.join(target, relative)
        await rm(output, { force: true })
        const db = new Database(path.join(source, relative), { fileMustExist: true })
        try {
          db.prepare('VACUUM INTO ?').run(output)
        } finally {
          db.close()
        }
      }
    }
  }
  await walk(source)
}

interface RestoreJournal {
  phase: 'installing' | 'committed'
  directory: string
  oldNames: string[]
  newNames: string[]
  receipt?: Record<string, unknown>
}
const journalFile = (dataDir: string) => path.join(dataDir, BACKUP_STATE, 'restore.json')
const retainedRoot = (name: string) =>
  name === BACKUP_STATE || TRANSIENT_ROOTS.has(name) || name.startsWith('.resource-')

/** 中断时回退整个安装计划；挂载根目录始终保持原位。 */
export async function recoverBackupRestore(dataDir: string): Promise<void> {
  const storage = path.join(dataDir, BACKUP_STATE)
  if (existsSync(storage) && (await lstat(storage)).isSymbolicLink())
    throw new Error('BACKUP_STORAGE_INVALID')
  const file = journalFile(dataDir)
  if (!existsSync(file)) return
  const journal = JSON.parse(await readFile(file, 'utf8')) as RestoreJournal
  if (
    !/^[a-f0-9-]{36}$/i.test(journal.directory) ||
    [...journal.oldNames, ...journal.newNames].some(
      (name) =>
        !name ||
        /[\\/:]/.test(name) ||
        [...name].some((char) => char.charCodeAt(0) < 32) ||
        name === '.' ||
        name === '..' ||
        retainedRoot(name),
    )
  )
    throw new Error('BACKUP_RESTORE_JOURNAL_INVALID')
  const directory = path.join(dataDir, BACKUP_STATE, 'restore', journal.directory)
  if (journal.phase === 'installing') {
    for (const name of new Set([...journal.oldNames, ...journal.newNames])) {
      const previous = path.join(directory, 'previous', name)
      const incoming = path.join(directory, 'incoming', name)
      const target = path.join(dataDir, name)
      if (existsSync(previous)) {
        await rm(target, { recursive: true, force: true })
        await rename(previous, target)
      } else if (!journal.oldNames.includes(name) && !existsSync(incoming)) {
        await rm(target, { recursive: true, force: true })
      }
    }
  } else if (journal.phase !== 'committed') throw new Error('BACKUP_RESTORE_JOURNAL_INVALID')
  else if (journal.receipt)
    await atomicBackupJson(
      path.join(dataDir, BACKUP_STATE, 'install-receipt.json'),
      journal.receipt,
    )
  await rm(file)
  await rm(directory, { recursive: true, force: true })
}

/** 数据已停止使用后安装影子目录，失败可回退；不 rename Docker 的卷挂载点。 */
export async function installBackupTree(
  dataDir: string,
  prepared: string,
  receipt?: Record<string, unknown>,
): Promise<void> {
  await recoverBackupRestore(dataDir)
  const id = randomUUID()
  const directory = path.join(dataDir, BACKUP_STATE, 'restore', id)
  const incoming = path.join(directory, 'incoming')
  await mkdir(path.join(directory, 'previous'), { recursive: true })
  await rename(prepared, incoming)
  // 本机身份与资源版本控制信息始终沿用目标端，不能被来源覆盖。
  for (const relative of LOCAL_FILES) {
    const source = path.join(dataDir, relative)
    if (!existsSync(source)) continue
    const target = path.join(incoming, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target)
  }
  const oldNames = (await readdir(dataDir)).filter((name) => !retainedRoot(name))
  const newNames = (await readdir(incoming)).filter((name) => !retainedRoot(name))
  const journal: RestoreJournal = {
    phase: 'installing',
    directory: id,
    oldNames,
    newNames,
    receipt,
  }
  await atomicBackupJson(journalFile(dataDir), journal)
  try {
    for (const name of oldNames)
      await rename(path.join(dataDir, name), path.join(directory, 'previous', name))
    for (const name of newNames) await rename(path.join(incoming, name), path.join(dataDir, name))
    await atomicBackupJson(journalFile(dataDir), { ...journal, phase: 'committed' })
  } catch (error) {
    await recoverBackupRestore(dataDir)
    throw error
  }
  await recoverBackupRestore(dataDir)
}
