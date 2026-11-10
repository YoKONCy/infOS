/**
 * 表达层标记的会话级缓存。
 *
 * 每个会话只查一次，所有气泡共用结果；查询失败（后端版本旧、接口 404）时
 * 该会话标为不可用，气泡上的入口整体隐藏，隔一段时间再有气泡挂载时重试。
 */
import { shallowReactive } from 'vue'
import { EXPRESSION_MARKS_MAX_PAGE_SIZE, normalizeExpressionQuote } from '@infos/shared'
import { t as __t } from '../../i18n/index'
import { expressionApi } from '../../api/modules/expressionApi'
import { useNotificationStore } from '../../stores/useNotificationStore'
import type { ExpressionMark, ExpressionMarkKind, ExpressionTarget } from './expressionTypes'

type ThreadState = 'loading' | 'ready' | 'unavailable'

interface ThreadEntry {
  state: ThreadState
  checkedAt: number
  byMessage: Map<string, ExpressionMark[]>
}

const MAX_PAGES = 50
const RETRY_AFTER_MS = 60_000

const threads = shallowReactive(new Map<string, ThreadEntry>())
const busyMessages = shallowReactive(new Set<string>())
const pending = new Map<string, Promise<void>>()

const threadKey = (agentId: string, threadId: string) => JSON.stringify([agentId, threadId])

/** 选中文字两端和内部的空白因渲染而异，比较时一律忽略。 */
export function sameQuote(a: string, b: string): boolean {
  return normalizeExpressionQuote(a) === normalizeExpressionQuote(b)
}

export function ensureThreadMarks(agentId: string, threadId: string): Promise<void> {
  const key = threadKey(agentId, threadId)
  const running = pending.get(key)
  if (running) return running
  const entry = threads.get(key)
  if (entry?.state === 'ready') return Promise.resolve()
  if (entry?.state === 'unavailable' && Date.now() - entry.checkedAt < RETRY_AFTER_MS)
    return Promise.resolve()
  const fresh: ThreadEntry = shallowReactive({
    state: 'loading' as ThreadState,
    checkedAt: Date.now(),
    byMessage: shallowReactive(new Map<string, ExpressionMark[]>()),
  })
  threads.set(key, fresh)
  const task = loadThread(agentId, threadId, fresh).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

async function loadThread(agentId: string, threadId: string, entry: ThreadEntry): Promise<void> {
  try {
    const items: ExpressionMark[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await expressionApi.listMarks({
        agentId,
        threadId,
        page,
        pageSize: EXPRESSION_MARKS_MAX_PAGE_SIZE,
      })
      const data = response.data
      if (!data || !Array.isArray(data.items)) throw new Error('invalid expression marks')
      items.push(...data.items)
      if (!data.items.length || items.length >= data.total) break
    }
    const grouped = new Map<string, ExpressionMark[]>()
    for (const mark of items) {
      const key = String(mark.messageId)
      grouped.set(key, [...(grouped.get(key) ?? []), mark])
    }
    for (const [messageId, marks] of grouped) entry.byMessage.set(messageId, sortMarks(marks))
    entry.state = 'ready'
  } catch {
    // 入口隐藏即可，不打扰聊天；管理页会单独说明原因。
    entry.state = 'unavailable'
  }
  entry.checkedAt = Date.now()
}

const sortMarks = (marks: ExpressionMark[]) => [...marks].sort((a, b) => a.createdAt - b.createdAt)

export function isExpressionReady(target: ExpressionTarget | null): boolean {
  return Boolean(
    target && threads.get(threadKey(target.agentId, target.threadId))?.state === 'ready',
  )
}

export function marksOf(target: ExpressionTarget | null): ExpressionMark[] {
  if (!target) return []
  return (
    threads.get(threadKey(target.agentId, target.threadId))?.byMessage.get(target.messageId) ?? []
  )
}

export function isMessageBusy(messageId: string): boolean {
  return busyMessages.has(messageId)
}

/** 写入缓存；管理页改动后也走这里，让打开着的气泡立刻同步。 */
export function syncMark(mark: ExpressionMark): void {
  const byMessage = threads.get(threadKey(mark.agentId, mark.threadId))?.byMessage
  if (!byMessage) return
  const key = String(mark.messageId)
  const others = (byMessage.get(key) ?? []).filter((item) => item.id !== mark.id)
  byMessage.set(key, sortMarks([...others, mark]))
}

export function forgetMark(mark: ExpressionMark): void {
  const byMessage = threads.get(threadKey(mark.agentId, mark.threadId))?.byMessage
  if (!byMessage) return
  const key = String(mark.messageId)
  const left = (byMessage.get(key) ?? []).filter((item) => item.id !== mark.id)
  if (left.length) byMessage.set(key, left)
  else byMessage.delete(key)
}

/** 同一消息一次只跑一个写操作，防止连点造成重复标记。失败时提示并返回 false。 */
async function write(messageId: string, action: () => Promise<void>): Promise<boolean> {
  if (busyMessages.has(messageId)) return false
  busyMessages.add(messageId)
  try {
    await action()
    return true
  } catch (error) {
    useNotificationStore().toast(
      error instanceof Error && error.message ? error.message : __t('ui.chat', '保存失败'),
      'error',
    )
    return false
  } finally {
    busyMessages.delete(messageId)
  }
}

function requireMark(data: ExpressionMark | undefined): ExpressionMark {
  if (!data) throw new Error(__t('ui.chat', '保存失败'))
  return data
}

/** 同一句同一类再点一次取消；点另一类改成另一类，不留下互相矛盾的两条。 */
export function toggleMark(
  target: ExpressionTarget,
  quote: string,
  kind: ExpressionMarkKind,
): Promise<boolean> {
  const existing = marksOf(target).find((mark) => sameQuote(mark.quote, quote))
  if (existing?.kind === kind) return removeMark(existing)
  return write(target.messageId, async () => {
    const response = existing
      ? await expressionApi.updateMark(existing.id, { kind })
      : await expressionApi.createMark({ ...target, kind, ...(quote ? { quote } : {}) })
    syncMark(requireMark(response.data))
  })
}

export function saveNote(
  target: ExpressionTarget,
  input: { markId?: string; quote: string; kind: ExpressionMarkKind; note: string },
): Promise<boolean> {
  return write(target.messageId, async () => {
    const response = input.markId
      ? await expressionApi.updateMark(input.markId, { kind: input.kind, note: input.note })
      : await expressionApi.createMark({
          ...target,
          kind: input.kind,
          note: input.note,
          ...(input.quote ? { quote: input.quote } : {}),
        })
    syncMark(requireMark(response.data))
  })
}

export function removeMark(mark: ExpressionMark): Promise<boolean> {
  return write(String(mark.messageId), async () => {
    await expressionApi.deleteMark(mark.id)
    forgetMark(mark)
  })
}

/** 仅供测试：清空模块级缓存。 */
export function resetExpressionMarks(): void {
  threads.clear()
  pending.clear()
  busyMessages.clear()
}
