import { t as __t } from '../../lib/i18n'
/**
 * ThemeService — 自定义主题的读取、导入与删除
 *
 * 主题存放在 `@data/themes/<id>/`，每个主题是一个文件夹（theme.json + theme.css + 资源文件）。
 * 用户可以直接把文件夹放进去，也可以通过设置页导入 ZIP。
 * 读取文件时只开放白名单内的类型；按真实路径校验，主题文件夹不能越出主题库，文件不能越出主题文件夹。
 *
 * @module packages/backend/src/services/theme/themeService
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { unzipSync } from 'fflate'
import {
  CUSTOM_THEME_FILE_TYPES,
  CUSTOM_THEME_LIMITS,
  CUSTOM_THEME_MANIFEST,
  CUSTOM_THEME_STYLESHEET,
  isCustomThemeId,
  normalizeCustomThemeManifest,
  toCustomThemeId,
  type CustomThemeSummary,
} from '@infos/shared'
import { AppError } from '../../lib/appError'
import { createLogger } from '../../lib/logger'
import { packagePath } from '../../packages/packageFiles'

const logger = createLogger('ThemeService')

/** Windows 上杀毒或索引程序短暂占用文件夹时改名会失败，稍后重试即可。 */
const RENAME_RETRIES = 5
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** 覆盖导入时原主题的备份文件夹：`.backup.<主题 ID>.<随机串>`；主题 ID 不含点号。 */
const BACKUP_PATTERN = /^\.backup\.([a-z0-9][a-z0-9_-]{0,63})\.[0-9a-f]+$/
const RETIRED_PATTERN = /^\.retired\.([a-z0-9][a-z0-9_-]{0,63})\.[0-9a-f]+$/

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= RENAME_RETRIES || !BUSY_CODES.has(code)) throw error
      await delay(attempt * 20)
    }
  }
}

/** child 是否位于 parent 之内（不含 parent 自身）；两者都应是真实路径。 */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/** 角色以 base64 传入的资源文件，路径相对主题文件夹。 */
export interface ThemeAssetInput {
  path: string
  base64: string
}

export interface ThemeWriteOptions {
  /** 新增或覆盖的资源文件；未提到的已有资源保留。 */
  assets?: ThemeAssetInput[]
  /** 要删除的已有资源文件路径；不存在的路径忽略。 */
  removeAssets?: string[]
}

export interface ThemeWriteResult {
  theme: CustomThemeSummary
  created: boolean
  /** 本次写入的资源文件及解码后的字节数。 */
  assets: { path: string; bytes: number }[]
  /** 本次实际删除的资源文件。 */
  removedAssets: string[]
}

