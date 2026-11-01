import { describe, expect, it } from 'vitest'
import { buildAssistantPrompt } from '../src/services/assistantContext'
import { defaultAssistantSettings } from '../../src/assistantSettings'
import type { Project } from '../src/types'

const project = (): Project => ({
  id: 'canvas',
  title: '画布',
  revision: 1,
  items: [
    { id: 'group', x: 0, y: 0, content: { version: 1, kind: 'group', width: 600, height: 400 } },
    {
      id: 'inside',
      x: 20,
      y: 30,
      content: {
        version: 1,
        kind: 'text',
        width: 300,
        height: 200,
        groupId: 'group',
        text: '日落配色',
      },
    },
    {
      id: 'outside',
      x: 800,
      y: 0,
      content: { version: 1, kind: 'text', width: 300, height: 200, text: '其他创作' },
    },
  ],
})
describe('助手上下文范围与预算', () => {
  it('选中分组时包含组内节点，保留原画布的提案基准', () => {
    const context = {
      baseKey: 'original-key',
      project: project(),
      selected: ['group'],
      steps: [],
      imagesIncluded: false,
    }
    const prompt = JSON.parse(
      buildAssistantPrompt('整理分组', context, [{ role: 'user', text: '旧要求' }], {
        ...defaultAssistantSettings(),
        contextScope: 'selection',
        historyMessages: 0,
      }),
    )
    expect(prompt.context.project.items.map((item: { id: string }) => item.id)).toEqual([
      'group',
      'inside',
    ])
    expect(prompt.context.baseKey).toBe('original-key')
    expect(prompt.history).toEqual([])
    expect(context.project.items.map((item) => item.id)).toEqual(['group', 'inside', 'outside'])
  })
  it('上下文不足时先移除旧消息，当前请求与完整选中内容不被截断', () => {
    const context = {
      baseKey: 'key',
      project: project(),
      selected: [],
      steps: [],
      imagesIncluded: false,
    }
    const prompt = JSON.parse(
      buildAssistantPrompt(
        '本次完整要求',
        context,
        [
          { role: 'assistant', text: '旧'.repeat(4000) },
          { role: 'user', text: '最近的要求' },
        ],
        { ...defaultAssistantSettings(), contextCharacters: 4000 },
      ),
    )
    expect(prompt.request).toBe('本次完整要求')
    expect(prompt.context.project.items).toHaveLength(3)
    expect(prompt.history).toEqual([{ role: 'user', text: '最近的要求' }])
  })
  it('空选区不退回整张画布；当前内容超限时明确拒绝', () => {
    const context = {
      baseKey: 'key',
      project: project(),
      selected: [],
      steps: [],
      imagesIncluded: false,
    }
    expect(() =>
      buildAssistantPrompt('整理', context, [], {
        ...defaultAssistantSettings(),
        contextScope: 'selection',
      }),
    ).toThrow('ASSISTANT_SELECTION_REQUIRED')
    context.project.items[1]!.content.text = '当前内容'.repeat(2000)
    expect(() =>
      buildAssistantPrompt('整理', context, [], {
        ...defaultAssistantSettings(),
        contextCharacters: 4000,
      }),
    ).toThrow('ASSISTANT_CONTEXT_LIMIT')
  })
})
