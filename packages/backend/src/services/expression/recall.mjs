// 「她记得的事」：从候选记忆里挑一两条和当前话题相关、带着当时感受的共同经历。纯函数。
import { ago, clip, terms } from './text.mjs'

/**
 * 记忆的情绪强度（0~1）。宿主的 affect：valence 0~10（5 为中性），arousal 0~10。
 * 偏离中性越远、唤醒越高，强度越大。
 */
export function feeling(note) {
  const affect = note?.affect
  if (!affect) return 0
  const v = Number(affect.valence)
  const a = Number(affect.arousal)
  const fromValence = Number.isFinite(v) ? Math.abs(v - 5) / 5 : 0
  const fromArousal = Number.isFinite(a) ? Math.max(0, (a - 4) / 6) : 0
  return Math.min(1, Math.max(fromValence, fromArousal * 0.9))
}

/** 只保留插件要用的字段，避免把整条记忆长期放在内存和状态文件里。 */
export function slimNote(note) {
  if (!note || typeof note.id !== 'string' || typeof note.narrative !== 'string') return undefined
  const tags = [
    ...(note.participants ?? []),
    ...(note.places ?? []),
    ...(note.objects ?? []),
    ...(note.topics ?? []),
  ].filter((t) => typeof t === 'string')
  return {
    id: note.id,
    narrative: note.narrative.slice(0, 1200),
    eventAt: note.eventAt,
    createdAt: note.createdAt,
    importance: Number(note.importance) || 0,
    affect:
      note.affect && typeof note.affect === 'object'
        ? {
            tones: (note.affect.tones ?? []).filter((t) => typeof t === 'string').slice(0, 4),
            valence: Number(note.affect.valence),
            arousal: Number(note.affect.arousal),
          }
        : undefined,
    tags: tags.slice(0, 24),
    status: note.status ?? 'active',
  }
}

/**
 * 相关度（0~1）：查询词在这条记忆里的加权覆盖率。
 * 权重是候选池里的逆文档频率：少见的词分量重；池里一条都没有的词按最少见算（说明这句话在聊别的）。
 * 单字权重减半；只命中一个单字不算证据（避免巧合）。
 */
export function relevanceOf(note, queryTerms, idf) {
  const hay = `${note.narrative} ${(note.tags ?? []).join(' ')}`.toLowerCase()
  let total = 0
  let got = 0
  let hits = 0
  let strong = false
  for (const term of queryTerms) {
    const weight = idf.get(term)
    if (!weight) continue
    total += weight
    if (hay.includes(term)) {
      got += weight
      hits++
      if ([...term].length >= 2) strong = true
    }
  }
  if (!total || (!strong && hits < 2)) return 0
  return got / total
}

/**
 * 每个词的权重。池子够大（≥4 条）时，超过一半记忆都有的词（如称呼）当作没有区分度，权重为 0。
 */
export function idfTable(queryTerms, pool) {
  const n = pool.length
  const table = new Map()
  for (const term of queryTerms) {
    let df = 0
    for (const note of pool)
      if (`${note.narrative} ${(note.tags ?? []).join(' ')}`.toLowerCase().includes(term)) df++
    if (n >= 4 && df / n > 0.5) continue
    const weight = Math.log((n + 1) / Math.max(1, df)) || 0.1
    table.set(term, [...term].length >= 2 ? weight : weight / 2)
  }
  return table
}

/**
 * 给候选打分并挑选。
 * - 相关度：见 relevanceOf；记忆的标签整个出现在这句话里，额外加分；宿主自动 RAG 排前三的，有词面证据时再加一点。
 * - 只挑相关度过线的；再按 相关度、当时感受、重要度 排序。
 * - 冷却中的、太新的（几小时内刚发生，属于眼前的事）、已归档的跳过。
 * @returns 选中的记忆（附 score 与 relevance）
 */
export function pickMemories({
  query,
  candidates,
  ragIds = [],
  cooldown = {},
  exclude = [],
  now,
  settings,
}) {
  const queryTerms = terms(query)
  const ragRank = new Map(ragIds.map((id, index) => [id, index]))
  const cooldownMs = settings.memoryCooldownHours * 3_600_000
  const minAgeMs = settings.memoryMinAgeHours * 3_600_000
  const skip = new Set(exclude)
  const pool = [
    ...new Map(
      candidates.filter((n) => n && typeof n.narrative === 'string').map((n) => [n.id, n]),
    ).values(),
  ]
  const idf = idfTable(queryTerms, pool)
  const scored = []
  for (const note of pool) {
    if (skip.has(note.id)) continue
    if (note.status && note.status !== 'active') continue
    if (note.narrative.trim().length < 6) continue
    const at = Date.parse(note.eventAt ?? note.createdAt)
    if (Number.isFinite(at) && now - at < minAgeMs) continue
    const last = cooldown[note.id]
    if (Number.isFinite(last) && now - last < cooldownMs) continue
    const lexical = relevanceOf(note, queryTerms, idf)
    const tagHit = (note.tags ?? []).some(
      (tag) =>
        [...tag].length >= 2 &&
        String(query ?? '')
          .toLowerCase()
          .includes(tag.toLowerCase()),
    )
      ? 0.3
      : 0
    const rank = ragRank.get(note.id)
    const ragBonus = rank !== undefined && rank < 3 && (lexical > 0 || tagHit) ? 0.15 : 0
    const relevance = Math.min(1, lexical + tagHit + ragBonus)
    if (relevance < settings.memoryMinRelevance) continue
    const score =
      relevance * 0.6 + feeling(note) * 0.25 + (Math.min(10, note.importance ?? 0) / 10) * 0.15
    scored.push({ ...note, relevance, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, settings.memoryMax)
}

/** 记忆的一行：时间 + 她自己的叙述（截短）+ 当时的感受。 */
export function memoryLine(note, now, maxChars = 80) {
  const when = ago(Date.parse(note.eventAt ?? note.createdAt), now)
  const tones = note.affect?.tones?.length
    ? `（那时${note.affect.tones.slice(0, 2).join('、')}）`
    : ''
  const body = clip(
    note.narrative.replace(/\s+/g, ' ').trim(),
    Math.max(20, maxChars - when.length - tones.length - 1),
  )
  return `${when}，${body}${tones}`
}
