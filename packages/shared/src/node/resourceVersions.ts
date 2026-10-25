import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  EditableResourceKind,
  ResourceRevision,
  ResourceVersionsView,
} from '../resourceVersions'

const KINDS: EditableResourceKind[] = ['skills', 'custom', 'agents', 'packages']
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
interface State {
  version: 1
  safeMode: boolean
  safeModeReason?: 'manual' | 'switch-interrupted' | 'index-invalid'
  resumeRequested?: boolean
  boot?: { id: string; pid: number }
  revisions: ResourceRevision[]
  pending: ResourceVersionsView['pending']
  switching?: { id: string; action: 'apply' | 'rollback'; old: string; next: string }
}

/** 只管理用户资源。快照不包含依赖目录、运行数据或数据库。 */
export class ResourceVersions {
  readonly root: string
  readonly dataRoot: string
  constructor(dataRoot: string) {
    this.dataRoot = path.resolve(dataRoot)
    this.root = path.join(this.dataRoot, 'resource-versions')
  }
  private file() {
    return path.join(this.root, 'state.json')
  }
  private revision(id: string) {
    if (!UUID.test(id)) throw new Error('RESOURCE_REVISION_INVALID')
    return path.join(this.root, id)
  }
  private target(kind: EditableResourceKind) {
    if (!KINDS.includes(kind)) throw new Error('RESOURCE_KIND_INVALID')
    return path.join(path.resolve(this.dataRoot), kind)
  }
  private async state(): Promise<State> {
    try {
      const value = JSON.parse(await readFile(this.file(), 'utf8')) as State
      if (
        value.version !== 1 ||
        !Array.isArray(value.revisions) ||
        !Array.isArray(value.pending) ||
        value.revisions.length > 200 ||
        typeof value.safeMode !== 'boolean'
      )
        throw new Error('RESOURCE_INDEX_INVALID')
      for (const entry of value.revisions) {
        this.revision(entry.id)
        this.target(entry.kind)
        if (!['draft', 'pending', 'applied', 'rolled-back'].includes(entry.state))
          throw new Error('RESOURCE_INDEX_INVALID')
        // 记录里的路径只用于展示，不能控制恢复目标。
        entry.candidateDirectory = path.join(this.revision(entry.id), 'candidate')
      }
      for (const pending of value.pending) {
        if (
          !value.revisions.some((entry) => entry.id === pending.id) ||
          !['apply', 'rollback'].includes(pending.action)
        )
          throw new Error('RESOURCE_INDEX_INVALID')
      }
      if (
        value.switching &&
        (!UUID.test(value.switching.id) ||
          !['apply', 'rollback'].includes(value.switching.action) ||
          typeof value.switching.old !== 'string')
      )
        throw new Error('RESOURCE_INDEX_INVALID')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, safeMode: false, revisions: [], pending: [] }
      if (!(error as NodeJS.ErrnoException).code) {
        // 索引损坏不能连恢复入口也拖垮；保留原文件和全部快照，默认暂停拓展。
        await rename(this.file(), path.join(this.root, `state-${randomUUID()}.invalid.json`))
        const recovered: State = {
          version: 1,
          safeMode: true,
          safeModeReason: 'index-invalid',
          revisions: [],
          pending: [],
        }
        await this.save(recovered)
        return recovered
      }
      throw error
    }
  }
  private async save(value: State) {
    await mkdir(this.root, { recursive: true })
    const temporary = path.join(this.root, `${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value, null, 2))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, this.file())
          break
        } catch (error) {
          if (
            attempt >= 5 ||
            !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
          )
            throw error
          await delay(20 * 2 ** attempt)
        }
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  /** 后端与离线宿主共用文件锁；只清理已确认进程消失的旧锁。 */
  private async locked<T>(run: (state: State) => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true })
    await this.assertDirectory(this.root)
    const lock = path.join(this.root, 'state.lock')
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        handle = await open(lock, 'wx', 0o600)
        await handle.writeFile(String(process.pid))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 50) {
          if (handle) {
            await handle.close()
            await rm(lock, { force: true })
          }
          throw error
        }
        const pid = Number(await readFile(lock, 'utf8').catch(() => ''))
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ESRCH') await rm(lock, { force: true })
          }
        } else {
          // 创建锁后尚未写入 PID 就崩溃，等短暂写入窗口过去后才回收空锁。
          const info = await lstat(lock).catch(() => undefined)
          if (info && Date.now() - info.mtimeMs > 30000) await rm(lock, { force: true })
        }
        await delay(100)
      }
    }
    if (!handle) throw new Error('RESOURCE_LOCK_FAILED')
    try {
      return await run(await this.state())
    } finally {
      await handle.close()
      await rm(lock, { force: true })
    }
  }
  private async assertDirectory(directory: string, allowMissing = false) {
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === 'ENOENT') return undefined
      throw error
    })
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error('RESOURCE_PATH_INVALID')
    if (info) {
      const actualRoot = await realpath(this.dataRoot)
      const relative = path.relative(actualRoot, await realpath(directory))
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('RESOURCE_PATH_INVALID')
    }
  }
  private async files(directory: string) {
    await this.assertDirectory(directory)
    const result: Array<{ name: string; digest: string }> = []
    let bytes = 0,
      entries = 0
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 30) throw new Error('RESOURCE_SIZE_LIMIT')
      for (const name of (await readdir(dir)).sort()) {
        if (name === 'node_modules' || name === '.git') continue
        if (++entries > 20000) throw new Error('RESOURCE_SIZE_LIMIT')
        const file = path.join(dir, name),
          info = await lstat(file)
        if (info.isSymbolicLink()) throw new Error('RESOURCE_PATH_INVALID')
        if (info.isDirectory()) await visit(file, depth + 1)
        else if (info.isFile()) {
          bytes += info.size
          if (bytes > 256 * 1024 * 1024) throw new Error('RESOURCE_SIZE_LIMIT')
          result.push({
            name: path.relative(directory, file).replaceAll('\\', '/'),
            digest: createHash('sha256')
              .update(await readFile(file))
              .digest('hex'),
          })
        } else throw new Error('RESOURCE_PATH_INVALID')
      }
    }
    await visit(directory, 0)
    return result
  }
  private async digest(directory: string) {
    return createHash('sha256')
      .update(JSON.stringify(await this.files(directory)))
      .digest('hex')
  }
  private async copy(source: string, destination: string) {
    const before = await this.digest(source)
    const files = await this.files(source)
    await mkdir(destination, { recursive: true })
    for (const file of files) {
      const target = path.join(destination, file.name)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(source, file.name), target)
    }
    if ((await this.digest(destination)) !== before || (await this.digest(source)) !== before)
      throw new Error('RESOURCE_SOURCE_CHANGED')
    return before
  }
  async view(): Promise<ResourceVersionsView> {
    return this.locked(async (state) => ({
      safeMode: state.safeMode,
      interrupted: !!state.switching,
      restartRequired:
        !!state.pending.length ||
        !!state.resumeRequested ||
        (state.safeMode && process.env.INFOS_RESOURCE_SAFE_MODE !== '1'),
      revisions: state.revisions,
      pending: state.pending,
    }))
  }
  async checkout(kind: EditableResourceKind): Promise<ResourceRevision> {
    return this.locked(async (state) => {
      if (
        state.revisions.length >= 200 ||
        state.pending.some((entry) => state.revisions.find((r) => r.id === entry.id)?.kind === kind)
      )
        throw new Error('RESOURCE_PENDING_EXISTS')
      const id = randomUUID(),
        directory = this.revision(id)
      await this.assertDirectory(this.target(kind), true)
      await mkdir(this.target(kind), { recursive: true })
      const baseDigest = await this.copy(this.target(kind), path.join(directory, 'base'))
      await this.copy(path.join(directory, 'base'), path.join(directory, 'candidate'))
      const revision: ResourceRevision = {
        id,
        kind,
        createdAt: new Date().toISOString(),
        state: 'draft',
        baseDigest,
        candidateDirectory: path.join(directory, 'candidate'),
      }
      state.revisions.push(revision)
      await this.save(state)
      return revision
    })
  }
  async changes(id: string) {
    const directory = this.revision(id)
    const before = new Map(
      (await this.files(path.join(directory, 'base'))).map((file) => [file.name, file.digest]),
    )
    const after = new Map(
      (await this.files(path.join(directory, 'candidate'))).map((file) => [file.name, file.digest]),
    )
    return [...new Set([...before.keys(), ...after.keys()])]
      .filter((file) => before.get(file) !== after.get(file))
      .map((file) => ({
        file,
        kind: !before.has(file) ? 'added' : !after.has(file) ? 'deleted' : 'modified',
      }))
  }
  async preview(id: string, file: string) {
    const directory = this.revision(id)
    if (!(await this.changes(id)).some((entry) => entry.file === file))
      throw new Error('RESOURCE_PATH_INVALID')
    const read = async (side: string) => {
      const target = path.join(directory, side, file)
      const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (!info) return ''
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64000) return null
      const bytes = await readFile(target)
      return bytes.includes(0) ? null : bytes.toString('utf8')
    }
    return { file, before: await read('base'), after: await read('candidate') }
  }
  async discard(id: string) {
    await this.locked(async (state) => {
      const revision = state.revisions.find((entry) => entry.id === id)
      if (
        !revision ||
        !['draft', 'rolled-back'].includes(revision.state) ||
        state.pending.some((entry) => entry.id === id)
      )
        throw new Error('RESOURCE_REVISION_INVALID')
      state.revisions = state.revisions.filter((entry) => entry.id !== id)
      await this.save(state)
      await rm(this.revision(id), { recursive: true, force: true })
    })
  }
  async schedule(id: string, action: 'apply' | 'rollback') {
    await this.locked(async (state) => {
      const revision = state.revisions.find((entry) => entry.id === id)
      if (
        !revision ||
        (action === 'apply' && revision.state !== 'draft') ||
        (action === 'rollback' && revision.state !== 'applied')
      )
        throw new Error('RESOURCE_REVISION_INVALID')
      if (
        state.pending.some(
          (entry) => state.revisions.find((r) => r.id === entry.id)?.kind === revision.kind,
        )
      )
        throw new Error('RESOURCE_PENDING_EXISTS')
      if (action === 'apply') {
        if ((await this.digest(this.target(revision.kind))) !== revision.baseDigest)
          throw new Error('RESOURCE_SOURCE_CHANGED')
        await rm(path.join(this.revision(id), 'release'), { recursive: true, force: true })
        revision.digest = await this.copy(
          path.join(this.revision(id), 'candidate'),
          path.join(this.revision(id), 'release'),
        )
      } else {
        const latest = state.revisions
          .filter((entry) => entry.kind === revision.kind && entry.state === 'applied')
          .sort((a, b) => (a.appliedAt ?? a.createdAt).localeCompare(b.appliedAt ?? b.createdAt))
          .at(-1)
        if (latest?.id !== id) throw new Error('RESOURCE_ROLLBACK_ORDER')
      }
      state.pending.push({ id, action })
      if (action === 'apply') revision.state = 'pending'
      await this.save(state)
    })
  }
  async cancel(id: string) {
    await this.locked(async (state) => {
      if (state.switching?.id === id) return
      state.pending = state.pending.filter((entry) => entry.id !== id)
      const revision = state.revisions.find((entry) => entry.id === id)
      if (revision?.state === 'pending') revision.state = 'draft'
      await this.save(state)
    })
  }
  async setSafeMode(enabled: boolean) {
    await this.locked(async (state) => {
      state.safeMode = enabled
      if (enabled) state.safeModeReason = 'manual'
      else delete state.safeModeReason
      state.resumeRequested = !enabled
      await this.save(state)
    })
  }
  /** 只能在后端实例锁取得后、加载任何第三方资源前调用。 */
  async beginBoot(): Promise<{ id: string; safeMode: boolean }> {
    return this.locked(async (state) => {
      // 旧实现把任意未清理的启动标记都当成资源故障，断电和开发重启也会误触发。
      // 无来源的旧标记不再阻止资源加载；恢复模式必须来自用户选择或明确的资源恢复现场。
      if (state.safeMode && !state.safeModeReason) state.safeMode = false
      if (state.switching) {
        state.safeMode = true
        state.safeModeReason = 'switch-interrupted'
      }
      delete state.resumeRequested
      const id = randomUUID()
      // 不再跟踪整次应用运行是否正常退出，只保留真实资源目录切换的日志。
      delete state.boot
      await this.save(state)
      // 中断的目录切换优先恢复原目录副本，保留候选和现场，等待用户重新选择。
      if (state.switching) {
        const switching = state.switching
        const revision = state.revisions.find((entry) => entry.id === switching.id)
        if (!revision) throw new Error('RESOURCE_INDEX_INVALID')
        const target = this.target(revision.kind)
        const restore = path.join(this.dataRoot, `.resource-restore-${randomUUID()}`)
        const oldName = path.relative(this.dataRoot, path.resolve(switching.old))
        if (!/^\.resource-old-[a-f0-9-]+$/i.test(oldName)) throw new Error('RESOURCE_INDEX_INVALID')
        const old = path.join(this.dataRoot, oldName)
        const hasOld = await lstat(old).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        const source = hasOld ? old : path.join(this.revision(revision.id), 'base')
        if (!hasOld && (await this.digest(source)) !== revision.baseDigest)
          throw new Error('RESOURCE_SOURCE_CHANGED')
        await this.copy(source, restore)
        const quarantined = path.join(this.dataRoot, `.resource-interrupted-${randomUUID()}`)
        try {
          await rename(target, quarantined)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await rename(restore, target)
        state.pending = state.pending.filter((entry) => entry.id !== revision.id)
        revision.state = switching.action === 'rollback' && hasOld ? 'applied' : 'draft'
        delete state.switching
        await this.save(state)
      }
      for (const pending of [...state.pending]) {
        const revision = state.revisions.find((entry) => entry.id === pending.id)!
        const directory = this.revision(revision.id)
        const source = path.join(directory, pending.action === 'apply' ? 'release' : 'base')
        const digest = pending.action === 'apply' ? revision.digest : revision.baseDigest
        if ((await this.digest(source)) !== digest) throw new Error('RESOURCE_SOURCE_CHANGED')
        if (
          pending.action === 'apply' &&
          (await this.digest(this.target(revision.kind))) !== revision.baseDigest
        )
          throw new Error('RESOURCE_SOURCE_CHANGED')
        const next = path.join(this.dataRoot, `.resource-next-${randomUUID()}`)
        const old = path.join(this.dataRoot, `.resource-old-${randomUUID()}`)
        await this.copy(source, next)
        state.switching = { ...pending, old, next }
        await this.save(state)
        await this.assertDirectory(this.target(revision.kind), true)
        try {
          await rename(this.target(revision.kind), old)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await rename(next, this.target(revision.kind))
        revision.state = pending.action === 'apply' ? 'applied' : 'rolled-back'
        if (pending.action === 'apply') revision.appliedAt = new Date().toISOString()
        state.pending = state.pending.filter((entry) => entry.id !== revision.id)
        delete state.switching
        await this.save(state)
        // 原目录保留为额外恢复副本，不在启动期间递归删除用户文件。
      }
      return { id, safeMode: state.safeMode }
    })
  }
  async cleanShutdown(id: string) {
    await this.locked(async (state) => {
      if (state.boot?.id === id) {
        delete state.boot
        await this.save(state)
      }
    })
  }
}
