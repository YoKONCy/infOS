import { describe, expect, it } from 'vitest'
import { ConversationProjectionService } from '../../../src/projections/conversationProjectionService'
import { ApprovalService } from '../../../src/services/execution/approvalService'
import { AgentInputService } from '../../../src/services/execution/agentInputService'

function createProjection() {
  const approvals = new ApprovalService()
  const inputs = new AgentInputService()
  const service = new ConversationProjectionService(
    {
      getThread: async () => ({ id: 'thread-1', agentId: 'pero', threadKind: 'side', generation: 1 }),
      assertGeneration: async () => {},
      listMessages: async () => ({ items: [], total: 0 }),
    } as never,
    { listForMessages: async () => new Map() } as never,
    approvals,
    inputs,
  )
  approvals.onRequested((request) => service.invalidate(request.threadId))
  inputs.onRequested((request) => service.invalidate(request.threadId))
  approvals.onResolved((request) => service.invalidate(request.threadId))
  inputs.onResolved((request) => service.invalidate(request.threadId))
  return { service, approvals, inputs }
}

describe('Conversation交互Surface投影', () => {
  it('NIT 父子关系经过消息落盘读取后仍保留，历史子调用可被前端归组', async () => {
    const tool = {
      blockId: 'nested',
      sequence: 2,
      kind: 'tool',
      turn: 1,
      callId: 'nit-child',
      parentCallId: 'script',
      name: 'read_file',
      args: '{}',
      result: '读取完成',
      isError: false,
    }
    const service = new ConversationProjectionService(
      {
        getThread: async () => ({ id: 'thread-1', agentId: 'pero', threadKind: 'side', generation: 1 }),
        assertGeneration: async () => {},
        listMessages: async () => ({
          items: [
            {
              id: 1,
              threadId: 'thread-1',
              agentId: 'pero',
              role: 'assistant',
              content: '完成',
              status: 'active',
              revision: 1,
              timestamp: '2026-10-20T00:00:00Z',
              metadataJson: JSON.stringify({ contentBlocks: [tool], toolCalls: [tool] }),
            },
          ],
          total: 1,
        }),
      } as never,
      { listForMessages: async () => new Map() } as never,
    )
    const snapshot = await service.getSnapshot('thread-1')
    expect(snapshot.messages[0]?.contentBlocks[0]).toMatchObject({ parentCallId: 'script' })
    expect(snapshot.messages[0]?.toolCalls[0]).toMatchObject({ parentCallId: 'script' })
    expect(
      snapshot.surfaces[0]?.nodes.find((node) => node.kind === 'tool-call')?.props,
    ).toMatchObject({ parentCallId: 'script' })
  })

  it('从消息 metadata 重建原始重试记录，计数和位置不因回连丢失', async () => {
    const retry = {
      retryId: 'retry-1',
      state: 'recovered',
      attempt: 1,
      maxRetries: 5,
      reason: '上游连接重置',
      delayMs: 1250,
      startedAt: 100,
      updatedAt: 500,
      partialResponse: true,
    }
    const service = new ConversationProjectionService(
      {
        getThread: async () => ({ id: 'thread-1', agentId: 'pero', threadKind: 'side', generation: 1 }),
        assertGeneration: async () => {},
        listMessages: async () => ({
          items: [
            {
              id: 1,
              threadId: 'thread-1',
              agentId: 'pero',
              role: 'assistant',
              content: '最终答复',
              status: 'active',
              revision: 0,
              timestamp: '2026-10-18T00:00:00Z',
              metadataJson: JSON.stringify({
                contentBlocks: [
                  {
                    blockId: 'old',
                    sequence: 1,
                    kind: 'narration',
                    turn: 1,
                    phase: 'progress',
                    content: '旧片段',
                  },
                  { blockId: 'retry', sequence: 2, kind: 'model_retry', turn: 1, retry },
                  {
                    blockId: 'new',
                    sequence: 3,
                    kind: 'narration',
                    turn: 1,
                    phase: 'final',
                    content: '最终答复',
                  },
                ],
              }),
            },
          ],
          total: 1,
        }),
      } as never,
      { listForMessages: async () => new Map() } as never,
    )
    const snapshot = await service.getSnapshot('thread-1')
    expect(snapshot.messages[0]?.contentBlocks[1]).toMatchObject({ kind: 'model_retry', retry })
    expect(snapshot.surfaces[0]?.nodes.map((node) => node.kind)).toEqual([
      'markdown',
      'model-retry',
      'markdown',
    ])
    expect(snapshot.surfaces[0]?.nodes[1]?.props).toMatchObject({ ...retry, turn: 1 })
  })
  it('历史错位标签不再展示，并恢复独立口语答复；用户文字与审计原文保持完整', async () => {
    const text = '已完成。<spoken_reply>请查看文件。</spoken_reply>交付说明。'
    const legacy = {
      id: 2,
      threadId: 'thread-1',
      agentId: 'pero',
      role: 'assistant',
      content: text,
      status: 'active',
      revision: 0,
      timestamp: '2026-10-14T01:00:00Z',
      rawContent: text,
      metadataJson: JSON.stringify({
        contentBlocks: [
          {
            blockId: 'final',
            kind: 'narration',
            turn: 1,
            sequence: 1,
            phase: 'final',
            content: text,
          },
        ],
      }),
    }
    const service = new ConversationProjectionService(
      {
        getThread: async () => ({ id: 'thread-1', agentId: 'pero', threadKind: 'side', generation: 1 }),
        assertGeneration: async () => {},
        listMessages: async () => ({
          items: [legacy, { ...legacy, id: 1, role: 'user', metadataJson: '{}' }],
          total: 2,
        }),
      } as never,
      { listForMessages: async () => new Map() } as never,
    )
    const snapshot = await service.getSnapshot('thread-1')
    const message = snapshot.messages.find((item) => item.role === 'assistant')!
    expect(message.content).toBe('已完成。交付说明。')
    expect(message.spokenReply).toBe('请查看文件。')
    expect(snapshot.surfaces.find((item) => item.messageId === '2')?.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'markdown',
        props: expect.objectContaining({ source: message.content }),
      }),
    )
    expect(snapshot.messages.find((item) => item.role === 'user')?.content).toBe(text)
    expect(legacy.content).toBe(text)
    expect(message.rawContent).toBe(text)
  })
  it('缓存建立后新增求助仍应立即进入下一份Projection', async () => {
    const { service, inputs } = createProjection()
    expect((await service.getSnapshot('thread-1')).surfaces).toEqual([])

    inputs.create({
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'thread-1',
      threadId: 'thread-1',
      question: '你希望采用哪一种方式？',
    })

    const snapshot = await service.getSnapshot('thread-1')
    expect(snapshot.surfaces).toEqual([
      expect.objectContaining({
        surfaceId: expect.stringMatching(/^conversation-input:/),
        threadId: 'thread-1',
        nodes: [
          expect.objectContaining({
            kind: 'input',
            props: expect.objectContaining({
              question: '你希望采用哪一种方式？',
              principalId: 'pero',
            }),
          }),
        ],
      }),
    ])
  })

  it('缓存建立后新增审批仍应立即进入下一份Projection', async () => {
    const { service, approvals } = createProjection()
    await service.getSnapshot('thread-1')

    approvals.create({
      agentId: 'pero',
      channel: 'desktop',
      sessionId: 'thread-1',
      threadId: 'thread-1',
      toolName: 'delete_file',
      args: { file_path: 'C:/outside/test.txt' },
      reason: '需要删除工作区外文件',
    })

    const snapshot = await service.getSnapshot('thread-1')
    expect(snapshot.surfaces).toEqual([
      expect.objectContaining({
        surfaceId: expect.stringMatching(/^conversation-approval:/),
        nodes: [
          expect.objectContaining({
            kind: 'approval',
            props: expect.objectContaining({
              toolName: 'delete_file',
              title: '需要删除工作区外文件',
              threadId: 'thread-1',
              principalId: 'pero',
            }),
          }),
        ],
      }),
    ])
  })
})
