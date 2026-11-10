import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ExecutionSession } from './executionSession'
import { WorkspaceError, WS_ERROR, type VirtualWorkspace, diffLines } from './virtualWorkspace'

interface Span {
  start: number
  end: number
}
interface Reference {
  owner: string
  path: string
  hash: string
  expires: number
  range?: { start: number; end: number }
  lines?: { start: number; end: number }
}
interface Ticket {
  owner: string
  args: Record<string, unknown>
  hash: string
  expires: number
  candidates: Span[]
  bytes: number
}
const references = new Map<string, Reference>()
const tickets = new Map<string, Ticket>()
const MAX_REFERENCES = 4096
const MAX_TICKET_BYTES = 32 * 1024 * 1024
const LIFETIME_MS = 30 * 60_000
let expiryTimer: ReturnType<typeof setTimeout> | undefined
export const fileEditOwner = (session: ExecutionSession, realmId?: string) =>
  JSON.stringify([session.id, session.ownerAgentId, session.threadId, session.taskId, realmId])

function sweep(): void {
  for (const map of [references, tickets])
    for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key)
}

function scheduleExpiry(): void {
  if (expiryTimer || (!references.size && !tickets.size)) return
  const expires = Math.min(
    ...[...references.values(), ...tickets.values()].map((entry) => entry.expires),
  )
  expiryTimer = setTimeout(
    () => {
      expiryTimer = undefined
      sweep()
      scheduleExpiry()
    },
    Math.max(1, expires - Date.now()),
  )
  expiryTimer.unref()
}

export function createReadReference(
  owner: string,
  path: string,
  result: { hash: string; content: string; lineStart?: number; lineEnd?: number },
  offset = 0,
): string | undefined {
  if (
    !result.content.length ||
    (result.lineEnd !== undefined && result.lineStart! > result.lineEnd)
  )
    return
  sweep()
  while (references.size >= MAX_REFERENCES) references.delete(references.keys().next().value!)
  const ref = `read:${randomUUID()}`
  references.set(ref, {
    owner,
    path,
    hash: result.hash,
    expires: Date.now() + LIFETIME_MS,
    ...(result.lineStart !== undefined && result.lineEnd !== undefined
      ? { lines: { start: result.lineStart, end: result.lineEnd } }
      : { range: { start: offset, end: offset + result.content.length } }),
  })
  scheduleExpiry()
  return ref
}

function reference(ref: unknown, owner: string): Reference {
  sweep()
  const value = typeof ref === 'string' ? references.get(ref) : undefined
  if (!value || value.owner !== owner)
    throw new Error('读取引用已失效或不属于当前会话，请重新读取文件')
  return value
}

/** 只向受权预览提供引用的位置与版本，不延长有效期或改变候选状态。 */
export function fileEditPreviewReference(ref: string, owner: string) {
  const value = reference(ref, owner)
  return {
    path: value.path,
    hash: value.hash,
    range: value.range ? { ...value.range } : undefined,
    lines: value.lines ? { ...value.lines } : undefined,
  }
}

/** 审批前仅解析目标身份；实际执行仍重新核验权限、版本和范围。 */
export function prepareFileEditArguments(
  args: Record<string, unknown>,
  owner: string,
): Record<string, unknown> {
  if (args.ticket_id !== undefined) {
    sweep()
    const ticket = tickets.get(String(args.ticket_id))
    if (!ticket || ticket.owner !== owner)
      throw new Error('编辑候选已失效或不属于当前会话，请重新准备编辑')
    if (
      Object.keys(args).some(
        (key) =>
          !['ticket_id', 'pick', 'path', 'expected_hash'].includes(key) &&
          JSON.stringify(args[key]) !== JSON.stringify(ticket.args[key]),
      )
    )
      throw new Error('候选选择只能提供 ticket_id 和 pick，不能改变原修改内容')
    if (args.path !== undefined && args.path !== ticket.args.path)
      throw new Error('候选目标文件不允许改变')
    const pick = Number(args.pick)
    if (!Number.isSafeInteger(pick) || pick < 1 || pick > ticket.candidates.length)
      throw new Error('pick 必须是候选列表中有效的序号')
    return { ...ticket.args, expected_hash: ticket.hash, ticket_id: args.ticket_id, pick }
  }
  if (args.steps !== undefined && (!Array.isArray(args.steps) || !args.steps.length))
    throw new Error('steps 必须是非空数组')
  if (
    args.steps &&
    ['read_ref', 'old_text', 'new_text', 'line_start', 'line_end', 'after_line'].some(
      (key) => args[key] !== undefined,
    )
  )
    throw new Error('steps 不能与顶层单步编辑参数混用')
  const steps = Array.isArray(args.steps) ? args.steps : [args]
  let resolvedPath = typeof args.path === 'string' ? args.path : undefined
  let hash = typeof args.expected_hash === 'string' ? args.expected_hash : undefined
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step))
      throw new Error('编辑步骤必须是对象')
    if (step.read_ref !== undefined) {
      const ref = reference(step.read_ref, owner)
      if (resolvedPath && resolvedPath !== ref.path)
        throw new Error('同一批编辑只能使用同一文件的引用，请省略冗余 path')
      if (hash && hash !== ref.hash) throw new Error('同一批编辑引用的文件版本不一致')
      resolvedPath = ref.path
      hash = ref.hash
    }
  }
  if (!resolvedPath) throw new Error('编辑需要 path 或有效的 read_ref')
  return { ...args, path: resolvedPath, ...(hash ? { expected_hash: hash } : {}) }
}

