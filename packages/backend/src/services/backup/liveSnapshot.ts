import Database from 'better-sqlite3'
import { constants, lstatSync, mkdirSync, readdirSync, type Stats } from 'node:fs'
import { copyFile, lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { MemoryStoreRegistry } from '../../repositories/storeRegistry'
import { managedStoreBase } from '../../repositories/triviumFiles'
import { excludedBackupPath } from './backupStorage'

interface SourceFile {
  relative: string
  version: Stats
}

/** 固定独立读连接的 WAL 视图，后续分块备份期间业务连接仍可提交新事务。 */
function pinDatabase(source: string | Database.Database): Database.Database {
  const reader =
    typeof source === 'string'
      ? new Database(source, { readonly: true, fileMustExist: true })
      : source.memory
        ? new Database(source.serialize())
        : new Database(source.name, { readonly: true, fileMustExist: true })
  try {
    reader.exec('BEGIN')
    reader.prepare('SELECT name FROM sqlite_schema LIMIT 1').get()
    return reader
  } catch (error) {
    reader.close()
    throw error
  }
}

function sameVersion(expected: Stats, actual: Stats): boolean {
  return (
    actual.isFile() && !actual.isSymbolicLink() &&
    expected.size === actual.size && expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs && expected.ino === actual.ino && expected.dev === actual.dev
  )
}

/** 同步边界只固定数据库视图与文件版本；大文件导出、复制在后续异步阶段完成。 */
export async function captureLiveSnapshot(
  dataDir: string,
  destination: string,
  sqlite: Database.Database,
  stores: Pick<MemoryStoreRegistry, 'captureSnapshot'>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const files: SourceFile[] = []
  const directories: string[] = []
  const databases: Array<{ relative: string; reader: Database.Database }> = []
  try {
    stores.captureSnapshot(destination, () => {
      signal?.throwIfAborted()
      if (sqlite.inTransaction) throw new Error('BACKUP_ACTIVE_TRANSACTION')
      const collect = (prefix = '') => {
        for (const entry of readdirSync(path.join(dataDir, prefix), { withFileTypes: true })) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name
          if (
            relative === 'infos.db' || excludedBackupPath(relative) ||
            managedStoreBase(relative) || entry.isSymbolicLink()
          ) continue
          if (entry.isDirectory()) {
            directories.push(relative)
            collect(relative)
          } else if (entry.isFile()) {
            const source = path.join(dataDir, relative)
            if (/\.(?:db|sqlite)$/.test(relative))
              databases.push({ relative, reader: pinDatabase(source) })
            else files.push({ relative, version: lstatSync(source) })
          }
        }
      }
      collect()
      // 主库最后导出，先释放可能使用回滚日志的子应用数据库读锁。
      databases.push({ relative: 'infos.db', reader: pinDatabase(sqlite) })
    })
    for (const directory of directories) {
      signal?.throwIfAborted()
      await mkdir(path.join(destination, directory), { recursive: true })
    }
    for (const { relative, reader } of databases) {
      signal?.throwIfAborted()
      const target = path.join(destination, relative)
      await mkdir(path.dirname(target), { recursive: true })
      try {
        await reader.backup(target, {
          progress: () => {
            signal?.throwIfAborted()
            // 每步复制有限页面，步骤之间由驱动让出事件循环。
            return 100
          },
        })
      } finally {
        reader.close()
      }
    }
    for (const file of files) {
      signal?.throwIfAborted()
      const source = path.join(dataDir, file.relative)
      const target = path.join(destination, file.relative)
      if (!sameVersion(file.version, await lstat(source)))
        throw new Error(`BACKUP_SOURCE_CHANGED: ${file.relative}`)
      // 支持的文件系统使用写时复制；其他文件系统由异步复制回退。
      await copyFile(source, target, constants.COPYFILE_FICLONE)
      if (
        !sameVersion(file.version, await lstat(source)) ||
        (await lstat(target)).size !== file.version.size
      )
        throw new Error(`BACKUP_SOURCE_CHANGED: ${file.relative}`)
    }
    signal?.throwIfAborted()
  } finally {
    for (const { reader } of databases) if (reader.open) reader.close()
  }
}
