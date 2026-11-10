// 「情绪余温」：最近情绪较重的事留下一条会衰减的余温，几小时到几天内逐渐消退。纯函数。
import { ago, clip } from './text.mjs'
import { feeling } from './recall.mjs'

const HOUR = 3_600_000

/**
 * 当前消息里的情绪线索：只用于「对方这句话本身情绪很重」时补一条短余温。
 * 主来源是宿主写记忆时已经判断好的 affect；这里是没有记忆时的轻量兜底，不调用模型。
 * 每项：[正则, 基调]
 */
const CUES = [
  [/(哭了|想哭|哭得|眼泪|泪目)/, '难过'],
  [/(难过|伤心|心碎|好丧|很丧|低落|沮丧|失落)/, '低落'],
  [/(崩溃|撑不住|受不了了|绷不住)/, '崩溃'],
  [/(焦虑|好慌|心慌|睡不着|失眠)/, '焦虑'],
  [/(分手|离婚|去世|住院|生病了|病倒|手术)/, '沉重'],
  [/(吵架|吵了一架|被骂|挨骂|委屈)/, '委屈'],
  [/(被裁|裁员|辞职了|被开除|挂科|考砸|没考上|面试.{0,4}(挂|没过))/, '受挫'],
  [/(好开心|太开心|超开心|高兴死|激动|录取了|上岸|升职|拿到offer)/i, '开心'],
]
const INTENSIFIER = /(真的|特别|好|太|超级|非常)/

/** 从对方这句话里识别情绪较重的事；没有就返回 undefined。 */
export function cueFromMessage(text, now) {
  const message = String(text ?? '').trim()
  if (message.length < 4 || message.length > 600) return undefined
  const tones = []
  for (const [pattern, tone] of CUES)
    if (pattern.test(message) && !tones.includes(tone)) tones.push(tone)
  if (!tones.length) return undefined
  const intensity = Math.min(
    0.85,
    0.6 + (tones.length > 1 ? 0.1 : 0) + (INTENSIFIER.test(message) ? 0.08 : 0),
  )
  return {
    id: `cue:${now}`,
    source: 'cue',
    at: now,
    text: `你们聊到：「${clip(message.replace(/\s+/g, ' '), 36)}」`,
    tones: tones.slice(0, 2),
    intensity,
    halfLifeH: 8,
  }
}

/** 从一条刚写入的记忆生成余温：事件发生在 maxHours 以内且情绪强度够才算。 */
export function glowFromNote(note, now, settings) {
  const intensity = Math.min(1, feeling(note) + ((note.importance ?? 0) >= 7 ? 0.1 : 0))
  if (intensity < settings.afterglowMinIntensity) return undefined
  const at = Date.parse(note.eventAt ?? note.createdAt)
  if (!Number.isFinite(at) || now - at > settings.afterglowMaxHours * HOUR) return undefined
  return {
    id: note.id,
    source: 'memory',
    at,
    text: note.narrative.replace(/\s+/g, ' ').trim().slice(0, 200),
    tones: note.affect?.tones?.slice(0, 2) ?? [],
    intensity,
    // 强度 0.6 → 约 14 小时半衰，1.0 → 48 小时半衰
    halfLifeH: Math.min(48, Math.max(6, 6 + (intensity - 0.5) * 84)),
  }
}

/** 某一时刻的余温强度：按半衰期指数衰减。 */
export const strength = (glow, now) =>
  glow.intensity * 0.5 ** (Math.max(0, now - glow.at) / HOUR / glow.halfLifeH)

/** 合并新余温，去重、清掉过期和已经淡到看不出的，最多留 20 条。 */
export function mergeGlows(list, additions, now, settings) {
  const byId = new Map()
  for (const glow of [...(list ?? []), ...additions]) if (glow && glow.id) byId.set(glow.id, glow)
  return [...byId.values()]
    .filter((g) => now - g.at <= settings.afterglowMaxHours * HOUR && strength(g, now) >= 0.1)
    .sort((a, b) => b.at - a.at)
    .slice(0, 20)
}

/** 挑当前最明显的一条余温；刚发生的（还在眼前的对话里）先不提。 */
export function pickGlow(list, now, settings, exclude = []) {
  const skip = new Set(exclude)
  let best
  for (const glow of list ?? []) {
    if (skip.has(glow.id)) continue
    const age = now - glow.at
    if (age < settings.afterglowMinAgeMinutes * 60_000 || age > settings.afterglowMaxHours * HOUR)
      continue
    const s = strength(glow, now)
    if (s < 0.2) continue
    if (!best || s > best.s) best = { glow, s }
  }
  return best && { ...best.glow, strength: best.s }
}

/** 余温的一行：多久以前、还剩多少、是什么事、什么基调。 */
export function glowLine(glow, now, maxChars = 70) {
  // 按剩下的比例说：还在心上 / 淡了些 / 只剩一点
  const ratio = glow.intensity ? glow.strength / glow.intensity : 1
  const level = ratio >= 0.7 ? '还在心上' : ratio >= 0.4 ? '淡了些' : '只剩一点'
  const head = `${ago(glow.at, now)}，${level}`
  const tones = glow.tones?.length ? `（${glow.tones.join('、')}）` : ''
  const body = clip(glow.text, Math.max(16, maxChars - head.length - tones.length - 3))
  return `${head}：${body}${tones}`
}
