import { describe, expect, it } from 'vitest'
import type { EventNote } from '@infos/shared'
import { buildVisibleMemorySource, isSourceVisible } from '../../../src/services/memory/automaticRagSelection'

const note: EventNote = {
  id: 'event-28',
  agentId: 'pero',
  narrative: '用户与角色一起确定了周末的安排。',
  eventAt: '2026-11-07T09:00:00.000Z',
  createdAt: '2026-11-07T09:00:00.000Z',
  importance: 0.5,
  affect: { tones: [], valence: 0, arousal: 0 },
  participants: [],
  places: [],
  objects: [],
  topics: [],
  status: 'active',
  origin: {
    mode: 'background',
    threadId: 'main-pero',
    pairIds: [],
    messageIds: ['28', '29'],
    messageRevisions: { '28': 1, '29': 1 },
    channel: 'desktop',
  },
}

describe('自动召回的可见来源过滤', () => {
  it('独立消息的全部原始修订可见时，排除对应摘要', () => {
    const visible = buildVisibleMemorySource('main-pero', [
      { id: 28, role: 'user', revision: 1, pairId: null },
      { id: 29, role: 'assistant', revision: 1, pairId: null },
    ])
    expect(isSourceVisible(note, visible)).toBe(true)
  })

  it('同一消息已经改写时，保留基于旧修订的记忆', () => {
    const visible = buildVisibleMemorySource('main-pero', [
      { id: 28, role: 'user', revision: 2, pairId: null },
      { id: 29, role: 'assistant', revision: 1, pairId: null },
    ])
    expect(isSourceVisible(note, visible)).toBe(false)
  })

  it('合并记忆还引用侧会话来源时，保留完整记忆', () => {
    const combined: EventNote = {
      ...note,
      origin: {
        ...note.origin,
        sources: [
          note.origin,
          { ...note.origin, threadId: 'side-pero', messageIds: ['40'], messageRevisions: { '40': 1 } },
        ],
      },
    }
    const visible = buildVisibleMemorySource('main-pero', [
      { id: 28, role: 'user', revision: 1 },
      { id: 29, role: 'assistant', revision: 1 },
    ])
    expect(isSourceVisible(combined, visible)).toBe(false)
  })
})
