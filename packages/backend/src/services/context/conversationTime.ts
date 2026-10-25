import type { ChatMessage } from '../llm/types'

export interface ConversationTimeEntry {
  id: number
  timestamp: string | null
}

const TIME_ANCHOR_INTERVAL_MS = 60 * 60 * 1000

function parseRecordedTime(
  value: string | null,
): { milliseconds: number; label: string } | undefined {
  const match = value?.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  )
  if (!match) return
  const [, day, minute, second = '00', fraction = '', zone] = match
  const wallTime = `${day}T${minute}:${second}${fraction}`
  const wallMilliseconds = Date.parse(`${wallTime}Z`)
  if (
    !Number.isFinite(wallMilliseconds) ||
    new Date(wallMilliseconds).toISOString().slice(0, 19) !== `${day}T${minute}:${second}`
  )
    return
  const offset = zone === 'Z' ? '+00:00' : zone?.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
  // 旧数据库保存本地墙上时间且没有时区。按原值比较和展示，不随服务器当前时区改写历史。
  const milliseconds = Date.parse(`${wallTime}${offset ?? 'Z'}`)
  if (!Number.isFinite(milliseconds)) return
  return { milliseconds, label: `${day} ${minute}${offset ? ` ${offset}` : ''}` }
}

/** 输入为同一会话从头开始的用户消息时间序列；只读派生，不随上下文窗口重新起算。 */
export function buildConversationTimeAnchors(
  entries: readonly ConversationTimeEntry[],
): Map<number, string> {
  const anchors = new Map<number, string>()
  let lastMarkedAt: number | undefined
  for (const entry of entries) {
    const recorded = parseRecordedTime(entry.timestamp)
    if (!recorded) continue
    if (
      lastMarkedAt !== undefined &&
      recorded.milliseconds - lastMarkedAt < TIME_ANCHOR_INTERVAL_MS
    )
      continue
    // 这是固定的模型上下文标记，不属于界面文案，也不随语言配置改写已有历史。
    anchors.set(entry.id, `【对话记录时间：${recorded.label}】`)
    lastMarkedAt = recorded.milliseconds
  }
  return anchors
}

/** 时间只装配到历史正文；结构化输入保持原媒体与文字部分，调用方不修改原消息。 */
export function prependConversationTime(
  content: ChatMessage['content'],
  anchor: string | undefined,
): ChatMessage['content'] {
  if (!anchor) return content
  return Array.isArray(content)
    ? [{ type: 'text', text: anchor }, ...content]
    : `${anchor}\n${content ?? ''}`
}
