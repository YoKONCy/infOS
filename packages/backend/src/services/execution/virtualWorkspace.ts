/**
 * virtualWorkspace — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  mkdir,
  link,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { assertSafetyFileAccess, safetyFileAccessible } from './safetyPath'
import type { ExecutionSession } from './executionSession'

// ─────────────────────────────────────────────
// 工作区文件操作错误（带结构化错误码）
// ─────────────────────────────────────────────

/** 工作区文件操作错误码（供 ReAct 层 toolFailure 精准区分失败原因） */
export const WS_ERROR = {
  /** old_text 为空 */
  EDIT_EMPTY_OLD_TEXT: 'EDIT_EMPTY_OLD_TEXT',
  /** old_text 与 new_text 完全相同，没有任何可生效改动 */
  EDIT_NO_CHANGES: 'EDIT_NO_CHANGES',
  /** 目标文件不存在 */
  EDIT_FILE_NOT_FOUND: 'EDIT_FILE_NOT_FOUND',
  /** 二进制文件拒绝编辑 */
  EDIT_BINARY_FILE: 'EDIT_BINARY_FILE',
  /** old_text 未匹配到任何内容 */
  EDIT_NOT_FOUND: 'EDIT_NOT_FOUND',
  /** old_text 匹配次数非唯一 */
  EDIT_NOT_UNIQUE: 'EDIT_NOT_UNIQUE',
  /** expected_hash 与当前文件不一致（并发保护） */
  EDIT_HASH_MISMATCH: 'EDIT_HASH_MISMATCH',
  /** 二进制文件拒绝写入 */
  WRITE_BINARY_FILE: 'WRITE_BINARY_FILE',
  /** expected_hash 与当前文件不一致（并发保护） */
  WRITE_HASH_MISMATCH: 'WRITE_HASH_MISMATCH',
  /** 路径超出可读/可写范围 */
  PATH_OUT_OF_SCOPE: 'PATH_OUT_OF_SCOPE',
  /** 路径受保护，禁止访问 */
  PATH_PROTECTED: 'PATH_PROTECTED',
  /** 重命名目标已存在，禁止覆盖 */
  RENAME_TARGET_EXISTS: 'RENAME_TARGET_EXISTS',
  /** 文件操作目标不存在 */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** 当前操作仅允许普通文件 */
  NOT_A_FILE: 'NOT_A_FILE',
} as const

/** 工作区文件操作错误码联合类型 */
export type WorkspaceErrorCode = (typeof WS_ERROR)[keyof typeof WS_ERROR]

/**
 * 工作区文件操作错误
 *
 * 带结构化 code，工具层 catch 后可转成 toolFailure(code, message) 返回给 Agent。
 */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
  }
}

// ─────────────────────────────────────────────
// 行级 diff 统计（让 Agent 感知"真正生效"的改动）
// ─────────────────────────────────────────────

/** 单次行级读取最多返回的行数。 */
const MAX_LINE_READ_LINES = 800

/** 行级 diff LCS 计算的最大格子数（超过则退回块级近似，避免大文件全量写卡死） */
const MAX_DIFF_CELLS = 250_000

/** 行级 diff 统计结果 */
export interface LineDiffStats {
  /** 新增行数（+） */
  insertions: number
  /** 删除行数（-） */
  deletions: number
  /** 是否因规模过大退回块级近似（仅超大文件全量写时可能为 true） */
  approximate?: boolean
}

/**
 * 计算两个文本之间的行级 diff 统计（前缀/后缀收缩 + LCS）
 *
 * 语义（区别于"文本块行数"）：
 * - 修改 1 行内容 → insertions=1, deletions=1
 * - 新增 2 行 → insertions=2, deletions=0
 * - 删除 3 行 → insertions=0, deletions=3
 */
