import path from 'node:path'
import { open, realpath, opendir, lstat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { t } from '../../lib/i18n'

type Query =
  | { kind: 'pwd' }
  | {
      kind: 'list'
      path: string
      files: boolean
      directories: boolean
      recurse: boolean
      hidden: boolean
    }
  | { kind: 'read'; path: string; first?: number; last?: number; raw: boolean }
  | { kind: 'search'; path: string; pattern: string; caseSensitive: boolean }
type Projection = {
  kind: 'select' | 'sort' | 'format'
  fields: string[]
  first?: number
  last?: number
  descending: boolean
}
interface Pipeline {
  query: Query
  projections: Projection[]
}
export interface ReadOnlyTerminalPlan {
  fingerprint: string
  pipelines: Pipeline[]
  commands: string[]
}
export interface ReadOnlyTerminalGrant {
  plan: ReadOnlyTerminalPlan
  cwd: string
  root: string
  checkPath: (absolutePath: string) => boolean
}
interface Token {
  value: string
  quoted: boolean
}
type Row = string | Record<string, string | number | boolean>

const FIELDS = new Set(['Name', 'FullName', 'Length', 'PSIsContainer', 'Extension'])
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 4096

function fingerprint(args: Record<string, unknown>): string {
  return JSON.stringify({
    command: String(args.command ?? '').trim(),
    argv: args.argv,
    cwd: args.cwd || undefined,
  })
}

/** 仅接受常量、管道和顺序组合；语法不明确时交回原审批，不解释任意 Shell。 */
function tokenize(command: string, windows: boolean): Array<Token[] | '|' | ';'> | null {
  const result: Array<Token[] | '|' | ';'> = []
  let words: Token[] = [],
    value = '',
    started = false,
    quoted = false
  let quote = ''
  const word = () => {
    if (started) words.push({ value, quoted })
    value = ''
    started = false
    quoted = false
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (char === quote) {
        if (windows && quote === "'" && command[i + 1] === "'") {
          value += "'"
          i++
        } else quote = ''
      } else {
        if (quote === '"' && /[$`]/.test(char)) return null
        if (!windows && char === '\\') return null
        value += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      if (started) return null
      quote = char
      quoted = true
      started = true
    } else if (char === '|' || char === ';' || char === '\n') {
      word()
      if (!words.length) {
        if (char === '\n' && [';', '|'].includes(String(result.at(-1)))) continue
        return null
      }
      result.push(words, char === '|' ? '|' : ';')
      words = []
    } else if (/\s/.test(char)) word()
    else {
      if (/[$`{}()&<>#\0]/.test(char) || (!windows && char === '\\') || (windows && char === '@'))
        return null
      if (quoted) return null
      started = true
      value += char
    }
  }
  if (quote) return null
  word()
  if (words.length) result.push(words)
  else if (result.at(-1) === '|') return null
  if (result.at(-1) === ';') result.pop()
  return result
}

function number(value: string | undefined): number | undefined {
  return value && /^\d{1,5}$/.test(value) && Number(value) <= MAX_ROWS ? Number(value) : undefined
}
function fields(values: string[]): string[] | null {
  const names = values
    .join(',')
    .split(',')
    .filter(Boolean)
    .map((name) => [...FIELDS].find((field) => field.toLowerCase() === name.toLowerCase()))
  return names.every((name) => name !== undefined) ? (names as string[]) : null
}
function source(words: Token[], windows: boolean): Query | null {
  if (words[0]?.quoted) return null
  const name = windows ? words[0]?.value.toLowerCase() : words[0]?.value
  const args = words.slice(1).map((word) => word.value)
  if ((windows ? ['pwd', 'get-location'].includes(name ?? '') : name === 'pwd') && !args.length)
    return { kind: 'pwd' }
  const list = windows ? ['get-childitem', 'gci', 'dir', 'ls'].includes(name ?? '') : name === 'ls'
  const read = windows
    ? ['get-content', 'gc', 'cat'].includes(name ?? '')
    : ['cat', 'head', 'tail'].includes(name ?? '')
  const search = windows && ['select-string', 'sls'].includes(name ?? '')
  if (!list && !read && !search) return null
  let target: string | undefined,
    literal = false,
    first: number | undefined,
    last: number | undefined
  let files = false,
    directories = false,
    recurse = false,
    hidden = windows,
    raw = false
  let pattern: string | undefined,
    simple = false,
    caseSensitive = false
  if (!windows && name === 'head') first = 10
  if (!windows && name === 'tail') last = 10
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!,
      option = words[i + 1]?.quoted ? '' : windows ? arg.toLowerCase() : arg
    if (windows && ['-literalpath', '-path'].includes(option)) {
      if (target !== undefined || args[i + 1] === undefined) return null
      target = args[++i]
      literal = option === '-literalpath'
    } else if (list && (windows ? option === '-file' : option === '-1')) files ||= windows
    else if (list && windows && option === '-directory') directories = true
    else if (list && windows && option === '-recurse') recurse = true
    else if (
      list &&
      (windows ? option === '-force' : ['-a', '-A', '-l', '-la', '-al'].includes(option))
    )
      hidden ||= windows || option !== '-l'
    else if (
      read &&
      (windows ? ['-totalcount', '-head', '-tail'].includes(option) : option === '-n')
    ) {
      const count = number(args[++i])
      if (count === undefined) return null
      if (option === '-tail' || (!windows && name === 'tail')) last = count
      else first = count
    } else if (read && windows && option === '-raw') raw = true
    else if (search && option === '-simplematch') simple = true
    else if (search && option === '-casesensitive') caseSensitive = true
    else if (search && option === '-pattern') {
      if (pattern !== undefined || args[i + 1] === undefined) return null
      pattern = args[++i]
    } else if ((words[i + 1]?.quoted || !arg.startsWith('-')) && target === undefined) target = arg
    else return null
  }
  if (
    target !== undefined &&
    (!target || target.includes('\0') || (!literal && /[*?[\]]/.test(target)))
  )
    return null
  if (list) return { kind: 'list', path: target ?? '.', files, directories, recurse, hidden }
  if (
    !target ||
    (first !== undefined && last !== undefined) ||
    (raw && (first !== undefined || last !== undefined))
  )
    return null
  if (search)
    return simple && pattern !== undefined
      ? { kind: 'search', path: target, pattern, caseSensitive }
      : null
  return { kind: 'read', path: target, first, last, raw }
}
function projection(words: Token[], windows: boolean): Projection | null {
  if (words[0]?.quoted) return null
  const name = windows ? words[0]?.value.toLowerCase() : words[0]?.value
  const args = words.slice(1).map((word) => word.value)
  if (!windows) {
    if (!['head', 'tail'].includes(name ?? '')) return null
    const count = !args.length
      ? 10
      : args.length === 2 && args[0] === '-n'
        ? number(args[1])
        : undefined
    return count === undefined
      ? null
      : {
          kind: 'select',
          fields: [],
          descending: false,
          ...(name === 'head' ? { first: count } : { last: count }),
        }
  }
  const kind = ['select-object', 'select'].includes(name ?? '')
    ? 'select'
    : ['sort-object', 'sort'].includes(name ?? '')
      ? 'sort'
      : ['format-table', 'ft'].includes(name ?? '')
        ? 'format'
        : undefined
  if (!kind) return null
  const properties: string[] = []
  let first: number | undefined,
    last: number | undefined,
    descending = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!,
      option = words[i + 1]?.quoted ? '' : arg.toLowerCase()
    if (option === '-property') {
      if (!args[i + 1] || args[i + 1]!.startsWith('-')) return null
      continue
    }
    if (kind === 'select' && ['-first', '-last'].includes(option)) {
      const count = number(args[++i])
      if (count === undefined) return null
      if (option === '-first') first = count
      else last = count
    } else if (kind === 'sort' && option === '-descending') descending = true
    else if (kind === 'format' && option === '-autosize') continue
    else if (!arg.startsWith('-')) properties.push(arg)
    else return null
  }
  const names = fields(properties)
  if (!names || (first !== undefined && last !== undefined)) return null
  return { kind, fields: names, first, last, descending }
}

export function planReadOnlyTerminal(
  args: Record<string, unknown>,
  platform = process.platform,
): ReadOnlyTerminalPlan | null {
  if (
    typeof args.command !== 'string' ||
    !args.command.trim() ||
    args.command.length > 16000 ||
    (args.cwd !== undefined && typeof args.cwd !== 'string')
  )
    return null
  const windows = platform === 'win32'
  let tokens: Array<Token[] | '|' | ';'> | null
  if (args.argv !== undefined) {
    if (
      !Array.isArray(args.argv) ||
      args.argv.length > 64 ||
      args.argv.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg)) ||
      args.argv.join('').length > 16000 ||
      !/^[a-zA-Z-]+$/.test(args.command)
    )
      return null
    tokens = [
      [
        { value: args.command, quoted: false },
        ...args.argv.map((value) => ({ value, quoted: false })),
      ],
    ]
  } else tokens = tokenize(args.command.trim(), windows)
  if (!tokens?.length || tokens.length > 63) return null
  const pipelines: Pipeline[] = []
  let current: Pipeline | undefined,
    pipe = false
  for (const token of tokens) {
    if (token === '|') {
      pipe = true
      continue
    }
    if (token === ';') {
      current = undefined
      pipe = false
      continue
    }
    if (pipe && current) {
      if (current.projections.at(-1)?.kind === 'format') return null
      const step = projection(token, windows)
      if (!step) return null
      current.projections.push(step)
      pipe = false
    } else {
      const query = source(token, windows)
      if (!query) return null
      current = { query, projections: [] }
      pipelines.push(current)
    }
  }
  return {
    fingerprint: fingerprint(args),
    pipelines,
    commands: tokens
      .filter((token): token is Token[] => Array.isArray(token))
      .map((words) => words[0]!.value),
  }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}