/** 严格的 base64：只允许标准字母表与结尾补位；换行等空白先去掉。 */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export class ThemeService {
  /** 按主题 ID 串行化导入、删除与备份恢复，避免同一主题文件夹被并发改写。 */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly root: string) {}

  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const current = previous.then(work)
    const settled = current.catch(() => undefined)
    this.locks.set(id, settled)
    try {
      return await current
    } finally {
      if (this.locks.get(id) === settled) this.locks.delete(id)
    }
  }

  get folder(): string {
    return this.root
  }

  /** 列出有效主题：文件夹名合法且包含 theme.css；theme.json 缺失或损坏时用文件夹名作名称。 */
  async list(): Promise<CustomThemeSummary[]> {
    if (!existsSync(this.root)) return []
    await this.recoverBackups()
    const themes: CustomThemeSummary[] = []
    for (const id of readdirSync(this.root)) {
      if (!isCustomThemeId(id)) continue
      try {
        const dir = this.ownedDir(id)
        if (!dir || !this.ownedFile(dir, CUSTOM_THEME_STYLESHEET)) continue
        themes.push(await this.summary(id, dir))
      } catch (error) {
        logger.warn(__t('logs.theme', '主题无法读取，已跳过: {0} — {1}', [id, String(error)]))
      }
    }
    return themes.sort((left, right) => left.name.localeCompare(right.name))
  }

  private async summary(id: string, dir: string): Promise<CustomThemeSummary> {
    return { id, ...normalizeCustomThemeManifest(await this.readManifest(dir), id) }
  }

  private async readManifest(dir: string): Promise<unknown> {
    const bytes = await this.readOwnedFile(dir, CUSTOM_THEME_MANIFEST)
    if (!bytes) return undefined
    if (bytes.length > CUSTOM_THEME_LIMITS.manifest) return undefined
    try {
      return JSON.parse(bytes.toString('utf-8'))
    } catch {
      return undefined
    }
  }

  /**
   * 主题文件夹的真实路径，必须位于主题库的真实路径之内；
   * 文件夹本身是指向主题库外的目录联接或符号链接时视为不存在。
   */
  private ownedDir(id: string): string | undefined {
    if (!isCustomThemeId(id)) return undefined
    try {
      const entry = path.join(this.root, id)
      // 主题根不接受别名，否则按 ID 加锁无法覆盖同一真实目录的另一入口。
      if (lstatSync(entry).isSymbolicLink()) return undefined
      const dir = realpathSync(entry)
      return isInside(realpathSync(this.root), dir) && statSync(dir).isDirectory() ? dir : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 主题文件夹内文件的真实路径。packagePath 只校验路径字符串，
   * 这里再按真实路径确认文件仍在主题文件夹内，且是普通文件。
   */
  private ownedFile(dir: string, relative: string): string | undefined {
    try {
      const file = realpathSync(packagePath(dir, relative))
      return isInside(dir, file) && statSync(file).isFile() ? file : undefined
    } catch {
      return undefined
    }
  }

  /** 打开后核对文件身份与归属，再从同一句柄读取；路径被替换也不能重定向读取。 */
  private async readOwnedFile(dir: string, relative: string): Promise<Buffer | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const file = this.ownedFile(dir, relative)
      if (!file) return undefined
      const expected = statSync(file, { bigint: true })
      handle = await open(file, 'r')
      const actual = await handle.stat({ bigint: true })
      if (
        !actual.isFile() ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        realpathSync(dir) !== dir ||
        !isInside(realpathSync(this.root), dir) ||
        this.ownedFile(dir, relative) !== file
      )
        return undefined
      return await handle.readFile()
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return undefined
      throw error
    } finally {
      await handle?.close()
    }
  }

  private themeDir(id: string): string {
    const dir = this.ownedDir(id)
    if (!dir)
      throw new AppError('NOT_FOUND', {
        message: __t('server.theme', '主题不存在: {0}', [id]),
        data: { themeId: id },
      })
    return dir
  }

  /** 读取主题文件夹中的文件（theme.css、图片、字体）。 */
  async readFile(id: string, relative: string): Promise<{ bytes: Buffer; mime: string }> {
    const dir = this.themeDir(id)
    const mime = CUSTOM_THEME_FILE_TYPES[path.extname(relative).toLowerCase()]
    const file = mime ? this.ownedFile(dir, relative) : undefined
    if (!mime || !file)
      throw new AppError('NOT_FOUND', {
        message: __t('server.theme', '主题文件不存在: {0}', [relative]),
        data: { themeId: id, file: relative },
      })
    const bytes = await this.readOwnedFile(dir, relative)
    if (!bytes)
      throw new AppError('NOT_FOUND', {
        message: __t('server.theme', '主题文件不存在: {0}', [relative]),
        data: { themeId: id, file: relative },
      })
    return { bytes, mime }
  }

  /**
   * 待恢复和已提交待清理采用不同名称；无法判定的多份历史备份全部保留。
   * 每个主题在自己的锁内处理，不与进行中的导入冲突。
   */
  private async recoverBackups(): Promise<void> {
    const ids = new Set(
      readdirSync(this.root).flatMap((name) => {
        const id = (BACKUP_PATTERN.exec(name) ?? RETIRED_PATTERN.exec(name))?.[1]
        return id ? [id] : []
      }),
    )
    for (const id of ids) await this.exclusive(id, () => this.recoverId(id))
  }

  private backupNames(id: string, retired = false): string[] {
    if (!existsSync(this.root)) return []
    const pattern = retired ? RETIRED_PATTERN : BACKUP_PATTERN
    return readdirSync(this.root).filter((name) => pattern.exec(name)?.[1] === id)
  }

  /** 调用者持有 ID 锁；绝不因目标存在便销毁没有提交状态的备份。 */
  private async recoverId(id: string): Promise<void> {
    for (const name of this.backupNames(id, true))
      await rm(path.join(this.root, name), { recursive: true, force: true }).catch(() => undefined)
    const names = this.backupNames(id)
    if (!names.length) return
    const backup = path.join(this.root, names[0]!)
    try {
      if (
        names.length !== 1 ||
        existsSync(path.join(this.root, id)) ||
        lstatSync(backup).isSymbolicLink()
      )
        throw new Error('AMBIGUOUS_THEME_BACKUP')
      await renameWithRetry(backup, path.join(this.root, id))
      logger.info(__t('logs.theme', '已从备份恢复主题: {0}', [id]))
    } catch (error) {
      logger.warn(
        __t('logs.theme', '主题备份处理失败: {0}，备份位置: {1} — {2}', [
          id,
          names.join(', '),
          String(error),
        ]),
      )
    }
  }

  /**
   * 导入主题 ZIP。主题 ID 取 ZIP 内唯一的顶层文件夹名，没有时取 ZIP 文件名。
   * 已存在同名主题时，`replace` 为真才覆盖，否则返回 ALREADY_EXISTS。
   */
  async import(bytes: Uint8Array, fileName: string, replace: boolean): Promise<CustomThemeSummary> {
    const invalid = (message: string) => new AppError('VALIDATION_ERROR', { message })
    if (!bytes.length || bytes.length > CUSTOM_THEME_LIMITS.archive)
      throw invalid(__t('server.theme', '主题包为空或超过 20MB'))
    let expanded = 0
    let count = 0
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(bytes, {
        filter: (entry) => {
          if (
            ++count > CUSTOM_THEME_LIMITS.files ||
            (expanded += Math.max(0, entry.originalSize)) > CUSTOM_THEME_LIMITS.expanded
          )
            throw new Error('THEME_SIZE_LIMIT')
          // macOS 打包时附带的 __MACOSX 资源分支不是主题内容。
          return !entry.name.endsWith('/') && !entry.name.startsWith('__MACOSX/')
        },
      })
    } catch (error) {
      throw invalid(
        String(error).includes('THEME_SIZE_LIMIT')
          ? __t('server.theme', '主题包解压后超过 64MB 或文件过多')
          : __t('server.theme', '无法读取主题包，请确认是 ZIP 文件'),
      )
    }
    const names = Object.keys(entries)
    const tops = new Set(names.map((name) => name.split('/')[0]))
    const nested =
      tops.size === 1 && names.every((name) => name.includes('/')) ? `${[...tops][0]}/` : ''
    if (!entries[`${nested}${CUSTOM_THEME_STYLESHEET}`])
      throw invalid(__t('server.theme', '主题包缺少 theme.css'))
    if (entries[`${nested}${CUSTOM_THEME_STYLESHEET}`]!.length > CUSTOM_THEME_LIMITS.stylesheet)
      throw invalid(__t('server.theme', 'theme.css 不能超过 1MB'))
    // 名称全是中文等情况下得不到合法 ID，改用随机 ID；显示名称以 theme.json 为准。
    const id =
      toCustomThemeId(nested ? nested.slice(0, -1) : fileName.replace(/\.zip$/i, '')) ||
      `theme-${randomUUID().slice(0, 8)}`
    const target = path.join(this.root, id)
    // 存在检查、替换与结果读取在同一把锁内完成；同一主题的删除也使用这把锁。
    const theme = await this.exclusive(id, async () => {
      await this.recoverId(id)
      if ((existsSync(target) || this.backupNames(id).length) && !replace)
        throw new AppError('ALREADY_EXISTS', {
          message: __t('server.theme', '已存在同名主题: {0}', [id]),
          data: { themeId: id },
        })
      if (this.backupNames(id).length)
        throw new AppError('INTERNAL_ERROR', {
          message: __t('server.theme', '主题备份状态不明确，请先检查备份文件夹'),
          data: { themeId: id, backups: this.backupNames(id) },
        })
      // 不能通过替换别名操作另一个主题；悬空联接也应拒绝。
      try {
        if (lstatSync(target).isSymbolicLink()) this.themeDir(id)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }

      // 先解压到临时文件夹，全部成功后再替换，避免中途失败留下半个主题。
      mkdirSync(this.root, { recursive: true })
      const staging = path.join(this.root, `.import-${randomUUID()}`)
      try {
        for (const [name, content] of Object.entries(entries)) {
          const relative = name.slice(nested.length)
          let file: string
          try {
            file = packagePath(staging, relative)
          } catch {
            throw invalid(__t('server.theme', '主题包含有不安全的路径: {0}', [relative]))
          }
          // 不支持的文件类型直接跳过，例如说明文档或源文件。
          if (
            relative !== CUSTOM_THEME_MANIFEST &&
            !CUSTOM_THEME_FILE_TYPES[path.extname(file).toLowerCase()]
          )
            continue
          await mkdir(path.dirname(file), { recursive: true })
          await writeFile(file, content, { flag: 'wx' })
        }
        await this.swap(id, staging, target)
      } catch (error) {
        await rm(staging, { recursive: true, force: true })
        throw error
      }
      const dir = this.ownedDir(id)
      if (!dir || !this.ownedFile(dir, CUSTOM_THEME_STYLESHEET))
        throw invalid(__t('server.theme', '主题包缺少 theme.css'))
      return this.summary(id, dir)
    })
    logger.info(__t('logs.theme', '已导入主题: {0}', [id]))
    return theme
  }

  /**
   * 把解压好的临时文件夹换到目标位置。覆盖时原主题先改名为备份，新主题就位后再删除备份；
   * 就位失败则把备份移回。改名遇到短暂占用时有界重试；移回仍失败时保留备份（下次读取主题列表时自动恢复），
   * 记录主题 ID 与备份位置，并返回同时带有两次错误的明确错误。
   */
  private async swap(id: string, staging: string, target: string): Promise<void> {
    const backup = existsSync(target)
      ? path.join(this.root, `.backup.${id}.${randomUUID().replace(/-/g, '')}`)
      : ''
    const retired = backup
      ? path.join(this.root, path.basename(backup).replace('.backup.', '.retired.'))
      : ''
    if (backup) await renameWithRetry(target, backup)
    try {
      await renameWithRetry(staging, target)
      // 提交点：只有改名成功的 retired 才允许自动删除，备份本身始终表示待恢复。
      if (backup) await renameWithRetry(backup, retired)
    } catch (error) {
      if (!backup) throw error
      try {
        // 提交标记改名失败时，先撤回刚就位的新目录，再恢复旧版本。
        if (existsSync(target)) await renameWithRetry(target, staging)
        await renameWithRetry(backup, target)
      } catch (restoreError) {
        logger.warn(
          __t('logs.theme', '主题备份处理失败: {0}，备份位置: {1} — {2}', [
            id,
            backup,
            `${String(error)}; ${String(restoreError)}`,
          ]),
        )
        throw new AppError('INTERNAL_ERROR', {
          message: __t(
            'server.theme',
            '替换主题失败，原主题已保留在备份文件夹 {0}，重新读取主题列表时会自动恢复',
            [backup],
          ),
          data: { themeId: id, backup },
          cause: new AggregateError([error, restoreError]),
        })
      }
      throw error
    }
    // 新主题已就位；备份删不掉（例如被占用）时留给下次读取主题列表时清理。
    if (retired) await rm(retired, { recursive: true, force: true }).catch(() => undefined)
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      // 删备份失败就不报告删除成功，避免随后恢复撤销删除。
      await this.recoverId(id)
      const target = this.themeDir(id)
      for (const name of [...this.backupNames(id), ...this.backupNames(id, true)])
        await rm(path.join(this.root, name), { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    })
    logger.info(__t('logs.theme', '已删除主题: {0}', [id]))
  }

  /** 读取主题源文件文本（阶段 3 角色读取主题）；theme.json 缺失时为 null。 */
  async readSource(id: string): Promise<{ manifest: string | null; css: string }> {
    const dir = this.themeDir(id)
    const manifest = (await this.readOwnedFile(dir, CUSTOM_THEME_MANIFEST))?.toString('utf-8') ?? null
    const css = (await this.readFile(id, CUSTOM_THEME_STYLESHEET)).bytes.toString('utf-8')
    return { manifest, css }
  }

  /**
   * 写入（新建或覆盖）主题的 theme.json 与 theme.css，与手动导入的主题放在同一位置。
   * 可同时以 base64 写入图片、字体资源（类型白名单、路径规则与 ZIP 导入相同），
   * 或删除已有资源；未提到的已有资源保留，同路径的资源被覆盖。
   * 全部参数校验通过后才动磁盘：先把每个文件写成同目录临时文件，全部写好再逐个改名，
   * 写临时文件失败时清理临时文件和新建的文件夹，原主题保持不变。
   */
  write(
    id: string,
    manifest: unknown,
    css: string,
    options: ThemeWriteOptions = {},
  ): Promise<ThemeWriteResult> {
    return this.exclusive(id, async () => {
      await this.recoverId(id)
      return this.writeNow(id, manifest, css, options)
    })
  }

  private async writeNow(
    id: string,
    manifest: unknown,
    css: string,
    options: ThemeWriteOptions,
  ): Promise<ThemeWriteResult> {
    const invalid = (message: string) => new AppError('VALIDATION_ERROR', { message })
    if (!isCustomThemeId(id))
      throw invalid(__t('server.theme', '主题 ID 只能包含小写字母、数字、下划线和连字符'))
    if (Buffer.byteLength(css, 'utf-8') > CUSTOM_THEME_LIMITS.stylesheet)
      throw invalid(__t('server.theme', 'theme.css 不能超过 1MB'))
    const unsafe = findUnsafeThemeUrl(css)
    if (unsafe !== undefined)
      throw invalid(__t('server.theme', 'theme.css 中的资源路径不能越出主题文件夹: {0}', [unsafe]))
    const created = !existsSync(path.join(this.root, id))
    // 主题已存在时按真实路径定位，避免目录联接或符号链接把写入带出主题库。
    const dir = created ? path.join(this.root, id) : this.themeDir(id)
    const assets = decodeThemeAssets(dir, options.assets ?? [])
    const removals = (options.removeAssets ?? []).map((relative) => ({
      relative,
      file: resolveThemeAssetPath(dir, relative),
    }))
    const written = new Set(assets.map((asset) => asset.file.toLowerCase()))
    const conflict = removals.find((item) => written.has(item.file.toLowerCase()))
    if (conflict)
      throw invalid(
        __t('server.theme', '同一个资源文件不能同时写入和删除: {0}', [conflict.relative]),
      )

    // 写入后整个主题文件夹仍须符合导入时的文件数与解压总大小限制。
    const sizes = created ? new Map<string, number>() : await folderSizes(dir)
    for (const item of removals) sizes.delete(item.file.toLowerCase())
    for (const asset of assets) sizes.set(asset.file.toLowerCase(), asset.bytes.length)
    sizes.set(path.join(dir, CUSTOM_THEME_MANIFEST).toLowerCase(), 0)
    sizes.set(path.join(dir, CUSTOM_THEME_STYLESHEET).toLowerCase(), Buffer.byteLength(css))
    const total = [...sizes.values()].reduce((sum, size) => sum + size, 0)
    if (sizes.size > CUSTOM_THEME_LIMITS.files || total > CUSTOM_THEME_LIMITS.expanded)
      throw invalid(__t('server.theme', '写入后主题文件夹超过 64MB 或文件过多'))

    const normalized = normalizeCustomThemeManifest(manifest, id)
    // 资源排在前面：先就位，最后替换 theme.css，避免样式引用尚未就位的文件。
    const files: [string, string | Buffer][] = [
      ...assets.map((asset): [string, Buffer] => [asset.file, asset.bytes]),
      [path.join(dir, CUSTOM_THEME_MANIFEST), `${JSON.stringify(normalized, null, 2)}\n`],
      [path.join(dir, CUSTOM_THEME_STYLESHEET), css],
    ]
    const staged: [string, string][] = []
    const createdDirs: string[] = []
    try {
      for (const [file, content] of files) {
        const parent = path.dirname(file)
        const made = await mkdir(parent, { recursive: true })
        if (made) createdDirs.push(made)
        // 子目录的真实路径必须仍在主题文件夹之内：目录联接或符号链接不能把写入带出主题库。
        const realDir = realpathSync(dir)
        const realParent = realpathSync(parent)
        if (realParent !== realDir && !isInside(realDir, realParent))
          throw invalid(
            __t('server.theme', '主题包含有不安全的路径: {0}', [path.relative(dir, file)]),
          )
        const temporary = `${file}.${randomUUID()}.tmp`
        staged.push([temporary, file])
        await writeFile(temporary, content)
      }
    } catch (error) {
      await Promise.all(staged.map(([temporary]) => rm(temporary, { force: true })))
      for (const made of createdDirs.reverse()) await rm(made, { recursive: true, force: true })
      throw error
    }
    // 改名失败（如文件被占用）时清理尚未改名的临时文件；已改名的文件保持新内容。
    for (const [index, [temporary, file]] of staged.entries()) {
      try {
        await rename(temporary, file)
      } catch (error) {
        await Promise.all(staged.slice(index).map(([rest]) => rm(rest, { force: true })))
        throw error
      }
    }
    // 新文件已全部就位，删除资源失败（如文件被占用）只记日志，不让整个写入报错。
    const removedAssets: string[] = []
    for (const item of removals) {
      try {
        if (!existsSync(item.file) || !statSync(item.file).isFile()) continue
        await rm(item.file, { force: true })
        removedAssets.push(item.relative)
      } catch (error) {
        logger.warn(
          __t('logs.theme', '主题资源删除失败，已保留: {0} — {1}', [item.relative, String(error)]),
        )
      }
    }
    logger.info(__t('logs.theme', '已写入主题: {0}', [id]))
    return {
      theme: { id, ...normalized },
      created,
      assets: assets.map((asset) => ({ path: asset.relative, bytes: asset.bytes.length })),
      removedAssets,
    }
  }
}

