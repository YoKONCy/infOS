import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmService } from '@infos/backend/services/llm/llmService'
import { AnthropicProvider } from '@infos/backend/services/llm/providers/anthropicProvider'
import { OpenAiProvider } from '@infos/backend/services/llm/providers/openaiProvider'
import { OpenAiResponsesProvider } from '@infos/backend/services/llm/providers/openaiResponsesProvider'
import type { ChatMessage, LlmProvider } from '@infos/backend/services/llm/types'

const messages: ChatMessage[] = [
  { role: 'system', content: '固定系统规则' },
  { role: 'user', content: '第一问' },
  { role: 'assistant', content: '第一答' },
  { role: 'user', content: '本轮时间和资料' },
  { role: 'user', content: '第二问' },
]
const options = {
  tools: [
    {
      type: 'function' as const,
      function: { name: 'lookup', description: '查询', parameters: { type: 'object' } },
    },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function provider(protocol: string, apiBase: string): LlmProvider {
  const config = { apiKey: '', apiBase, modelId: 'test-model' }
  return protocol === 'anthropic'
    ? new AnthropicProvider(config)
    : protocol === 'responses'
      ? new OpenAiResponsesProvider(config)
      : new OpenAiProvider(config)
}
function response(protocol: string, usage: Record<string, unknown>) {
  return protocol === 'anthropic'
    ? { content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn', usage }
    : protocol === 'responses'
      ? { output: [], usage }
      : { choices: [{ message: { content: '好' }, finish_reason: 'stop' }], usage }
}
function stream(protocol: string, usage: Record<string, unknown>) {
  if (protocol === 'anthropic')
    return [
      `event: message_start\ndata: ${JSON.stringify({ message: { usage: { ...usage, output_tokens: 1 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}\n\n`,
      'event: message_stop\ndata: {}\n\n',
    ].join('')
  if (protocol === 'responses')
    return `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: response(protocol, usage) })}\n\n`
  return `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`
}
async function collectUsage(source: ReturnType<LlmProvider['chatStream']>) {
  let usage
  for await (const delta of source) if (delta.usage) usage = delta.usage
  return usage
}

for (const protocol of ['chat', 'responses', 'anthropic']) {
  describe(`${protocol} 无标签请求`, () => {
    it.each(['https://api.openai.com/v1', 'https://api.anthropic.com', 'https://relay.example/v1'])(
      '%s 流式及非流式各发一次，不加缓存字段或修改输入',
      async (apiBase) => {
        const original = structuredClone(messages)
        const captured: Array<Record<string, unknown>> = []
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url, init: RequestInit) => {
            const body = JSON.parse(String(init.body))
            captured.push(body)
            return body.stream
              ? new Response(stream(protocol, {}), {
                  headers: { 'content-type': 'text/event-stream' },
                })
              : Response.json(response(protocol, {}))
          }),
        )
        const client = provider(protocol, apiBase)
        await client.chat(messages, options)
        await collectUsage(client.chatStream(messages, options))
        expect(fetch).toHaveBeenCalledTimes(2)
        for (const body of captured) {
          expect(JSON.stringify(body)).not.toMatch(
            /"(?:cache_control|prompt_cache_key|prompt_cache_options|prompt_cache_retention)"/,
          )
          if (protocol === 'anthropic') {
            expect(body.messages).toEqual([
              { role: 'user', content: '第一问' },
              { role: 'assistant', content: '第一答' },
              { role: 'user', content: '本轮时间和资料\n第二问' },
            ])
          } else {
            expect(body[protocol === 'responses' ? 'input' : 'messages']).toMatchObject(messages)
          }
        }
        expect(messages).toEqual(original)
        if (protocol === 'anthropic') expect(captured[0]).toMatchObject({ system: '固定系统规则' })
      },
    )

    it.each([400, 422])('%i 参数错误不触发缓存兜底请求', async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ error: { message: 'Unknown parameter: prompt_cache_key' } }, { status }),
        ),
      )
      const service = new LlmService()
      const config = {
        provider: protocol === 'anthropic' ? 'anthropic' : 'openai',
        wireApi: protocol === 'responses' ? ('responses' as const) : ('chat_completions' as const),
        apiBase: 'https://relay.example',
        modelId: 'test-model',
        apiKey: '',
      }
      await expect(service.chat(config, messages)).rejects.toThrow()
      expect(fetch).toHaveBeenCalledTimes(1)
      vi.mocked(fetch).mockClear()
      await expect(collectUsage(service.chatStream(config, messages))).rejects.toThrow()
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })
}

