import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../../src/services/llm/types'
import type { ThreadMessageInfo } from '../../../../src/services/thread/threadService'
import {
  auditWorkMessages,
  closeWorkToolGroups,
  persistentWorkMessage,
  projectWorkHistory,
  publicWorkMetadata,
  type WorkContextRecord,
} from '../../../../src/services/context/workContext'
import { promptFingerprint } from '../../../../src/services/llm/promptCache'

const scope = { threadId: 'thread', agentId: 'pero', channel: 'desktop', modelKey: 'model' }
const trace: ChatMessage[] = [
  {
    role: 'assistant',
    content: '先读取',
    reasoningContent: '完整思考',
    nativeReasoning: [{ format: 'reasoning_details', opaque: { signature: '签名' } }],
    toolCalls: [
      {
        id: 'read',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
      },
    ],
  },
  { role: 'tool', toolCallId: 'read', content: '文件的完整旧版本正文' },
  { role: 'assistant', content: '已读取' },
]
function fixture() {
  const user = {
    id: 1,
    threadId: 'thread',
    agentId: null,
    pairId: 'pair',
    role: 'user',
    content: '读取文件',
    revision: 1,
    metadataJson: '{}',
    status: 'active',
  } as ThreadMessageInfo
  const record: WorkContextRecord = {
    ...scope,
    version: 1,
    pairId: 'pair',
    inputHash: promptFingerprint(user.content),
    replyHash: promptFingerprint('已读取'),
    historyRevisions: [[1, 1]],
    messages: structuredClone(trace),
  }
  const assistant = {
    ...user,
    id: 2,
    role: 'assistant',
    agentId: 'pero',
    content: '已读取',
    metadataJson: JSON.stringify({ workContext: record }),
  } as ThreadMessageInfo
  const compiled: ChatMessage[] = [
    { role: 'system', content: '当前系统规则' },
    { role: 'user', content: user.content, cacheControl: { kind: 'history', historyMessageId: 1 } },
    {
      role: 'assistant',
      content: assistant.content,
      cacheControl: { kind: 'history', historyMessageId: 2, key: '2:1' },
    },
    { role: 'user', content: '继续', cacheControl: { kind: 'current' } },
  ]
  return { user, assistant, record, compiled }
}

