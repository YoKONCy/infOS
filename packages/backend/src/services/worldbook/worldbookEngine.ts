/**
 * 世界书激活引擎 — 按蓝绿灯、关键词、触发概率、粘滞轮数与 Token 预算选出本轮注入的条目
 *
 * 激活的条目按顺序数拼接为一段正文，由装配放入末尾的本轮动态上下文。
 * 纯函数，不读写文件、不保存会话状态：
 * - 粘滞通过向前多扫描 N 轮消息实现，重新生成、编辑或删除历史后结果自然一致；
 * - 蓝灯的触发概率由本轮装配种子决定，同一轮 ReAct 内结果稳定；
 *   绿灯按触发它的那条消息判定，扫描与粘滞期间结果一致。
 *
 * @module packages/backend/src/services/worldbook/worldbookEngine
 */

import type {
  WorldbookActivation,
  WorldbookChannel,
  WorldbookEntry,
  WorldbookHit,
  WorldbookHitReason,
  WorldbookSettings,
} from '@infos/shared'
import { tokenCounter } from '../tokenizer/tokenCounter'

export interface WorldbookScanMessage {
  role: string
  content: unknown
}

export interface WorldbookSource {
  bookId: string
  entries: readonly WorldbookEntry[]
}

export interface WorldbookActivationInput {
  /** 按时间从旧到新排列，最后一条通常是当前输入。 */
  messages: readonly WorldbookScanMessage[]
  channel: WorldbookChannel
  /** 替换条目正文中的 `{{char}}`。 */
  charName: string
  /** 替换条目正文中的 `{{user}}`，与酒馆框架宏一致使用用户名字。 */
  userName: string
  /** 蓝灯触发概率的随机种子；同一种子下结果稳定。 */
  seed: string
}

export function emptyWorldbookActivation(): WorldbookActivation {
  return { hits: [], dropped: [], skipped: [], content: '', tokens: 0 }
}

/** 只读取文本内容；图片、音频等附件不参与关键词扫描。 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n')
}

function renderContent(content: string, input: WorldbookActivationInput): string {
  return content
    .replace(/\{\{\s*char\s*\}\}/gi, () => input.charName)
    .replace(/\{\{\s*user\s*\}\}/gi, () => input.userName)
    .trim()
}

interface Trigger {
  keyword: string
  /** 命中消息在从新到旧列表中的位置。 */
  index: number
  /** 命中消息及其前一条的正文，作为该次触发的概率种子。 */
  fingerprint: string
}

/** 从新到旧逐条消息匹配，返回最近一次命中；避免关键词跨越两条消息拼接后误命中。 */
function findTrigger(
  entry: WorldbookEntry,
  texts: readonly string[],
  limit: number,
): Trigger | undefined {
  for (let index = 0; index < Math.min(limit, texts.length); index++) {
    const text = texts[index]!
    const keyword = entry.keys.find((key) => key && text.includes(key.toLocaleLowerCase()))
    if (keyword) return { keyword, index, fingerprint: `${text}\n${texts[index + 1] ?? ''}` }
  }
  return undefined
}

/** FNV-1a 散列映射到 [0, 100)，用于可复现的触发概率。 */
function roll(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return ((hash >>> 0) % 10_000) / 100
}

interface Candidate {
  key: string
  bookId: string
  entry: WorldbookEntry
  /** 跨书稳定排序：先按书的先后，再按条目在书中的位置。 */
  index: number
  reason: WorldbookHitReason
  keyword?: string
  content: string
  tokens: number
}

const byOrder = (left: Candidate, right: Candidate) =>
  left.entry.order - right.entry.order || left.index - right.index

export function activateWorldbook(
  sources: readonly WorldbookSource[],
  settings: Pick<WorldbookSettings, 'scanDepth' | 'tokenBudget'>,
  input: WorldbookActivationInput,
): WorldbookActivation {
  const result = emptyWorldbookActivation()
  if (!sources.some((source) => source.entries.length)) return result
  // 从新到旧排列，便于按扫描深度截取最近的消息。
  const texts = input.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => messageText(message.content).toLocaleLowerCase())
    .reverse()
  const candidates: Candidate[] = []
  let index = 0
  for (const source of sources) {
    for (const entry of source.entries) {
      index++
      if (!entry.enabled) continue
      if (entry.channels.length && !entry.channels.includes(input.channel)) continue
      const content = renderContent(entry.content, input)
      if (!content) continue
      const key = `${source.bookId}/${entry.id}`
      let reason: WorldbookHitReason = 'constant'
      let keyword: string | undefined
      let seed = `${input.seed}:${key}`
      if (entry.light !== 'constant') {
        // 持续轮数按用户与角色各一条消息折算为消息数，向前多扫描对应范围。
        const trigger = findTrigger(entry, texts, settings.scanDepth + entry.sticky * 2)
        if (!trigger) continue
        reason = trigger.index < settings.scanDepth ? 'keyword' : 'sticky'
        keyword = trigger.keyword
        // 概率按触发消息判定：同一次触发在扫描与粘滞期间结果一致，未通过的不会在粘滞期补上。
        seed = `${trigger.fingerprint}:${key}`
      }
      if (entry.probability < 100 && roll(seed) >= entry.probability) {
        result.skipped.push(key)
        continue
      }
      candidates.push({
        key,
        bookId: source.bookId,
        entry,
        index,
        reason,
        keyword,
        content,
        tokens: tokenCounter.countTokens(content),
      })
    }
  }
  if (!candidates.length) return result

  // 与酒馆一致：预算按蓝灯优先、其次顺序数大者优先占用；预算用尽后其余条目全部舍弃。
  const accepted: Candidate[] = []
  const priority = [...candidates].sort(
    (left, right) =>
      Number(left.reason !== 'constant') - Number(right.reason !== 'constant') ||
      right.entry.order - left.entry.order ||
      left.index - right.index,
  )
  let exhausted = false
  for (const candidate of priority) {
    exhausted ||=
      settings.tokenBudget > 0 && result.tokens + candidate.tokens > settings.tokenBudget
    if (exhausted) {
      result.dropped.push(candidate.key)
      continue
    }
    result.tokens += candidate.tokens
    accepted.push(candidate)
  }
  accepted.sort(byOrder)

  result.hits = accepted.map(
    (candidate): WorldbookHit => ({
      bookId: candidate.bookId,
      entryId: candidate.entry.id,
      title: candidate.entry.title,
      reason: candidate.reason,
      ...(candidate.keyword ? { keyword: candidate.keyword } : {}),
      tokens: candidate.tokens,
    }),
  )
  result.content = accepted.map((candidate) => candidate.content).join('\n\n')
  return result
}

/** 将提示词装配的频道与群聊标记映射为世界书场景；后台任务等其他频道不注入世界书。 */
export function worldbookChannelOf(
  channel: string,
  isGroup: boolean,
): WorldbookChannel | undefined {
  if (channel === 'desktop') return 'desktop'
  if (channel === 'group') return 'group'
  if (channel === 'social') return isGroup ? 'social_group' : 'social_private'
  return undefined
}
