import { createHash } from 'node:crypto'
import type { EventNote } from '@infos/shared'
import { formatEventTime } from './eventMemoryTime'
import { tokenCounter } from '../tokenizer/tokenCounter'

/**
 * 自动 RAG 的最终选择：把直接命中与固定补充合成注入列表，并在记忆专属预算内保留完整事件。
 *
 * 只做纯计算，不访问 Store；EventMemoryService 负责检索与状态校验。
 */

/** 事件进入注入列表的理由；数值越小优先级越高。 */
export type AutomaticRagReason = 'direct' | 'latest' | 'previous'

const REASON_PRIORITY: Record<AutomaticRagReason, number> = {
  direct: 0,
  latest: 1,
  previous: 2,
}

export interface AutomaticRagCandidate {
  note: EventNote
  reason: AutomaticRagReason
  /** 直接命中的名次；固定补充为其所依附命中的名次，末尾事件为 -1。 */
  rank: number
  /** 直接前驱所依附的命中事件 ID；命中被舍弃时前驱也失去注入理由。 */
  anchorId?: string
}

const MEMORY_CONTEXT_OPEN = '<memory_context kind="event_notes">'
const MEMORY_CONTEXT_CLOSE = '</memory_context>'

/** 单条事件的注入文本；预算计数与 ContextCompiler 共用同一格式。 */
export function formatEventNoteLine(note: EventNote): string {
  return (
    `<event_note id="${note.id}" event_at="${formatEventTime(note.eventAt)}">` +
    note.narrative +
    '</event_note>'
  )
}

/** 生成 memory_context 区块；无事件时返回空字符串。 */
export function formatMemoryContext(notes: EventNote[]): string {
  if (!notes.length) return ''
  return [MEMORY_CONTEXT_OPEN, ...notes.map(formatEventNoteLine), MEMORY_CONTEXT_CLOSE].join('\n')
}

/**
 * 按“末尾 → 命中 → 其前驱 → 下一命中……”的展示顺序构造候选，同一 ID 只保留首个位置，
 * 理由取其中优先级最高者（例如既是末尾又是直接命中时按直接命中计）。
 */
export function buildAutomaticRagCandidates(
  hits: EventNote[],
  latest: EventNote | undefined,
  previousOf: (note: EventNote) => EventNote | undefined,
  /** 直接前驱限额，按命中名次分配；缺省不限。 */
  maxPrevious = Number.POSITIVE_INFINITY,
): AutomaticRagCandidate[] {
  const ordered: AutomaticRagCandidate[] = []
  if (latest) ordered.push({ note: latest, reason: 'latest', rank: -1 })
  hits.forEach((hit, rank) => {
    ordered.push({ note: hit, reason: 'direct', rank })
    const previous = rank < maxPrevious ? previousOf(hit) : undefined
    if (previous) ordered.push({ note: previous, reason: 'previous', rank, anchorId: hit.id })
  })
  const byId = new Map<string, AutomaticRagCandidate>()
  for (const candidate of ordered) {
    const existing = byId.get(candidate.note.id)
    if (!existing) {
      byId.set(candidate.note.id, candidate)
      continue
    }
    if (REASON_PRIORITY[candidate.reason] < REASON_PRIORITY[existing.reason]) {
      // 保留展示位置，只升级理由
      byId.set(candidate.note.id, { ...candidate, note: existing.note })
    }
  }
  return [...byId.values()]
}

/**
 * 本轮模型可见的对话来源，用于来源去重。
 * - `messageIds`：本轮实际进入上下文的 user/assistant 消息（含当前输入）；
 * - `completePairIds`：用户与助手两侧都可见的历史对话对，不含当前对话对。
 */
export interface VisibleMemorySource {
  threadId: string
  messageIds: string[]
  messageRevisions?: Record<string, number>
  completePairIds: string[]
}

