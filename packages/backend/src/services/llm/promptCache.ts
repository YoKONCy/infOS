import { t as __t } from '../../lib/i18n'
import { createHash } from 'node:crypto'
import type { ChatMessage, ToolDefinition } from './types'
import { releaseFileEditReferences } from '../execution/fileEditing'
import { releaseToolObservations } from '../execution/toolObservation'
import { createLogger } from '../../lib/logger'
import { compareToolNames } from '../agent/toolOrder'

const logger = createLogger('PromptReplay')

/** 对象键固定排序，数组与模型返回的原生数据顺序保持原样。 */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  )
}

export function promptFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)) ?? 'null')
    .digest('hex')
}

export function canonicalTools(tools?: ToolDefinition[]): ToolDefinition[] | undefined {
  return (
    tools
      ?.map((tool) => canonicalValue(tool) as ToolDefinition)
      // 动态工具排在末尾，上下线不改变常驻工具前缀。
      .sort((a, b) => compareToolNames(a.function.name, b.function.name))
  )
}

export function historyKey(message: ChatMessage): string {
  return message.cacheControl?.key ?? promptFingerprint([message.role, message.content])
}

/** 状态变化只追加到尾部，保持已经发送给模型的消息前缀不变。 */
export function appendPromptSnapshot(
  messages: ChatMessage[],
  key: string,
  content: string,
  attributes: Pick<ChatMessage, 'fileObservations'> = {},
): boolean {
  const previous = [...messages].reverse().find((message) => message.cacheControl?.key === key)
  if (previous?.content === content) return false
  messages.push({
    ...attributes,
    role: 'user',
    content,
    cacheControl: { kind: 'snapshot', key },
  })
  return true
}

interface Entry {
  fingerprint: string
  expected: string[]
  reply: string
  deliveries?: Array<{ key: string; reply: string }>
  messages: ChatMessage[]
  expires: number
  bytes: number
}

let privacyEpoch = 0
const entries = new Map<string, Entry>()
const MAX_BYTES = 32 * 1024 * 1024
let expiryTimer: ReturnType<typeof setTimeout> | undefined
function scheduleExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = undefined
  if (!entries.size) return
  const expires = Math.min(...[...entries.values()].map((entry) => entry.expires))
  expiryTimer = setTimeout(
    () => {
      for (const [key, entry] of entries) if (entry.expires <= Date.now()) entries.delete(key)
      scheduleExpiry()
    },
    Math.max(1, expires - Date.now()),
  )
  expiryTimer.unref()
}

/** 永久遗忘立即释放所有热轨迹；不把读取正文或图片写入持久化数据库。 */
export function promptReplayGeneration(): number {
  return privacyEpoch
}

export function invalidatePromptReplay(scope?: string, deleteStored = false): void {
  releaseFileEditReferences(scope ? { threadId: scope } : {})
  releaseToolObservations(scope ? { threadId: scope } : {}, deleteStored)
  privacyEpoch++
  if (!scope) entries.clear()
  else
    for (const key of entries.keys())
      if (key.endsWith(`:${scope}`) || key.startsWith(scope)) entries.delete(key)
  scheduleExpiry()
}

