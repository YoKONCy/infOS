import { t as __t } from '../../lib/i18n'
/**
 * WorldbookService — 世界书书库、全局激活设置与角色绑定
 *
 * 存储布局（均位于数据目录，不进入提示词草稿与发布版本）：
 * - `@data/worldbooks/books/{id}.json`：单本世界书
 * - `@data/worldbooks/settings.json`：全局激活设置与全局启用的书
 * - `@data/worldbooks/bindings.json`：角色的主要 / 附加世界书，以及已导入的角色内嵌世界书指纹
 *
 * 提示词装配是同步流程，因此书库在内存中保持一份副本，写入时先落盘再更新内存。
 *
 * @module packages/backend/src/services/worldbook/worldbookService
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  WORLDBOOK_FILE_NAME,
  WORLDBOOK_LIMITS,
  createWorldbookSettings,
  exportWorldbookFile,
  importSillyTavernWorldbook,
  isWorldbookId,
  normalizeWorldbookBinding,
  normalizeWorldbookEntries,
  normalizeWorldbookName,
  normalizeWorldbookSettings,
  type Worldbook,
  type WorldbookActivation,
  type WorldbookBinding,
  type WorldbookChannel,
  type WorldbookEntry,
  type WorldbookSettings,
  type WorldbookSummary,
} from '@infos/shared'
import { AppError } from '../../lib/appError'
import { createLogger } from '../../lib/logger'
import {
  activateWorldbook,
  emptyWorldbookActivation,
  type WorldbookScanMessage,
  type WorldbookSource,
} from './worldbookEngine'

const logger = createLogger('WorldbookService')

/** 已导入过的角色内嵌世界书：指纹避免用户解绑后被重复导入，书 ID 用于角色删除后重新出现时复用。 */
interface BundleRecord {
  hash: string
  bookId?: string
}

/** 角色 ID 可以是 `constructor`、`__proto__` 等名字，因此用 Map 保存，不用普通对象。 */
interface Bindings {
  agents: Map<string, WorldbookBinding>
  bundles: Map<string, BundleRecord>
}

export interface WorldbookActivationRequest {
  agentId: string
  channel: WorldbookChannel
  messages: readonly WorldbookScanMessage[]
  charName: string
  userName: string
  seed: string
}

/** Windows 上杀毒或索引程序短暂占用目标文件时，改名会失败，稍后重试即可。 */
const RENAME_RETRIES = 5

/** 同一文件夹内先写临时文件再改名，避免中途失败留下半个 JSON。 */
function writeJsonAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < RENAME_RETRIES && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        // 同步短暂等待：内存副本只在落盘成功后更新，写入需在本次调用内完成。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 20)
        continue
      }
      rmSync(temp, { force: true })
      throw error
    }
  }
}

function nameKey(name: string): string {
  return name.toLocaleLowerCase()
}

export class WorldbookService {
  private readonly booksDir: string
  private readonly settingsFile: string
  private readonly bindingsFile: string
  private books = new Map<string, Worldbook>()
  private settings: WorldbookSettings = createWorldbookSettings()
  private bindings: Bindings = { agents: new Map(), bundles: new Map() }

  constructor(rootDir: string) {
    this.booksDir = path.join(rootDir, 'books')
    this.settingsFile = path.join(rootDir, 'settings.json')
    this.bindingsFile = path.join(rootDir, 'bindings.json')
  }

  /** 读取书库；损坏的单本世界书跳过并记录，不影响其他书。 */
  initialize(): void {
    mkdirSync(this.booksDir, { recursive: true })
    this.books = new Map()
    for (const file of readdirSync(this.booksDir)) {
      if (!file.endsWith('.json')) continue
      const id = file.slice(0, -'.json'.length)
      if (!isWorldbookId(id)) continue
      try {
        this.books.set(
          id,
          this.parseBook(id, JSON.parse(readFileSync(path.join(this.booksDir, file), 'utf-8'))),
        )
      } catch (error) {
        logger.warn(
          __t('logs.worldbook', '世界书文件无法读取，已跳过: {0} — {1}', [file, String(error)]),
        )
      }
    }
    this.settings = normalizeWorldbookSettings(this.readJson(this.settingsFile))
    const file = this.readJson(this.bindingsFile) as
      | { agents?: Record<string, unknown>; bundles?: Record<string, unknown> }
      | undefined
    this.bindings = { agents: new Map(), bundles: new Map() }
    for (const [agentId, binding] of Object.entries(file?.agents ?? {}))
      this.bindings.agents.set(agentId.toLowerCase(), normalizeWorldbookBinding(binding))
    for (const [agentId, value] of Object.entries(file?.bundles ?? {})) {
      // 早期文件只记录指纹字符串。
      const record = (typeof value === 'string' ? { hash: value } : value) as
        | Partial<BundleRecord>
        | undefined
      if (typeof record?.hash !== 'string') continue
      this.bindings.bundles.set(agentId.toLowerCase(), {
        hash: record.hash,
        ...(typeof record.bookId === 'string' ? { bookId: record.bookId } : {}),
      })
    }
  }