/**
 * 事件原文是否已全部出现在本轮可见历史中。
 *
 * 只有来源被完整覆盖时才排除：任何一条来源消息不可见（例如当前对话对里尚未显示的旧回复、
 * 窗口之外的较早消息），摘要都可能含有模型看不到的信息，必须保留。
 * 人工修订过的事件正文可能补充了原对话之外的内容，不按来源排除。
 */
export function isSourceVisible(
  note: EventNote,
  visible: VisibleMemorySource | undefined,
): boolean {
  if (!visible || note.origin.manualEdit) return false
  const messageIds = new Set(visible.messageIds)
  const pairIds = new Set(visible.completePairIds)
  const sources = note.origin.sources?.length ? note.origin.sources : [note.origin]
  return sources.every((source) => {
    if (source.threadId !== visible.threadId || source.experienceIds?.length || source.manualEdit)
      return false
    if (source.messageIds.length)
      return source.messageIds.every((id) => {
        const key = String(id)
        const revision = visible.messageRevisions?.[key] ?? 1
        return messageIds.has(key) && revision === (source.messageRevisions?.[key] ?? 1)
      })
    return source.pairIds.length > 0 && source.pairIds.every((id) => pairIds.has(id))
  })
}

/** 由本轮装配进上下文的消息计算可见来源；只统计 user/assistant 正文。 */
export function buildVisibleMemorySource(
  threadId: string,
  messages: ReadonlyArray<{ id: number; role: string; revision?: number; pairId?: string | null }>,
  currentPairId?: string,
): VisibleMemorySource {
  const conversation = messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  )
  const sides = new Map<string, Set<string>>()
  const revisedPairs = new Set<string>()
  for (const message of conversation) {
    if (!message.pairId || message.pairId === currentPairId) continue
    if ((message.revision ?? 1) > 1) revisedPairs.add(message.pairId)
    const roles = sides.get(message.pairId) ?? new Set<string>()
    roles.add(message.role)
    sides.set(message.pairId, roles)
  }
  return {
    threadId,
    messageIds: conversation.map((message) => String(message.id)),
    messageRevisions: Object.fromEntries(conversation.map((message) => [String(message.id), message.revision ?? 1])),
    completePairIds: [...sides]
      .filter(([id, roles]) => !revisedPairs.has(id) && roles.has('user') && roles.has('assistant'))
      .map(([pairId]) => pairId),
  }
}

/** 规范化正文哈希：Unicode 兼容归一、忽略大小写与全部空白，用于识别不同 ID 的相同正文。 */
export function narrativeKey(note: EventNote): string {
  const normalized = note.narrative.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '')
  return createHash('sha256').update(normalized).digest('hex')
}