export async function grantReadOnlyTerminal(
  plan: ReadOnlyTerminalPlan,
  workspaceRoot: string,
  cwd: unknown,
  checkPath: ReadOnlyTerminalGrant['checkPath'],
  signal?: AbortSignal,
): Promise<ReadOnlyTerminalGrant | null> {
  try {
    signal?.throwIfAborted()
    const root = await realpath(workspaceRoot)
    const actual = await realpath(
      path.resolve(root, String(cwd || '.').replace(/^@principal[\\/]/i, '')),
    )
    if (!within(root, actual) || !checkPath(actual)) return null
    for (const { query } of plan.pipelines) {
      signal?.throwIfAborted()
      if (query.kind === 'pwd') continue
      const target = await realpath(path.resolve(actual, query.path))
      if (!within(root, target) || !checkPath(target)) return null
    }
    signal?.throwIfAborted()
    return { plan, root, cwd: actual, checkPath }
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

/** 执行封闭的文件读取操作；不会启动 Shell、解释器或模型指定的可执行文件。 */
export async function executeReadOnlyTerminal(
  grant: ReadOnlyTerminalGrant,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (fingerprint(args) !== grant.plan.fingerprint)
    throw new Error(
      t('errors.terminal-readonly', 'READ_ONLY_CONTEXT_CHANGED: 只读查询参数或工作区已变化'),
    )
  const check = async (target: string) => {
    signal?.throwIfAborted()
    const actual = await realpath(target)
    if (!within(grant.root, actual) || !grant.checkPath(actual))
      throw new Error(t('errors.terminal-readonly', '只读查询路径超出允许范围'))
    return actual
  }
  await check(grant.cwd)
  const text = async (target: string) => {
    const actual = await check(target)
    const before = await lstat(actual)
    if (!before.isFile() || before.size > MAX_FILE_BYTES)
      throw new Error(t('errors.terminal-readonly', '只读查询仅支持不超过 2 MiB 的普通文本文件'))
    const file = await open(actual, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > MAX_FILE_BYTES)
        throw new Error(t('errors.terminal-readonly', '只读查询仅支持不超过 2 MiB 的普通文本文件'))
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
      let length = 0
      while (length <= MAX_FILE_BYTES) {
        signal?.throwIfAborted()
        const result = await file.read(bytes, length, bytes.length - length, null)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > MAX_FILE_BYTES || bytes.subarray(0, length).includes(0))
        throw new Error(t('errors.terminal-readonly', '只读查询仅支持不超过 2 MiB 的普通文本文件'))
      return bytes.subarray(0, length).toString('utf8')
    } finally {
      await file.close()
    }
  }
  const outputs: string[] = []
  for (const pipeline of grant.plan.pipelines) {
    const query = pipeline.query
    let rows: Row[] = []
    let table = false
    if (query.kind === 'pwd') rows = [grant.cwd]
    else if (query.kind === 'list') {
      const pending = [path.resolve(grant.cwd, query.path)]
      let entries = 0
      while (pending.length) {
        const directory = await check(pending.pop()!)
        const names: Dirent[] = []
        const self = await lstat(directory)
        if (!self.isDirectory()) {
          if (!query.directories)
            rows.push({
              Name: path.basename(directory),
              FullName: directory,
              Length: self.isFile() ? self.size : 0,
              PSIsContainer: false,
              Extension: path.extname(directory),
            })
          continue
        }
        // 流式枚举并限制条目，避免为了判定上限先把整个巨大目录装入内存。
        for await (const entry of await opendir(directory)) {
          signal?.throwIfAborted()
          if (++entries > MAX_ROWS)
            throw new Error(t('errors.terminal-readonly', '只读查询条目过多，请缩小查询范围'))
          names.push(entry)
        }
        names.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of names) {
          signal?.throwIfAborted()
          if ((!query.hidden && entry.name.startsWith('.')) || entry.isSymbolicLink()) continue
          const filename = await check(path.join(directory, entry.name))
          const info = await lstat(filename)
          if (info.isSymbolicLink()) continue
          if (query.recurse && info.isDirectory()) pending.push(filename)
          if ((query.files && info.isDirectory()) || (query.directories && !info.isDirectory()))
            continue
          rows.push({
            Name: entry.name,
            FullName: filename,
            Length: info.isFile() ? info.size : 0,
            PSIsContainer: info.isDirectory(),
            Extension: path.extname(entry.name),
          })
        }
      }
    } else {
      const content = await text(path.resolve(grant.cwd, query.path))
      const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
      if (lines.at(-1) === '') lines.pop()
      if (query.kind === 'search') {
        const pattern = query.caseSensitive ? query.pattern : query.pattern.toLowerCase()
        rows = lines.flatMap((line, index) =>
          (query.caseSensitive ? line : line.toLowerCase()).includes(pattern)
            ? [`${query.path}:${index + 1}:${line}`]
            : [],
        )
      } else
        rows = query.raw
          ? [content]
          : query.first !== undefined
            ? lines.slice(0, query.first)
            : query.last !== undefined
              ? query.last === 0
                ? []
                : lines.slice(-query.last)
              : lines
    }
    for (const step of pipeline.projections) {
      if (step.kind === 'sort') {
        const properties = step.fields.length ? step.fields : ['Name']
        rows.sort((a, b) => {
          for (const property of properties) {
            const left =
              typeof a === 'string' ? (property === 'Length' ? a.length : a) : (a[property] ?? '')
            const right =
              typeof b === 'string' ? (property === 'Length' ? b.length : b) : (b[property] ?? '')
            const order =
              typeof left === 'number' && typeof right === 'number'
                ? left - right
                : String(left).localeCompare(String(right))
            if (order) return step.descending ? -order : order
          }
          return 0
        })
      } else {
        table ||= step.kind === 'format'
        if (step.first !== undefined) rows = rows.slice(0, step.first)
        if (step.last !== undefined) rows = step.last === 0 ? [] : rows.slice(-step.last)
        if (step.fields.length)
          rows = rows.map((row) =>
            Object.fromEntries(
              step.fields.map((key) => [
                key,
                typeof row === 'string' ? (key === 'Length' ? row.length : '') : (row[key] ?? ''),
              ]),
            ),
          )
      }
    }
    const header = table && rows[0] && typeof rows[0] !== 'string' ? Object.keys(rows[0]) : []
    outputs.push(
      header.length
        ? [
            header.join('\t'),
            ...rows.map((row) =>
              header.map((key) => (typeof row === 'string' ? '' : row[key])).join('\t'),
            ),
          ].join('\n')
        : rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n'),
    )
    if (Buffer.byteLength(outputs.join('\n')) > MAX_FILE_BYTES)
      throw new Error(t('errors.terminal-readonly', '只读查询条目过多，请缩小查询范围'))
  }
  signal?.throwIfAborted()
  return outputs.join('\n')
}
