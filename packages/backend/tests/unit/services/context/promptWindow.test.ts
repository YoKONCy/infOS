import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../../src/services/llm/types'
import { slidePromptWindow } from '../../../../src/services/context/promptWindow'
import { tokenCounter } from '../../../../src/services/tokenizer/tokenCounter'

function group(index: number): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      reasoningContent: `第 ${index} 轮思考`,
      toolCalls: ['a', 'b'].map((suffix) => ({
        id: `${index}-${suffix}`,
        type: 'function' as const,
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: `${index}-${suffix}.ts` }),
        },
      })),
    },
    ...['a', 'b'].map(
      (suffix): ChatMessage => ({
        role: 'tool',
        toolCallId: `${index}-${suffix}`,
        content: `文件 ${index}-${suffix}\n` + '原始正文'.repeat(100),
      }),
    ),
  ]
}
function paired(messages: ChatMessage[]) {
  const calls = messages.flatMap((message) => message.toolCalls ?? [])
  const results = messages.filter((message) => message.role === 'tool')
  expect(results.map((message) => message.toolCallId).sort()).toEqual(
    calls.map((call) => call.id).sort(),
  )
}

describe('逐请求自动滑动窗口', () => {
  it('一次用户输入中几百个 ReAct 组也能前移，保持最新结果及多工具关联', () => {
    const current: ChatMessage = {
      role: 'user',
      content: '持续完成任务',
      cacheControl: { kind: 'current' },
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: '固定规则' },
      current,
      ...Array.from({ length: 220 }, (_, index) => group(index)).flat(),
    ]
    const count = () => tokenCounter.countMessages(messages)
    const result = slidePromptWindow(messages, 5000, count)
    expect(result.usedTokens).toBeLessThanOrEqual(5000)
    expect(result.removedMessages).toBeGreaterThan(0)
    expect(messages).toContain(current)
    expect(messages.some((message) => message.toolCallId === '219-b')).toBe(true)
    expect(messages.some((message) => message.toolCallId === '0-a')).toBe(false)
    paired(messages)
  })

  it('未超预算保持对象和顺序，不进行摘要或改写', () => {
    const messages = [{ role: 'user' as const, content: '任务' }, ...group(1)]
    const original = structuredClone(messages)
    const result = slidePromptWindow(messages, 100_000, () => tokenCounter.countMessages(messages))
    expect(result.removedMessages).toBe(0)
    expect(messages).toEqual(original)
  })

  it('再次滑窗更新交接通知的来源，旧通知不会锁住已经退出的起点', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '固定规则' },
      { role: 'user', content: '旧材料'.repeat(600) },
      {
        role: 'user',
        content: '当前输入一',
        cacheControl: { kind: 'current', replayAnchor: { key: 'input-1', messageId: 1 } },
      },
    ]
    const count = () => tokenCounter.countMessages(messages)
    expect(count()).toBeGreaterThan(1000)
    expect(slidePromptWindow(messages, 1000, count).removedMessages).toBeGreaterThan(0)
    const notice = messages.find(
      (message) => message.cacheControl?.key === 'infos.work.sliding-window',
    )
    expect(notice?.cacheControl?.replayAnchor).toEqual({ key: 'input-1', messageId: 1 })
    messages.push(
      { role: 'user', content: '新增的大段材料'.repeat(600) },
      {
        role: 'user',
        content: '当前输入二',
        cacheControl: { kind: 'current', replayAnchor: { key: 'input-2', messageId: 2 } },
      },
    )
    expect(count()).toBeGreaterThan(1000)
    expect(slidePromptWindow(messages, 1000, count).removedMessages).toBeGreaterThan(0)
    expect(notice?.cacheControl?.replayAnchor).toEqual({ key: 'input-2', messageId: 2 })
    expect(messages.some((message) => message.content === '当前输入一')).toBe(false)
    expect(messages.at(-1)?.content).toBe('当前输入二')
  })

  it('旧轮框架快照随窗口退出，本轮槽位与输入保持完整', () => {
    const oldSlot: ChatMessage = {
      role: 'user',
      content: '旧轮动态资料'.repeat(2000),
      cacheControl: {
        kind: 'snapshot',
        key: 'prompt-slot:turn_context',
        replayAnchor: { key: 'input-1', messageId: 1 },
      },
    }
    const currentSlot: ChatMessage = {
      role: 'user',
      content: '本轮动态资料',
      cacheControl: {
        kind: 'snapshot',
        key: 'prompt-slot:turn_context',
        replayAnchor: { key: 'input-2', messageId: 2 },
      },
    }
    const current: ChatMessage = {
      role: 'user',
      content: '当前请求',
      cacheControl: { kind: 'current', replayAnchor: { key: 'input-2', messageId: 2 } },
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: '固定规则' },
      oldSlot,
      currentSlot,
      current,
    ]
    const result = slidePromptWindow(messages, 1000, () => tokenCounter.countMessages(messages))
    expect(result.usedTokens).toBeLessThanOrEqual(1000)
    expect(messages).not.toContain(oldSlot)
    expect(messages).toContain(currentSlot)
    expect(messages).toContain(current)
  })

  it('不会拆散未闭合的工具批次', () => {
    const pending: ChatMessage = {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'pending', type: 'function', function: { name: 'edit_file', arguments: '{}' } },
      ],
    }
    const messages: ChatMessage[] = [
      { role: 'user', content: '任务', cacheControl: { kind: 'current' } },
      ...group(1),
      ...group(2),
      pending,
    ]
    slidePromptWindow(messages, 1800, () => tokenCounter.countMessages(messages))
    expect(messages).toContain(pending)
    expect(messages.some((message) => message.toolCallId === 'pending')).toBe(false)
  })
})
