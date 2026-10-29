import { describe, expect, it, vi } from 'vitest'
import { runReActLoop } from '@infos/backend/services/agent/reactLoop'
import type { ChatDelta, ChatMessage } from '@infos/backend/services/llm/types'
import type { ModelConfig } from '@infos/backend/services/llm/llmService'

const selfMinding = {
  assistantPrefill: {
    content: '<selfMinding>',
    mode: 'once' as const,
    source: 'system.assistantPrefill',
  },
}

const modelConfig: ModelConfig = { provider: 'openai', modelId: 'test-model', apiKey: 'k' }

function textStream(...chunks: string[]) {
  return (async function* (): AsyncGenerator<ChatDelta> {
    for (const [index, content] of chunks.entries())
      yield {
        choices: [
          { delta: { content }, finishReason: index === chunks.length - 1 ? 'stop' : null },
        ],
      }
  })()
}

async function run(modelConfig: ModelConfig, responses: Array<() => AsyncGenerator<ChatDelta>>) {
  const requests: ChatMessage[][] = []
  const chatStream = vi.fn((_config, messages: ChatMessage[]) => {
    requests.push(structuredClone(messages))
    return responses[requests.length - 1]!()
  })
  const generator = runReActLoop({
    llmService: { chatStream, estimateInputTokens: vi.fn(() => 10) } as never,
    modelConfig,
    messages: [
      { role: 'system', content: '规则' },
      { role: 'user', content: '你好' },
    ],
    promptPlan: selfMinding,
    tools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
    toolExecutor: {
      execute: vi.fn().mockResolvedValue({
        output: '结果',
        durationMs: 1,
        isError: false,
        shouldTerminate: false,
      }),
    },
    source: 'desktop',
    config: { maxTurns: 3 },
  })
  let narration = ''
  let thinking = ''
  let next = await generator.next()
  while (!next.done) {
    const event = next.value
    if (event.event === 'narration_delta') narration += event.data.delta
    else if (event.event === 'thinking_delta') thinking += event.data.delta
    next = await generator.next()
  }
  return { requests, narration, thinking, result: next.value }
}

const prefillTail = (messages: ChatMessage[]) =>
  messages.filter((message) => message.promptSegment === 'assistant_prefill')

describe('ReAct 预填充续写判定', () => {
  it('上游返回完整答案且无关闭标签时，答案进入正文而不是思考块', async () => {
    const { narration, thinking, result, requests } = await run(modelConfig, [
      () => textStream('今天天气很好，', '适合出门。'),
    ])
    expect(prefillTail(requests[0]!)).toHaveLength(1)
    expect(narration).toBe('今天天气很好，适合出门。')
    expect(thinking).toBe('')
    expect(result.contentBlocks.filter((block) => block.kind === 'thinking')).toHaveLength(0)
    expect(result.contentBlocks.find((block) => block.kind === 'narration')).toMatchObject({
      content: '今天天气很好，适合出门。',
    })
  })

  it('上游真正续写时拼回开标签，思考与正文各归其位', async () => {
    const { narration, thinking } = await run(modelConfig, [
      () => textStream('先想', '一下</selfM', 'inding>你好呀。'),
    ])
    expect(thinking).toBe('先想一下')
    expect(narration).toBe('你好呀。')
  })

  it('上游自己从思考开标签重新开头时不重复拼回', async () => {
    const { narration, thinking } = await run(modelConfig, [
      () => textStream('<selfMinding>想想</selfMinding>', '好的。'),
    ])
    expect(thinking).toBe('想想')
    expect(narration).toBe('好的。')
  })
})