export function diffLines(oldText: string, newText: string): LineDiffStats {
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)

  // 收缩公共前缀/后缀，仅对中间差异段做 LCS，降低大文件全量写时的开销
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix)
  const newMid = newLines.slice(prefix, newLines.length - suffix)

  // 中间段无差异（纯前缀/后缀重合）
  if (oldMid.length === 0 && newMid.length === 0) {
    return { insertions: 0, deletions: 0 }
  }

  // LCS 精确统计（受格子数上限保护）
  if (oldMid.length * newMid.length <= MAX_DIFF_CELLS) {
    const lcs = longestCommonSubsequenceLength(oldMid, newMid)
    return { insertions: newMid.length - lcs, deletions: oldMid.length - lcs }
  }

  // 中间段过大：退回块级近似（行数统计依然准确，粒度变粗）
  return { insertions: newMid.length, deletions: oldMid.length, approximate: true }
}

/** 经典 DP 求 LCS 长度（仅在行数差异较小时调用，内存按较短的数组维度分配） */
function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  const dp = new Uint32Array(long.length + 1)
  for (let i = 1; i <= short.length; i += 1) {
    let prev = 0
    for (let j = 1; j <= long.length; j += 1) {
      const current = dp[j]!
      dp[j] = short[i - 1] === long[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!)
      prev = current
    }
  }
  return dp[long.length]!
}

export interface FileReadOptions {
  /** 纯只读工具可读取设备绝对路径；相对路径仍以 Workspace 为基准。 */
  deviceScope?: boolean
  offset?: number
  limit?: number
  lineStart?: number
  lineEnd?: number
  tailLines?: number
}

export interface FileReadResult {
  content: string
  encoding: 'utf-8'
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  totalBytes: number
  /** 文件总行数（Agent 感知文件整体规模） */
  totalLines: number
  hash: string
  truncated: boolean
  nextOffset?: number
  lineStart?: number
  lineEnd?: number
}

export interface GlobOptions {
  pattern: string
  cwd?: string
  /** 纯只读查找可在用户明确指定的设备目录下运行。 */
  deviceScope?: boolean
  maxDepth?: number
  limit?: number
  includeHidden?: boolean
}

/** 执行会话内的受控文件系统。 */
export class VirtualWorkspace {
  private readonly mutationQueues = new Map<string, Promise<void>>()

