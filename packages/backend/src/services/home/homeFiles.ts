import path from 'node:path'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import type { HomeIntent, HomeScope, HomeSnapshot } from '@infos/shared'
import type { HomeRepository } from '../../repositories/home.repo'
import type { HomeAuthorizationService } from './homeAuthorization'
import type { HomeActivityService } from './homeActivity'
import type { HomeCheckpointService } from './homeCheckpoints'
import { contentHash, HomeStorage } from './homeStorage'
import { canonicalPath, containsPath, pathKey } from './homePaths'
import { HomeError } from './homeErrors'
import { isProtectedCredentialFile } from '../execution/protectedFiles'

// 排除目录参考 Roo Code excludes.ts（Apache-2.0）；只影响搜索，不豁免任何写前快照。
// Copyright Roo Code contributors. 修改：缩减为目录名，二进制文件仍完整备份。
const SEARCH_EXCLUDES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.next',
  '__pycache__',
])
interface Owned extends HomeScope {
  id: string
  path: string
  hash: string
}

export class HomeFileService {
  private reconcileBeforeChange(scope: HomeScope) {
    for (const row of this.checkpoints.list(scope)) {
      if (row.state !== 'pending') continue
      if (row.provider === 'system')
        throw new HomeError('HOME_CONFLICT', {
          checkpointId: row.id,
          reason: 'native_trash_pending',
        })
      this.checkpoints.reconcile(scope, row.id)
    }
  }
  constructor(
    private repo: HomeRepository,
    readonly storage: HomeStorage,
    private auth: HomeAuthorizationService,
    private checkpoints: HomeCheckpointService,
    private activity: HomeActivityService,
    private workspace: (agentId: string) => string,
    private privateRoots: string[] = [],
  ) {
    this.privateRoots = privateRoots.map(canonicalPath)
  }
  isOwn(scope: HomeScope, file: string) {
    if (containsPath(canonicalPath(this.workspace(scope.agentId)), file)) return true
    const owned = this.repo
      .list<Owned>('owned', scope.agentId, scope.sessionId)
      .find((row) => pathKey(row.path) === pathKey(file))
    return !!owned && this.storage.read(file).snapshot.hash === owned.hash
  }
  private remember(scope: HomeScope, file: string, hash: string) {
    const id = `owned:${scope.agentId}:${scope.sessionId}:${pathKey(file)}`
    this.repo.put('owned', { ...scope, id, path: file, hash })
  }
  private resolve(scope: HomeScope, file: string) {
    const result = canonicalPath(file),
      ownRoot = canonicalPath(this.workspace(scope.agentId))
    // infOS 自己的凭据与访问控制文件（含 Electron 用户数据目录里的）：读写删都不行。
    if (isProtectedCredentialFile(result)) throw new HomeError('HOME_PATH_INVALID')
    if (
      this.privateRoots.some((root) => containsPath(root, result)) &&
      !containsPath(ownRoot, result)
    )
      throw new HomeError('HOME_PATH_INVALID')
    return result
  }
  read(scope: HomeScope, input: string) {
    const file = this.resolve(scope, input)
    this.auth.enforce(scope, { action: 'read', paths: [file] })
    const { snapshot, buffer } = this.storage.read(file)
    if (!buffer) throw new HomeError('HOME_NOT_FOUND')
    return { ...snapshot, content: buffer.toString('base64'), encoding: 'base64' }
  }
  list(scope: HomeScope, input: string) {
    const dir = this.resolve(scope, input)
    this.auth.enforce(scope, { action: 'read', paths: [dir] })
    const entries = readdirSync(dir, { withFileTypes: true })
    return {
      entries: entries.slice(0, 1000).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
        link: entry.isSymbolicLink(),
      })),
      truncated: entries.length > 1000,
    }
  }
  search(scope: HomeScope, input: string, query: string) {
    const root = this.resolve(scope, input)
    this.auth.enforce(scope, { action: 'read', paths: [root] })
    const hits: Array<{ path: string; line: number; text: string }> = [],
      queue = [root]
    let visited = 0
    while (queue.length && visited < 1000 && hits.length < 100) {
      const dir = queue.shift()!
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++visited > 1000 || hits.length >= 100) break
        if (entry.isSymbolicLink() || SEARCH_EXCLUDES.has(entry.name)) continue
        if (isProtectedCredentialFile(path.join(dir, entry.name))) continue
        // 搜到私有目录、硬链接这类不能碰的条目就跳过，不让整次搜索失败。
        let file: string
        try {
          file = this.resolve(scope, path.join(dir, entry.name))
        } catch (error) {
          if (error instanceof HomeError && error.code === 'HOME_PATH_INVALID') continue
          throw error
        }
        if (entry.isDirectory()) {
          queue.push(file)
          continue
        }
        try {
          const buffer = this.storage.read(file).buffer
          if (!buffer || buffer.includes(0) || buffer.length > 1024 * 1024) continue
          for (const [index, line] of buffer.toString('utf8').split('\n').entries()) {
            if (line.includes(query))
              hits.push({ path: file, line: index + 1, text: line.slice(0, 500) })
            if (hits.length >= 100) break
          }
        } catch (error) {
          if (!(error instanceof HomeError && error.code === 'HOME_LIMIT')) throw error
        }
      }
    }
    return { hits, truncated: queue.length > 0 || visited >= 1000 || hits.length >= 100 }
  }
  prepareLegacy(scope: HomeScope, input: string, buffer: Buffer, append = false) {
    const file = this.resolve(scope, input),
      original = this.storage.read(file)
    const next = append && original.buffer ? Buffer.concat([original.buffer, buffer]) : buffer
    const after = [{ ...original.snapshot, hash: contentHash(next), size: next.length }]
    this.reconcileBeforeChange(scope)
    this.auth.enforce(scope, {
      action: 'write',
      paths: [file],
      parameters: { before: [original.snapshot.hash], after: [after[0]!.hash] },
    })
    this.storage.reserve(original.buffer ? [original.buffer, next] : [next])
    return this.checkpoints.prepare(scope, 'write', [original.snapshot], after)
  }
  finishLegacy(scope: HomeScope, checkpoint: import('@infos/shared').HomeCheckpoint) {
    const actual = this.storage.read(checkpoint.after[0]!.path).snapshot
    if (actual.hash !== checkpoint.after[0]!.hash) throw new HomeError('HOME_CONFLICT')
    const before = checkpoint.before[0]!
    const wasOwn =
      before.hash === null ||
      this.repo
        .list<Owned>('owned', scope.agentId, scope.sessionId)
        .some((row) => pathKey(row.path) === pathKey(actual.path) && row.hash === before.hash)
    checkpoint.after = [actual]
    this.checkpoints.finish(checkpoint, 'applied')
    // 她新建的文件算她自己的，和 home_files 一样。
    if (wasOwn && actual.hash) this.remember(scope, actual.path, actual.hash)
    this.activity.record(scope, {
      action: 'write',
      objects: [actual.path],
      result: 'success',
      checkpointId: checkpoint.id,
    })
  }
  /** 写入没做成（被停止、提交前文件变了、新建被抢先）：这次快照作废，不留悬着的检查点挡后面的操作。 */
  abandonLegacy(scope: HomeScope, checkpoint: import('@infos/shared').HomeCheckpoint) {
    this.checkpoints.finish(checkpoint, 'failed')
    this.activity.record(scope, {
      action: 'write',
      objects: [checkpoint.before[0]!.path],
      result: 'failed',
      checkpointId: checkpoint.id,
      detail: 'not_written',
    })
  }
  /** 给可信主进程的两阶段回收协议；后端先留下完整快照，再交出精确请求。 */
  prepareNativeTrash(scope: HomeScope, input: string) {
    const file = this.resolve(scope, input),
      original = this.storage.read(file)
    if (!original.buffer || !original.snapshot.hash) throw new HomeError('HOME_NOT_FOUND')
    this.reconcileBeforeChange(scope)
    this.auth.enforce(scope, {
      action: 'delete',
      paths: [file],
      parameters: { before: [original.snapshot.hash], after: [null], provider: 'system' },
    })
    this.storage.reserve([original.buffer])
    const checkpoint = this.checkpoints.prepare(
      scope,
      'delete',
      [original.snapshot],
      [{ ...original.snapshot, hash: null, size: 0, mode: undefined }],
    )
    this.repo.put('checkpoint', { ...checkpoint, provider: 'system' })
    return { path: file, expectedHash: original.snapshot.hash, checkpointId: checkpoint.id, scope }
  }
  completeNativeTrash(scope: HomeScope, checkpointId: string, result: 'success' | 'failed') {
    const checkpoint = this.checkpoints.get(scope, checkpointId)
    if (
      checkpoint.state !== 'pending' ||
      checkpoint.action !== 'delete' ||
      checkpoint.before.length !== 1
    )
      throw new HomeError('HOME_CONFLICT')
    const original = checkpoint.before[0]!,
      actual = this.storage.read(original.path).snapshot
    if (
      (result === 'success' && actual.hash !== null) ||
      (result === 'failed' && actual.hash !== original.hash)
    )
      throw new HomeError('HOME_CONFLICT')
    this.checkpoints.finish(checkpoint, result === 'success' ? 'applied' : 'failed')
    this.activity.record(scope, {
      action: 'delete',
      objects: [original.path],
      result,
      checkpointId,
      detail: 'system_recycle',
    })
    return { checkpointId, recycled: result === 'success', provider: 'system' }
  }
  mutate(
    scope: HomeScope,
    action: 'write' | 'move' | 'delete',
    input: string,
    content?: Buffer,
    destination?: string,
  ) {
    const file = this.resolve(scope, input),
      target = destination ? this.resolve(scope, destination) : undefined
    if (action === 'move' && (!target || pathKey(file) === pathKey(target)))
      throw new HomeError('HOME_INVALID')
    const original = this.storage.read(file),
      before = [original.snapshot],
      buffers: Buffer[] = []
    const wasOwn = this.isOwn(scope, file)
    if (action !== 'write' && !original.buffer) throw new HomeError('HOME_NOT_FOUND')
    if (original.buffer) buffers.push(original.buffer)
    let after: HomeSnapshot[]
    if (action === 'write') {
      if (!content) throw new HomeError('HOME_INVALID')
      buffers.push(content)
      after = [{ ...original.snapshot, hash: contentHash(content), size: content.length }]
    } else if (action === 'move') {
      const next = this.storage.read(target!)
      if (next.buffer || existsSync(target!)) throw new HomeError('HOME_CONFLICT')
      before.push(next.snapshot)
      after = [
        { ...original.snapshot, hash: null, size: 0, mode: undefined },
        { ...original.snapshot, path: target! },
      ]
    } else after = [{ ...original.snapshot, hash: null, size: 0, mode: undefined }]
    const intent: HomeIntent = {
      action,
      paths: before.map((snapshot) => snapshot.path),
      parameters: {
        before: before.map((snapshot) => snapshot.hash),
        after: after.map((snapshot) => snapshot.hash),
      },
    }
    let checkpoint: ReturnType<HomeCheckpointService['prepare']> | undefined
    try {
      this.reconcileBeforeChange(scope)
      this.auth.enforce(scope, intent)
      this.storage.reserve(buffers, action === 'delete' ? original.snapshot.size : 0)
      checkpoint = this.checkpoints.prepare(scope, action, before, after)
      before.forEach((snapshot) => this.storage.assertCurrent(snapshot))
      if (action === 'write') this.storage.write(original.snapshot, content!)
      else if (action === 'move') renameSync(canonicalPath(file), canonicalPath(target!))
      else this.storage.trash(scope, original.snapshot)
      // 写回实际元信息，撤回时也能识别权限位变化。
      checkpoint.after = after.map((snapshot) => this.storage.read(snapshot.path).snapshot)
      this.checkpoints.finish(checkpoint, 'applied')
      for (const snapshot of checkpoint.after) {
        const previous = before.find((item) => pathKey(item.path) === pathKey(snapshot.path))
        if (snapshot.hash && (previous?.hash === null || wasOwn))
          this.remember(scope, snapshot.path, snapshot.hash)
      }
      this.activity.record(scope, {
        action,
        objects: before.map((snapshot) => snapshot.path),
        result: 'success',
        checkpointId: checkpoint.id,
      })
      return { checkpointId: checkpoint.id, files: checkpoint.after }
    } catch (error) {
      const raced = error instanceof HomeError && error.code === 'HOME_CREATE_RACE'
      if (
        checkpoint &&
        (raced ||
          before.every((snapshot) => {
            try {
              return this.storage.read(snapshot.path).snapshot.hash === snapshot.hash
            } catch {
              return false
            }
          }))
      )
        this.checkpoints.finish(checkpoint, 'failed')
      if (!(error instanceof HomeError && error.code === 'HOME_CONFIRMATION_REQUIRED'))
        this.activity.record(scope, {
          action,
          objects: before.map((snapshot) => snapshot.path),
          result:
            raced || (error instanceof HomeError && error.code === 'HOME_CONFLICT')
              ? 'conflict'
              : 'failed',
          checkpointId: checkpoint?.id,
          detail: error instanceof HomeError ? error.code : 'HOME_IO',
        })
      throw error instanceof HomeError ? error : new HomeError('HOME_IO')
    }
  }
}