function lineSpans(text: string): Span[] {
  const spans: Span[] = []
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g
  for (const match of text.matchAll(pattern)) {
    if (!match[0].length) break
    spans.push({ start: match.index, end: match.index + match[0].length })
  }
  if (!spans.length) spans.push({ start: 0, end: 0 })
  return spans
}

function exactMatches(text: string, target: string): Span[] {
  const spans: Span[] = []
  let offset = 0
  while (offset <= text.length) {
    const index = text.indexOf(target, offset)
    if (index < 0) break
    spans.push({ start: index, end: index + target.length })
    offset = index + Math.max(1, target.length)
  }
  return spans
}

export async function applyFileEdits(
  workspace: VirtualWorkspace,
  session: ExecutionSession,
  raw: Record<string, unknown>,
  options: {
    owner: string
    approved?: boolean
    signal?: AbortSignal
    afterWrite?: (
      captured: unknown,
      written: { oldHash?: string; newHash: string },
    ) => Promise<void>
  },
  beforeWrite?: (filePath: string, next: Buffer) => Promise<unknown>,
) {
  const args = prepareFileEditArguments(raw, options.owner)
  return workspace.withFileMutation(
    session,
    String(args.path),
    options.approved,
    async (filePath) => {
      options.signal?.throwIfAborted()
      const bytes = await readFile(filePath)
      if (bytes.subarray(0, 8000).includes(0)) throw new Error('二进制文件不能使用文本编辑')
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (args.expected_hash && args.expected_hash !== hash)
        throw new WorkspaceError(
          WS_ERROR.EDIT_HASH_MISMATCH,
          '文件版本已经变化，请重新读取后再编辑',
        )
      const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\uFEFF' : ''
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
      const lines = lineSpans(text)
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      const steps = Array.isArray(args.steps) ? args.steps : [args]
      if (!steps.length) throw new Error('steps 不能为空')
      const edits: Array<Span & { content: string }> = []
      for (const step of steps) {
        const modes = [
          step.read_ref !== undefined,
          step.old_text !== undefined,
          step.line_start !== undefined || step.after_line !== undefined,
        ].filter(Boolean).length
        if (modes !== 1) throw new Error('每一步必须且只能选择 read_ref、old_text 或行定位之一')
        if (typeof step.new_text !== 'string')
          throw new Error('每一步的 new_text 必须是字符串；删除时传空字符串')
        if (
          step.after_line !== undefined &&
          (step.line_start !== undefined || step.line_end !== undefined)
        )
          throw new Error('after_line 不能与替换行范围混用')
        let span: Span
        let content = step.new_text.replace(/\r\n|\n/g, eol)
        if (step.read_ref !== undefined) {
          const ref = reference(step.read_ref, options.owner)
          if (ref.path !== filePath || ref.hash !== hash)
            throw new Error('读取引用的文件或版本已经变化，请重新读取')
          if (ref.lines && (!lines[ref.lines.start - 1] || !lines[ref.lines.end - 1]))
            throw new Error('读取引用的行范围已经失效')
          span = ref.range ?? {
            start: lines[ref.lines!.start - 1]!.start,
            end: lines[ref.lines!.end - 1]!.end,
          }
          // 范围读取不包含最后一行的行终止符，引用替换同样保留它。
          if (ref.lines) {
            const tail = text.slice(span.start, span.end).match(/(?:\r\n|\n|\r)$/)?.[0]
            if (tail) span = { ...span, end: span.end - tail.length }
          }
        } else if (step.old_text !== undefined) {
          if (typeof step.old_text !== 'string' || !step.old_text.length)
            throw new Error('old_text 不能为空')
          const candidates = exactMatches(text, step.old_text.replace(/\r\n|\n/g, eol))
          if (!candidates.length)
            throw new WorkspaceError(WS_ERROR.EDIT_NOT_FOUND, 'old_text 未匹配，请重新读取相关片段')
          if (candidates.length > 1 && args.ticket_id === undefined) {
            if (steps.length !== 1)
              throw new Error('批量步骤存在歧义，请先用行范围或读取引用明确定位')
            const ticketBytes = Buffer.byteLength(JSON.stringify(args)) + candidates.length * 16
            if (ticketBytes > MAX_TICKET_BYTES)
              throw new Error('歧义编辑正文过大，请用 read_ref 或版本化行范围明确定位')
            while (tickets.size >= MAX_REFERENCES) tickets.delete(tickets.keys().next().value!)
            let retained = [...tickets.values()].reduce((sum, ticket) => sum + ticket.bytes, 0)
            while (retained + ticketBytes > MAX_TICKET_BYTES && tickets.size) {
              const oldest = tickets.keys().next().value!
              retained -= tickets.get(oldest)!.bytes
              tickets.delete(oldest)
            }
            const ticketId = `edit:${randomUUID()}`
            tickets.set(ticketId, {
              owner: options.owner,
              args: { ...args },
              hash,
              candidates,
              bytes: ticketBytes,
              expires: Date.now() + LIFETIME_MS,
            })
            scheduleExpiry()
            return {
              success: false as const,
              needsSelection: true,
              ticketId,
              path: filePath,
              hash,
              candidates: candidates.map((candidate, index) => ({
                pick: index + 1,
                line: text.slice(0, candidate.start).split('\n').length,
                preview: text.slice(Math.max(0, candidate.start - 80), candidate.end + 80),
              })),
            }
          }
          span = candidates[args.ticket_id ? Number(args.pick) - 1 : 0]!
          if (!span) throw new Error('候选已失效，请重新准备编辑')
        } else {
          if (!args.expected_hash) throw new Error('行定位编辑必须携带 expected_hash')
          if (step.after_line !== undefined) {
            const after = Number(step.after_line)
            if (!Number.isSafeInteger(after) || after < 0 || after > lines.length)
              throw new Error('after_line 超出文件范围')
            const at = after === 0 ? 0 : lines[after - 1]!.end
            span = { start: at, end: at }
            if (content.length) {
              if (after > 0 && at === text.length && !/[\r\n]$/.test(text)) content = eol + content
              if (at < text.length && !/[\r\n]$/.test(content)) content += eol
            }
          } else {
            const start = Number(step.line_start)
            const end = Number(step.line_end ?? start)
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start < 1 ||
              end < start ||
              end > lines.length
            )
              throw new Error('编辑行范围无效或超出文件范围')
            span = { start: lines[start - 1]!.start, end: lines[end - 1]!.end }
            const tail = text.slice(span.start, span.end).match(/(?:\r\n|\n|\r)$/)?.[0]
            if (tail && step.new_text.length) span.end -= tail.length
          }
        }
        if (span.start < 0 || span.end > text.length) throw new Error('读取引用的范围已失效')
        edits.push({ ...span, content })
      }
      edits.sort((a, b) => a.start - b.start || a.end - b.end)
      for (let index = 1; index < edits.length; index++) {
        const previous = edits[index - 1]!,
          current = edits[index]!
        if (current.start < previous.end || current.start === previous.start)
          throw new Error('编辑范围重叠或存在同点插入，整批未写入')
      }
      let next = text
      for (const edit of [...edits].reverse())
        next = next.slice(0, edit.start) + edit.content + next.slice(edit.end)
      if (next === text) throw new WorkspaceError(WS_ERROR.EDIT_NO_CHANGES, '编辑没有产生实际变化')
      const captured = await beforeWrite?.(filePath, Buffer.from(bom + next))
      options.signal?.throwIfAborted()
      if (
        createHash('sha256')
          .update(await readFile(filePath))
          .digest('hex') !== hash
      )
        throw new WorkspaceError(
          WS_ERROR.EDIT_HASH_MISMATCH,
          '提交前文件已变化，整批未写入，请重新读取',
        )
      const after = bom + next
      await workspace.atomicWrite(filePath, after)
      if (args.ticket_id) tickets.delete(String(args.ticket_id))
      const newHash = createHash('sha256').update(after).digest('hex')
      let checkpointWarning: string | undefined
      try {
        await options.afterWrite?.(captured, { oldHash: hash, newHash })
      } catch {
        checkpointWarning = '文件已写入，但检查点保存失败；请核对当前文件，不要重复应用编辑。'
      }
      return {
        success: true as const,
        operation: 'edit',
        path: filePath,
        sourceRef: filePath,
        oldHash: hash,
        newHash,
        checkpointWarning,
        ...diffLines(text, next),
        editRange: {
          startLine: text.slice(0, edits[0]!.start).split('\n').length,
          endLine: text.slice(0, edits.at(-1)!.end).split('\n').length,
        },
        ranges: edits.map(({ start, end }) => ({ start, end })),
        beforeText: text,
        afterText: next,
      }
    },
  )
}

export function releaseFileEditReferences(owner: {
  agentId?: string
  threadId?: string
  taskId?: string
}): void {
  for (const map of [references, tickets])
    for (const [key, value] of map) {
      const [, agentId, threadId, taskId] = JSON.parse(value.owner)
      if (
        (!owner.agentId || owner.agentId === agentId) &&
        (!owner.threadId || owner.threadId === threadId) &&
        (!owner.taskId || owner.taskId === taskId)
      )
        map.delete(key)
    }
  if (!references.size && !tickets.size && expiryTimer) {
    clearTimeout(expiryTimer)
    expiryTimer = undefined
  }
}
