/**
 * code_search — 安全代码搜索工具
 *
 * 优先使用 ripgrep JSON 输出，始终通过 spawn 参数数组执行且不启用 shell；
 * rg 不可用时降级为 Node 流式逐行搜索。
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import ignore from 'ignore'
import path from 'node:path'
import readline from 'node:readline'
import { t } from '../../lib/i18n'
import type { BuiltinTool } from '../index'
import { getProductivityRuntime, resolveExecutionSession } from '../productivityRuntimeHolder'
import { toolSuccess } from '../../services/execution/toolResult'
import { retainToolObservation } from '../../services/execution/toolObservation'

const MAX_RESULTS = 50
const SEARCH_TIMEOUT_MS = 15_000
const MAX_FILE_BYTES = 10 * 1024 * 1024
const require = createRequire(import.meta.url)

/** 单条匹配：文件路径 + 行号 + 列号（1-based）+ 该行内容 */
export interface CodeMatch {
  file: string
  line: number
  column?: number
  content: string
}

interface SearchInput {
  query: string
  isRegex: boolean
  fileType?: string
  searchPath: string
  respectGitIgnore?: boolean
  includeHidden?: boolean
  signal?: AbortSignal
}

export const codeSearcherTool: BuiltinTool = {
  name: 'code_search',

  async execute(args, ctx) {
    const query = String(args.query ?? '')
    if (!query) throw new Error('query 不能为空')
    const isRegex = Boolean(args.is_regex)
    const fileType = args.file_type ? String(args.file_type) : undefined
    const respectGitIgnore = args.respect_gitignore !== false
    const includeHidden = args.include_hidden === true
    const session = await resolveExecutionSession(ctx)
    const searchPath = await getProductivityRuntime().virtualWorkspace.resolveReadablePath(
      session,
      args.path ? String(args.path) : '.',
      ctx.deviceReadScope,
    )

    const options = {
      query,
      isRegex,
      fileType,
      searchPath,
      respectGitIgnore,
      includeHidden,
      signal: ctx.signal,
    }
    const rg = await searchWithRipgrep(options)
    // Node fallback 仅在 rg 不可用时执行
    const node = rg.available ? null : await searchWithNode(options)
    const result = rg.available
      ? {
          matches: rg.matches,
          total: rg.matches.length,
          truncated: rg.truncated,
          engine: 'ripgrep',
        }
      : {
          matches: node!.matches,
          total: node!.matches.length,
          truncated: node!.truncated,
          engine: 'node-fallback',
        }
    result.total = result.matches.length
    const fileCount = new Set(result.matches.map((match) => match.file)).size
    // 只保留已命中的真实路径作为只读打开凭据，不扩大工作区编辑边界。
    const resultRef = result.matches.length
      ? retainToolObservation(
          JSON.stringify({
            kind: 'code_search_files',
            files: [...new Set(result.matches.map((match) => match.file))],
          }),
          ctx,
        )
      : undefined
    const navigation =
      resultRef && !ctx.realmId
        ? {
            resultRef,
            agentId: ctx.agentId,
            threadId: ctx.threadId,
            taskId: ctx.taskId,
          }
        : undefined
    return toolSuccess(
      JSON.stringify({
        ...result,
        fileCount,
        searchRoot: searchPath,
        respectGitIgnore,
        includeHidden,
        navigation,
      }),
      {
        engine: result.engine,
        fileCount,
        total: result.total,
        truncated: result.truncated,
        searchRoot: searchPath,
      },
    )
  },
}

export function resolveRipgrepPath(): string {
  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const resourcesRoot = process.env.INFOS_RESOURCES_ROOT
  if (resourcesRoot) {
    const bundled = path.join(
      resourcesRoot,
      'bin',
      `${process.platform}-${process.arch}`,
      executable,
    )
    if (existsSync(bundled)) return bundled
  }
  // 开发环境优先复用 @vscode/ripgrep 当前平台包。
  try {
    const module = require('@vscode/ripgrep') as { rgPath?: string }
    if (module.rgPath && existsSync(module.rgPath)) return module.rgPath
  } catch {
    /* 依赖未安装时继续回退系统 PATH。 */
  }
  return 'rg'
}

