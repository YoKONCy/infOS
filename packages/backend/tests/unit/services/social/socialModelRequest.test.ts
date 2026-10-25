import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestSocialModel } from '@infos/social/runtime/socialModelRequest'
import type { ChatMessage, ChatOptions, LlmService } from '@infos/backend/applicationHostAbi'

const input: ChatMessage[] = [{ role: 'user', content: '你好' }]
const model = { provider: 'openai', modelId: 'social-test', apiKey: 'test', stream: true }
afterEach(() => vi.useRealTimers())

describe('社交模型请求与流式草稿隔离', () => {
  it.each(['once', 'continuous'] as const)(
    '社交链路复用统一编译计划并正确处理续轮：%s',
    async (mode) => {
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: '你好',
          promptPlan: {
            assistantPrefill: { content: '我先', mode, source: 'system.assistantPrefill' },
          },
        },
      ]
      const chat = vi.fn().mockImplementation(async () => ({
        choices: [{ message: { role: 'assistant', content: '确认。' }, finishReason: 'stop' }],
      }))
      const first = await requestSocialModel(
        { chat } as never,
        { ...model, stream: false },
        messages,
        { usageContext: { step: 1 } } as never,
      )
      expect(chat.mock.calls[0]?.[1].at(-1)).toMatchObject({
        role: 'assistant',
        content: '我先',
        promptSegment: 'assistant_prefill',
      })
      expect(first.choices[0]?.message.content).toBe('我先确认。')
      const second = await requestSocialModel(
        { chat } as never,
        { ...model, stream: false },
        messages,
        { usageContext: { step: 2 } } as never,
      )
      expect(second.choices[0]?.message.content).toBe(
        mode === 'continuous' ? '我先确认。' : '确认。',
      )
      expect(messages).toHaveLength(1)
    },
  )

  it('多级回退丢弃旧模型的正文、思考、工具参数和用量，不混入新调用', async () => {
    const onRetry = vi.fn()
    const chatConfigured = vi.fn(async function* () {
      yield {
        choices: [
          {
            delta: {
              content: '旧正文',
              reasoningContent: '旧思考',
              toolCalls: [
                { index: 0, id: 'old', function: { name: 'social_act', arguments: '{"中断' } },
              ],
            },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      }
      yield {
        choices: [],
        retry: {
          retryId: 'retry-1',
          state: 'waiting' as const,
          attempt: 2,
          maxRetries: 3,
          delayMs: 0,
          reason: '模拟连接错误',
          startedAt: 1,
          updatedAt: 1,
          partialResponse: true,
          modelId: 'fallback',
          modelLevel: 2,
          modelLevels: 2,
          modelAttempt: 1,
        },
      }
      yield {
        choices: [
          {
            delta: {
              content: '新正文',
              toolCalls: [
                {
                  index: 0,
                  id: 'new',
                  function: { name: 'social_act', arguments: '{"action":"pass"}' },
                },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      }
    })
    const result = await requestSocialModel(
      { chatConfigured } as unknown as LlmService,
      {
        ...model,
        fallbackModels: [{ ...model, modelId: 'fallback' }],
      },
      input,
      { onRetry },
    )
    expect(result.choices[0]?.message).toMatchObject({
      content: '新正文',
      toolCalls: [{ id: 'new', function: { name: 'social_act', arguments: '{"action":"pass"}' } }],
    })
    // 工具续轮保留空 reasoning_content，满足思考模型协议，但不能残留旧模型思考。
    expect(result.choices[0]?.message.reasoningContent).toBe('')
    expect(result.usage).toBeUndefined()
    expect(onRetry).toHaveBeenCalledOnce()
    expect(chatConfigured).toHaveBeenCalledWith(
      expect.anything(),
      input,
      expect.objectContaining({ retryPartialResponse: true }),
    )
  })
  it('使用模型卡的流式配置，完整拼接分段工具参数并保留思考回传字段', async () => {
    const chat = vi.fn()
    const chatConfigured = vi.fn(async function* () {
      yield {
        choices: [
          {
            delta: {
              reasoningContent: '返回简短招呼',
              toolCalls: [
                {
                  index: 0,
                  id: 'call-1',
                  function: { name: 'social_act', arguments: '{"reply":' },
                },
              ],
            },
          },
        ],
      }
      yield {
        choices: [
          {
            delta: { toolCalls: [{ index: 0, function: { arguments: '"你好"}' } }] },
            finishReason: 'tool_calls',
          },
        ],
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      }
    })
    const result = await requestSocialModel(
      { chat, chatConfigured } as unknown as LlmService,
      model,
      input,
      {},
    )
    expect(chat).not.toHaveBeenCalled()
    expect(result.choices[0]?.message).toMatchObject({
      reasoningContent: '返回简短招呼',
      toolCalls: [
        { id: 'call-1', function: { name: 'social_act', arguments: '{"reply":"你好"}' } },
      ],
    })
    expect(result.usage?.totalTokens).toBe(25)
  })

  it('明确关闭流式时只调用非流式接口', async () => {
    const chat = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: '结果' }, finishReason: 'stop' }],
    })
    const chatConfigured = vi.fn()
    await requestSocialModel(
      { chat, chatConfigured } as unknown as LlmService,
      { ...model, stream: false },
      input,
      {},
    )
    expect(chat).toHaveBeenCalledOnce()
    expect(chatConfigured).not.toHaveBeenCalled()
  })

  it('断流时拒绝半截工具草稿，重试接收独立的新草稿并释放进度计时器', async () => {
    vi.useFakeTimers()
    const broken = vi.fn(async function* () {
      yield {
        choices: [
          {
            delta: {
              toolCalls: [
                { index: 0, id: 'old', function: { name: 'social_act', arguments: '{"reply":' } },
              ],
            },
          },
        ],
      }
    })
    await expect(
      requestSocialModel({ chatConfigured: broken } as unknown as LlmService, model, input, {}),
    ).rejects.toThrow('未收到模型完成标记')
    expect(vi.getTimerCount()).toBe(0)
    const complete = vi.fn(async function* () {
      yield {
        choices: [
          {
            delta: {
              toolCalls: [
                {
                  index: 0,
                  id: 'new',
                  function: { name: 'social_act', arguments: '{"action":"pass"}' },
                },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      }
    })
    const result = await requestSocialModel(
      { chatConfigured: complete } as unknown as LlmService,
      model,
      input,
      {},
    )
    expect(result.choices[0]?.message.toolCalls?.[0]).toMatchObject({
      id: 'new',
      function: { arguments: '{"action":"pass"}' },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('父回合取消能传递到在飞请求，退出时释放进度计时器', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const chat = vi.fn(
      (_model: unknown, _messages: unknown, options: ChatOptions) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true,
          })
        }),
    )
    const pending = requestSocialModel(
      { chat } as unknown as LlmService,
      { ...model, stream: false },
      input,
      { signal: controller.signal },
    )
    const failed = expect(pending).rejects.toThrow('社交任务已取消')
    controller.abort(new Error('社交任务已取消'))
    await failed
    expect(vi.getTimerCount()).toBe(0)
  })
})
