// 「不重复自己」：按她自己最近的回复统计开头、结尾和高频短句，明显重复时给一句提醒。纯函数。
// 不使用通用词表：所有候选都来自她自己的历史，阈值按条数比例计算。
import { cleanReply, clip, readable } from './text.mjs'

const PUNCT_TAIL = /[\s，。！？!?,.、；;：:…~～\-—]+$/u
const isQuestionEnd = (text) => /[？?][\s\p{Extended_Pictographic}~～]*$/u.test(text)

/** 在 texts 里找出现次数过线、尽量长的同一开头（或结尾）。 */
function sharedEdge(texts, edge, lengths, minCount) {
  for (const k of lengths) {
    const groups = new Map()
    for (const text of texts) {
      const chars = [...text]
      if (chars.length < k + 2) continue
      const key = (edge === 'start' ? chars.slice(0, k) : chars.slice(-k)).join('')
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    let best
    for (const [key, count] of groups) {
      if (count < minCount(k)) continue
      if (readable(key) < 2) continue
      if (!best || count > best.count) best = { key, count }
    }
    if (best) return best
  }
  return undefined
}

/** 高频短句：5~10 字的片段，在足够多条回复里都出现过；只留最长的那个版本。 */
function frequentPhrases(texts, minDf, ignore) {
  const df = new Map()
  for (const text of texts) {
    const chars = [...text]
    const seen = new Set()
    for (let n = 5; n <= 10; n++) {
      for (let i = 0; i + n <= chars.length; i++) {
        const gram = chars.slice(i, i + n).join('')
        if (seen.has(gram) || /^\s|\s$/.test(gram) || readable(gram) < 4) continue
        seen.add(gram)
      }
    }
    for (const gram of seen) df.set(gram, (df.get(gram) ?? 0) + 1)
  }
  const candidates = [...df].filter(
    ([gram, count]) => count >= minDf && !ignore.some((x) => x && gram.includes(x)),
  )
  // 去掉被更长、出现次数相当的片段包含的短片段
  const maximal = candidates.filter(
    ([gram, count]) =>
      !candidates.some(
        ([other, otherCount]) => other !== gram && other.includes(gram) && otherCount >= count - 1,
      ),
  )
  maximal.sort((a, b) => b[1] - a[1] || [...b[0]].length - [...a[0]].length)
  return maximal
    .map(([gram, count]) => ({ key: gram.replace(PUNCT_TAIL, ''), count }))
    .filter((p) => readable(p.key) >= 4)
}

/**
 * 统计重复模式。
 * @param replies 她的回复（按时间先后），每项 { text }
 * @returns [{ type: 'opening'|'ending'|'question'|'phrase', key, count, of }]
 */
export function findPatterns(replies, settings) {
  const all = replies.map((r) => cleanReply(r.text)).filter((t) => readable(t) >= 2)
  if (all.length < settings.repeatMinReplies) return []
  const recent = all.slice(-15)
  const n = recent.length
  const patterns = []
  const opening = sharedEdge(recent, 'start', [8, 7, 6, 5, 4, 3, 2], (k) =>
    k >= 3 ? Math.max(4, Math.ceil(n * 0.3)) : Math.max(5, Math.ceil(n * 0.45)),
  )
  if (opening)
    patterns.push({
      type: 'opening',
      key: opening.key.replace(PUNCT_TAIL, '') || opening.key,
      count: opening.count,
      of: n,
    })
  const trimmed = recent.map((t) => t.replace(/[\s\p{Extended_Pictographic}]+$/u, ''))
  const ending = sharedEdge(trimmed, 'end', [8, 7, 6, 5, 4, 3], () =>
    Math.max(4, Math.ceil(n * 0.3)),
  )
  if (ending) patterns.push({ type: 'ending', key: ending.key, count: ending.count, of: n })
  else {
    const last = recent.slice(-10)
    const questions = last.filter(isQuestionEnd).length
    if (last.length >= 8 && questions >= Math.ceil(last.length * 0.7))
      patterns.push({ type: 'question', key: '?', count: questions, of: last.length })
  }
  const window = all.slice(-settings.repeatWindow)
  const minDf = Math.max(5, Math.ceil(window.length * 0.2))
  const taken = patterns.map((p) => p.key)
  for (const phrase of frequentPhrases(window, minDf, settings.ignorePhrases ?? [])) {
    if (
      taken.some((key) => key.length >= 2 && (key.includes(phrase.key) || phrase.key.includes(key)))
    )
      continue
    patterns.push({ type: 'phrase', key: phrase.key, count: phrase.count, of: window.length })
    taken.push(phrase.key)
    if (patterns.filter((p) => p.type === 'phrase').length >= 2) break
  }
  return patterns
}

const patternId = (p) => `${p.type}:${p.key}`

/**
 * 是否该提醒：距上次提醒至少隔 repeatEveryReplies 条回复；同一模式在冷却期内不重复提。
 * @returns 本次要提的模式（最多两条），或 undefined
 */
export function decideNudge({ patterns, nudge = {}, seq, now, settings }) {
  if (!patterns.length) return undefined
  if (Number.isFinite(nudge.lastSeq) && seq - nudge.lastSeq < settings.repeatEveryReplies)
    return undefined
  const cooldown = settings.repeatPatternCooldownHours * 3_600_000
  const fresh = patterns.filter((p) => {
    const last = nudge.shown?.[patternId(p)]
    return !(Number.isFinite(last) && now - last < cooldown)
  })
  return fresh.length ? fresh.slice(0, 2) : undefined
}

/** 记下这次提醒，返回新的 nudge 状态。 */
export function markNudge(nudge = {}, chosen, seq, now, settings) {
  const keep = settings.repeatPatternCooldownHours * 3_600_000 * 2
  const shown = Object.fromEntries(
    Object.entries(nudge.shown ?? {}).filter(([, at]) => now - at < keep),
  )
  for (const p of chosen) shown[patternId(p)] = now
  return { lastSeq: seq, lastAt: now, shown }
}

/** 只描述句式类型，避免将口癖原文再次示范给模型。 */
export function nudgeLine(chosen) {
  const labels = {
    opening: '使用相同的开头结构',
    ending: '使用相同的收尾结构',
    question: '用问句收尾',
    phrase: '重复固定短句',
  }
  return `你最近常${chosen.map((p) => labels[p.type]).join('；')}，这次按实际意思换个说法。`
}
