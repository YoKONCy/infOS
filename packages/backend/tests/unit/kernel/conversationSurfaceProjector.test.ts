import type { ConversationMessageProjection } from '@infos/shared'
import { describe, expect, it } from 'vitest'
import { ConversationSurfaceProjector } from '@infos/backend/projections/conversationSurfaceProjector'

function message(revision = 1): ConversationMessageProjection {
  return {
    messageId: '42',
    threadId: 'thread-1',
    role: 'assistant',
    content: '## 完成',
    rawContent: null,
    pairId: 'pair-1',
    senderId: 'pero',
    agentId: 'pero',
    revision,
    imageTranscription: false,
    status: 'completed',
    timestamp: '2026-08-18T00:00:00.000Z',
    toolCalls: [
      {
        callId: 'call-1',
        name: 'read_file',
        args: '{"path":"a.ts"}',
        result: '内容',
        isError: false,
      },
    ],
    contentBlocks: [],
    attachments: [],
  }
}

describe('Conversation Surface Projector', () => {
  it('重建历史时使用搜索列表预览，不被无正文的工具审计覆盖', () => {
    const value = message()
    const preview = JSON.stringify({
      matches: [{ file: '/project/a.ts', line: 3, column: 7, content: '命中' }],
      total: 1,
      fileCount: 1,
      navigation: {
        agentId: 'pero',
        threadId: 'thread-1',
        resultRef: 'tool-result:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
    })
    value.toolCalls = [
      {
        callId: 'search',
        name: 'code_search',
        args: '{}',
        result: '{"kind":"tool_result_audit","fileCount":1,"total":1}',
        isError: false,
      },
    ]
    value.contentBlocks = [
      {
        kind: 'tool',
        blockId: 'search-block',
        sequence: 1,
        turn: 1,
        callId: 'search',
        name: 'code_search',
        args: '{}',
        result: preview,
        isError: false,
      },
    ]
    const restored = JSON.parse(JSON.stringify(value))
    const result = new ConversationSurfaceProjector()
      .projectMessage(restored, 'pero')
      .nodes.find((node) => node.kind === 'tool-result')
    expect(result?.props).toMatchObject({ callId: 'search', result: preview })
  })

  it('旧 NIT 审计记录补进对应脚本，已有子时间线不重复渲染', () => {
    const value = message()
    value.contentBlocks = [
      {
        kind: 'tool',
        blockId: 'script-block',
        sequence: 1,
        turn: 1,
        callId: 'script',
        name: 'run_script',
        args: '{}',
        result: '完成',
        isError: false,
      },
    ]
    value.toolCalls = [
      {
        callId: 'nit-one',
        name: 'read_file',
        args: '{"path":"a.ts"}',
        result: '读取完成',
        isError: false,
      },
      {
        callId: 'nit-two',
        name: 'edit_file',
        args: '{"path":"a.ts"}',
        result: '修改完成',
        isError: false,
      },
      { callId: 'script', name: 'run_script', args: '{}', result: '完成', isError: false },
    ]
    const projector = new ConversationSurfaceProjector()
    const calls = projector
      .projectMessage(value, 'pero')
      .nodes.filter((node) => node.kind === 'tool-call')
    expect(calls.map((node) => node.props)).toMatchObject([
      { callId: 'script' },
      { callId: 'nit-one', parentCallId: 'script' },
      { callId: 'nit-two', parentCallId: 'script' },
    ])
    value.contentBlocks.push({
      kind: 'tool',
      blockId: 'new-child',
      sequence: 2,
      turn: 1,
      callId: 'nit-one',
      parentCallId: 'script',
      name: 'read_file',
      args: '{}',
      result: '读取完成',
    })
    const restored = projector
      .projectMessage(value, 'pero')
      .nodes.filter((node) => node.kind === 'tool-call')
    expect(
      restored.filter((node) => (node.props as { callId: string }).callId === 'nit-one'),
    ).toHaveLength(1)
  })

  it('暂停记录可从持久消息重建，不显示失败或输出完成', () => {
    const value = message()
    value.status = 'active'
    value.executionPause = {
      kind: 'desktop',
      code: 'DESKTOP_WAITING',
      message: '用户已接管',
      toolName: 'open_application',
      callId: 'open',
      pausedAt: '2026-10-18T08:00:00Z',
    }
    const surface = new ConversationSurfaceProjector().projectMessage(value, 'pero')
    expect(surface.state).toBe('committed')
    expect(surface.nodes.some((node) => node.kind === 'error')).toBe(false)
    expect(surface.nodes.at(-1)?.props).toMatchObject({
      state: 'paused',
      message: '桌面操作已暂停：用户已接管',
    })
  })
  it('历史重试记录保留在断开处，后续重试不覆盖前一次计数', () => {
    const value = message()
    const retry = {
      retryId: 'retry-1',
      state: 'recovered' as const,
      attempt: 1,
      maxRetries: 5,
      delayMs: 1000,
      reason: '连接异常',
      startedAt: 1,
      updatedAt: 2,
      partialResponse: true,
    }
    value.contentBlocks = [
      {
        blockId: 'before',
        sequence: 1,
        kind: 'narration',
        turn: 1,
        phase: 'progress',
        content: '中断前',
      },
      { blockId: 'retry-1', sequence: 2, kind: 'model_retry', turn: 1, retry },
      {
        blockId: 'retry-2',
        sequence: 3,
        kind: 'model_retry',
        turn: 1,
        retry: { ...retry, retryId: 'retry-2', attempt: 2 },
      },
      {
        blockId: 'after',
        sequence: 4,
        kind: 'narration',
        turn: 1,
        phase: 'final',
        content: '后续回复',
      },
    ]
    const surface = new ConversationSurfaceProjector().projectMessage(value, 'pero')
    expect(surface.nodes.map((node) => node.kind)).toEqual([
      'markdown',
      'model-retry',
      'model-retry',
      'markdown',
    ])
    expect(surface.nodes[1]?.props).toMatchObject(retry)
    expect(surface.nodes[2]?.props).toMatchObject({ retryId: 'retry-2', attempt: 2 })
  })
  it('相同领域消息必须生成完全相同的 committed Surface', () => {
    const projector = new ConversationSurfaceProjector()
    const first = projector.projectMessage(message(), 'pero')
    const second = projector.projectMessage(message(), 'pero')

    expect(second).toEqual(first)
  })

  it('编辑只改变 generation 和 revision，不改变稳定 Surface 与 Node 身份', () => {
    const projector = new ConversationSurfaceProjector()
    const first = projector.projectMessage(message(1), 'pero')
    const edited = projector.projectMessage(message(2), 'pero')

    expect(edited.surfaceId).toBe(first.surfaceId)
    expect(edited.nodes.map(({ kind, nodeId }) => ({ kind, nodeId }))).toEqual(
      first.nodes.map(({ kind, nodeId }) => ({ kind, nodeId })),
    )
    expect(edited.generation).not.toBe(first.generation)
    expect(edited.revision).toBe(2)
  })

  it('工具调用和结果必须保留独立节点身份', () => {
    const surface = new ConversationSurfaceProjector().projectMessage(message(), 'pero')
    expect(surface.nodes.map((node) => node.kind)).toEqual(['markdown', 'tool-call', 'tool-result'])
    expect(new Set(surface.nodes.map((node) => node.nodeId)).size).toBe(surface.nodes.length)
    expect(surface.nodes.find((node) => node.kind === 'tool-call')?.props).toMatchObject({
      name: 'read_file',
      args: '{"path":"a.ts"}',
    })
    expect(surface.nodes.find((node) => node.kind === 'tool-result')?.props).toMatchObject({
      result: '内容',
      isError: false,
    })
    for (const node of surface.nodes.filter((node) => node.kind.startsWith('tool-'))) {
      expect(node.props).toMatchObject({ callId: 'call-1' })
    }
  })
})