async function searchWithRipgrep(
  input: SearchInput,
): Promise<{ available: boolean; matches: CodeMatch[]; truncated: boolean }> {
  input.signal?.throwIfAborted()
  const rootInfo = await stat(input.searchPath)
  return new Promise((resolve, reject) => {
    const rgArgs = [
      '--no-config',
      '--json',
      '-n',
      '--no-require-git',
      '--max-filesize',
      String(MAX_FILE_BYTES),
      '--glob',
      '!**/.git/**',
    ]
    if (input.respectGitIgnore === false) rgArgs.push('--no-ignore-vcs')
    if (input.includeHidden) rgArgs.push('--hidden')
    if (!input.isRegex) rgArgs.push('-F')
    for (const extension of fileTypeExtensions(input.fileType) ?? [])
      rgArgs.push('--iglob', `*${extension}`)
    rgArgs.push('--', input.query, input.searchPath)
    const rgCommand = resolveRipgrepPath()
    const child = spawn(rgCommand, rgArgs, {
      cwd: rootInfo.isDirectory() ? input.searchPath : path.dirname(input.searchPath),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const matches: CodeMatch[] = []
    let stdout = ''
    let stderr = ''
    let unavailable = false
    // 达到结果上限被截断时标记，避免 Agent 误以为已拿到全量结果
    let truncated = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, SEARCH_TIMEOUT_MS)
    const abort = () => child.kill()
    input.signal?.addEventListener('abort', abort, { once: true })

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') unavailable = true
      else reject(error)
    })
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        parseRgLine(stdout.slice(0, newline), matches)
        stdout = stdout.slice(newline + 1)
        if (matches.length >= MAX_RESULTS) {
          child.kill()
          truncated = true
        }
        newline = stdout.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 8000)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      if (unavailable) {
        resolve({ available: false, matches: [], truncated: false })
        return
      }
      if (input.signal?.aborted) {
        reject(new Error('代码搜索已取消'))
        return
      }
      if (timedOut) {
        reject(new Error(t('server.tools', '代码搜索超时，请缩小搜索范围')))
        return
      }
      parseRgLine(stdout, matches)
      // rg: 0=有匹配，1=无匹配；主动达到结果上限后的非零退出也视为成功。
      if (code !== 0 && code !== 1 && matches.length < MAX_RESULTS) {
        reject(new Error(`ripgrep 执行失败 (exitCode=${code}): ${stderr.trim()}`))
        return
      }
      resolve({ available: true, matches: matches.slice(0, MAX_RESULTS), truncated })
    })
  })
}

function parseRgLine(line: string, matches: CodeMatch[]): void {
  if (!line.trim() || matches.length >= MAX_RESULTS) return
  try {
    const event = JSON.parse(line) as {
      type?: string
      data?: {
        path?: { text?: string }
        line_number?: number
        lines?: { text?: string }
        submatches?: Array<{ start?: number }>
      }
    }
    if (event.type === 'match') {
      const rawLine = event.data?.lines?.text ?? ''
      const submatch = event.data?.submatches?.[0]
      matches.push({
        file: event.data?.path?.text ?? '',
        line: event.data?.line_number ?? 0,
        // rg 的 start 为 0-based 字节偏移，界面使用 1-based UTF-16 列号。
        column:
          submatch?.start !== undefined ? byteOffsetToColumn(rawLine, submatch.start) : undefined,
        content: rawLine.trimEnd().slice(0, 300),
      })
    }
  } catch {
    /* 忽略非 JSON 诊断行。 */
  }
}

/** 把 rg 的字节偏移转成与编辑器一致的列号。 */
function byteOffsetToColumn(line: string, byteStart: number): number {
  const bytes = Buffer.from(line, 'utf8')
  const prefix = bytes.subarray(0, Math.max(0, byteStart)).toString('utf8')
  return prefix.length + 1
}

