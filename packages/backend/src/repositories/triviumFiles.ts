import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'

export const TRIVIUM_VERSION = '0.9.0-beta.4'
export const TRIVIUM_FORMAT = 10
export const TRIVIUM_BACKUP_DIRECTORY = '.store-upgrades'

const suffixes = new Set([
  '',
  '.vec',
  '.wal',
  '.lock',
  '.flush_ok',
  '.quiver',
  '.quiver.meta',
  '.text',
  '.text.meta',
  '.pidx',
  '.gidx',
  '.manifest.json',
  '.dimension',
  '.publish',
  '.publish.0',
  '.publish.1',
  '.publish.2',
  '.publish.3',
  '.publish.4',
  '.publish.5',
  '.publish.6',
  '.publish.7',
  '.publish.8',
])

/** 只识别指定数据库的文件组，不把同目录其他数据库或用户文档算作旁路文件。 */
export function isTriviumFile(fileName: string, baseName: string): boolean {
  if (!fileName.startsWith(baseName)) return false
  const suffix = fileName.slice(baseName.length)
  return (
    suffixes.has(suffix) ||
    /^\.pld\.\d+$/.test(suffix) ||
    (suffix.endsWith('.tmp') &&
      (suffixes.has(suffix.slice(0, -4)) || /^\.pld\.\d+\.tmp$/.test(suffix)))
  )
}

export function triviumFiles(databasePath: string): string[] {
  const directory = path.dirname(databasePath)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => isTriviumFile(name, path.basename(databasePath)))
    .map((name) => {
      const file = path.join(directory, name)
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`数据库文件组含有非常规文件：${file}`)
      return file
    })
    .sort()
}

export function managedRelative(dataRoot: string, target: string): string {
  const relative = path.relative(path.resolve(dataRoot), path.resolve(target))
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('数据库文件必须位于受管数据目录内')
  return relative
}

/** 检查完整祖先链，避免目录联接把备份写入或删除引向数据目录外。 */
export function assertManagedFilePath(dataRoot: string, target: string): void {
  const relative = managedRelative(dataRoot, target)
  let current = path.resolve(dataRoot)
  for (const component of ['', ...relative.split(path.sep)]) {
    current = path.join(current, component)
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error(`数据库受管路径不能包含符号链接或目录联接：${current}`)
  }
}

export function upgradeBackupPath(dataRoot: string, databasePath: string): string {
  return path.join(
    dataRoot,
    TRIVIUM_BACKUP_DIRECTORY,
    TRIVIUM_VERSION,
    managedRelative(dataRoot, databasePath),
  )
}

/** 升级后仍发现历代受管备份，避免永久遗忘或维度重建遗漏旧版本正文。 */
export function upgradeBackupRoots(dataRoot: string): string[] {
  const root = path.join(dataRoot, TRIVIUM_BACKUP_DIRECTORY)
  assertManagedFilePath(dataRoot, root)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(entry.name),
    )
    .map((entry) => path.join(root, entry.name))
    .sort()
}

export function managedStoreBase(relativePath: string): string | null {
  const normalized = relativePath.replaceAll('\\', '/')
  const base =
    /^(agent_[\w-]+\/(?:memory|social|main|diary)\.tdb|knowledge\/(?:facts|knowledge)\.tdb)/.exec(
      normalized,
    )?.[1]
  return base && isTriviumFile(normalized, base) ? base : null
}

/** 有界读取文件摘要；大库备份不把全部向量和正文再次加载进 JavaScript 堆。 */
function digest(file: string): { size: number; sha256: string } {
  const fd = openSync(file, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let size = 0
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (!count) break
      size += count
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    closeSync(fd)
  }
  return { size, sha256: hash.digest('hex') }
}

export function databaseFormat(databasePath: string): number | null {
  if (!existsSync(databasePath)) return null
  const header = Buffer.alloc(6)
  const fd = openSync(databasePath, 'r')
  try {
    if (
      readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.toString('ascii', 0, 4) !== 'TVDB'
    )
      throw new Error(`数据库文件头无效：${databasePath}`)
    return header.readUInt16LE(4)
  } finally {
    closeSync(fd)
  }
}

/** 调用方必须持有引擎的共享读锁；有待恢复 WAL 时不允许以不一致副本冒充升级备份。 */
export function backupLegacyStore(dataRoot: string, databasePath: string, format: number): string {
  const sourceFiles = triviumFiles(databasePath).filter((file) => !file.endsWith('.tmp'))
  const inventory = sourceFiles.map((file) => ({ name: path.basename(file), ...digest(file) }))
  const fingerprint = createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
  const destination = path.join(upgradeBackupPath(dataRoot, databasePath), fingerprint)
  assertManagedFilePath(dataRoot, destination)
  if (existsSync(destination)) {
    const manifest = JSON.parse(readFileSync(path.join(destination, 'backup.json'), 'utf8')) as {
      source: string
      format: number
      files: Array<{ name: string; size: number; sha256: string }>
    }
    if (
      manifest.source !== managedRelative(dataRoot, databasePath) ||
      manifest.format !== format ||
      manifest.files.length !== sourceFiles.length
    )
      throw new Error('已有升级备份与旧数据库不匹配')
    for (const file of sourceFiles) {
      const entry = manifest.files.find((item) => item.name === path.basename(file))
      const current = digest(file)
      const saved = entry ? digest(path.join(destination, path.basename(file))) : undefined
      if (
        !entry ||
        !saved ||
        entry.sha256 !== current.sha256 ||
        entry.size !== current.size ||
        saved.sha256 !== entry.sha256 ||
        saved.size !== entry.size
      )
        throw new Error('升级备份校验失败，已阻止打开可写旧库')
    }
    return destination
  }
  const staging = `${destination}.stage-${randomUUID()}`
  managedRelative(dataRoot, staging)
  mkdirSync(staging, { recursive: true })
  try {
    const files = sourceFiles.map((file) => {
      const name = path.basename(file)
      const target = path.join(staging, name)
      copyFileSync(file, target)
      const fd = openSync(target, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const copied = { name, ...digest(target) }
      const expected = inventory.find((item) => item.name === name)!
      if (copied.size !== expected.size || copied.sha256 !== expected.sha256)
        throw new Error(`数据库升级备份复制校验失败：${name}`)
      return copied
    })
    const fd = openSync(path.join(staging, 'backup.json'), 'wx')
    try {
      writeFileSync(
        fd,
        JSON.stringify(
          {
            targetVersion: TRIVIUM_VERSION,
            source: managedRelative(dataRoot, databasePath),
            format,
            createdAt: new Date().toISOString(),
            files,
          },
          null,
          2,
        ),
      )
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(staging, destination)
    return destination
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}