/** 去掉规范化正文相同的事件，保留先出现者（调用方保证顺序即优先级）。 */
export function dedupeByNarrative(notes: EventNote[]): EventNote[] {
  const seen = new Set<string>()
  return notes.filter((note) => {
    const key = narrativeKey(note)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 候选之间按优先级做正文去重，输出保持原展示顺序。 */
export function dedupeCandidatesByNarrative(
  candidates: AutomaticRagCandidate[],
): AutomaticRagCandidate[] {
  const kept = new Set(dedupeByNarrative(priorityOrder(candidates).map((item) => item.note)))
  return candidates.filter((item) => kept.has(item.note))
}

/** 选择优先级：直接命中按名次，其次末尾事件，最后按所依附命中的名次放前驱。 */
function priorityOrder(candidates: AutomaticRagCandidate[]): AutomaticRagCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      REASON_PRIORITY[left.reason] - REASON_PRIORITY[right.reason] || left.rank - right.rank,
  )
}

export interface AutomaticRagBudgetResult {
  notes: EventNote[]
  /** 因预算舍弃的事件数 */
  droppedCount: number
}

/**
 * 在记忆专属 Token 上限内保留完整事件，不截断单条正文。
 *
 * - `tokenBudget <= 0` 表示不限，结果与旧行为一致；
 * - 按优先级逐条尝试，放不下的事件整条跳过，后续更短的事件仍可使用剩余额度；
 * - 前驱只在其依附的命中被保留时才有注入理由；
 * - 输出保持原展示顺序，避免改变已有提示词结构。
 */
export function selectWithinTokenBudget(
  candidates: AutomaticRagCandidate[],
  tokenBudget: number,
  countTokens: (text: string) => number = (text) => tokenCounter.countTokens(text),
): AutomaticRagBudgetResult {
  if (!(tokenBudget > 0)) return { notes: candidates.map((item) => item.note), droppedCount: 0 }
  // 包装标签与换行的固定开销；逐行计数再各加 1 个 Token 余量，抵消拼接处分词差异。
  let used = countTokens(`${MEMORY_CONTEXT_OPEN}\n${MEMORY_CONTEXT_CLOSE}`) + 1
  const kept = new Set<string>()
  for (const candidate of priorityOrder(candidates)) {
    if (candidate.anchorId && !kept.has(candidate.anchorId)) continue
    const cost = countTokens(`${formatEventNoteLine(candidate.note)}\n`) + 1
    if (used + cost > tokenBudget) continue
    used += cost
    kept.add(candidate.note.id)
  }
  const notes = candidates.filter((item) => kept.has(item.note.id)).map((item) => item.note)
  return { notes, droppedCount: candidates.length - notes.length }
}

/** 余弦相似度；任一向量为零或维度不一致时返回 undefined，表示没有可用的向量证据。 */
export function cosineSimilarity(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number | undefined {
  if (left.length !== right.length || !left.length) return undefined
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (!leftNorm || !rightNorm) return undefined
  return dot / Math.sqrt(leftNorm * rightNorm)
}

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** 查询中的文字片段：拉丁词按词切分，CJK 连续段取全部二字组；均至少 2 个字符。 */
function queryTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').toLocaleLowerCase()
  const terms = new Set<string>()
  for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!CJK_PATTERN.test(word)) {
      if (word.length >= 2) terms.add(word)
      continue
    }
    const chars = [...word]
    for (let index = 0; index + 1 < chars.length; index += 1)
      terms.add(chars[index]! + chars[index + 1]!)
  }
  return [...terms]
}

/**
 * 文字证据：事件的人物/地点/物品/主题标签（至少 2 个字符）出现在查询中；
 * `includeNarrative` 时，查询的词或二字组出现在正文中也算。
 */
export function hasLexicalEvidence(
  note: EventNote,
  query: string,
  includeNarrative: boolean,
): boolean {
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase()
  // 旧版或不完整的载荷可能缺少某类标签，按空列表处理
  const labels = [
    ...(note.participants ?? []),
    ...(note.places ?? []),
    ...(note.objects ?? []),
    ...(note.topics ?? []),
  ]
  if (
    labels.some((label) => {
      const value = label.normalize('NFKC').toLocaleLowerCase().trim()
      return [...value].length >= 2 && normalizedQuery.includes(value)
    })
  )
    return true
  if (!includeNarrative) return false
  const narrative = note.narrative.normalize('NFKC').toLocaleLowerCase()
  return queryTerms(query).some((term) => narrative.includes(term))
}

export interface BasicRelevanceGate {
  minSimilarity: number
  /** 查询向量；向量不可用（文本回退）时为 undefined。 */
  queryVector?: ArrayLike<number>
}

/**
 * 基础管线的独立相关度判断，不使用混合检索分数：
 * - 有查询向量时：余弦 ≥ minSimilarity，或标签与查询一致；
 * - 文本回退时：没有可校准的向量证据，标签或正文与查询有文字重合即放行。
 */
export function passesBasicRelevance(
  note: EventNote,
  noteVector: ArrayLike<number> | undefined,
  query: string,
  gate: BasicRelevanceGate,
): boolean {
  const similarity =
    gate.queryVector && noteVector ? cosineSimilarity(gate.queryVector, noteVector) : undefined
  if (similarity === undefined) return hasLexicalEvidence(note, query, true)
  return similarity >= gate.minSimilarity || hasLexicalEvidence(note, query, false)
}
