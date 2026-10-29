import { describe, expect, it, vi } from 'vitest'
import type { SurfaceFrame } from '@infos/shared'
import { AppError } from '@infos/backend/lib/appError'
import { runChatStream } from '@infos/backend/services/conversation/chatStreamRunner'

describe('队列准备失败的实时反馈', () => {
  it('Execution 尚未创建时也打开失败 Surface，使仅订阅 Surface 的客户端收到原因', async () => {
    const afterTurn = vi.fn()
    const unregisterTask = vi.fn()
    const frames: SurfaceFrame[] = []
    const outcome = await runChatStream(
      {
        runtimeStateService: {
          getAbortSignal: vi.fn(),
          unregisterTask,
        },
        conversationQueue: { afterTurn, setLive: vi.fn() },
        conversationTurnService: {
          async *streamTurn() {
            yield await Promise.reject(new AppError('CONFIG_ERROR', { message: '请选择可用模型' }))
          },
        },
      } as never,
      {
        threadId: 'thread',
        agentId: 'pero',
        content: '你好',
        queueMessageId: 'submission',
      },
      async (event) => {
        // 与持久队列的 Gateway 转发一致：普通 SSE error 不会传给 Surface 订阅者。
        if (event.event === 'surface') frames.push(JSON.parse(event.data))
      },
    )
    expect(outcome).toEqual({ success: false, error: '请选择可用模型' })
    expect(frames.map((frame) => frame.operation.type)).toEqual(['surface.open', 'surface.fail'])
    expect(frames[0]!.operation).toMatchObject({ threadId: 'thread', principalId: 'pero' })
    expect(frames[1]!.operation).toMatchObject({
      code: 'CONFIG_ERROR',
      message: '请选择可用模型',
    })
    expect(frames[1]!.surfaceId).toBe(frames[0]!.surfaceId)
    expect(afterTurn).toHaveBeenCalledWith('thread', outcome)
    expect(unregisterTask).toHaveBeenCalledWith('thread')
  })
})
