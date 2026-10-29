import { t as __t } from '../lib/i18n'
/**
 * 记忆 Store 注册表
 *
 * 管理 Agent 私有 EventNote Store 与全局共享事实、文档检索 Store。
 *
 * 文件结构:
 * ```
 * data/
 * ├── agent_pero/memory.tdb
 * ├── agent_neko/memory.tdb
 * ├── knowledge/facts.tdb
 * └── knowledge/knowledge.tdb
 * ```
 *
 * @module packages/backend/src/repositories/storeRegistry
 */

import path from 'node:path'
import {
  mkdirSync,
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  copyFileSync,
  renameSync,
} from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { StoreOperationError, storeDiagnostic, type StoreDiagnostic } from '../lib/storeDiagnostics'
import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
// triviumdb 是 NAPI CJS 模块 (module.exports = { TriviumDB })，ESM 只能通过 require 加载
import type { TriviumDB as TriviumDBType } from 'triviumdb'
const _triviumModule = _require('triviumdb') as {
  TriviumDB: new (...args: unknown[]) => TriviumDBType
}
const TriviumDB = _triviumModule.TriviumDB
import type { PathResolver } from '../core/pathResolver'
import { createLogger } from '../lib/logger'
import {
  assertManagedFilePath,
  backupLegacyStore,
  databaseFormat,
  managedRelative,
  managedStoreBase,
  triviumFiles,
  TRIVIUM_FORMAT,
  TRIVIUM_BACKUP_DIRECTORY,
  isTriviumFile,
  upgradeBackupRoots,
} from './triviumFiles'

const logger = createLogger('StoreRegistry')

/** Store 模式 */
export type StoreMode = 'main' | 'social'
export type SharedStoreKind = 'facts' | 'knowledge'

/** 向量维度配置 (与 EmbeddingService 对齐) */
const DEFAULT_DIM = 1536

// ─────────────────────────────────────────────
// Store 注册表
// ─────────────────────────────────────────────

export class MemoryStoreRegistry {
  /** 缓存已打开的 TriviumDB 实例 (key = 文件路径) */
  private stores = new Map<string, TriviumDBType>()
  /** 文本索引预热标记 (key = 文件路径，true 表示写入后尚未执行预热) */
  private textIndexDirty = new Map<string, boolean>()
  private descriptions = new Map<
    string,
    { key: string; value: { exists: boolean; dimension: number; nodeCount: number } }
  >()
  private readonly warnings = new Map<string, StoreDiagnostic[]>()
  private readonly maintenance = new Map<string, symbol>()
  private readonly maintenanceScope = new AsyncLocalStorage<symbol>()
  private readonly activeCalls = new Map<string, Set<Promise<unknown>>>()

  constructor(
    private pathResolver: PathResolver,
    private dim: number = DEFAULT_DIM,
  ) {}

  private assertAvailable(target: string): void {
    const owner = this.maintenance.get(target)
    if (owner && owner !== this.maintenanceScope.getStore())
      throw new StoreOperationError({
        code: 'STORE_MAINTENANCE',
        phase: 'drain',
        path: target,
        message: __t('server.index-maintenance', '数据库正在维护，请稍后重试'),
      })
  }

  private assertNoActiveCalls(target: string): void {
    if (this.activeCalls.get(target)?.size)
      throw new StoreOperationError({
        code: 'STORE_MAINTENANCE',
        phase: 'drain',
        path: target,
        message: __t('server.index-maintenance', '数据库仍有操作未结束，已保留原索引'),
      })
  }

