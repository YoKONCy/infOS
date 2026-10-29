import { providerApiUrl } from './providerUrl'
import { normalizeTokenUsage, reportedCacheUsage, reportedCacheInput, tokenCount } from '../usage'
import { combinedOutputLimit, fetchLlmResponse } from '../requestPolicy'
import { geminiReasoningEffort } from '../geminiThinking'
import type {
  ChatCompletion,
  ChatDelta,
  ChatMessage,
  ChatOptions,
  LlmProvider,
  NativeReasoningPayload,
  ProviderConfig,
  ToolCall,
  UsageInfo,
} from '../types'
import { AppError } from '../../../lib/appError'
import { retryAfterMilliseconds, temporaryUpstreamCode } from '../retryPolicy'
import { normalizeSystemMessages, sanitizeToolParameters, stripBase64DataUris } from '../sanitize'
import { responsesContent } from '../multimodalContent'

/** OpenAI Responses语义协议Provider。 */
export class OpenAiResponsesProvider implements LlmProvider {
  constructor(private readonly config: ProviderConfig) {}

  getInputTokenPayload(messages: ChatMessage[], opts: ChatOptions): Record<string, unknown> {
    const payload = this.buildPayload(messages, opts, false)
    return { input: payload.input, tools: payload.tools }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatCompletion> {
    const response = await this.request(this.buildPayload(messages, opts, false), opts)
    const data = (await response.json()) as Record<string, unknown>
    return this.normalizeResponse(data)
  }

  async *chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatDelta> {
    const response = await this.request(this.buildPayload(messages, opts, true), opts)
    const reader = response.body?.getReader()
    if (!reader) throw this.error('OpenAI Responses响应体为空', { retryable: true })
    const decoder = new TextDecoder()
    const calls = new Map<string, { index: number; id: string; name: string }>()
    let callIndex = 0
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          let event: Record<string, unknown>
          try {
            event = JSON.parse(trimmed.slice(6)) as Record<string, unknown>
          } catch {
            continue
          }
          const type = event.type
          if (
            type === 'response.reasoning_summary_text.delta' ||
            type === 'response.reasoning_text.delta'
          ) {
            const delta = typeof event.delta === 'string' ? event.delta : ''
            if (delta) yield this.delta({ reasoningContent: delta })
          } else if (type === 'response.output_text.delta') {
            const delta = typeof event.delta === 'string' ? event.delta : ''
            if (delta) yield this.delta({ content: delta })
          } else if (type === 'response.output_item.added') {
            const item = event.item as Record<string, unknown> | undefined
            if (item?.type === 'reasoning') {
              yield this.delta({
                nativeReasoning: [{ format: 'responses_reasoning', opaque: item }],
              })
            } else if (item?.type === 'function_call') {
              const key = String(item.id ?? item.call_id ?? callIndex)
              const call = {
                index: callIndex++,
                id: String(item.call_id ?? item.id ?? key),
                name: String(item.name ?? ''),
              }
              calls.set(key, call)
              yield this.delta({
                toolCalls: [
                  {
                    index: call.index,
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: String(item.arguments ?? '') },
                  },
                ],
              })
            }
          } else if (type === 'response.function_call_arguments.delta') {
            const key = String(event.item_id ?? event.call_id ?? '')
            const call = calls.get(key)
            if (call) {
              yield this.delta({
                toolCalls: [
                  { index: call.index, function: { arguments: String(event.delta ?? '') } },
                ],
              })
            }
          } else if (
            type === 'response.completed' ||
            (type === 'response.incomplete' &&
              (
                (event.response as Record<string, unknown> | undefined)?.incomplete_details as
                  | Record<string, unknown>
                  | undefined
              )?.reason === 'max_output_tokens')
          ) {
            const completed = event.response as Record<string, unknown> | undefined
            yield {
              choices: [
                { delta: {}, finishReason: type === 'response.incomplete' ? 'length' : 'stop' },
              ],
              usage: completed
                ? this.normalizeUsage(completed.usage as Record<string, unknown> | undefined)
                : undefined,
            }
          } else if (
            type === 'response.failed' ||
            type === 'response.incomplete' ||
            type === 'error'
          ) {
            const responseError = (event.response as Record<string, unknown> | undefined)?.error
            const error = (event.error ?? responseError) as Record<string, unknown> | undefined
            throw this.error(String(error?.message ?? type), {
              retryable: temporaryUpstreamCode(error?.code) || temporaryUpstreamCode(error?.type),
            })
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(this.url('/models'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok)
      throw this.error(`获取模型列表失败：HTTP ${response.status}`, {
        status: response.status,
        retryable: false,
      })
    const data = (await response.json()) as { data?: Array<{ id?: string }> }
    return (data.data ?? []).flatMap((item) => (item.id ? [item.id] : [])).sort()
  }

  private buildPayload(
    messages: ChatMessage[],
    opts: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const reasoningEffort = geminiReasoningEffort(this.config.modelId, opts.reasoningEffort)
    const payload: Record<string, unknown> = {
      model: this.config.modelId,
      input: this.serializeInput(normalizeSystemMessages(messages)),
      stream,
      store: false,
    }
    const outputLimit = combinedOutputLimit({ ...opts, reasoningEffort }, true)
    if (outputLimit !== undefined) payload.max_output_tokens = outputLimit
    if (typeof opts.temperature === 'number') payload.temperature = opts.temperature
    if (typeof opts.topP === 'number') payload.top_p = opts.topP
    if (reasoningEffort || opts.returnNativeReasoning) {
      payload.reasoning = {
        ...(reasoningEffort
          ? { effort: reasoningEffort === 'off' ? 'none' : reasoningEffort }
          : {}),
        ...(opts.returnNativeReasoning ? { summary: 'auto' } : {}),
      }
    }
    if (opts.tools?.length) {
      payload.tools = opts.tools.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: sanitizeToolParameters(tool.function.parameters),
      }))
    }
    if (opts.toolChoice !== undefined) {
      payload.tool_choice =
        typeof opts.toolChoice === 'object'
          ? { type: 'function', name: opts.toolChoice.function.name }
          : opts.toolChoice
    }
    if (opts.stop?.length) payload.stop = opts.stop
    return payload
  }

  private serializeInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = []
    for (const message of messages) {
      if (message.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId,
          output:
            typeof message.content === 'string'
              ? stripBase64DataUris(message.content)
              : JSON.stringify(message.content),
        })
        continue
      }
      if (message.role === 'assistant') {
        for (const payload of message.nativeReasoning ?? []) {
          if (
            payload.format === 'responses_reasoning' &&
            payload.opaque &&
            typeof payload.opaque === 'object'
          ) {
            input.push(payload.opaque as Record<string, unknown>)
          }
        }
      }
      if (message.content !== null) {
        input.push({ role: message.role, content: responsesContent(message.content, message.role) })
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })
      }
    }
    return input
  }

  private normalizeResponse(data: Record<string, unknown>): ChatCompletion {
    const output = (data.output ?? []) as Array<Record<string, unknown>>
    let content = ''
    let reasoningContent = ''
    const nativeReasoning: NativeReasoningPayload[] = []
    const toolCalls: ToolCall[] = []
    for (const item of output) {
      if (item.type === 'reasoning') {
        const summary = (item.summary ?? []) as Array<Record<string, unknown>>
        const text = summary.map((part) => String(part.text ?? '')).join('')
        reasoningContent += text
        nativeReasoning.push({
          format: 'responses_reasoning',
          text: text || undefined,
          opaque: item,
        })
      } else if (item.type === 'message') {
        for (const part of (item.content ?? []) as Array<Record<string, unknown>>) {
          if (part.type === 'output_text' && typeof part.text === 'string') content += part.text
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: String(item.call_id ?? item.id ?? ''),
          type: 'function',
          function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '') },
        })
      }
    }
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: content || null,
            reasoningContent: reasoningContent || undefined,
            nativeReasoning: nativeReasoning.length ? nativeReasoning : undefined,
            toolCalls: toolCalls.length ? toolCalls : undefined,
          },
          finishReason:
            String(data.status ?? '') === 'completed'
              ? 'stop'
              : (data.incomplete_details as Record<string, unknown> | undefined)?.reason ===
                  'max_output_tokens'
                ? 'length'
                : String(data.status ?? ''),
        },
      ],
      usage: this.normalizeUsage(data.usage as Record<string, unknown> | undefined),
    }
  }

  private normalizeUsage(raw?: Record<string, unknown>): UsageInfo | undefined {
    if (!raw) return undefined
    const output = raw.output_tokens_details as Record<string, unknown> | undefined
    return normalizeTokenUsage({
      input:
        tokenCount(raw.input_tokens) ?? tokenCount(raw.prompt_tokens) ?? reportedCacheInput(raw),
      output: tokenCount(raw.output_tokens) ?? raw.completion_tokens,
      total: raw.total_tokens,
      ...reportedCacheUsage(raw, 'input_tokens_details'),
      reasoning: output?.reasoning_tokens,
    })
  }

  private delta(delta: ChatDelta['choices'][number]['delta']): ChatDelta {
    return { choices: [{ delta, finishReason: null }] }
  }

  private async request(payload: Record<string, unknown>, opts: ChatOptions): Promise<Response> {
    const response = await fetchLlmResponse(
      this.url('/responses'),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
      opts,
      'openai-responses',
    )
    if (!response.ok) {
      const text = await response.text()
      const quota =
        response.status === 429 && /insufficient_quota|free users|token plan/i.test(text)
      throw this.error(`OpenAI Responses API错误 (${response.status}): ${text.slice(0, 500)}`, {
        status: response.status,
        retryable: !quota && [408, 429, 500, 502, 503, 504].includes(response.status),
        retryAfter: retryAfterMilliseconds(response.headers.get('retry-after')),
      })
    }
    return response
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
    }
  }

  private url(path: string): string {
    return providerApiUrl(this.config.apiBase, path)
  }

  private error(message: string, data: Record<string, unknown> = {}): AppError {
    return new AppError('LLM_ERROR', {
      message,
      data: { provider: 'openai-responses', model: this.config.modelId, ...data },
    })
  }
}