/** 找出 theme.css 中含 `..` 的相对资源路径；全部安全时返回 undefined。 */
export function findUnsafeThemeUrl(css: string): string | undefined {
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi)) {
    const value = (match[2] ?? '').trim()
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value)) continue
    if (value.split(/[?#]/)[0]!.split(/[\\/]/).includes('..')) return value
  }
  return undefined
}

/**
 * 解析资源文件路径：规则同 ZIP 导入（相对路径、不能越出主题文件夹、文件名合法），
 * 类型只限图片与字体；theme.css、theme.json 由 write 的专用参数写入，不能当作资源。
 */
function resolveThemeAssetPath(dir: string, relative: unknown): string {
  const invalid = (message: string) => new AppError('VALIDATION_ERROR', { message })
  if (typeof relative !== 'string')
    throw invalid(__t('server.theme', '主题包含有不安全的路径: {0}', [String(relative)]))
  let file: string
  try {
    file = packagePath(dir, relative)
  } catch {
    throw invalid(__t('server.theme', '主题包含有不安全的路径: {0}', [relative]))
  }
  const extension = path.extname(file).toLowerCase()
  if (extension === '.css' || !CUSTOM_THEME_FILE_TYPES[extension])
    throw invalid(
      __t('server.theme', '不支持的主题资源文件类型: {0}（只接受图片与字体，不接受 SVG）', [
        relative,
      ]),
    )
  return file
}

/** 校验并解码全部资源；任何一个不合格都整体拒绝。 */
function decodeThemeAssets(
  dir: string,
  assets: ThemeAssetInput[],
): { relative: string; file: string; bytes: Buffer }[] {
  const invalid = (message: string) => new AppError('VALIDATION_ERROR', { message })
  if (assets.length > CUSTOM_THEME_LIMITS.files)
    throw invalid(__t('server.theme', '写入后主题文件夹超过 64MB 或文件过多'))
  const seen = new Set<string>()
  return assets.map((asset) => {
    const { path: relative, base64 } = (asset ?? {}) as Partial<ThemeAssetInput>
    const file = resolveThemeAssetPath(dir, relative)
    // Windows 下路径不区分大小写，按小写判断重复。
    if (seen.has(file.toLowerCase()))
      throw invalid(__t('server.theme', '资源文件重复: {0}', [relative]))
    seen.add(file.toLowerCase())
    const compact = typeof base64 === 'string' ? base64.replace(/\s+/g, '') : ''
    if (!compact || !BASE64_PATTERN.test(compact))
      throw invalid(__t('server.theme', '资源文件不是有效的 base64: {0}', [relative]))
    // 先按编码长度判断，避免为超大输入分配内存；每 4 个字符最多 3 字节。
    if (
      (compact.length / 4) * 3 - (compact.match(/=+$/)?.[0].length ?? 0) >
      CUSTOM_THEME_LIMITS.asset
    )
      throw invalid(__t('server.theme', '单个资源文件不能超过 2MB: {0}', [relative]))
    // resolveThemeAssetPath 已确认 relative 是字符串
    return { relative: relative as string, file, bytes: Buffer.from(compact, 'base64') }
  })
}

/** 统计主题文件夹内现有文件的大小，键为小写绝对路径。 */
async function folderSizes(dir: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) sizes.set(full.toLowerCase(), (await stat(full)).size)
    }
  }
  await visit(dir)
  return sizes
}