/** 仅在历史仍为原始前缀、权限和模型一致时续接真实轨迹；冷启动从规范历史重新编译。 */
export function preparePromptReplay(scope: string, input: ChatMessage[], identity: unknown) {
  const epoch = privacyEpoch
  // 一条持久化回复可展开为数百条工具消息；按来源消息校验，而非按展开后的条数匹配。
  const history: Array<{ key: string; messages: ChatMessage[]; lastIndex: number }> = []
  input.forEach((message, index) => {
    if (message.cacheControl?.kind !== 'history') return
    const key = message.cacheControl.historySourceKey ?? historyKey(message)
    const previous = history.at(-1)
    if (previous?.key === key && message.cacheControl.historySourceKey !== undefined) {
      previous.messages.push(message)
      previous.lastIndex = index
    } else history.push({ key, messages: [message], lastIndex: index })
  })
  const keys = history.map((group) => group.key)
  const firstHistory = input.findIndex((message) => message.cacheControl?.kind === 'history')
  let lastHistory = -1
  for (let index = input.length - 1; index >= 0; index--) {
    if (input[index]?.cacheControl?.kind === 'history') {
      lastHistory = index
      break
    }
  }
  const ordered =
    firstHistory < 0 ||
    (input.slice(0, firstHistory).every((message) => message.role === 'system') &&
      input
        .slice(firstHistory, lastHistory + 1)
        .every((message) => message.cacheControl?.kind === 'history'))
  const fingerprint = promptFingerprint([
    identity,
    input
      .filter((message) => message.role === 'system')
      .map(({ role, content }) => ({ role, content })),
  ])
  const previous = entries.get(scope)
  entries.delete(scope)
  const replyGroup = previous && history[previous.expected.length]
  const replyMessage = replyGroup?.messages.at(-1)
  const deliveriesMatch = previous?.deliveries?.length
    ? previous.deliveries.every((delivery, index) => {
        const group = history[previous.expected.length + index]
        const message = group?.messages.at(-1)
        return (
          group?.key === delivery.key &&
          message?.role === 'assistant' &&
          !group.messages.some((item) => item.cacheControl?.edited) &&
          (message.cacheControl?.reply ?? message.content) === delivery.reply
        )
      })
    : replyMessage?.role === 'assistant' &&
      !replyGroup?.messages.some((message) => message.cacheControl?.edited) &&
      (replyMessage.cacheControl?.reply ?? replyMessage.content) === previous?.reply
  const compatible =
    ordered &&
    previous &&
    previous.expires > Date.now() &&
    previous.fingerprint === fingerprint &&
    previous.expected.every((key, index) => keys[index] === key) &&
    deliveriesMatch
  const reason = compatible
    ? '完整轨迹已复用'
    : !previous
      ? '无可用热轨迹或进程已重启'
      : previous.expires <= Date.now()
        ? '热轨迹已过期'
        : !ordered
          ? '历史消息布局不连续'
          : previous.fingerprint !== fingerprint
            ? '模型、工具或系统前缀发生变化'
            : !previous.expected.every((key, index) => keys[index] === key)
              ? '历史滑出、撤回或内容发生变化'
              : '已送达消息组缺失、顺序变化或被修改'
  logger.debug(__t('logs.llm', '提示词轨迹续接'), {
    scope,
    reused: Boolean(compatible),
    reason,
    historyMessages: history.length,
    deliveredMessages: previous?.deliveries?.length ?? (previous ? 1 : 0),
  })
  let messages = structuredClone(input)
  const turnStart = messages.find(
    (message) => message.role !== 'system' && message.cacheControl?.kind !== 'history',
  )
  if (turnStart)
    turnStart.cacheControl = {
      ...turnStart.cacheControl,
      kind: turnStart.cacheControl?.kind ?? 'snapshot',
      turnStart: true,
    }
  if (compatible) {
    const consumed = previous.expected.length + (previous.deliveries?.length || 1)
    const consumedThrough = history[consumed - 1]!.lastIndex
    const tail = messages.filter((message, index) => {
      if (message.role === 'system') return false
      if (message.cacheControl?.kind === 'history') return index > consumedThrough
      return true
    })
    messages = [...structuredClone(previous.messages), ...structuredClone(tail)]
  }
  return {
    messages,
    reused: Boolean(compatible),
    reason,
    commit(
      transcript: ChatMessage[],
      visibleReply: string,
      deliveries?: Array<{ key: string; reply: string }>,
    ): void {
      if (epoch !== privacyEpoch || !visibleReply.trim()) return
      const last = transcript.at(-1)
      if (
        last?.role === 'assistant' &&
        !last.toolCalls?.length &&
        !(typeof last.content === 'string' ? last.content.trim() : last.content?.length)
      )
        return
      const expected = [
        ...keys,
        ...input.flatMap((message) => message.cacheControl?.currentKeys ?? []),
      ]
      const bytes = Buffer.byteLength(JSON.stringify(transcript), 'utf8')
      if (bytes > MAX_BYTES / 2) return
      for (const [key, entry] of entries) if (entry.expires <= Date.now()) entries.delete(key)
      entries.set(scope, {
        fingerprint,
        expected,
        reply: visibleReply,
        deliveries: deliveries?.length ? structuredClone(deliveries) : undefined,
        messages: structuredClone(transcript),
        bytes,
        expires: Date.now() + 30 * 60_000,
      })
      let total = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
      while (entries.size > 64 || total > MAX_BYTES) {
        const oldest = entries.keys().next().value as string
        total -= entries.get(oldest)!.bytes
        entries.delete(oldest)
      }
      scheduleExpiry()
    },
  }
}

/** 按本轮快照边界移除整段旧轨迹，工具调用、结果和原生思考一起退出。 */
export function trimOldestPromptRound(messages: ChatMessage[]): boolean {
  const starts = messages.flatMap((message, index) =>
    message.cacheControl?.turnStart ? [index] : [],
  )
  if (starts.length < 2) {
    const firstHistory = messages.findIndex((message) => message.cacheControl?.kind === 'history')
    if (firstHistory < 0) return false
    let end = firstHistory
    let replied = false
    while (end < messages.length && messages[end]!.cacheControl?.kind === 'history') {
      const message = messages[end]!
      if (replied && message.role === 'user') break
      if (message.role === 'assistant') replied = true
      end++
    }
    messages.splice(firstHistory, end - firstHistory)
    return true
  }
  const first = messages.findIndex((message) => message.role !== 'system')
  if (first < 0 || starts[1]! <= first) return false
  messages.splice(first, starts[1]! - first)
  return true
}

/** 保留完整轮次，达到上限时批量移除四分之一，为后续追加留出空间。 */
const windows = new Map<string, { first: string; limit: number }>()
export function stableHistoryWindow<T>(
  scope: string,
  items: T[],
  limit: number,
  key: (item: T) => string,
  align?: (selected: T[]) => T[],
): T[] {
  if (limit <= 0) return items
  const previous = windows.get(scope)
  const start =
    previous?.limit === limit ? items.findIndex((item) => key(item) === previous.first) : -1
  let selected = start >= 0 ? items.slice(start) : items
  if (selected.length > limit) {
    selected = selected.slice(-Math.max(1, limit - Math.ceil(limit / 4)))
    if (align) selected = align(selected)
  }
  if (selected.length) {
    windows.delete(scope)
    windows.set(scope, { first: key(selected[0]!), limit })
    if (windows.size > 512) windows.delete(windows.keys().next().value as string)
  }
  return selected
}
