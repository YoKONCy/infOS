import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'

const TRANSIENT_CODES = new Set([
  'EBUSY',
  'EACCES',
  'EPERM',
  'EMFILE',
  'ENFILE',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_CANTOPEN',
])

/** 只重试可能短暂恢复的文件错误；磁盘满、只读文件系统和格式损坏立即上报。 */
export async function retryStartupIo<T>(operation: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (attempt >= 4 || !TRANSIENT_CODES.has(code ?? '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
    }
  }
}

export class DaemonAlreadyRunningError extends Error {
  readonly code = 'DAEMON_ALREADY_RUNNING'

  constructor(
    readonly dataDirectory: string,
    cause: unknown,
  ) {
    super(`数据目录已有后端进程正在使用: ${dataDirectory}`, { cause })
  }
}

export class StartupStorageError extends Error {
  readonly code = 'STARTUP_STORAGE_ERROR'

  constructor(
    readonly storagePath: string,
    readonly operation: string,
    cause: unknown,
  ) {
    const error = cause as NodeJS.ErrnoException
    const detail = `${error?.code ?? 'Error'}: ${error?.message ?? String(cause)}`
    super(`启动存储不可用: ${storagePath}；步骤: ${operation}；原因: ${detail}`, { cause })
  }
}

/** 卷内固定锁跨容器互斥；同时持有旧锁，兼容仍使用目录外锁的本地版本。 */
export async function acquireDaemonLease(dataDirectory: string): Promise<{
  dataDirectory: string
  release: () => void
}> {
  const connections: Database.Database[] = []
  let lockPath = dataDirectory
  try {
    await retryStartupIo(() => mkdir(dataDirectory, { recursive: true }))
    const physical = await retryStartupIo(() => realpath(dataDirectory))
    // Windows 路径大小写和符号链接必须落到同一个实例锁。
    const identity = process.platform === 'win32' ? physical.toLowerCase() : physical
    const name = createHash('sha256').update(identity).digest('hex')
    const storage = path.join(physical, '.backup-state')
    await retryStartupIo(() => mkdir(storage, { recursive: true, mode: 0o700 }))
    if ((await lstat(storage)).isSymbolicLink()) throw new Error('BACKUP_STORAGE_INVALID')
    const locks = [
      path.join(storage, 'runtime-locks', 'daemon.sqlite'),
      path.join(path.dirname(physical), '.infos-runtime-locks', `${name}.sqlite`),
    ]
    for (const file of locks) {
      lockPath = file
      await retryStartupIo(() => mkdir(path.dirname(file), { recursive: true, mode: 0o700 }))
      const connection = await retryStartupIo(() => new Database(file, { timeout: 0 }))
      connections.push(connection)
      try { connection.exec('BEGIN IMMEDIATE') }
      catch (error) {
        if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new DaemonAlreadyRunningError(physical, error)
        throw error
      }
    }
    let released = false
    return {
      dataDirectory: physical,
      release: () => {
        if (released) return
        for (const connection of connections) connection.close()
        released = true
      },
    }
  } catch (error) {
    for (const connection of connections) connection.close()
    if (error instanceof DaemonAlreadyRunningError) throw error
    throw new StartupStorageError(lockPath, 'instance-lock', error)
  }
}

/** 用独占临时目录验证实际创建、读取、改名和删除能力，不触碰已有用户文件。 */
export async function verifyDataDirectory(dataDirectory: string): Promise<void> {
  let directory: string | undefined
  let failure: unknown
  let operation = 'create-probe'
  try {
    directory = await retryStartupIo(() => mkdtemp(path.join(dataDirectory, '.startup-check-')))
    operation = 'write-probe'
    const source = path.join(directory, 'probe.tmp')
    const target = path.join(directory, 'probe.ready')
    await retryStartupIo(() => writeFile(source, 'infOS', { flag: 'wx', mode: 0o600 }))
    operation = 'rename-probe'
    await retryStartupIo(() => rename(source, target))
    operation = 'read-probe'
    if ((await retryStartupIo(() => readFile(target, 'utf8'))) !== 'infOS') {
      throw new Error('STARTUP_STORAGE_PROBE_MISMATCH')
    }
  } catch (error) {
    failure = error
  }
  if (directory) {
    const probeDirectory = directory
    try {
      // 仅清理本次独占创建的两个文件；目录内出现其他文件时保留现场。
      await retryStartupIo(() => rm(path.join(probeDirectory, 'probe.tmp'), { force: true }))
      await retryStartupIo(() => rm(path.join(probeDirectory, 'probe.ready'), { force: true }))
      await retryStartupIo(() => rmdir(probeDirectory))
    } catch (error) {
      if (!failure) {
        operation = 'remove-probe'
        failure = error
      }
    }
  }
  if (failure) throw new StartupStorageError(dataDirectory, operation, failure)
}