  /** 内置写入共享同文件队列；外部程序仍依赖提交前版本核验。 */
  async withFileMutation<T>(
    session: ExecutionSession,
    inputPath: string,
    approved: boolean | undefined,
    operation: (filePath: string) => Promise<T>,
  ): Promise<T> {
    let filePath = approved
      ? await this.resolveApprovedWritePath(inputPath)
      : await this.resolvePath(session, inputPath, 'write')
    filePath = await realpath(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return filePath
    })
    const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath
    const previous = this.mutationQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = previous.catch(() => {}).then(() => held)
    this.mutationQueues.set(key, current)
    await previous.catch(() => {})
    try {
      return await operation(filePath)
    } finally {
      release()
      if (this.mutationQueues.get(key) === current) this.mutationQueues.delete(key)
    }
  }
  async read(
    session: ExecutionSession,
    inputPath: string,
    options: FileReadOptions = {},
  ): Promise<FileReadResult> {
    const filePath = options.deviceScope
      ? await this.resolveDeviceReadPath(session, inputPath)
      : await this.resolvePath(session, inputPath, 'read')
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error(`目标不是文件: ${inputPath}`)
    const buffer = await readFile(filePath)
    if (this.looksBinary(buffer)) throw new Error('检测到二进制文件，文本读取已拒绝')
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
    const hash = createHash('sha256').update(buffer).digest('hex')
    const eol = this.detectEol(text)
    // 全文件按行切分一次，供各行级读取分支共用，同时得到总行数
    const lines = text.split(/\r?\n/)
    const totalLines = lines.length

    if (options.tailLines !== undefined) {
      const count = Math.max(1, Math.min(Math.trunc(options.tailLines), MAX_LINE_READ_LINES))
      const start = Math.max(0, lines.length - count)
      return {
        content: lines.slice(start).join('\n'),
        encoding: 'utf-8',
        eol,
        totalBytes: buffer.length,
        totalLines,
        hash,
        truncated: start > 0,
        lineStart: start + 1,
        lineEnd: lines.length,
      }
    }
    if (options.lineStart !== undefined || options.lineEnd !== undefined) {
      const requestedStart = Math.max(1, Math.trunc(options.lineStart ?? 1))
      const requestedEnd = Math.max(
        1,
        Math.trunc(options.lineEnd ?? requestedStart + MAX_LINE_READ_LINES - 1),
      )
      if (requestedEnd < requestedStart) throw new Error('line_end 不能小于 line_start')
      const boundedEnd = Math.min(requestedEnd, requestedStart + MAX_LINE_READ_LINES - 1)

      // 超出文件尾部时返回空窗口，而不是构造 end < start 的矛盾范围。
      if (requestedStart > totalLines) {
        return {
          content: '',
          encoding: 'utf-8',
          eol,
          totalBytes: buffer.length,
          totalLines,
          hash,
          truncated: totalLines > 0,
          lineStart: requestedStart,
          lineEnd: requestedStart - 1,
        }
      }

      const end = Math.min(totalLines, boundedEnd)
      return {
        content: lines.slice(requestedStart - 1, end).join('\n'),
        encoding: 'utf-8',
        eol,
        totalBytes: buffer.length,
        totalLines,
        hash,
        truncated: requestedStart > 1 || end < totalLines,
        lineStart: requestedStart,
        lineEnd: end,
      }
    }
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, Math.min(options.limit ?? 16_000, 128_000))
    const content = text.slice(offset, offset + limit)
    const nextOffset = offset + content.length
    return {
      content,
      encoding: 'utf-8',
      eol,
      totalBytes: buffer.length,
      totalLines,
      hash,
      truncated: offset > 0 || nextOffset < text.length,
      nextOffset: nextOffset < text.length ? nextOffset : undefined,
    }
  }

  async glob(session: ExecutionSession, options: GlobOptions): Promise<string[]> {
    const root = options.deviceScope
      ? await this.resolveDeviceReadPath(session, options.cwd ?? '.')
      : await this.resolvePath(session, options.cwd ?? '.', 'read')
    const rootInfo = await stat(root)
    if (!rootInfo.isDirectory()) throw new Error('Glob 搜索根路径不是目录')
    const regex = this.globToRegExp(options.pattern.replaceAll('\\', '/'))
    const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 12, 64))
    const limit = Math.max(1, Math.min(options.limit ?? 200, 2_000))
    const output: string[] = []

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > maxDepth || output.length >= limit) return
      if (!(await safetyFileAccessible(directory))) return
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (output.length >= limit) break
        if (!options.includeHidden && entry.name.startsWith('.')) continue
        if (entry.name === 'node_modules') continue
        const absolute = path.join(directory, entry.name)
        if (!(await safetyFileAccessible(absolute))) continue
        const relative = path.relative(root, absolute).replaceAll('\\', '/')
        if (entry.isDirectory()) await walk(absolute, depth + 1)
        else if (entry.isFile() && regex.test(relative)) output.push(relative)
      }
    }
    await walk(root, 0)
    return output
  }

  async write(
    session: ExecutionSession,
    input: {
      path: string
      content: string
      expectedHash?: string
      append?: boolean
      deviceScope?: boolean
      signal?: AbortSignal
      beforeWrite?: () => Promise<unknown>
      afterWrite?: (
        captured: unknown,
        written: { oldHash?: string; newHash: string },
      ) => Promise<void>
    },
  ) {
    return this.withFileMutation(session, input.path, input.deviceScope, async () => {
      const captured = await input.beforeWrite?.()
      // 保险钩子可绑定读取时的版本，空串表示该路径当时尚不存在。
      const guardedHash = (captured as { expectedBeforeHash?: string | null } | undefined)
        ?.expectedBeforeHash
      const written = await this.writeUnlocked(
        session,
        guardedHash === undefined
          ? input
          : {
              ...input,
              expectedHash: input.expectedHash ?? guardedHash ?? '',
              // 保险钩子认定这是新建：只能排他创建，被抢先就报 EEXIST，不能覆盖。
              exclusive: guardedHash === null,
            },
      )
      let checkpointWarning: string | undefined
      try {
        await input.afterWrite?.(captured, written)
      } catch {
        checkpointWarning = '文件已写入，但检查点保存失败；请核对文件，不要重复写入。'
      }
      return { ...written, checkpointWarning }
    })
  }

  /** 文档导出只创建新文件；同内容重试可复用，禁止覆盖用户或其他任务的版本。 */
  async createBinary(
    session: ExecutionSession,
    input: {
      path: string
      bytes: Buffer
      signal?: AbortSignal
      beforeWrite?: () => Promise<unknown>
      afterWrite?: (captured: unknown, bytes: Buffer) => Promise<void>
    },
  ) {
    return this.withFileMutation(session, input.path, false, async (filePath) => {
      input.signal?.throwIfAborted()
      const assertWorkspaceParent = async () => {
        let probe = path.dirname(filePath)
        for (;;) {
          const actual = await realpath(probe).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return undefined
          })
          if (actual) {
            const relative = path.relative(await realpath(session.workspaceRoot), actual)
            if (
              relative === '..' ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            )
              throw new Error('文档输出目录通过链接越出当前工作区')
            return
          }
          const parent = path.dirname(probe)
          if (parent === probe) throw new Error('文档输出目录无效')
          probe = parent
        }
      }
      await assertWorkspaceParent()
      const newHash = createHash('sha256').update(input.bytes).digest('hex')
      const current = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (current) {
        if (
          current.isFile() &&
          current.size === input.bytes.length &&
          createHash('sha256')
            .update(await readFile(filePath))
            .digest('hex') === newHash
        )
          return { path: input.path, newHash, bytes: input.bytes.length, created: false }
        throw new Error('目标文件已存在，请换一个输出文件名')
      }
      const captured = await input.beforeWrite?.()
      await mkdir(path.dirname(filePath), { recursive: true })
      const temporary = path.join(path.dirname(filePath), `.${randomUUID()}.document.tmp`)
      try {
        await writeFile(temporary, input.bytes, { flag: 'wx' })
        const handle = await open(temporary, 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        await this.resolvePath(session, input.path, 'write')
        await assertWorkspaceParent()
        input.signal?.throwIfAborted()
        // 原子发布且不替换已出现的文件，避免生成期间夹入的人工文件被覆盖。
        await link(temporary, filePath)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
      let checkpointWarning: string | undefined
      try {
        await input.afterWrite?.(captured, input.bytes)
      } catch {
        checkpointWarning = '文件已保存，但回滚记录保存失败，请勿重复导出'
      }
      return {
        path: input.path,
        newHash,
        bytes: input.bytes.length,
        created: true,
        checkpointWarning,
      }
    })
  }

  private async writeUnlocked(
    session: ExecutionSession,
    input: {
      path: string
      content: string
      expectedHash?: string
      append?: boolean
      deviceScope?: boolean
      signal?: AbortSignal
      exclusive?: boolean
    },
  ) {
    const filePath = input.deviceScope
      ? await this.resolveApprovedWritePath(input.path)
      : await this.resolvePath(session, input.path, 'write')
    // 读取旧内容（不存在视为新建），用于计算真实 diff 统计
    let currentHash: string | undefined
    let oldText = ''
    let existed = false
    try {
      const buffer = await readFile(filePath)
      if (this.looksBinary(buffer)) {
        throw new WorkspaceError(WS_ERROR.WRITE_BINARY_FILE, '检测到二进制文件，拒绝文本写入')
      }
      currentHash = createHash('sha256').update(buffer).digest('hex')
      oldText = buffer.toString('utf8')
      existed = true
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      // ENOENT：文件不存在，按新建处理
    }
    if (input.expectedHash !== undefined && (currentHash ?? '') !== input.expectedHash) {
      throw new WorkspaceError(
        WS_ERROR.WRITE_HASH_MISMATCH,
        '文件已被外部修改，expected_hash 不匹配，请重新读取',
      )
    }
    const nextContent = input.append ? `${oldText}${input.content}` : input.content
    const diff = diffLines(oldText, nextContent)
    let finalHash: string | undefined
    try {
      finalHash = createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (finalHash !== currentHash)
      throw new WorkspaceError(WS_ERROR.WRITE_HASH_MISMATCH, '提交前文件已变化，请重新读取')
    input.signal?.throwIfAborted()
    await this.atomicWrite(filePath, nextContent, input.exclusive && !existed)
    return {
      success: true,
      operation: input.append ? 'append' : existed ? 'overwrite' : 'create',
      editRange: existed
        ? { startLine: 1, endLine: oldText.split(/\r?\n/).length }
        : { startLine: 1, endLine: nextContent.split(/\r?\n/).length },
      insertions: diff.insertions,
      deletions: diff.deletions,
      oldHash: currentHash,
      newHash: createHash('sha256').update(nextContent, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(nextContent, 'utf8'),
    }
  }

  async edit(
    session: ExecutionSession,
    input: {
      path: string
      oldText: string
      newText: string
      expectedHash?: string
      deviceScope?: boolean
    },
  ) {
    return this.withFileMutation(session, input.path, input.deviceScope, () =>
      this.editUnlocked(session, input),
    )
  }

  private async editUnlocked(
    session: ExecutionSession,
    input: {
      path: string
      oldText: string
      newText: string
      expectedHash?: string
      deviceScope?: boolean
    },
  ) {
    if (!input.oldText) {
      throw new WorkspaceError(WS_ERROR.EDIT_EMPTY_OLD_TEXT, 'old_text 不能为空')
    }
    if (input.oldText === input.newText) {
      throw new WorkspaceError(
        WS_ERROR.EDIT_NO_CHANGES,
        'old_text 与 new_text 完全相同，文件不会产生任何变化；请提供真正需要替换的新内容',
      )
    }
    const filePath = input.deviceScope
      ? await this.resolveApprovedWritePath(input.path)
      : await this.resolvePath(session, input.path, 'write')
    let buffer: Buffer
    try {
      buffer = await readFile(filePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new WorkspaceError(
          WS_ERROR.EDIT_FILE_NOT_FOUND,
          `文件不存在，无法编辑: ${input.path}`,
        )
      }
      throw error
    }
    if (this.looksBinary(buffer)) {
      throw new WorkspaceError(WS_ERROR.EDIT_BINARY_FILE, '检测到二进制文件，拒绝文本编辑')
    }
    const currentHash = createHash('sha256').update(buffer).digest('hex')
    if (input.expectedHash && input.expectedHash !== currentHash) {
      throw new WorkspaceError(
        WS_ERROR.EDIT_HASH_MISMATCH,
        '文件已发生变化，expected_hash 不匹配，请重新读取后再编辑',
      )
    }
    const content = buffer.toString('utf8')
    let count = 0
    let cursor = 0
    while ((cursor = content.indexOf(input.oldText, cursor)) !== -1) {
      count += 1
      cursor += input.oldText.length
    }
    if (count === 0) {
      throw new WorkspaceError(
        WS_ERROR.EDIT_NOT_FOUND,
        'old_text 未在文件中匹配到任何内容，请重新读取文件后携带准确的 old_text 再编辑',
      )
    }
    if (count !== 1) {
      throw new WorkspaceError(
        WS_ERROR.EDIT_NOT_UNIQUE,
        `old_text 必须唯一匹配，当前匹配数: ${count}，请扩大上下文使其唯一`,
      )
    }
    const startOffset = content.indexOf(input.oldText)
    const endOffset = startOffset + input.oldText.length
    // 定位改动行范围（第 1 行起）：以匹配段前后累计的换行符数为准
    const startLine = content.slice(0, startOffset).split('\n').length
    const endLine = content.slice(0, endOffset).split('\n').length
    const next = content.replace(input.oldText, input.newText)
    await this.atomicWrite(filePath, next)
    const diff = diffLines(input.oldText, input.newText)
    return {
      success: true,
      operation: 'edit',
      editRange: { startLine, endLine },
      insertions: diff.insertions,
      deletions: diff.deletions,
      oldHash: currentHash,
      newHash: createHash('sha256').update(next, 'utf8').digest('hex'),
    }
  }

  /** exclusive：目标已存在就报 EEXIST，用硬链接发布，不会替换夹进来的文件。 */
  async atomicWrite(filePath: string, content: string, exclusive = false): Promise<void> {
    const directory = path.dirname(filePath)
    await mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, content, 'utf8')
      const handle = await open(temporary, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (exclusive) {
        await link(temporary, filePath)
        await rm(temporary, { force: true })
      } else await rename(temporary, filePath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * 重命名普通文件；工作区页面可显式允许目录操作。
   * 新名称仅允许 basename，目标固定在原目录，且禁止覆盖已有文件。
   */
  async renameFile(
    session: ExecutionSession,
    inputPath: string,
    newName: string,
    allowDirectory = false,
  ) {
    const source = await this.resolvePath(session, inputPath, 'write')
    const normalizedName = newName.trim()
    if (
      !normalizedName ||
      path.basename(normalizedName) !== normalizedName ||
      normalizedName === '.' ||
      normalizedName === '..' ||
      /[\\/:*?"<>|]/.test(normalizedName)
    ) {
      throw new WorkspaceError(WS_ERROR.PATH_OUT_OF_SCOPE, '新文件名不能包含目录路径')
    }
    const sourceInfo = await lstat(source).catch(() => null)
    if (!sourceInfo) throw new WorkspaceError(WS_ERROR.FILE_NOT_FOUND, `文件不存在: ${inputPath}`)
    if (
      sourceInfo.isSymbolicLink() ||
      (!sourceInfo.isFile() && !(allowDirectory && sourceInfo.isDirectory()))
    )
      throw new WorkspaceError(WS_ERROR.NOT_A_FILE, '不支持重命名此类型的文件')
    if (allowDirectory) await this.validateWorkspaceEntry(session, source, sourceInfo.isDirectory())

    const target = await this.resolvePath(
      session,
      path.join(path.dirname(inputPath), normalizedName),
      'write',
    )
    const targetInfo = await lstat(target).catch(() => null)
    if (targetInfo)
      throw new WorkspaceError(WS_ERROR.RENAME_TARGET_EXISTS, `同名文件已存在: ${normalizedName}`)
    await rename(source, target)
    return {
      oldPath: path.relative(session.workspaceRoot, source).replaceAll('\\', '/'),
      newPath: path.relative(session.workspaceRoot, target).replaceAll('\\', '/'),
      name: normalizedName,
    }
  }

  /** 删除工作区内的普通文件；不递归删除目录，避免误删整个目录树。 */
  async deleteFile(session: ExecutionSession, inputPath: string, deviceScope = false) {
    const target = deviceScope
      ? await this.resolveApprovedWritePath(inputPath)
      : await this.resolvePath(session, inputPath, 'write')
    const targetInfo = await lstat(target).catch(() => null)
    if (!targetInfo) throw new WorkspaceError(WS_ERROR.FILE_NOT_FOUND, `文件不存在: ${inputPath}`)
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink())
      throw new WorkspaceError(WS_ERROR.NOT_A_FILE, '当前仅支持删除普通文件')
    await rm(target)
    return { path: inputPath.replaceAll('\\', '/') }
  }

  /** 用户在文件树确认删除后，可递归删除目录；Agent 的文件删除能力仍沿用原有边界。 */
  async deleteEntry(session: ExecutionSession, inputPath: string) {
    const target = await this.resolvePath(session, inputPath, 'write')
    const info = await lstat(target).catch(() => null)
    if (!info) throw new WorkspaceError(WS_ERROR.FILE_NOT_FOUND, `文件或文件夹不存在: ${inputPath}`)
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new WorkspaceError(WS_ERROR.NOT_A_FILE, '不支持删除此类型的文件')
    await this.validateWorkspaceEntry(session, target, info.isDirectory())
    await rm(target, { recursive: info.isDirectory() })
    return { path: path.relative(session.workspaceRoot, target).replaceAll('\\', '/') }
  }

  /** 在递归操作前校验整棵目录树；子项符号链接只处理链接本身，不跟随目标。 */
  private async validateWorkspaceEntry(
    session: ExecutionSession,
    target: string,
    directory: boolean,
  ): Promise<void> {
    const root = path.resolve(session.workspaceRoot)
    const actualRoot = await realpath(root)
    const actual = await realpath(target)
    if (
      path.relative(root, target) === '' ||
      !this.isWithin(root, target) ||
      path.relative(actualRoot, actual) === '' ||
      !this.isWithin(actualRoot, actual)
    ) {
      throw new WorkspaceError(WS_ERROR.PATH_OUT_OF_SCOPE, '只能操作工作区根目录内的文件或文件夹')
    }
    await this.resolvePath(session, target, 'write')
    if (!directory) return
    for (const entry of await readdir(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name)
      if (entry.isSymbolicLink()) {
        const relative = path.relative(root, child).replaceAll('\\', '/')
        if (
          session.sandboxProfile.protectedPaths.some(
            (part) => relative === part || relative.startsWith(`${part}/`),
          )
        )
          throw new WorkspaceError(WS_ERROR.PATH_PROTECTED, `路径受保护，禁止访问: ${relative}`)
        continue
      }
      await this.validateWorkspaceEntry(session, child, entry.isDirectory())
    }
  }

  /** 解析并校验真实目录；拒绝 workspace 内符号链接/Junction 指向外部。 */
  async resolveDirectory(
    session: ExecutionSession,
    inputPath: string,
    options: { deviceScope?: boolean } = {},
  ): Promise<string> {
    const lexical = options.deviceScope
      ? await this.resolveDeviceReadPath(session, inputPath)
      : await this.resolvePath(session, inputPath, 'read')
    const actual = await realpath(lexical)
    if (!options.deviceScope) await this.assertRealPathAllowed(session, actual, 'read', inputPath)
    const info = await stat(actual)
    if (!info.isDirectory()) throw new Error(`目标不是目录: ${inputPath}`)
    return actual
  }

  /** 搜索工具使用与普通读取相同的设备只读或工作区路径边界。 */
  async resolveReadablePath(
    session: ExecutionSession,
    inputPath: string,
    deviceScope = false,
  ): Promise<string> {
    const lexical = deviceScope
      ? this.resolveDeviceReadPath(session, inputPath)
      : this.resolvePath(session, inputPath, 'read')
    const actual = await realpath(await lexical)
    if (!deviceScope) await this.assertRealPathAllowed(session, actual, 'read', inputPath)
    return actual
  }

  /** 元信息与正文读取使用相同的路径校验。 */
  async fileInfo(session: ExecutionSession, inputPath: string, deviceScope = false) {
    let target: string
    try {
      target = deviceScope
        ? await this.resolveDeviceReadPath(session, inputPath)
        : await this.resolvePath(session, inputPath, 'read')
      const info = await stat(target)
      return {
        exists: true,
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        size: info.size,
        modifiedAt: info.mtime,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { exists: false, isFile: false, isDirectory: false, size: 0, modifiedAt: null }
    }
  }

  /** 列目录只读取条目本身的元信息，不跟随子项符号链接。 */
  async listDirectory(session: ExecutionSession, inputPath: string, deviceScope = false) {
    const directory = await this.resolveDirectory(session, inputPath, { deviceScope })
    const names = await readdir(directory)
    return Promise.all(
      names.map(async (name) => {
        if (!(await safetyFileAccessible(path.join(directory, name)))) return null
        const info = await lstat(path.join(directory, name))
        return { name, isDirectory: info.isDirectory(), size: info.size, modifiedAt: info.mtime }
      }),
    ).then((items) => items.filter((item): item is NonNullable<typeof item> => item !== null))
  }

  /** 设备级只读解析：只接受现有真实路径，绝对路径按设备定位，相对路径仍基于 Workspace。 */
  private async resolveDeviceReadPath(
    session: ExecutionSession,
    inputPath: string,
  ): Promise<string> {
    const normalizedPath = this.normalizePrincipalPath(inputPath)
    const resolved = path.isAbsolute(normalizedPath)
      ? path.resolve(normalizedPath)
      : path.resolve(session.workspaceRoot, normalizedPath)
    await assertSafetyFileAccess(resolved)
    const actual = await realpath(resolved)
    const info = await stat(actual)
    if (!info.isFile() && !info.isDirectory())
      throw new Error(`目标不是普通文件或目录: ${inputPath}`)
    return actual
  }

  /** 已审批写路径：仅接受绝对路径，并校验最近存在父目录的真实位置。 */
  private async resolveApprovedWritePath(inputPath: string): Promise<string> {
    if (!path.isAbsolute(inputPath)) {
      throw new WorkspaceError(WS_ERROR.PATH_OUT_OF_SCOPE, '工作区外审批写入必须使用绝对路径')
    }
    const resolved = path.resolve(inputPath)
    await assertSafetyFileAccess(resolved)
    let probe = resolved
    let foundExistingParent = false
    while (!foundExistingParent) {
      try {
        await realpath(probe)
        foundExistingParent = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = path.dirname(probe)
        if (parent === probe) throw error
        probe = parent
      }
    }
    return resolved
  }

  private async resolvePath(
    session: ExecutionSession,
    inputPath: string,
    mode: 'read' | 'write',
  ): Promise<string> {
    const resolved = path.resolve(session.workspaceRoot, this.normalizePrincipalPath(inputPath))
    await assertSafetyFileAccess(resolved)
    const roots =
      mode === 'read' ? session.sandboxProfile.readableRoots : session.sandboxProfile.writableRoots
    if (
      session.sandboxProfile.name !== 'full-access' &&
      !roots.some((root) => this.isWithin(root, resolved))
    ) {
      throw new WorkspaceError(
        WS_ERROR.PATH_OUT_OF_SCOPE,
        `路径超出${mode === 'read' ? '可读' : '可写'}范围: ${inputPath}`,
      )
    }
    const relative = path.relative(session.workspaceRoot, resolved).replaceAll('\\', '/')
    if (
      session.sandboxProfile.protectedPaths.some(
        (part) => relative === part || relative.startsWith(`${part}/`),
      )
    ) {
      throw new WorkspaceError(WS_ERROR.PATH_PROTECTED, `路径受保护，禁止访问: ${inputPath}`)
    }

    // 已存在目标校验其真实路径；新文件则校验最近存在的父目录，防止经 Junction/symlink 逃逸。
    let probe = resolved
    let resolvedParent = false
    while (!resolvedParent) {
      try {
        const actual = await realpath(probe)
        await this.assertRealPathAllowed(session, actual, mode, inputPath)
        resolvedParent = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = path.dirname(probe)
        if (parent === probe) throw error
        probe = parent
      }
    }
    return resolved
  }

  private async assertRealPathAllowed(
    session: ExecutionSession,
    actual: string,
    mode: 'read' | 'write',
    inputPath: string,
  ): Promise<void> {
    if (session.sandboxProfile.name === 'full-access') return
    const roots =
      mode === 'read' ? session.sandboxProfile.readableRoots : session.sandboxProfile.writableRoots
    const realRoots = await Promise.all(
      roots.map(async (root) => realpath(root).catch(() => path.resolve(root))),
    )
    if (!realRoots.some((root) => this.isWithin(root, actual))) {
      throw new WorkspaceError(
        WS_ERROR.PATH_OUT_OF_SCOPE,
        `路径通过符号链接越出${mode === 'read' ? '可读' : '可写'}范围: ${inputPath}`,
      )
    }
  }

  private isWithin(root: string, target: string): boolean {
    const relative = path.relative(path.resolve(root), target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  private normalizePrincipalPath(inputPath: string): string {
    return /^@principal[\\/]/i.test(inputPath) ? inputPath.slice('@principal/'.length) : inputPath
  }

  private looksBinary(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8_000))
    return sample.includes(0)
  }

  private detectEol(text: string): FileReadResult['eol'] {
    const crlf = text.includes('\r\n')
    const lf = /(^|[^\r])\n/.test(text)
    return crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none'
  }

  private globToRegExp(pattern: string): RegExp {
    let source = '^'
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index]!
      if (char === '*' && pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else if (char === '*') source += '[^/]*'
      else if (char === '?') source += '[^/]'
      else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
    return new RegExp(`${source}$`, 'i')
  }
}