  private readJson(file: string): unknown {
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch (error) {
      logger.warn(
        __t('logs.worldbook', '世界书配置无法读取，已使用默认值: {0} — {1}', [file, String(error)]),
      )
      return undefined
    }
  }

  private parseBook(id: string, value: unknown): Worldbook {
    const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const revision = Number(source.revision)
    return {
      version: 1,
      id,
      name: normalizeWorldbookName(source.name) || id,
      revision: Number.isInteger(revision) && revision > 0 ? revision : 1,
      updatedAt:
        typeof source.updatedAt === 'string' ? source.updatedAt : new Date(0).toISOString(),
      entries: normalizeWorldbookEntries(source.entries),
    }
  }

  // ── 书库 ──

  list(): WorldbookSummary[] {
    return [...this.books.values()]
      .map((book) => ({
        id: book.id,
        name: book.name,
        entryCount: book.entries.length,
        revision: book.revision,
        updatedAt: book.updatedAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  get(bookId: string): Worldbook | undefined {
    return this.books.get(bookId)
  }

  private require(bookId: string): Worldbook {
    const book = this.books.get(bookId)
    if (!book)
      throw new AppError('NOT_FOUND', {
        message: __t('server.worldbook', '世界书不存在: {0}', [bookId]),
        data: { bookId },
      })
    return book
  }

  private validName(value: unknown, exceptId?: string): string {
    const name = normalizeWorldbookName(value)
    if (!name)
      throw new AppError('VALIDATION_ERROR', {
        message: __t('server.worldbook', '世界书名称不能为空'),
      })
    const key = nameKey(name)
    if ([...this.books.values()].some((book) => book.id !== exceptId && nameKey(book.name) === key))
      throw new AppError('DUPLICATE_NAME', {
        message: __t('server.worldbook', '已存在同名世界书: {0}', [name]),
        data: { name },
      })
    return name
  }

  private persistBook(book: Worldbook): void {
    writeJsonAtomic(path.join(this.booksDir, `${book.id}.json`), book)
    this.books.set(book.id, book)
  }

  create(input: { name: unknown; entries?: unknown }): Worldbook {
    if (this.books.size >= WORLDBOOK_LIMITS.books)
      throw new AppError('OUT_OF_RANGE', {
        message: __t('server.worldbook', '世界书数量已达上限 {0}', [WORLDBOOK_LIMITS.books]),
      })
    const name = this.validName(input.name)
    let id = ''
    do id = `wb-${randomUUID().replace(/-/g, '').slice(0, 12)}`
    while (this.books.has(id))
    const book: Worldbook = {
      version: 1,
      id,
      name,
      revision: 1,
      updatedAt: new Date().toISOString(),
      entries: normalizeWorldbookEntries(input.entries),
    }
    this.persistBook(book)
    return book
  }

  /** 保存名称与条目；修订号不一致时拒绝，避免覆盖其他窗口的修改。 */
  save(bookId: string, input: { name: unknown; entries: unknown; revision: number }): Worldbook {
    const current = this.require(bookId)
    if (input.revision !== current.revision)
      throw new AppError('CONFLICT', {
        message: __t('server.worldbook', '世界书已在其他位置被修改，请刷新后再保存'),
        data: { bookId, revision: current.revision },
      })
    const book: Worldbook = {
      ...current,
      name: this.validName(input.name, bookId),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      entries: normalizeWorldbookEntries(input.entries),
    }
    this.persistBook(book)
    return book
  }

  duplicate(bookId: string, name: unknown): Worldbook {
    return this.create({ name, entries: this.require(bookId).entries })
  }

  /** 删除世界书，并同步移出全局启用列表与所有角色绑定。 */
  remove(bookId: string): void {
    this.require(bookId)
    rmSync(path.join(this.booksDir, `${bookId}.json`), { force: true })
    this.books.delete(bookId)
    if (this.settings.globalBooks.includes(bookId))
      this.writeSettings({
        ...this.settings,
        globalBooks: this.settings.globalBooks.filter((id) => id !== bookId),
      })
    const agents = new Map(this.bindings.agents)
    let changed = false
    for (const [agentId, binding] of agents) {
      if (binding.primary !== bookId && !binding.additional.includes(bookId)) continue
      agents.set(agentId, {
        primary: binding.primary === bookId ? null : binding.primary,
        additional: binding.additional.filter((id) => id !== bookId),
      })
      changed = true
    }
    if (changed) this.writeBindings({ ...this.bindings, agents })
  }

  // ── 全局设置 ──

  getSettings(): WorldbookSettings {
    return { ...this.settings, globalBooks: [...this.settings.globalBooks] }
  }

  /**
   * 保存激活设置。未提供 `globalBooks` 时保留服务端当前的全局列表，
   * 页面只提交扫描深度与 Token 上限，避免旧页面覆盖其他窗口的增删。
   */
  saveSettings(value: unknown): WorldbookSettings {
    const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const settings = normalizeWorldbookSettings({
      ...source,
      globalBooks: source.globalBooks ?? this.settings.globalBooks,
    })
    // 已被删除的书直接剔除，避免旧页面保存时报错。
    settings.globalBooks = settings.globalBooks.filter((id) => this.books.has(id))
    this.writeSettings(settings)
    return this.getSettings()
  }

  /** 按单本增删全局世界书，多个窗口同时操作时互不覆盖。 */
  addGlobalBook(bookId: string): WorldbookSettings {
    this.require(bookId)
    if (!this.settings.globalBooks.includes(bookId)) {
      if (this.settings.globalBooks.length >= WORLDBOOK_LIMITS.books)
        throw new AppError('OUT_OF_RANGE', {
          message: __t('server.worldbook', '世界书数量已达上限 {0}', [WORLDBOOK_LIMITS.books]),
        })
      this.writeSettings({ ...this.settings, globalBooks: [...this.settings.globalBooks, bookId] })
    }
    return this.getSettings()
  }

  removeGlobalBook(bookId: string): WorldbookSettings {
    if (this.settings.globalBooks.includes(bookId))
      this.writeSettings({
        ...this.settings,
        globalBooks: this.settings.globalBooks.filter((id) => id !== bookId),
      })
    return this.getSettings()
  }

  private writeSettings(settings: WorldbookSettings): void {
    writeJsonAtomic(this.settingsFile, settings)
    this.settings = settings
  }

  // ── 角色绑定 ──

  listBindings(): Record<string, WorldbookBinding> {
    return Object.fromEntries(
      [...this.bindings.agents].map(([agentId, binding]) => [
        agentId,
        { primary: binding.primary, additional: [...binding.additional] },
      ]),
    )
  }

  getBinding(agentId: string): WorldbookBinding {
    const binding = this.bindings.agents.get(agentId.toLowerCase())
    return binding
      ? { primary: binding.primary, additional: [...binding.additional] }
      : { primary: null, additional: [] }
  }

  /**
   * 保存角色绑定。提供 `expected`（编辑前看到的绑定）时，若服务端已被其他窗口修改则拒绝（CONFLICT），
   * 避免旧窗口覆盖新的绑定。
   */
  saveBinding(agentId: string, value: unknown, expected?: unknown): WorldbookBinding {
    if (expected !== undefined) {
      const current = this.getBinding(agentId)
      const base = normalizeWorldbookBinding(expected)
      if (
        current.primary !== base.primary ||
        current.additional.join('\n') !== base.additional.join('\n')
      )
        throw new AppError('CONFLICT', {
          message: __t('server.worldbook', '角色的世界书绑定已在其他位置被修改'),
          data: { agentId, binding: current },
        })
    }
    const binding = normalizeWorldbookBinding(value)
    // 已被删除的书直接剔除，避免旧页面保存时报错。
    if (binding.primary && !this.books.has(binding.primary)) binding.primary = null
    binding.additional = binding.additional.filter((id) => this.books.has(id))
    this.writeBindings({
      ...this.bindings,
      agents: new Map(this.bindings.agents).set(agentId.toLowerCase(), binding),
    })
    return this.getBinding(agentId)
  }

  /**
   * 删除角色时清理其绑定；书库中的世界书保留。
   * 内嵌世界书记录保留，同一角色（如内置角色）重新出现时复用已导入的书，不重复导入。
   */
  removeAgent(agentId: string): void {
    const id = agentId.toLowerCase()
    if (!this.bindings.agents.has(id)) return
    const agents = new Map(this.bindings.agents)
    agents.delete(id)
    this.writeBindings({ ...this.bindings, agents })
  }

  private writeBindings(bindings: Bindings): void {
    writeJsonAtomic(this.bindingsFile, {
      agents: Object.fromEntries(bindings.agents),
      bundles: Object.fromEntries(bindings.bundles),
    })
    this.bindings = bindings
  }

  // ── 角色资源包 ──

  /** 角色导出时附带的主要世界书文件（酒馆格式）；未绑定或书已删除时返回空。 */
  exportAgentBundle(agentId: string): { path: string; contentBase64: string } | undefined {
    const primary = this.getBinding(agentId).primary
    const book = primary ? this.books.get(primary) : undefined
    if (!book) return undefined
    return {
      path: WORLDBOOK_FILE_NAME,
      contentBase64: Buffer.from(JSON.stringify(exportWorldbookFile(book), null, 2)).toString(
        'base64',
      ),
    }
  }

  /**
   * 导入角色目录中内嵌的世界书：仅在角色尚未绑定主要世界书、且该文件内容未导入过时执行。
   * 新书使用文件内名称，重名时追加序号，并绑定为该角色的主要世界书。
   * 同一份文件导入过时：用户解绑后不再导入；角色被删除后重新出现时重新绑定原来那本书。
   */
  importAgentBundle(agentId: string, agentDir: string): void {
    const id = agentId.toLowerCase()
    const file = path.join(agentDir, WORLDBOOK_FILE_NAME)
    if (!existsSync(file)) return
    try {
      const raw = readFileSync(file)
      const hash = createHash('sha256').update(raw).digest('hex')
      const record = this.bindings.bundles.get(id)
      if (record?.hash === hash) {
        if (!this.bindings.agents.has(id) && record.bookId && this.books.has(record.bookId))
          this.bind(id, record.bookId, record)
        return
      }
      const primary = this.getBinding(id).primary
      if (primary && this.books.has(primary)) {
        // 已有绑定时只记录指纹，不覆盖用户的选择。
        this.writeBindings({
          ...this.bindings,
          bundles: new Map(this.bindings.bundles).set(id, { hash }),
        })
        return
      }
      const imported = importSillyTavernWorldbook(JSON.parse(raw.toString('utf-8')))
      const book = this.create({
        name: this.availableName(imported.name || agentId),
        entries: imported.entries,
      })
      this.bind(id, book.id, { hash, bookId: book.id })
      logger.info(__t('logs.worldbook', '已导入角色内嵌世界书: {0} → {1}', [id, book.name]))
    } catch (error) {
      logger.warn(__t('logs.worldbook', '角色内嵌世界书导入失败: {0} — {1}', [id, String(error)]))
    }
  }

  /** 绑定为主要世界书并记录内嵌文件来源。 */
  private bind(agentId: string, bookId: string, record: BundleRecord): void {
    const binding = { ...this.getBinding(agentId), primary: bookId }
    binding.additional = binding.additional.filter((id) => id !== bookId)
    this.writeBindings({
      agents: new Map(this.bindings.agents).set(agentId, binding),
      bundles: new Map(this.bindings.bundles).set(agentId, record),
    })
  }

  private availableName(base: string): string {
    const name = normalizeWorldbookName(base) || 'worldbook'
    const used = new Set([...this.books.values()].map((book) => nameKey(book.name)))
    if (!used.has(nameKey(name))) return name
    for (let index = 2; ; index++) {
      const candidate = normalizeWorldbookName(`${name} (${index})`)
      if (!used.has(nameKey(candidate))) return candidate
    }
  }

  // ── 激活 ──

  /** 全局启用的书在前，其次是角色主要世界书与附加世界书；同一本书只计算一次。 */
  activate(request: WorldbookActivationRequest): WorldbookActivation {
    const binding = this.getBinding(request.agentId)
    const ids = [
      ...this.settings.globalBooks,
      ...(binding.primary ? [binding.primary] : []),
      ...binding.additional,
    ]
    const sources: WorldbookSource[] = []
    for (const id of new Set(ids)) {
      const book = this.books.get(id)
      if (book?.entries.length) sources.push({ bookId: id, entries: book.entries })
    }
    if (!sources.length) return emptyWorldbookActivation()
    return activateWorldbook(sources, this.settings, request)
  }

  /** 编辑页命中测试：只计算传入的草稿条目，按当前全局设置激活。 */
  test(input: {
    entries: WorldbookEntry[]
    text: string
    channel: WorldbookChannel
  }): WorldbookActivation {
    return activateWorldbook(
      [{ bookId: 'draft', entries: normalizeWorldbookEntries(input.entries) }],
      this.settings,
      {
        messages: [{ role: 'user', content: input.text }],
        channel: input.channel,
        charName: '{{char}}',
        userName: '{{user}}',
        seed: randomUUID(),
      },
    )
  }
}