const samples: Array<[string, Record<string, unknown>, number | undefined, number | undefined]> = [
  [
    '标准明细',
    { prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } },
    600,
    300,
  ],
  [
    'Responses 明细',
    { input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } },
    600,
    300,
  ],
  ['Claude 顶层字段', { cache_read_input_tokens: 600, cache_creation_input_tokens: 300 }, 600, 300],
  ['顶层 cached_tokens', { cached_tokens: 600, cache_write_tokens: 300 }, 600, 300],
  [
    'DeepSeek 未命中不是写入',
    { prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 },
    600,
    undefined,
  ],
  [
    'NewAPI 写入字段',
    { prompt_tokens_details: { cached_tokens: 600, cached_creation_tokens: 300 } },
    600,
    300,
  ],
  [
    '明细内 Claude 写入字段',
    { prompt_tokens_details: { cached_tokens: 600, cache_creation_input_tokens: 300 } },
    600,
    300,
  ],
  [
    'Claude TTL 分项',
    {
      cache_read_input_tokens: 600,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    },
    600,
    300,
  ],
  [
    'NewAPI TTL 分项',
    {
      cached_tokens: 600,
      claude_cache_creation_5_m_tokens: 100,
      claude_cache_creation_1_h_tokens: 200,
    },
    600,
    300,
  ],
  [
    'OpenAI TTL 分项',
    {
      input_tokens_details: {
        cached_tokens: 600,
        cache_write_tokens_details: { ttl_30m_tokens: 100, ttl_12h_tokens: 200 },
      },
    },
    600,
    300,
  ],
  [
    '多个写入别名不重复相加',
    {
      prompt_tokens_details: {
        cached_tokens: 600,
        cache_write_tokens: 300,
        cached_creation_tokens: 300,
      },
      cache_creation_input_tokens: 300,
    },
    600,
    300,
  ],
  [
    '明确的零保留',
    {
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 300,
    },
    0,
    0,
  ],
  [
    '非法字段不伪装成零',
    { prompt_tokens_details: { cached_tokens: -1, cache_write_tokens: '300' } },
    undefined,
    undefined,
  ],
  ['未上报仍为空', {}, undefined, undefined],
]
for (const protocol of ['chat', 'responses']) {
  describe(`${protocol} 自动缓存用量`, () => {
    it.each(samples)('%s 在流式和非流式均可读取', async (_label, aliases, read, write) => {
      const usage = {
        prompt_tokens: 1000,
        input_tokens: 1000,
        completion_tokens: 10,
        output_tokens: 10,
        total_tokens: 1010,
        ...aliases,
      }
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(response(protocol, usage)))
          .mockResolvedValueOnce(
            new Response(stream(protocol, usage), {
              headers: { 'content-type': 'text/event-stream' },
            }),
          ),
      )
      const client = provider(protocol, 'https://relay.example')
      const completion = await client.chat(messages, {})
      const streamed = await collectUsage(client.chatStream(messages, {}))
      for (const actual of [completion.usage, streamed]) {
        expect(actual).toMatchObject({
          promptTokens: 1000,
          completionTokens: 10,
          totalTokens: 1010,
        })
        expect(actual?.cachedReadTokens).toBe(read)
        expect(actual?.cachedWriteTokens).toBe(write)
      }
    })

    it('DeepSeek 仅明确上报 hit 和 miss 时才能补全输入量', async () => {
      const usage = {
        prompt_cache_hit_tokens: 600,
        prompt_cache_miss_tokens: 400,
        completion_tokens: 10,
        output_tokens: 10,
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(response(protocol, usage))),
      )
      const actual = (await provider(protocol, 'https://relay.example').chat(messages, {})).usage
      expect(actual).toMatchObject({
        promptTokens: 1000,
        completionTokens: 10,
        totalTokens: 1010,
        cachedReadTokens: 600,
      })
      expect(actual?.cachedWriteTokens).toBeUndefined()
    })
  })
}

describe('Anthropic 自动缓存用量', () => {
  it('不加标签也读取缓存读写，流式仅结束输出更新不会丢失输入', async () => {
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 300,
      output_tokens: 10,
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(response('anthropic', usage)))
        .mockResolvedValueOnce(
          new Response(stream('anthropic', usage), {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
    )
    const client = provider('anthropic', 'https://relay.example')
    const completion = await client.chat(messages, {})
    const streamed = await collectUsage(client.chatStream(messages, {}))
    for (const actual of [completion.usage, streamed])
      expect(actual).toMatchObject({
        promptTokens: 1000,
        completionTokens: 10,
        totalTokens: 1010,
        cachedReadTokens: 600,
        cachedWriteTokens: 300,
      })
  })
})
