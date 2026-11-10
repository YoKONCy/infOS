import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type {
  HomeCheckpoint,
  HomeLimits,
  HomeScope,
  HomeShelfItem,
  HomeSnapshot,
} from '@infos/shared'
import type { HomeRepository } from '../../repositories/home.repo'
import { canonicalPath, pathKey } from './homePaths'
import { HomeError } from './homeErrors'

export const contentHash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
function writeDurable(file: string, buffer: Buffer, mode = 0o600) {
  const descriptor = openSync(file, 'wx', mode)
  try {
    writeFileSync(descriptor, buffer)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
function flushCopy(file: string) {
  const descriptor = openSync(file, 'r+')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
export interface HomeRecycle {
  id: string
  agentId: string
  sessionId: string
  path: string
  storedPath: string
  hash: string
  size: number
  restored?: boolean
}

export class HomeStorage {
  readonly objectsDir: string
  readonly recycleDir: string
  constructor(
    readonly root: string,
    private repo: HomeRepository,
    private limits: () => HomeLimits,
    private now = Date.now,
  ) {
    this.objectsDir = path.join(root, 'objects')
    this.recycleDir = path.join(root, 'recycle')
    mkdirSync(this.objectsDir, { recursive: true })
    mkdirSync(this.recycleDir, { recursive: true })
    canonicalPath(this.objectsDir)
    canonicalPath(this.recycleDir)
  }
  read(file: string): { snapshot: HomeSnapshot; buffer?: Buffer } {
    const resolved = canonicalPath(file)
    try {
      const stat = lstatSync(resolved)
      if (!stat.isFile()) throw new HomeError('HOME_INVALID')
      if (stat.size > this.limits().fileMaxBytes) throw new HomeError('HOME_LIMIT')
      const buffer = readFileSync(resolved)
      if (buffer.length > this.limits().fileMaxBytes) throw new HomeError('HOME_LIMIT')
      return {
        snapshot: {
          path: resolved,
          hash: contentHash(buffer),
          size: buffer.length,
          mode: stat.mode,
        },
        buffer,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { snapshot: { path: resolved, hash: null, size: 0 } }
    }
  }
  blob(hash: string): Buffer {
    if (!/^[a-f\d]{64}$/.test(hash)) throw new HomeError('HOME_INVALID')
    const buffer = readFileSync(path.join(this.objectsDir, hash))
    if (contentHash(buffer) !== hash) throw new HomeError('HOME_CONFLICT')
    return buffer
  }
  usedBytes() {
    return [this.objectsDir, this.recycleDir].reduce(
      (sum, dir) =>
        sum +
        readdirSync(dir).reduce((bytes, name) => bytes + statSync(path.join(dir, name)).size, 0),
      0,
    )
  }
  /** 只清理过期快照和无引用对象；回收区没有自动永久删除。 */
  cleanup() {
    const checkpoints = this.repo.list<HomeCheckpoint>('checkpoint')
    for (const checkpoint of checkpoints) {
      if (
        checkpoint.state !== 'pending' &&
        checkpoint.createdAt + this.limits().checkpointRetentionMs <= this.now()
      ) {
        this.repo.put('checkpoint', { ...checkpoint, before: [], after: [], state: 'expired' })
      }
    }
    const references = new Set(
      this.repo
        .list<HomeCheckpoint>('checkpoint')
        .flatMap((row) => [...row.before, ...row.after].map((snapshot) => snapshot.hash))
        .filter(Boolean),
    )
    for (const item of this.repo.list<HomeShelfItem>('shelf'))
      if (item.hash) references.add(item.hash)
    for (const name of readdirSync(this.objectsDir))
      if (!references.has(name)) rmSync(path.join(this.objectsDir, name))
  }
  reserve(buffers: Buffer[], extraBytes = 0) {
    this.cleanup()
    const unique = new Map(buffers.map((buffer) => [contentHash(buffer), buffer]))
    const extra = [...unique].reduce(
      (sum, [hash, buffer]) =>
        sum + (existsSync(path.join(this.objectsDir, hash)) ? 0 : buffer.length),
      extraBytes,
    )
    if (
      this.usedBytes() + extra > this.limits().snapshotMaxBytes ||
      buffers.some((buffer) => buffer.length > this.limits().fileMaxBytes)
    )
      throw new HomeError('HOME_LIMIT')
    for (const [hash, buffer] of unique) {
      const target = path.join(this.objectsDir, hash)
      if (!existsSync(target)) writeDurable(target, buffer)
      else this.blob(hash)
    }
  }
  assertCurrent(snapshot: HomeSnapshot) {
    const actual = this.read(snapshot.path).snapshot
    if (
      actual.hash !== snapshot.hash ||
      (snapshot.mode !== undefined && actual.mode !== snapshot.mode)
    )
      throw new HomeError('HOME_CONFLICT', {
        path: snapshot.path,
        expectedHash: snapshot.hash,
        actualHash: actual.hash,
      })
  }
  /** 原子替换文件；临时文件只属于本次写入，不作为可见用户文件。 */
  write(snapshot: HomeSnapshot, buffer: Buffer) {
    this.assertCurrent(snapshot)
    const target = canonicalPath(snapshot.path),
      temporary = path.join(path.dirname(target), `.infos-${randomUUID()}.tmp`)
    try {
      // 和 write_file 一样，新建时父目录不存在就建上。
      mkdirSync(path.dirname(target), { recursive: true })
      writeDurable(temporary, buffer, snapshot.mode ?? 0o600)
      if (snapshot.mode !== undefined) chmodSync(temporary, snapshot.mode)
      this.assertCurrent(snapshot)
      if (snapshot.hash === null) {
        try {
          linkSync(temporary, target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new HomeError('HOME_CREATE_RACE', { paths: [snapshot.path] })
          throw error
        }
      } else renameSync(temporary, target)
    } finally {
      if (existsSync(temporary)) rmSync(temporary)
    }
  }
  /** 后端兜底回收站：跨卷先保留副本并校验，最后才移除原位置。 */
  trash(scope: HomeScope, snapshot: HomeSnapshot): HomeRecycle {
    if (!snapshot.hash) throw new HomeError('HOME_NOT_FOUND')
    this.assertCurrent(snapshot)
    const id = randomUUID(),
      storedPath = path.join(this.recycleDir, id)
    const value: HomeRecycle = {
      ...scope,
      id,
      path: snapshot.path,
      storedPath,
      hash: snapshot.hash,
      size: snapshot.size,
    }
    this.repo.put('recycle', value)
    try {
      try {
        renameSync(canonicalPath(snapshot.path), storedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        copyFileSync(snapshot.path, storedPath, constants.COPYFILE_EXCL)
        flushCopy(storedPath)
        if (contentHash(readFileSync(storedPath)) !== snapshot.hash)
          throw new HomeError('HOME_CONFLICT')
        this.assertCurrent(snapshot)
        unlinkSync(snapshot.path)
      }
    } catch (error) {
      if (!existsSync(storedPath)) this.repo.remove('recycle', id)
      throw error
    }
    return value
  }
  restoreRecycle(scope: HomeScope, id: string) {
    const value = this.repo.get<HomeRecycle>('recycle', id)
    if (
      !value ||
      value.agentId !== scope.agentId ||
      value.sessionId !== scope.sessionId ||
      value.restored
    )
      throw new HomeError('HOME_NOT_FOUND')
    if (
      this.read(value.path).snapshot.hash !== null ||
      contentHash(readFileSync(value.storedPath)) !== value.hash
    )
      throw new HomeError('HOME_CONFLICT')
    copyFileSync(value.storedPath, canonicalPath(value.path), constants.COPYFILE_EXCL)
    flushCopy(value.path)
    if (contentHash(readFileSync(value.path)) !== value.hash) throw new HomeError('HOME_CONFLICT')
    unlinkSync(value.storedPath)
    this.repo.put('recycle', { ...value, restored: true })
    return value
  }
  listRecycle(scope: HomeScope) {
    return this.repo
      .list<HomeRecycle>('recycle', scope.agentId, scope.sessionId)
      .filter((row) => !row.restored)
      .map(({ storedPath: _storedPath, ...row }) => row)
  }
  /** 回收区里还没恢复的文件：数量与占用（给设置页的「清空回收区」说明用）。 */
  recycleSummary(agentId?: string) {
    const rows = this.repo.list<HomeRecycle>('recycle', agentId).filter((row) => !row.restored)
    return { items: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) }
  }
  /**
   * 用户在设置页手动清空回收区：永久删除回收区里的文件。
   * 只由管理接口在用户二次确认后调用；没有任何 Agent 工具或自动清理会走到这里。
   * 检查点的快照对象不受影响，保留期内的改动仍可撤回。
   */
  purgeRecycle(agentId?: string) {
    const rows = this.repo.list<HomeRecycle>('recycle', agentId).filter((row) => !row.restored)
    let items = 0,
      bytes = 0
    for (const row of rows) {
      // 存储路径只认回收区目录里的记录 ID，不接受任意路径。
      const stored = path.join(this.recycleDir, row.id)
      if (path.resolve(row.storedPath) !== path.resolve(stored)) continue
      rmSync(stored, { force: true })
      this.repo.remove('recycle', row.id)
      items++
      bytes += row.size
    }
    return { items, bytes }
  }
  samePath(a: string, b: string) {
    return pathKey(a) === pathKey(b)
  }
}
