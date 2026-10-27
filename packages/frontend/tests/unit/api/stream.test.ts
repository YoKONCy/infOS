import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const baseUrlMock = vi.hoisted(() => ({
  getBaseUrl: vi.fn(() => 'http://localhost:7359'),
}))

vi.mock('@infos/frontend/api/transportUtils', () => ({
  getBaseUrl: baseUrlMock.getBaseUrl,
}))

import { streamRequest } from '@infos/frontend/api/stream'

// 使用真实传输层；测试环境也要提供当前页面来源，才能核验服务端与凭据边界。
beforeEach(() => {
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      location: { origin: 'http://localhost:7359' },
    }),
  )
  vi.stubGlobal('document', new EventTarget())
})

function createStream(chunks: string[]) {
  const bytes = new TextEncoder().encode(chunks.join(''))
  const chinese = bytes.findIndex((byte) => byte > 127)
  const cuts = [
    ...new Set([0, 3, chinese + 1, Math.floor(bytes.length / 2), bytes.length - 1, bytes.length]),
  ].sort((a, b) => a - b)
  let index = 0
  let finish!: () => void
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    ended,
    getReader: () => ({
      cancel: vi.fn(async () => {
        finish()
      }),
      releaseLock: vi.fn(),
      read: async () => {
        if (index >= cuts.length - 1) {
          finish()
          return { done: true, value: undefined }
        }
        const value = bytes.slice(cuts[index], cuts[++index])
        return { done: false, value }
      },
    }),
  }
}

describe('streamRequest', () => {
  it('Surface 回调出错必须进入错误处理，不能当成坏 JSON 静默忽略', async () => {
    const onError = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, body: createStream(['event: surface\ndata: {}\n\n']) })),
    )
    streamRequest(
      '/chat/stream',
      {},
      {
        onSurface: () => {
          throw new Error('渲染失败')
        },
        onError,
      },
    )
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith({ code: 'STREAM_ERROR', message: '渲染失败' })
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('应当发送 POST 请求并解析完整 SSE 事件序列', async () => {
    const events = {
      onSurface: vi.fn(),
      onRagProgress: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const stream = createStream([
      'event: rag_progress\ndata: {"stage":"embedding","message":"正在生成记忆检索向量"}\n\n',
      'event: surface\ndata: {"protocolVersion":1,"surfaceId":"s1","generation":"g1","revision":1,"sequence":1,"operationId":"o1","operation":{"type":"surface.open","threadId":"t1","principalId":"pero"}}\n\n',
      'event: done\ndata: {"usage":{"promptTokens":4,"completionTokens":8},"toolCallCount":0,"durationMs":10,"threadId":"t1"}',
    ])
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, body: stream }))
    vi.stubGlobal('fetch', fetchMock)

    const controller = streamRequest('/chat/stream', { message: '你好' }, events)
    await stream.ended
    await vi.waitFor(() => expect(events.onDone).toHaveBeenCalledOnce())

    expect(controller).toBeInstanceOf(AbortController)
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:7359/api/chat/stream', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'include',
      body: JSON.stringify({ message: '你好' }),
      signal: controller.signal,
    })
    expect(events.onRagProgress).toHaveBeenCalledWith({
      stage: 'embedding',
      message: '正在生成记忆检索向量',
    })
    expect(events.onSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        surfaceId: 's1',
        operation: expect.objectContaining({ type: 'surface.open' }),
      }),
    )
    expect(events.onDone).toHaveBeenCalledWith({
      usage: { promptTokens: 4, completionTokens: 8 },
      toolCallCount: 0,
      durationMs: 10,
      threadId: 't1',
    })
    expect(events.onError).not.toHaveBeenCalled()
  })

  it('应当在 HTTP 响应异常或缺少 body 时触发网络错误', async () => {
    const events = { onError: vi.fn() }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 503, body: null, json: async () => null })),
    )

    streamRequest('/chat/stream', {}, events)
    await vi.waitFor(() => expect(events.onError).toHaveBeenCalled())

    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NETWORK_ERROR', message: expect.stringContaining('503') }),
    )
  })

  it('应当忽略无效 JSON 事件并处理 error 事件', async () => {
    const events = { onSurface: vi.fn(), onError: vi.fn() }
    const stream = createStream([
      'event: surface\ndata: 不是 JSON\n\n',
      'event: error\ndata: {"code":"LLM_ERROR","message":"模型异常"}\n\n',
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, body: stream })),
    )

    streamRequest('/chat/stream', {}, events)
    await stream.ended
    await vi.waitFor(() => expect(events.onError).toHaveBeenCalledOnce())

    expect(events.onSurface).not.toHaveBeenCalled()
    expect(events.onError).toHaveBeenCalledWith({ code: 'LLM_ERROR', message: '模型异常' })
  })

  it('只有用户主动取消才静默，上游中断和网络异常必须进入错误处理', async () => {
    const streamErrorEvents = { onError: vi.fn() }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('连接断开'))),
    )

    streamRequest('/chat/stream', {}, streamErrorEvents)
    await vi.waitFor(() => expect(streamErrorEvents.onError).toHaveBeenCalledOnce())

    expect(streamErrorEvents.onError).toHaveBeenCalledWith({
      code: 'STREAM_ERROR',
      message: '连接断开',
    })

    const abortEvents = { onError: vi.fn() }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(Object.assign(new Error('已中断'), { name: 'AbortError' }))),
    )

    const cancelled = streamRequest('/chat/stream', {}, abortEvents)
    cancelled.abort()
    await vi.dynamicImportSettled()

    expect(abortEvents.onError).not.toHaveBeenCalled()
    const upstreamAbort = { onError: vi.fn() }
    streamRequest('/chat/stream', {}, upstreamAbort)
    await vi.waitFor(() => expect(upstreamAbort.onError).toHaveBeenCalledOnce())
  })
})

describe('流式连接保活与断流恢复入口', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('半开连接超过保活窗口后只报告一次断流，不重新发送任务', async () => {
    const onError = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start() {} })
    const fetchMock = vi.fn(async () => ({ ok: true, body }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = streamRequest('/chat/stream', { threadId: '原任务' }, { onError })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(controller.signal.aborted).toBe(true)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'STREAM_ERROR' }))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(onError).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('只有保活帧的长工具任务可以持续等待，不按整段任务时长超时', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, body })),
    )
    const onError = vi.fn()
    const controller = streamRequest('/chat/stream', {}, { onError })
    for (let cycle = 0; cycle < 8; cycle++) {
      await vi.advanceTimersByTimeAsync(15_000)
      source.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
      await Promise.resolve()
    }
    expect(controller.signal.aborted).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    controller.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onError).not.toHaveBeenCalled()
  })
})