describe('持久工作上下文', () => {
  it('恢复历史工作输入时保留时间标记，原始输入哈希与本轮输入保持原样', () => {
    const { user, assistant, record, compiled } = fixture()
    record.input = { role: 'user', content: '读取文件\n【工作区选择】a.ts' }
    assistant.metadataJson = JSON.stringify({ workContext: record })
    const before = JSON.stringify([user, assistant, compiled])
    const anchor = '【对话记录时间：2026-10-25 07:02】'
    const restored = projectWorkHistory(
      compiled,
      [user, assistant],
      scope,
      new Map([[user.id, anchor]]),
    )
    expect(restored.find((message) => message.cacheControl?.historyMessageId === 1)?.content).toBe(
      `${anchor}\n读取文件\n【工作区选择】a.ts`,
    )
    expect(restored.some((message) => message.toolCallId === 'read')).toBe(true)
    expect(restored.at(-1)?.content).toBe('继续')
    expect(JSON.stringify([user, assistant, compiled])).toBe(before)
  })
  it('主动回合不需要伪造用户消息，仍能恢复输入与工具原件', () => {
    const { assistant, record, compiled } = fixture()
    record.inputKind = 'proactive'
    record.input = { role: 'user', content: '宿主自主检查' }
    record.inputHash = promptFingerprint(record.input.content)
    record.historyRevisions = []
    assistant.metadataJson = JSON.stringify({ workContext: record })
    const input = compiled.filter((message) => message.cacheControl?.historyMessageId !== 1)
    const restored = projectWorkHistory(input, [assistant], scope)
    expect(restored.some((message) => message.content === '宿主自主检查')).toBe(true)
    expect(
      restored.some((message) => message.role === 'tool' && message.toolCallId === 'read'),
    ).toBe(true)
    expect(restored.at(-1)?.content).toBe('继续')
  })
  it('冷启动按消息身份恢复完整工具协议，不靠热缓存，保留最新用户修正', () => {
    const { user, assistant, compiled } = fixture()
    const before = JSON.stringify(compiled)
    const restored = projectWorkHistory(compiled, [user, assistant], scope)
    expect(restored.slice(2, 5).map(({ cacheControl: _cache, ...message }) => message)).toEqual(
      trace,
    )
    expect(restored[0]?.content).toBe('当前系统规则')
    expect(
      restored.slice(2, 5).every((message) => message.cacheControl?.historySourceKey === '2:1'),
    ).toBe(true)
    expect(restored.at(-1)?.content).toBe('继续')
    expect(JSON.stringify(compiled)).toBe(before)
  })

  it.each([
    { agentId: 'nana' },
    { threadId: 'other' },
    { taskId: 'background' },
    { channel: 'group' },
  ])('不同作用域不恢复详细轨迹：%j', (different) => {
    const { user, assistant, compiled } = fixture()
    expect(projectWorkHistory(compiled, [user, assistant], { ...scope, ...different })).toEqual(
      compiled,
    )
  })

  it('切换模型只去掉不兼容推理载荷，工具参数与正文继续可用', () => {
    const { user, assistant, compiled } = fixture()
    const restored = projectWorkHistory(compiled, [user, assistant], {
      ...scope,
      modelKey: 'other',
    })
    expect(restored.find((message) => message.toolCalls)?.reasoningContent).toBeUndefined()
    expect(restored.find((message) => message.toolCalls)?.nativeReasoning).toBeUndefined()
    expect(restored.find((message) => message.toolCallId === 'read')?.content).toBe(
      trace[1]!.content,
    )
  })

  it('输入编辑后阻止旧轨迹，基于新修正生成的记录仍然可以恢复', () => {
    const { user, assistant, compiled, record } = fixture()
    user.content = '改成读取另一个文件'
    user.revision = 2
    expect(projectWorkHistory(compiled, [user, assistant], scope)).toEqual(compiled)
    record.inputHash = promptFingerprint(user.content)
    record.historyRevisions = [[1, 2]]
    assistant.metadataJson = JSON.stringify({ workContext: record })
    expect(
      projectWorkHistory(compiled, [user, assistant], scope).some(
        (message) => message.toolCallId === 'read',
      ),
    ).toBe(true)
    assistant.revision = 2
    expect(projectWorkHistory(compiled, [user, assistant], scope)).toEqual(compiled)
  })

  it('中断批次不伪造成功，不重放调用，也不留下孤立结果', () => {
    const interrupted: ChatMessage[] = [
      trace[0]!,
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'write', type: 'function', function: { name: 'write_file', arguments: '{}' } },
        ],
      },
    ]
    const restored = closeWorkToolGroups(interrupted)
    expect(restored.filter((message) => message.role === 'tool')).toHaveLength(2)
    expect(
      restored
        .filter((message) => message.role === 'tool')
        .every((message) => message.toolExecutionFailed),
    ).toBe(true)
    expect(restored.find((message) => message.toolCallId === 'write')?.content).toContain(
      '不得当作成功',
    )
  })

  it('调试与列表不再次装载历史正文，当前轮原件仍完整保存', () => {
    const { user, assistant, compiled } = fixture()
    const restored = projectWorkHistory(compiled, [user, assistant], scope)
    expect(JSON.stringify(auditWorkMessages(restored))).not.toContain('文件的完整旧版本正文')
    expect(publicWorkMetadata(assistant.metadataJson)).toBe('{}')
    expect(persistentWorkMessage(trace[1]!)).toEqual(trace[1])
    const image = persistentWorkMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'attachment:图片快照' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    })
    expect(String(image.content)).toContain('attachment:图片快照')
    expect(JSON.stringify(image)).not.toContain('base64')
  })
  it('永久遗忘撤销详细副本后，旧工具条也不能作为兼容入口重新注入', () => {
    const { user, assistant, compiled } = fixture()
    assistant.metadataJson = JSON.stringify({
      workContextRevoked: true,
      toolCalls: [
        { callId: 'old', name: 'read_file', args: { path: 'a.ts' }, result: '已遗忘资料' },
      ],
    })
    expect(projectWorkHistory(compiled, [user, assistant], scope)).toEqual(compiled)
  })
})