async function searchWithNode(
  input: SearchInput,
): Promise<{ matches: CodeMatch[]; truncated: boolean }> {
  const matches: CodeMatch[] = []
  const matcher = createMatcher(input.query, input.isRegex)
  const extensions = fileTypeExtensions(input.fileType)
  const deadline = Date.now() + SEARCH_TIMEOUT_MS
  const check = () => {
    input.signal?.throwIfAborted()
    if (Date.now() > deadline) throw new Error(t('server.tools', '代码搜索超时，请缩小搜索范围'))
  }
  const rootInfo = await stat(input.searchPath)
  type Rules = { root: string; matcher: ReturnType<typeof ignore> }
  const readRules = async (directory: string): Promise<Rules[]> => {
    const matcher = ignore()
    for (const name of [
      ...(input.respectGitIgnore === false ? [] : ['.git/info/exclude', '.gitignore']),
      '.ignore',
      '.rgignore',
    ]) {
      try {
        matcher.add(await readFile(path.join(directory, name), 'utf8'))
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error
      }
    }
    const relativeRoot = path.relative(directory, input.searchPath).replaceAll('\\', '/')
    // 显式搜索根可位于被父目录忽略的运行时目录，根内规则仍照常生效。
    if (
      rootInfo.isDirectory() &&
      relativeRoot &&
      relativeRoot !== '..' &&
      !relativeRoot.startsWith('../') &&
      !path.isAbsolute(relativeRoot) &&
      matcher.ignores(`${relativeRoot}/`)
    )
      return []
    return [{ root: directory, matcher }]
  }
  const ancestors: string[] = []
  let ancestor = rootInfo.isDirectory()
    ? path.dirname(input.searchPath)
    : path.dirname(path.dirname(input.searchPath))
  while (!existsSync(path.join(input.searchPath, '.git'))) {
    ancestors.unshift(ancestor)
    if (existsSync(path.join(ancestor, '.git')) || path.dirname(ancestor) === ancestor) break
    ancestor = path.dirname(ancestor)
  }
  const inherited = (await Promise.all(ancestors.map(readRules))).flat()
  const searchOne = async (absolute: string) => {
    check()
    if (
      extensions &&
      ![...extensions].some((extension) => absolute.toLowerCase().endsWith(extension))
    )
      return
    const info = await stat(absolute)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return
    const handle = await open(absolute, 'r')
    try {
      const header = Buffer.alloc(Math.min(info.size, 8192))
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      if (header.subarray(0, bytesRead).includes(0)) return
    } finally {
      await handle.close()
    }
    await searchFile(absolute, matcher, matches, input.signal, check)
  }

  const walk = async (directory: string, parents: Rules[]): Promise<void> => {
    if (matches.length >= MAX_RESULTS) return
    check()
    const rules = [...parents, ...(await readRules(directory))]
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (matches.length >= MAX_RESULTS) return
      if (entry.name === '.git' || (!input.includeHidden && entry.name.startsWith('.'))) continue
      const absolute = path.join(directory, entry.name)
      let ignored = false
      for (const scope of rules) {
        const relative =
          path.relative(scope.root, absolute).replaceAll('\\', '/') +
          (entry.isDirectory() ? '/' : '')
        const decision = scope.matcher.test(relative)
        if (decision.ignored) ignored = true
        else if (decision.unignored) ignored = false
      }
      if (ignored) continue
      if (entry.isDirectory()) {
        await walk(absolute, rules)
        continue
      }
      if (!entry.isFile()) continue
      await searchOne(absolute)
    }
  }
  if (rootInfo.isDirectory()) await walk(input.searchPath, inherited)
  else await searchOne(input.searchPath)
  return { matches, truncated: matches.length >= MAX_RESULTS }
}

async function searchFile(
  filePath: string,
  matcher: (line: string) => number | null,
  output: CodeMatch[],
  signal?: AbortSignal,
  check?: () => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0
  try {
    for await (const raw of lines) {
      if (signal?.aborted) throw new Error('代码搜索已取消')
      check?.()
      lineNumber += 1
      const line = lineNumber === 1 ? raw.replace(/^\uFEFF/, '') : raw
      // matcher 返回首个匹配的 0-based 字符索引，null 表示本行无匹配
      const matchIndex = matcher(line)
      if (matchIndex !== null) {
        output.push({
          file: path.resolve(filePath),
          line: lineNumber,
          column: matchIndex + 1,
          content: line.slice(0, 300),
        })
        if (output.length >= MAX_RESULTS) break
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

/** 行匹配器：返回首个匹配的 0-based 字符索引（null 表示未命中） */
function createMatcher(query: string, isRegex: boolean): (line: string) => number | null {
  if (!isRegex) {
    return (line) => {
      const index = line.indexOf(query)
      return index >= 0 ? index : null
    }
  }
  let regex: RegExp
  try {
    regex = new RegExp(query)
  } catch (error) {
    throw new Error(`正则表达式无效: ${error instanceof Error ? error.message : String(error)}`)
  }
  return (line) => {
    regex.lastIndex = 0
    const match = regex.exec(line)
    return match ? match.index : null
  }
}

export const __codeSearchInternals = {
  searchWithRipgrep,
  searchWithNode,
  createMatcher,
  fileTypeExtensions,
}

function fileTypeExtensions(fileType?: string): Set<string> | null {
  if (!fileType) return null
  const map: Record<string, string[]> = {
    ts: ['.ts', '.tsx'],
    js: ['.js', '.jsx', '.mjs', '.cjs'],
    py: ['.py'],
    rust: ['.rs'],
    go: ['.go'],
    java: ['.java'],
    json: ['.json'],
    vue: ['.vue'],
    css: ['.css', '.scss', '.less'],
    markdown: ['.md'],
    html: ['.html', '.htm'],
  }
  const normalized = fileType.toLowerCase().replace(/^\*?\./, '')
  const aliases: Record<string, string> = {
    typescript: 'ts',
    javascript: 'js',
    python: 'py',
    rs: 'rust',
    md: 'markdown',
  }
  return new Set(map[aliases[normalized] ?? normalized] ?? [`.${normalized}`])
}
