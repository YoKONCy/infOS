// 文本小工具：规范化、关键词、相对时间、截断。全部是纯函数，不做任何 IO。

/** 按字符（而非 UTF-16 码元）计长度，emoji 算一个字。 */
export const len = (text) => [...String(text ?? '')].length

/** 截到 n 个字以内，超出时末尾补省略号。 */
export function clip(text, n) {
  const chars = [...String(text ?? '')]
  if (chars.length <= n) return chars.join('')
  return n <= 1 ? '…' : chars.slice(0, n - 1).join('') + '…'
}

/** 清理她的回复：去掉代码块、成对标签（思考、工具痕迹）、Markdown 符号和多余空白。 */
export function cleanReply(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<([a-zA-Z_][\w-]*)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*#>`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const CJK = /[㐀-鿿豈-﫿]/
// 分词用的虚字：只用来跳过「的了」「我你」这类无信息的二字组，不是禁词表。
const FUNCTION_CHARS = new Set(
  '的了吗呢吧啊呀哦嘛么我你他她它们是在有这那就都也还又很太和与跟个一不没要会能想说去来到给让把被着过得地上下里么啥怎什点只些再才刚'.split(
    '',
  ),
)

/**
 * 从一句话里抽检索词，按信息量从高到低：
 * 1. 中文二字组（两个字都不是虚字）；2. 单个实字；3. 3 个字母以上的英文单词。
 * 保持原文顺序去重。单字用于相关度计分（配合逆文档频率压低「猫猫」这类处处都有的字）。
 */
export function terms(text, max = 32) {
  const bigrams = []
  const unigrams = []
  const words = []
  const seen = new Set()
  const push = (list, term) => {
    if (!seen.has(term)) {
      seen.add(term)
      list.push(term)
    }
  }
  const source = String(text ?? '').toLowerCase()
  for (const run of source.match(/[㐀-鿿豈-﫿]+/g) ?? []) {
    const chars = [...run]
    for (let i = 0; i < chars.length; i++) {
      if (FUNCTION_CHARS.has(chars[i])) continue
      if (i + 1 < chars.length && !FUNCTION_CHARS.has(chars[i + 1]))
        push(bigrams, chars[i] + chars[i + 1])
    }
    for (const ch of chars) if (!FUNCTION_CHARS.has(ch)) push(unigrams, ch)
  }
  for (const word of source.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) push(words, word)
  return [...bigrams, ...words, ...unigrams].slice(0, max)
}

/** 相对时间的口语说法：刚才 / 约3小时前 / 昨天 / 前天 / 5天前 / 2周前 / 3个月前 / 1年多前。 */
export function ago(thenMs, nowMs) {
  if (!Number.isFinite(thenMs)) return '之前'
  const hours = Math.max(0, (nowMs - thenMs) / 3_600_000)
  if (hours < 1) return '刚才'
  if (hours < 20) return `约${Math.round(hours)}小时前`
  const days = Math.floor(hours / 24 + 0.2)
  if (days <= 1) return '昨天'
  if (days === 2) return '前天'
  if (days < 14) return `${days}天前`
  if (days < 60) return `${Math.round(days / 7)}周前`
  if (days < 365) return `${Math.round(days / 30)}个月前`
  return `${Math.floor(days / 365)}年多前`
}

/** 字符串是否含有可读内容（中文或字母），排除纯标点、数字、emoji。 */
export const readable = (text) =>
  [...String(text ?? '')].filter((c) => CJK.test(c) || /[a-z]/i.test(c)).length

/** 简单的稳定哈希，用于去重回复。 */
export function hash(text) {
  let h = 2166136261
  for (const ch of String(text ?? '')) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36)
}
