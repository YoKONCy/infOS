import { describe, expect, it } from 'vitest'
import type { SurfaceNode, SurfaceNodeId } from '@infos/shared'
import {
  groupExecutionItems,
  type ConversationRenderItem,
} from '../../src/compositor/executionGroups'

function node(id: string, kind: SurfaceNode['kind'], props: object = {}): ConversationRenderItem {
  return {
    type: 'node',
    id,
    node: { nodeId: id as SurfaceNodeId, kind, props, lifecycle: 'stable', revision: 1 },
  }
}
function tool(id: string): ConversationRenderItem {
  return node(id, 'tool-call', { callId: id, name: 'read_file', args: '{}', state: 'calling' })
}
function text(id: string, source: string): ConversationRenderItem {
  return { type: 'markdown-block', id, block: { id, source, kind: 'markdown', stable: true } }
}

describe('连续 ReAct 执行段', () => {
  it('工具结果、思考与状态不拆段，中途正文和最终正文留在段外并保留原顺序', () => {
    const groups = groupExecutionItems(
      [
        tool('call-1'),
        node('result-1', 'tool-result'),
        node('reasoning', 'native-reasoning'),
        node('status', 'status'),
        tool('call-2'),
        text('narration', '我应该先核对一下。'),
        tool('call-3'),
        tool('call-4'),
        text('answer', '完成了，以下是结果说明。'),
      ],
      false,
    )
    expect(groups.map((group) => group.items.map(({ item }) => item.id))).toEqual([
      ['call-1', 'result-1', 'reasoning', 'status', 'call-2'],
      ['narration'],
      ['call-3', 'call-4'],
      ['answer'],
    ])
    expect(groups.map((group) => group.toolCount)).toEqual([2, 0, 2, 0])
  })

  it('需要确认、提问、错误与交付附件始终在执行段外', () => {
    const groups = groupExecutionItems(
      [
        tool('one'),
        node('approval', 'approval'),
        tool('two'),
        node('input', 'input'),
        node('error', 'error'),
        node('image', 'attachment'),
        tool('three'),
      ],
      false,
    )
    expect(groups.map((group) => group.items.map(({ item }) => item.id))).toEqual([
      ['one'],
      ['approval'],
      ['two'],
      ['input'],
      ['error'],
      ['image'],
      ['three'],
    ])
  })

  it('摘要计入 NIT 子调用及真实失败，结束但缺少结果的调用标为异常', () => {
    const parent = tool('script')
    if (parent.type !== 'node') throw new Error('工具样例必须为节点')
    parent.toolResult = { callId: 'script', result: '已结束', isError: false }
    parent.children = [
      { name: 'read_file', args: '{}', result: '已读取' },
      { name: 'write_file', args: '{}', result: '写入失败', isError: true },
    ]
    const groups = groupExecutionItems([parent, tool('interrupted')], true)
    expect(groups[0]?.toolCount).toBe(4)
    expect(groups[0]?.failureCount).toBe(2)
  })
})
