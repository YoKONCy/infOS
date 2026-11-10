// 组装注入正文：总长不超过 maxChars（默认 300 字，含标签）。纯函数。
import { glowLine } from './afterglow.mjs'
import { memoryLine } from './recall.mjs'
import { clip, len } from './text.mjs'

const OPEN = '<human_touch>'
const CLOSE = '</human_touch>'

/** 使用规则：只在有记忆或余温时附上。用正面描述，不给示例、不列禁词。 */
export const RULE =
  '这些是你心里有数的事，不是要说的话：真相关时，让它影响你留意什么、用什么语气接话；不复述，不点明，也不必每次都提。'

/** 盲测对照组「只有提示词」：同一位置、同样的意图，但不带任何具体数据。 */
export const PROMPT_ONLY = `${OPEN}\n说话时带上你们之间的历史感：相关时自然想起你们一起经历过的事；情绪不直接说出来，体现在你留意什么、怎么接话上；别重复自己最近常用的开头、结尾和句式。\n${CLOSE}`

/**
 * @param memories 选中的记忆（0~2 条）
 * @param glow 选中的余温（可选，已带 strength）
 * @param nudge 重复提醒的一句话（可选）
 * @returns 注入正文；什么都没有时返回空串
 */
export function compose({ memories = [], glow, nudge, now, maxChars = 300 }) {
  if (!memories.length && !glow && !nudge) return ''
  const fixed = [OPEN, CLOSE]
  if (memories.length || glow) fixed.push(RULE)
  const nudgeText = nudge ? clip(nudge, 70) : ''
  if (nudgeText) fixed.push(nudgeText)
  // 每行之间一个换行
  const lines = memories.length + (glow ? 1 : 0)
  const overhead = fixed.reduce((sum, part) => sum + len(part), 0) + fixed.length - 1 + lines
  const room = Math.max(0, maxChars - overhead)
  const body = []
  if (lines) {
    const each = Math.floor(room / lines)
    for (const note of memories) {
      const label = '你记得：'
      body.push(label + memoryLine(note, now, Math.max(24, Math.min(110, each - label.length))))
    }
    if (glow) {
      const label = '余温：'
      body.push(label + glowLine(glow, now, Math.max(24, Math.min(90, each - label.length))))
    }
  }
  const parts = [OPEN, ...body]
  if (memories.length || glow) parts.push(RULE)
  if (nudgeText) parts.push(nudgeText)
  parts.push(CLOSE)
  let text = parts.join('\n')
  // 兜底：极端情况下仍超长，就从正文行里再截
  while (len(text) > maxChars && body.length) {
    const longest = body.reduce((iMax, line, i) => (len(line) > len(body[iMax]) ? i : iMax), 0)
    const over = len(text) - maxChars
    const target = len(body[longest]) - over
    if (target < 12) body.splice(longest, 1)
    else body[longest] = clip(body[longest], target)
    const rebuilt = [OPEN, ...body]
    if (body.length) rebuilt.push(RULE)
    if (nudgeText) rebuilt.push(nudgeText)
    rebuilt.push(CLOSE)
    text = rebuilt.join('\n')
  }
  if (!body.length && !nudgeText) return ''
  return text
}