  /** 停止新访问并等待已进入的异步原生调用；同步重建和文件替换仍沿用现有流程。 */
  async withMaintenance<T>(
    target: string,
    operation: () => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertManagedStorePath(target)
    signal?.throwIfAborted()
    this.assertAvailable(target)
    if (this.maintenance.has(target)) return operation()
    const owner = Symbol('store-maintenance')
    this.maintenance.set(target, owner)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      signal?.throwIfAborted()
      const interrupted = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new StoreOperationError({
                code: 'STORE_DRAIN_TIMEOUT',
                phase: 'drain',
                path: target,
                message: __t('server.index-maintenance', '数据库仍有操作未结束，已保留原索引'),
              }),
            ),
          5000,
        )
        abort = () => reject(signal?.reason ?? new Error('Aborted'))
        signal?.addEventListener('abort', abort, { once: true })
      })
      await Promise.race([
        Promise.allSettled([...(this.activeCalls.get(target) ?? [])]),
        interrupted,
      ])
      signal?.throwIfAborted()
      return await this.maintenanceScope.run(owner, operation)
    } finally {
      if (timer) clearTimeout(timer)
      if (abort) signal?.removeEventListener('abort', abort)
      this.maintenance.delete(target)
    }
  }

  private guardedStore(target: string, native: TriviumDBType): TriviumDBType {
    const calls = new Set<Promise<unknown>>()
    this.activeCalls.set(target, calls)
    const view: TriviumDBType = new Proxy(native, {
      get: (store, property) => {
        const check = () => {
          this.assertAvailable(target)
          if (this.stores.get(target) !== view)
            throw new StoreOperationError({
              code: 'STORE_STALE_HANDLE',
              phase: 'access',
              path: target,
              message: __t(
                'server.index-maintenance',
                '数据库索引已切换，旧访问已取消，请重新读取',
              ),
            })
        }
        check()
        const value = Reflect.get(store, property, store)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          check()
          const result: unknown = Reflect.apply(value, store, args)
          if (
            result &&
            typeof result === 'object' &&
            typeof (result as PromiseLike<unknown>).then === 'function'
          ) {
            const pending = Promise.resolve(result)
            calls.add(pending)
            void pending.then(
              () => calls.delete(pending),
              () => calls.delete(pending),
            )
          }
          return result === native ? view : result
        }
      },
    })
    return view
  }

  storeDiagnostics(target: string): StoreDiagnostic[] {
    return this.warnings.get(target) ?? []
  }
  private warnStore(target: string, error: unknown, phase: string): void {
    this.warnings.set(target, [
      ...this.storeDiagnostics(target).slice(-7),
      storeDiagnostic(error, phase),
    ])
  }
  isMaintaining(target: string): boolean {
    return this.maintenance.has(target)
  }

  /**
   * Agent 专属事件记忆 Store (物理隔离)
   *
   * @example getAgentStore('pero', 'main') → data/agent_pero/memory.tdb
   */
  getAgentStore(agentId: string, mode: StoreMode = 'main'): TriviumDBType {
    const tdbPath = this.resolveAgentStorePath(agentId, mode)
    return this.getOrCreate(tdbPath)
  }

  /** 全 Agent 共享的事实或文档检索库。 */
  getSharedStore(kind: SharedStoreKind): TriviumDBType {
    return this.getOrCreate(this.resolveSharedStorePath(kind))
  }

  resolveSharedStorePath(kind: SharedStoreKind): string {
    return this.pathResolver.resolve(`@data/knowledge/${kind}.tdb`)
  }

  /**
   * 根据来源自动选择 Store
   *
   * 仅外部平台社交来源写入独立社交记忆：
   * - 'social' → social.tdb
   * - 'group' / 'group_chat' → main.tdb（infOS 内部据点多 Agent 群聊）
   * - 其他（desktop/companion）→ main.tdb
   *
   * @param agentId Agent ID
   * @param source  记忆来源（channel 或旧版 MemorySource）
   */
  getStoreBySource(agentId: string, source: string): TriviumDBType {
    switch (source) {
      case 'social':
        return this.getAgentStore(agentId, 'social')
      default:
        return this.getAgentStore(agentId, 'main')
    }
  }

  /** 当前Store维度；热更新时由重建流程统一切换。 */
  getDimension(): number {
    return this.dim
  }

  /** 切换目标维度但保留磁盘索引，旧库由维护任务逐项重建，失败时仍有原件。 */
  setDimension(dimension: number): void {
    if (!Number.isInteger(dimension) || dimension <= 0)
      throw new Error(__t('server.index-maintenance', '向量维度必须为正整数'))
    if (dimension === this.dim) return
    for (const target of new Set([...this.maintenance.keys(), ...this.stores.keys()])) {
      this.assertAvailable(target)
      this.assertNoActiveCalls(target)
    }
    for (const [target, store] of this.stores) {
      // 关闭失败时保留句柄和旧目标维度，不能继续切换或遗失原生资源的重试入口。
      store.close()
      this.stores.delete(target)
      this.activeCalls.delete(target)
      this.textIndexDirty.delete(target)
    }
    this.descriptions.clear()
    this.dim = dimension
  }
  /** 全量遗忘也覆盖已移除角色留下的受管索引目录。 */
  listStoredAgentIds(): string[] {
    const root = this.pathResolver.resolve('@data')
    const backups = upgradeBackupRoots(root)
    const agents = new Set<string>()
    for (const directory of [root, ...backups]) {
      if (!existsSync(directory)) continue
      if (directory !== root) assertManagedFilePath(root, directory)
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^agent_[\w-]+$/.test(entry.name))
          continue
        const names = readdirSync(path.join(directory, entry.name))
        if (
          names.some(
            (name) =>
              isTriviumFile(name, 'memory.tdb') ||
              isTriviumFile(name, 'social.tdb') ||
              /^\.index-[a-f0-9-]+$/i.test(name),
          )
        )
          agents.add(entry.name.slice(6))
      }
    }
    return [...agents].sort()
  }
  private assertManagedStorePath(target: string): void {
    assertManagedFilePath(this.pathResolver.resolve('@data'), target)
  }

  removeLegacyStores(): void {
    const dataRoot = this.pathResolver.resolve('@data')
    if (!existsSync(dataRoot)) return
    this.removeStoresRecursively(dataRoot, true)
  }

  /** 关闭并删除所有旧维度Store，切换后由调用方从SQLite重建索引。 */
  resetAllForDimension(dimension: number): void {
    if (!Number.isInteger(dimension) || dimension <= 0) throw new Error('Embedding维度必须为正整数')
    for (const target of new Set([...this.maintenance.keys(), ...this.stores.keys()])) {
      this.assertAvailable(target)
      this.assertNoActiveCalls(target)
    }
    // 社交图谱是长记忆主存，必须保留节点与边后迁移，不能当成可丢弃索引删除。
    for (const agentId of this.listStoredAgentIds()) this.rebuildSocialStore(agentId, dimension)
    for (const store of this.stores.values()) store.close()
    this.stores.clear()
    this.textIndexDirty.clear()
    this.activeCalls.clear()
    const dataRoot = this.pathResolver.resolve('@data')
    if (existsSync(dataRoot)) this.removeStoresRecursively(dataRoot, false)
    this.dim = dimension
    logger.info(__t('logs.repositories', '向量Store维度已切换: {0}', [dimension]))
  }

  /** 安全关闭所有 Store，先落盘再释放文件锁。 */
  closeAll(): void {
    for (const [tdbPath, store] of this.stores) {
      try {
        store.close()
        logger.debug(__t('logs.repositories', 'Store 已关闭: {0}', [tdbPath]))
      } catch (err) {
        logger.warn(__t('logs.repositories', 'Store 关闭失败: {0}', [tdbPath]), { error: err })
      }
    }
    this.stores.clear()
    this.textIndexDirty.clear()
    this.activeCalls.clear()
  }

  /** Store旁保存维度元数据，用于升级时识别旧索引。 */
  private dimensionPath(tdbPath: string): string {
    return `${tdbPath}.dimension`
  }

  /** 用原生结构化诊断识别已有库的维度，不用候选配置重写旧索引。 */
  private openExistingReader(tdbPath: string): TriviumDBType {
    const options = {
      dim: this.dim,
      accessMode: 'readOnly' as const,
      autoBuildQuiver: false,
      missingIndexPolicy: 'fallback' as const,
      payloadCacheMb: 8,
    }
    try {
      return new TriviumDB(tdbPath, options)
    } catch (error) {
      const failure = error as { code?: string; details?: { expected?: unknown } }
      const dimension = failure.details?.expected
      if (
        failure.code !== 'TDB_DIMENSION_MISMATCH' ||
        typeof dimension !== 'number' ||
        !Number.isSafeInteger(dimension) ||
        dimension <= 0
      )
        throw error
      return new TriviumDB(tdbPath, { ...options, dim: dimension })
    }
  }

  private removeStoresRecursively(directory: string, legacyOnly: boolean): void {
    const root = this.pathResolver.resolve('@data')
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink() || entry.name === TRIVIUM_BACKUP_DIRECTORY) continue
      if (entry.isDirectory()) {
        // 只维护引擎自己的目录，不能递归删除用户工作区里恰好同名的文件。
        if (directory === root && (entry.name === 'knowledge' || /^agent_[\w-]+$/.test(entry.name)))
          this.removeStoresRecursively(target, legacyOnly)
        continue
      }
      const base = managedStoreBase(managedRelative(root, target))
      if (!base) continue
      const selected = legacyOnly
        ? ['main.tdb', 'diary.tdb']
        : ['memory.tdb', 'facts.tdb', 'knowledge.tdb']
      if (selected.includes(path.basename(base))) {
        rmSync(target, { force: true })
        this.discardUpgradeBackup(path.join(root, base))
      }
    }
  }

  /** 升级只在首次写入旧格式前进行；备份时用共享读锁排除其他 Writer。 */
  private prepareLegacyStore(tdbPath: string): void {
    const format = databaseFormat(tdbPath)
    if (format === null || format >= TRIVIUM_FORMAT) return
    if (format < 5) throw new Error('旧数据库格式过早，请先用对应版本导出迁移')
    let reader: TriviumDBType | undefined
    try {
      reader = this.openExistingReader(tdbPath)
      const lockedFormat = databaseFormat(tdbPath)
      if (lockedFormat === null) throw new Error('持有共享读锁后旧库主文件缺失')
      if (lockedFormat >= TRIVIUM_FORMAT) return
      const backup = backupLegacyStore(this.pathResolver.resolve('@data'), tdbPath, lockedFormat)
      logger.info(__t('logs.repositories', '已保留数据库升级前的完整备份'), {
        path: tdbPath,
        format: lockedFormat,
        backup,
      })
    } catch (error) {
      throw new Error(
        '升级前备份未完成，尚未打开可写旧库。请关闭其他 Writer；如有待恢复 WAL，请先用旧版正常启动并退出。',
        { cause: error },
      )
    } finally {
      reader?.close()
    }
  }

  /** 永久删除与重建不能留下包含旧正文的升级副本。 */
  discardUpgradeBackup(tdbPath: string, preserveStaging?: string): void {
    this.assertManagedStorePath(tdbPath)
    this.assertAvailable(tdbPath)
    const root = this.pathResolver.resolve('@data')
    for (const backupRoot of upgradeBackupRoots(root)) {
      const backup = path.join(backupRoot, managedRelative(root, tdbPath))
      assertManagedFilePath(root, backup)
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
    }
    const parent = path.dirname(tdbPath)
    if (!existsSync(parent)) return
    // 异常发布留下的回滚区同样可能含旧正文；仅清理对应库，不能递归扫用户目录。
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^\.index-[a-f0-9-]+$/i.test(entry.name)
      )
        continue
      const staging = path.join(parent, entry.name)
      if (staging === preserveStaging) continue
      for (const directory of [path.join(staging, '.previous'), staging]) {
        if (!existsSync(directory)) continue
        assertManagedFilePath(this.pathResolver.resolve('@data'), directory)
        for (const file of triviumFiles(path.join(directory, path.basename(tdbPath))))
          rmSync(file, { force: true })
        if (readdirSync(directory).length === 0) rmdirSync(directory)
      }
    }
  }

  private removeStoreFiles(tdbPath: string): void {
    this.assertManagedStorePath(tdbPath)
    for (const file of triviumFiles(tdbPath)) rmSync(file, { force: true })
    this.discardUpgradeBackup(tdbPath)
  }

  /** 在同步边界内冻结写入和自动压实，SQLite 与各 Store 的复制之间不让出事件循环。 */
  captureSnapshot(destination: string, captureSqlite: () => void): void {
    if (this.maintenance.size || [...this.activeCalls.values()].some((calls) => calls.size))
      throw new StoreOperationError({
        code: 'STORE_MAINTENANCE',
        phase: 'snapshot',
        message: __t('server.index-maintenance', '数据库正在维护，请稍后重试'),
      })
    const root = this.pathResolver.resolve('@data')
    const relativeDestination = path.relative(path.resolve(root), path.resolve(destination))
    const backupWork = path.relative(
      path.join(path.resolve(root), '.backup-state', 'work'),
      path.resolve(destination),
    )
    const privateBackup = Boolean(
      backupWork && !backupWork.startsWith('..') && !path.isAbsolute(backupWork),
    )
    if (
      !relativeDestination ||
      (!relativeDestination.startsWith(`..${path.sep}`) &&
        relativeDestination !== '..' &&
        !path.isAbsolute(relativeDestination) &&
        !privateBackup)
    )
      throw new Error('数据库快照必须写入独立暂存目录或备份专用工作目录')
    const paths = new Set<string>(this.stores.keys())
    for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !(entry.name === 'knowledge' || /^agent_[\w-]+$/.test(entry.name))
      )
        continue
      for (const name of readdirSync(path.join(root, entry.name))) {
        const relative = `${entry.name}/${name}`
        const base = managedStoreBase(relative)
        if (base) paths.add(path.join(root, base))
      }
    }
    const paused: TriviumDBType[] = []
    const readers: TriviumDBType[] = []
    try {
      for (const store of this.stores.values()) {
        store.disableAutoCompaction()
        paused.push(store)
      }
      for (const source of paths) {
        this.assertManagedStorePath(source)
        const writer = this.stores.get(source)
        if (writer) writer.flush()
        else readers.push(this.openExistingReader(source))
      }
      captureSqlite()
      for (const source of paths) {
        const target = path.join(destination, managedRelative(root, source))
        mkdirSync(path.dirname(target), { recursive: true })
        for (const file of triviumFiles(source)) {
          // 旧 manifest 可能对应上次提交；普通恢复由当前 flush marker 校验整组文件。
          if (file.endsWith('.tmp') || file.endsWith('.manifest.json')) continue
          copyFileSync(file, path.join(path.dirname(target), path.basename(file)))
        }
        const check = this.openExistingReader(target)
        check.close()
      }
    } finally {
      for (const reader of readers) {
        try {
          reader.close()
        } catch (error) {
          logger.warn(__t('logs.repositories', '快照完成后关闭只读 Store 失败'), { error })
        }
      }
      for (const store of paused) {
        try {
          store.enableAutoCompaction(300)
        } catch (error) {
          logger.warn(__t('logs.repositories', '快照完成后恢复自动压实失败'), { error })
        }
      }
    }
  }

  /** 获取指定 Agent Store 的文件路径 */
  resolveAgentStorePath(agentId: string, mode: StoreMode): string {
    if (!/^[\w-]+$/.test(agentId)) throw new Error('角色 ID 格式无效')
    const fileName = mode === 'main' ? 'memory.tdb' : 'social.tdb'
    return this.pathResolver.resolve(`@data/agent_${agentId}/${fileName}`)
  }

  /** 不打开或创建缺失文件，展示已有索引及其实际维度。 */
  describeStore(tdbPath: string): {
    exists: boolean
    dimension: number | null
    nodeCount: number | null
  } {
    this.assertManagedStorePath(tdbPath)
    this.assertAvailable(tdbPath)
    const store = this.stores.get(tdbPath)
    if (store) return { exists: true, dimension: store.dim(), nodeCount: store.nodeCount() }
    const stat = (() => {
      try {
        return statSync(tdbPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    })()
    if (!stat) {
      this.descriptions.delete(tdbPath)
      return { exists: false, dimension: null, nodeCount: 0 }
    }
    const key = `${stat.mtimeMs}:${stat.size}`
    const cached = this.descriptions.get(tdbPath)
    if (cached?.key === key) return cached.value
    const reader = this.openExistingReader(tdbPath)
    try {
      const value = { exists: true, dimension: reader.dim(), nodeCount: reader.nodeCount() }
      this.descriptions.set(tdbPath, { key, value })
      return value
    } finally {
      reader.close()
    }
  }

  /** 先完整构建新文件再发布，模型调用失败不会先清空现有记忆。 */
  replaceAgentStore(
    agentId: string,
    mode: StoreMode,
    populate: (store: TriviumDBType) => void,
    dimension = this.dim,
  ): void {
    const target = this.resolveAgentStorePath(agentId, mode)
    this.assertManagedStorePath(target)
    this.assertAvailable(target)
    this.assertNoActiveCalls(target)
    mkdirSync(path.dirname(target), { recursive: true })
    const staging = path.join(path.dirname(target), `.index-${randomUUID()}`)
    mkdirSync(staging)
    const temporary = path.join(staging, path.basename(target))
    let replacement: TriviumDBType | undefined
    const previous = path.join(staging, '.previous')
    const movedOld: string[] = []
    const movedNew: string[] = []
    let preserveStaging = false
    let phase = 'build'
    let operationPath = temporary
    try {
      replacement = new TriviumDB(temporary, {
        dim: dimension,
        dtype: 'f32',
        syncMode: 'normal',
        payloadCacheMb: 32,
        payloadCacheEntryMb: 4,
      })
      populate(replacement)
      replacement.buildTextIndex()
      replacement.flush()
      phase = 'close-candidate'
      replacement.close()
      replacement = undefined
      writeFileSync(`${temporary}.dimension`, String(dimension), 'utf8')
      const cached = this.stores.get(target)
      phase = 'close-active'
      operationPath = target
      try {
        cached?.close()
      } finally {
        this.stores.delete(target)
        this.activeCalls.delete(target)
        this.textIndexDirty.delete(target)
        this.descriptions.delete(target)
      }
      mkdirSync(previous)
      try {
        phase = 'publish'
        // 旧文件组先移入同盘回滚区，新库发布并验证成功后才删除。
        for (const file of triviumFiles(target)) {
          operationPath = file
          renameSync(file, path.join(previous, path.basename(file)))
          movedOld.push(file)
        }
        for (const file of triviumFiles(temporary)) {
          operationPath = file
          const published = path.join(path.dirname(target), path.basename(file))
          renameSync(file, published)
          movedNew.push(published)
        }
        phase = 'validate'
        operationPath = target
        const reader = new TriviumDB(target, {
          dim: dimension,
          accessMode: 'readOnly',
          autoBuildQuiver: false,
          missingIndexPolicy: 'fallback',
          payloadCacheMb: 8,
        })
        try {
          if (reader.dim() !== dimension) throw new Error('重建文件组的向量维度校验失败')
        } finally {
          reader.close()
        }
        phase = 'cleanup'
        this.discardUpgradeBackup(target, staging)
      } catch (error) {
        try {
          for (const file of movedNew) rmSync(file, { force: true })
          for (const file of movedOld) renameSync(path.join(previous, path.basename(file)), file)
        } catch (rollbackError) {
          preserveStaging = true
          throw new StoreOperationError(
            {
              code: 'STORE_ROLLBACK_FAILED',
              phase: 'rollback',
              path: staging,
              message: __t('server.index-maintenance', '数据库维护未完成，阶段：{0}，路径：{1}', [
                'rollback',
                staging,
              ]),
              causes: [storeDiagnostic(error, phase), storeDiagnostic(rollbackError, 'rollback')],
            },
            new AggregateError([error, rollbackError]),
          )
        }
        throw error
      }
    } catch (error) {
      if (error instanceof StoreOperationError) throw error
      throw new StoreOperationError(
        {
          code: 'STORE_REBUILD_FAILED',
          phase,
          path: operationPath,
          message: __t('server.index-maintenance', '数据库维护未完成，阶段：{0}，路径：{1}', [
            phase,
            operationPath,
          ]),
          causes: [storeDiagnostic(error, phase)],
        },
        error,
      )
    } finally {
      // 附带关闭、暂存清理的错误单独保留，避免覆盖最初的发布或回滚错误。
      try {
        replacement?.close()
      } catch (error) {
        this.warnStore(target, error, 'close-candidate')
      }
      if (!preserveStaging && path.dirname(staging) === path.dirname(target)) {
        try {
          rmSync(staging, { recursive: true, force: true })
        } catch (error) {
          this.warnStore(target, error, 'cleanup')
        }
      }
    }
  }

  /** 社交节点不做 Embedding，保留全部摘要、关键词与关系，只重建零向量和索引。 */
  exportSocialBackup(
    agentId: string,
  ): Array<{ id: number; agent_id: string; payload_json: string; edges_json: string }> {
    const target = this.resolveAgentStorePath(agentId, 'social')
    if (!existsSync(target) && !this.stores.has(target)) return []
    const store = this.getAgentStore(agentId, 'social')
    const ids = new Set(store.allNodeIds())
    return [...ids].flatMap((id) => {
      const node = store.get(id)
      return node
        ? [
            {
              id,
              agent_id: agentId,
              payload_json: JSON.stringify(node.payload),
              edges_json: JSON.stringify(node.edges.filter((edge) => ids.has(edge.targetId))),
            },
          ]
        : []
    })
  }

  /** 社交摘要只存在于 TDB；逻辑导入保留特征哈希 ID，并对摘要与关系同步重映射。 */
  importSocialBackup(
    agentId: string,
    rows: Array<{ id: number; payload_json: string; edges_json: string }>,
    mode: 'skip' | 'replace' | 'duplicate',
    importId: string,
  ): void {
    type Edge = { targetId: number; label: string; weight: number }
    type Payload = Record<string, unknown> & { type?: string; content?: string }
    const old = mode === 'replace' ? [] : this.exportSocialBackup(agentId)
    const nodes = new Map<number, { payload: Payload; edges: Edge[] }>(
      old.map((row) => [
        row.id,
        { payload: JSON.parse(row.payload_json), edges: JSON.parse(row.edges_json) },
      ]),
    )
    const remap = new Map<number, number>()
    // 新摘要使用 u32 区间外的 ID，避免与社交 Scorer 的时间 ID 和特征哈希碰撞。
    let next = 2 ** 32
    for (const id of nodes.keys()) next = Math.max(next, id)
    const clean = (payload: Payload) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith('_backup'))),
      )
    const existing = new Map<string, number>(
      [...nodes].map(([id, node]) => [clean(node.payload), id]),
    )
    const retried = new Map<number, number>()
    for (const [id, node] of nodes)
      if (
        node.payload._backupImportId === importId &&
        typeof node.payload._backupSourceNodeId === 'number'
      )
        retried.set(node.payload._backupSourceNodeId, id)
    const incoming = rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload_json) as Payload,
      edges: JSON.parse(row.edges_json) as Edge[],
    }))
    for (const row of incoming) {
      row.payload.agentId = agentId
      if (row.payload.type === 'feature') {
        delete row.payload.agentId
        const previous = nodes.get(row.id)
        if (
          previous &&
          (previous.payload.type !== 'feature' || previous.payload.content !== row.payload.content)
        )
          throw new Error('BACKUP_SOCIAL_FEATURE_CONFLICT')
        remap.set(row.id, row.id)
        if (!previous) nodes.set(row.id, { payload: row.payload, edges: [] })
        continue
      }
      const retry = retried.get(row.id)
      const duplicate = mode === 'skip' ? existing.get(clean(row.payload)) : undefined
      const id = retry ?? duplicate ?? ++next
      if (!Number.isSafeInteger(id)) throw new Error('BACKUP_RECORD_LIMIT')
      remap.set(row.id, id)
      if (!nodes.has(id))
        nodes.set(id, {
          payload: { ...row.payload, _backupImportId: importId, _backupSourceNodeId: row.id },
          edges: [],
        })
    }
    for (const row of incoming) {
      const node = nodes.get(remap.get(row.id)!)!
      for (const edge of row.edges) {
        const targetId = remap.get(edge.targetId)
        if (
          targetId !== undefined &&
          !node.edges.some((item) => item.targetId === targetId && item.label === edge.label)
        )
          node.edges.push({ ...edge, targetId })
      }
    }
    this.replaceAgentStore(agentId, 'social', (store) => {
      const vector = new Array(this.dim).fill(0)
      for (const [id, node] of nodes) {
        store.insertWithId(id, vector, node.payload)
        if (typeof node.payload.content === 'string') {
          if (node.payload.type === 'feature') store.indexKeyword(id, node.payload.content)
          else store.indexText(id, node.payload.content)
        }
      }
      for (const [id, node] of nodes)
        for (const edge of node.edges)
          if (nodes.has(edge.targetId)) store.link(id, edge.targetId, edge.label, edge.weight)
    })
  }

  /** 社交节点不做 Embedding，保留全部摘要、关键词与关系，只重建零向量和索引。 */
  rebuildSocialStore(agentId: string, dimension = this.dim): number {
    const target = this.resolveAgentStorePath(agentId, 'social')
    this.assertManagedStorePath(target)
    this.assertAvailable(target)
    this.assertNoActiveCalls(target)
    if (!existsSync(target) && !this.stores.has(target)) return 0
    const cached = this.stores.get(target)
    if (!cached) this.prepareLegacyStore(target)
    // 重建前允许引擎恢复未落盘的 WAL，避免把可恢复的社交摘要当成缺失数据。
    const source =
      cached ??
      new TriviumDB(target, {
        dim: this.describeStore(target).dimension ?? this.dim,
        accessMode: 'readWrite',
        missingIndexPolicy: 'fallback',
        payloadCacheMb: 32,
        payloadCacheEntryMb: 4,
      })
    let nodes: Array<NonNullable<ReturnType<TriviumDBType['get']>>>
    try {
      nodes = source
        .allNodeIds()
        .map((id) => source.get(id))
        .filter((node): node is NonNullable<typeof node> => node !== null && node !== undefined)
    } finally {
      if (!cached) source.close()
    }
    this.replaceAgentStore(
      agentId,
      'social',
      (store) => {
        const vector = new Array(dimension).fill(0)
        const ids = new Set(nodes.map((node) => node.id))
        for (const node of nodes) {
          store.insertWithId(node.id, vector, node.payload)
          const payload = node.payload as { type?: string; content?: string }
          if (typeof payload?.content === 'string') {
            if (payload.type === 'feature') store.indexKeyword(node.id, payload.content)
            else store.indexText(node.id, payload.content)
          }
        }
        for (const node of nodes)
          for (const edge of node.edges) {
            if (ids.has(edge.targetId)) store.link(node.id, edge.targetId, edge.label, edge.weight)
          }
      },
      dimension,
    )
    return nodes.length
  }

  /** 安全关闭所有 Store，强制落盘 */
  flushAll(): void {
    for (const [tdbPath, store] of this.stores) {
      try {
        store.flush()
        logger.debug(__t('logs.repositories', 'Store 已落盘: {0}', [tdbPath]))
      } catch (err) {
        logger.warn(__t('logs.repositories', 'Store 落盘失败: {0}', [tdbPath]), { error: err })
      }
    }
  }

  /**
   * 预热所有 Store 的文本索引
   *
   * indexText() 替换对应节点的完整正文；buildTextIndex() 提前预热关键词自动机。
   * 应由 KernelScheduler 周期计划定期触发。
   */
  rebuildAllTextIndexes(): void {
    for (const [tdbPath, store] of this.stores) {
      try {
        store.buildTextIndex()
        this.textIndexDirty.set(tdbPath, false)
        logger.debug(__t('logs.repositories', '文本索引已重编译: {0}', [tdbPath]))
      } catch (err) {
        logger.warn(__t('logs.repositories', '文本索引重编译失败: {0}', [tdbPath]), { error: err })
      }
    }
  }

  /**
   * 标记某 Store 的文本索引为脏（indexText 后调用）
   *
   * AIOS 第八阶段：修复主 Agent BM25 索引从未编译的 bug。
   * 多字段正文应合并后一次 indexText()，后续调用会替换旧正文；关键词查询也可按需编译。
   * 此方法仅设置脏标记，实际编译延迟到 ensureTextIndexReady() 时执行。
   */
  markTextIndexDirty(tdbPath: string): void {
    this.textIndexDirty.set(tdbPath, true)
  }

  /**
   * 确保文本索引已预热（searchHybrid 前调用）
   *
   * 如果预热标记为 true，先执行 buildTextIndex() 再返回 Store。
   * 正文由 indexText() 替换；这里提前编译关键词自动机，并将延期加载或预算错误传给调用方。
   */
  ensureTextIndexReady(agentId: string, source: string): TriviumDBType {
    // 复用 getStoreBySource 的路由逻辑拿到 tdbPath
    const tdbPath = this.resolveStorePathBySource(agentId, source)
    const store = this.getOrCreate(tdbPath)

    if (this.textIndexDirty.get(tdbPath)) {
      try {
        store.buildTextIndex()
        this.textIndexDirty.set(tdbPath, false)
        logger.debug(__t('logs.repositories', '文本索引懒编译完成: {0}', [tdbPath]))
      } catch (err) {
        logger.warn(__t('logs.repositories', '文本索引懒编译失败: {0}', [tdbPath]), { error: err })
        throw err
      }
    }
    return store
  }

  /**
   * 根据来源解析 Store 文件路径（仅供内部脏标记机制使用）
   */
  private resolveStorePathBySource(agentId: string, source: string): string {
    switch (source) {
      case 'social':
        return this.resolveAgentStorePath(agentId, 'social')
      default:
        return this.resolveAgentStorePath(agentId, 'main')
    }
  }

  /**
   * 获取所有 Store 的运行时统计 (admin 监控用)
   *
   * 利用 TriviumDB 的 estimatedMemory() 和 nodeCount() API。
   */
  getStoreStats(): Array<{ path: string; nodeCount: number; memoryMB: number }> {
    const stats: Array<{ path: string; nodeCount: number; memoryMB: number }> = []
    for (const [tdbPath, store] of this.stores) {
      try {
        stats.push({
          path: tdbPath,
          nodeCount: store.nodeCount(),
          memoryMB: Math.round((store.estimatedMemory() / 1024 / 1024) * 100) / 100,
        })
      } catch {
        stats.push({ path: tdbPath, nodeCount: -1, memoryMB: -1 })
      }
    }
    return stats
  }

  /** 统计现有物理 Store 的节点总数，不为缺失的 Store 创建空文件。 */
  countExistingNodes(agentIds: string[]): number {
    const paths = new Set<string>([this.resolveSharedStorePath('facts')])
    for (const agentId of agentIds) {
      paths.add(this.resolveAgentStorePath(agentId, 'main'))
      paths.add(this.resolveAgentStorePath(agentId, 'social'))
    }

    let total = 0
    for (const tdbPath of paths) {
      const openedStore = this.stores.get(tdbPath)
      if (!openedStore && !existsSync(tdbPath)) continue
      try {
        total += (openedStore ?? this.getOrCreate(tdbPath)).nodeCount()
      } catch (error) {
        logger.warn(__t('logs.repositories', 'Store 节点统计失败: {0}', [tdbPath]), { error })
      }
    }
    return total
  }

  /** 清空指定 Agent 的物理 Store；关闭缓存实例后删除文件，下次访问会创建空库。 */
  resetAgentStore(agentId: string, mode: StoreMode): void {
    const tdbPath = this.resolveAgentStorePath(agentId, mode)
    this.assertManagedStorePath(tdbPath)
    this.assertAvailable(tdbPath)
    this.assertNoActiveCalls(tdbPath)
    this.descriptions.delete(tdbPath)
    const store = this.stores.get(tdbPath)
    if (store) {
      try {
        store.close()
      } finally {
        this.stores.delete(tdbPath)
        this.activeCalls.delete(tdbPath)
      }
    }
    this.textIndexDirty.delete(tdbPath)
    this.removeStoreFiles(tdbPath)
    logger.info(
      __t('logs.repositories', 'Agent Store 已清空: agent={0}, mode={1}', [agentId, mode]),
    )
  }

  /** 清空共享 Store；下次访问时创建空库。 */
  resetSharedStore(kind: SharedStoreKind): void {
    const tdbPath = this.resolveSharedStorePath(kind)
    this.assertManagedStorePath(tdbPath)
    this.assertAvailable(tdbPath)
    this.assertNoActiveCalls(tdbPath)
    this.descriptions.delete(tdbPath)
    const store = this.stores.get(tdbPath)
    if (store) {
      try {
        store.close()
      } finally {
        this.stores.delete(tdbPath)
        this.activeCalls.delete(tdbPath)
      }
    }
    this.textIndexDirty.delete(tdbPath)
    this.removeStoreFiles(tdbPath)
    logger.info(__t('logs.repositories', '共享 Store 已清空: kind={0}', [kind]))
  }

  /** 获取或创建 TriviumDB 实例 */
  private getOrCreate(tdbPath: string): TriviumDBType {
    this.assertAvailable(tdbPath)
    let store = this.stores.get(tdbPath)
    if (store) return store
    this.assertManagedStorePath(tdbPath)

    // 确保目录存在
    const dir = path.dirname(tdbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const dimensionPath = this.dimensionPath(tdbPath)
    if (existsSync(tdbPath) && existsSync(dimensionPath)) {
      const storedDimension = Number(readFileSync(dimensionPath, 'utf8'))
      if (storedDimension !== this.dim) {
        throw new Error(`向量Store维度不匹配: store=${storedDimension}, config=${this.dim}`)
      }
    }
    logger.info(__t('logs.repositories', '打开 TriviumDB Store: {0}', [tdbPath]))
    this.prepareLegacyStore(tdbPath)
    store = new TriviumDB(tdbPath, {
      dim: this.dim,
      dtype: 'f32',
      syncMode: 'normal',
      storageMode: 'mmap',
      autoBuildQuiver: true,
      loadTextIndex: true,
      memoryLimitMb: 512,
      payloadCacheMb: 32,
      payloadCacheEntryMb: 4,
      accessMode: 'readWrite',
      missingIndexPolicy: 'fallback',
    })
    try {
      if (store.dim() !== this.dim) {
        const actual = store.dim()
        throw new Error(
          `向量库维度不匹配：库为 ${actual} 维，当前配置为 ${this.dim} 维，请重建索引`,
        )
      }
      writeFileSync(dimensionPath, String(this.dim), 'utf8')

      // 从权威 Payload 补齐社交正文与显式关键词；新版重复关键词登记保持幂等。
      if (path.basename(tdbPath) === 'social.tdb') {
        for (const id of store.allNodeIds()) {
          const payload = store.get<{ type?: string; content?: string }>(id)?.payload
          if (typeof payload?.content !== 'string') continue
          if (payload.type === 'feature') store.indexKeyword(id, payload.content)
          else if (payload.type === 'event') store.indexText(id, payload.content)
        }
        store.buildTextIndex()
      }

      // 定时压缩仍由引擎托管；内存预算已在打开前传入，避免初始化峰值越界。
      store.enableAutoCompaction(300) // 每 5 分钟自动压缩落盘
      const view = this.guardedStore(tdbPath, store)
      this.stores.set(tdbPath, view)
      return view
    } catch (error) {
      // 新版文本预热会传播损坏与预算错误；初始化失败仍需释放原生句柄和 Writer 锁。
      this.stores.delete(tdbPath)
      this.activeCalls.delete(tdbPath)
      try {
        store.close()
      } catch (closeError) {
        logger.warn(__t('logs.repositories', 'Store 关闭失败: {0}', [tdbPath]), {
          error: closeError,
        })
      }
      throw error
    }
  }
}
