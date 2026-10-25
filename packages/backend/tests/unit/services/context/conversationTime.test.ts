import { describe, expect, it } from 'vitest'
import {
  buildConversationTimeAnchors,
  prependConversationTime,
} from '@infos/backend/services/context/conversationTime'
import type { ChatMessage } from '@infos/backend/services/llm/types'

describe('历史对话时间锚点', () => {
  it('跨三天恢复后从实际消息时间重新起算，不补空白小时，不按整点切分', () => {
    const anchors = buildConversationTimeAnchors([
      { id: 1, timestamp: '2026-10-22 11:04:00' },
      { id: 2, timestamp: '2026-10-25 07:02:00' },
      { id: 3, timestamp: '2026-10-25 08:00:00' },
      { id: 4, timestamp: '2026-10-25 08:01:59' },
      { id: 5, timestamp: '2026-10-25 08:02:00' },
      { id: 6, timestamp: '2026-10-25 09:15:00' },
      { id: 7, timestamp: '2026-10-25 10:14:59' },
    ])
    expect([...anchors.keys()]).toEqual([1, 2, 5, 6])
    expect(anchors.get(2)).toBe('【对话记录时间：2026-10-25 07:02】')
    expect(anchors.get(5)).toBe('【对话记录时间：2026-10-25 08:02】')
  })

  it('连续聊天与最后一次标记比较，追加新消息不会重排已有标记', () => {
    const prefix = [
      { id: 1, timestamp: '2026-10-25 10:00:00' },
      { id: 2, timestamp: '2026-10-25 10:40:00' },
      { id: 3, timestamp: '2026-10-25 11:05:00' },
    ]
    const before = buildConversationTimeAnchors(prefix)
    const after = buildConversationTimeAnchors([
      ...prefix,
      { id: 4, timestamp: '2026-10-25 11:45:00' },
      { id: 5, timestamp: '2026-10-25 12:05:00' },
    ])
    expect([...before.keys()]).toEqual([1, 3])
    for (const [id, anchor] of before) expect(after.get(id)).toBe(anchor)
    expect([...after.keys()].filter((id) => id >= 2)).toEqual([3, 5])
  })

  it('跳过缺失与非法日期，不用当前时刻补造时间', () => {
    expect([
      ...buildConversationTimeAnchors([
        { id: 1, timestamp: null },
        { id: 2, timestamp: '未知时间' },
        { id: 3, timestamp: '2026-02-30 07:02:00' },
        { id: 4, timestamp: '2026-10-25 25:00:00' },
        { id: 5, timestamp: '2026-10-25 07:02:00' },
      ]),
    ]).toEqual([[5, '【对话记录时间：2026-10-25 07:02】']])
  })

  it('有时区的来源保留原偏移，并按实际经过时间比较', () => {
    const anchors = buildConversationTimeAnchors([
      { id: 1, timestamp: '2026-10-25T07:02:00+08:00' },
      { id: 2, timestamp: '2026-10-25T00:01:59Z' },
      { id: 3, timestamp: '2026-10-25T00:02:00Z' },
    ])
    expect([...anchors]).toEqual([
      [1, '【对话记录时间：2026-10-25 07:02 +08:00】'],
      [3, '【对话记录时间：2026-10-25 00:02 +00:00】'],
    ])
  })

  it('历史多模态内容只前置一段标记，不修改媒体、原文或未标记输入', () => {
    const parts: ChatMessage['content'] = [
      { type: 'text', text: '当时发送的图片' },
      { type: 'image_url', image_url: { url: 'attachment:image' } },
    ]
    const before = structuredClone(parts)
    const marked = prependConversationTime(parts, '【对话记录时间：2026-10-25 07:02】')
    expect(marked).toEqual([{ type: 'text', text: '【对话记录时间：2026-10-25 07:02】' }, ...parts])
    expect(parts).toEqual(before)
    expect(prependConversationTime(parts, undefined)).toBe(parts)
    expect(prependConversationTime('当前输入', undefined)).toBe('当前输入')
  })
})
