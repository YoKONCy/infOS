import { randomUUID } from 'node:crypto'
import type { HomeCheckpoint, HomeLimits, HomeScope, HomeSnapshot } from '@infos/shared'
import type { HomeRepository } from '../../repositories/home.repo'
import type { HomeActivityService } from './homeActivity'
import { HomeStorage } from './homeStorage'
import { canonicalPath, pathKey } from './homePaths'
import { HomeError } from './homeErrors'

/** 参考 Roo Code ShadowCheckpointService 的会话基线/差异/恢复职责，改用内容寻址快照。 */
export class HomeCheckpointService {
  constructor(
    private repo: HomeRepository,
    private storage: HomeStorage,
    private activity: HomeActivityService,
    private limits: () => HomeLimits,
    private now = Date.now,
  ) {}
  prepare(
    scope: HomeScope,
    action: HomeCheckpoint['action'],
    before: HomeSnapshot[],
    after: HomeSnapshot[],
  ) {
    const value: HomeCheckpoint = {
      ...scope,
      id: randomUUID(),
      createdAt: this.now(),
      action,
      before,
      after,
      state: 'pending',
    }
    this.repo.put('checkpoint', value, value.createdAt)
    return value
  }
  finish(value: HomeCheckpoint, state: 'applied' | 'failed') {
    this.repo.transaction(() => {
      this.repo.put('checkpoint', { ...value, state })
      if (state === 'applied')
        this.repo.put('mutation', {
          id: value.id,
          agentId: value.agentId,
          sessionId: value.sessionId,
          taskId: value.taskId,
          time: this.now(),
          action: value.action,
          objects: value.before.map((snapshot) => snapshot.path),
          created: value.before.filter((snapshot) => !snapshot.hash).map((row) => row.path),
          result: 'success',
          checkpointId: value.id,
        })
    })
  }
  list(scope: HomeScope) {
    return this.repo.list<HomeCheckpoint>('checkpoint', scope.agentId, scope.sessionId)
  }
  /** 只核对磁盘事实，不覆盖文件；解决中断发生在写入前或写入完成后的检查点。 */
  reconcile(scope: HomeScope, id: string) {
    const row = this.get(scope, id)
    if (row.state !== 'pending') return row
    const matches = (snapshots: HomeSnapshot[]) =>
      snapshots.every(
        (snapshot) => this.storage.read(snapshot.path).snapshot.hash === snapshot.hash,
      )
    const state = matches(row.before) ? 'failed' : matches(row.after) ? 'applied' : undefined
    if (!state)
      throw new HomeError('HOME_CONFLICT', { checkpointId: id, reason: 'partial_operation' })
    const resolved = { ...row, state } as HomeCheckpoint
    if (state === 'applied') {
      resolved.after = row.after.map((snapshot) => this.storage.read(snapshot.path).snapshot)
      // 长期中断的检查点确认成功后，重新给用户完整的撤回保留窗口。
      resolved.createdAt = this.now()
    }
    this.finish(resolved, state)
    this.activity.record(scope, {
      action: row.action,
      objects: row.before.map((snapshot) => snapshot.path),
      result: state === 'applied' ? 'success' : 'failed',
      checkpointId: id,
      detail: 'reconciled',
    })
    return resolved
  }
  get(scope: HomeScope, id: string) {
    const row = this.repo.get<HomeCheckpoint>('checkpoint', id)
    if (!row || row.agentId !== scope.agentId || row.sessionId !== scope.sessionId)
      throw new HomeError('HOME_NOT_FOUND')
    if (
      row.state === 'expired' ||
      (row.state !== 'pending' && row.createdAt + this.limits().checkpointRetentionMs <= this.now())
    )
      throw new HomeError('HOME_EXPIRED')
    return row
  }
  diff(scope: HomeScope, id: string) {
    const row = this.get(scope, id)
    const display = (snapshot: HomeSnapshot) => {
      if (!snapshot.hash) return { ...snapshot, text: null, binary: false }
      const buffer = this.storage.blob(snapshot.hash),
        binary = buffer.includes(0) || buffer.length > 256 * 1024
      return { ...snapshot, text: binary ? undefined : buffer.toString('utf8'), binary }
    }
    return { ...row, before: row.before.map(display), after: row.after.map(display) }
  }
  undo(scope: HomeScope, id?: string) {
    const records = id
      ? [this.get(scope, id)]
      : this.list(scope)
          .filter((row) => row.state === 'applied')
          .reverse()
    if (this.list(scope).some((row) => row.state === 'pending'))
      throw new HomeError('HOME_CONFLICT', { reason: 'pending_checkpoint' })
    const simulated = new Map<string, string | null>()
    // 整个会话先预检，存在任一冲突时不产生部分撤回。
    for (const row of records) {
      if (row.state === 'undone') continue
      if (row.state !== 'applied') throw new HomeError('HOME_CONFLICT')
      this.get(scope, row.id)
      for (const snapshot of row.after) {
        canonicalPath(snapshot.path)
        const key = pathKey(snapshot.path),
          current = simulated.has(key)
            ? simulated.get(key)
            : this.storage.read(snapshot.path).snapshot.hash
        if (current !== snapshot.hash)
          throw new HomeError('HOME_CONFLICT', {
            path: snapshot.path,
            checkpointId: row.id,
            expectedHash: snapshot.hash,
            actualHash: current,
          })
      }
      for (const snapshot of row.before) {
        if (snapshot.hash) this.storage.blob(snapshot.hash)
        simulated.set(pathKey(snapshot.path), snapshot.hash)
      }
    }
    const undone: string[] = []
    for (const row of records) {
      if (row.state === 'undone') continue
      // 先检查本条所有对象，再恢复；创建文件的撤回也只进回收区。
      row.after.forEach((snapshot) => this.storage.assertCurrent(snapshot))
      const removals = row.before
        .filter((snapshot) => !snapshot.hash)
        .map(
          (snapshot) =>
            row.after.find((after) => this.storage.samePath(after.path, snapshot.path))!,
        )
        .filter((snapshot) => snapshot.hash)
      this.storage.reserve(
        [],
        removals.reduce((sum, snapshot) => sum + snapshot.size, 0),
      )
      for (const snapshot of row.before) {
        const expected = row.after.find((after) =>
          this.storage.samePath(after.path, snapshot.path),
        )!
        if (snapshot.hash) this.storage.write(expected, this.storage.blob(snapshot.hash))
        else if (expected.hash) this.storage.trash(scope, expected)
      }
      this.repo.put('checkpoint', { ...row, state: 'undone' })
      this.activity.record(scope, {
        action: 'undo',
        objects: row.before.map((snapshot) => snapshot.path),
        result: 'success',
        checkpointId: row.id,
      })
      undone.push(row.id)
    }
    return { undone }
  }
}
