import { t as __t } from '../../../lib/i18n'
/**
 * Anthropic 原生 Provider
 *
 * 使用 Anthropic Messages API 直接调用，
 * 输出统一转换为 OpenAI 格式的 ChatCompletion / ChatDelta。
 *
 * 支持：
 * - 非流式 / 流式对话
 * - Function Calling (tool_use / tool_result 双向转换)
 * - 流式 Tool Use 增量拼接
 * - 统一 AppError 错误处理
 * - 思考模式 (extended thinking) 兼容
 *
 * @module packages/backend/src/services/llm/providers/anthropicProvider
 */

import { providerApiUrl } from './providerUrl'
import { normalizeTokenUsage, tokenCount, reportedCacheUsage } from '../usage'
import { fetchLlmResponse } from '../requestPolicy'
import type {
  LlmProvider,
  ChatMessage,
  ChatOptions,
  ChatCompletion,
  ChatDelta,
  ProviderConfig,
  ToolCall,
  UsageInfo,
} from '../types'
import { AppError } from '../../../lib/appError'
import { stripBase64DataUris } from '../sanitize'
import { anthropicContent } from '../multimodalContent'
import { createLogger } from '../../../lib/logger'
import { temporaryUpstreamCode } from '../retryPolicy'

const logger = createLogger('AnthropicProvider')

/** Anthropic 默认 API 基址 */
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com'

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

const THINKING_BUDGETS = {
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
} as const

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(value)
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now())
}

/** 以完整 SSE 事件为边界读取，网络分包不能改变事件或 UTF-8 字符的含义。 */
async function* readAnthropicEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let dataLines: string[] = []
  function line(value: string): { event: string; data: Record<string, unknown> } | undefined {
    if (!value) {
      const type = event
      const source = dataLines.join('\n')
      event = ''
      dataLines = []
      if (!source || source === '[DONE]') return
      let data: Record<string, unknown>
      try {
        data = JSON.parse(source)
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
      } catch {
        throw new AppError('LLM_ERROR', { message: 'Anthropic 流事件格式无效' })
      }
      return { event: type || String(data.type ?? ''), data }
    }
    if (value.startsWith(':')) return
    const separator = value.indexOf(':')
    const field = separator < 0 ? value : value.slice(0, separator)
    const content = separator < 0 ? '' : value.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') event = content
    else if (field === 'data') dataLines.push(content)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const result = line(buffer.slice(0, end).replace(/\r$/, ''))
        buffer = buffer.slice(end + 1)
        if (result) yield result
      }
      if (done) {
        if (buffer) {
          const result = line(buffer.replace(/\r$/, ''))
          if (result) yield result
        }
        const result = line('')
        if (result) yield result
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class AnthropicProvider implements LlmProvider {
  constructor(private config: ProviderConfig) {}

  getInputTokenPayload(messages: ChatMessage[], opts: ChatOptions): Record<string, unknown> {
    const { systemPrompt, anthropicMessages } = this.convertMessages(messages)
    const body = this.buildBody(systemPrompt, anthropicMessages, opts, false)
    return { system: body.system, messages: body.messages, tools: body.tools }
  }

  /**
   * 非流式调用
   */
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatCompletion> {
    const { systemPrompt, anthropicMessages } = this.convertMessages(messages)
    const url = providerApiUrl(this.getBase(), '/messages')
    const body = this.buildBody(systemPrompt, anthropicMessages, opts, false)

    const response = await this.fetchWithTimeout(url, body, opts.timeout ?? 600_000, opts.signal)

    if (!response.ok) {
      await this.handleError(response, 'chat')
    }

    const data = (await response.json()) as Record<string, unknown>
    return this.toCompletion(data)
  }

  /**
   * 流式调用
   *
   * Anthropic 流式使用自定义 SSE 事件格式：
   * - message_start → 消息元数据
   * - content_block_start → 新内容块 (text / tool_use)
   * - content_block_delta → 增量 (text_delta / input_json_delta)
   * - content_block_stop → 块结束
   * - message_delta → 停止原因、usage
   * - message_stop → 消息完成
   */
  async *chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatDelta> {
    const { systemPrompt, anthropicMessages } = this.convertMessages(messages)
    const url = providerApiUrl(this.getBase(), '/messages')
    const body = this.buildBody(systemPrompt, anthropicMessages, opts, true)

    const response = await this.fetchWithTimeout(url, body, opts.timeout ?? 600_000, opts.signal)

    if (!response.ok) {
      await this.handleError(response, 'chatStream')
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new AppError('LLM_ERROR', {
        message: 'Anthropic 响应体为空',
        data: { provider: 'anthropic', model: this.config.modelId },
      })
    }

    let currentToolIndex = 0
    let accumulatedUsage: Record<string, unknown> = {}
    for await (const { event, data } of readAnthropicEvents(reader)) {
      switch (event) {
        case 'message_start': {
          const message = data.message as Record<string, unknown> | undefined
          const usage = message?.usage as Record<string, unknown> | undefined
          if (usage) accumulatedUsage = { ...usage }
          yield {
            choices: [{ delta: { role: 'assistant' }, finishReason: null }],
            usage: usage ? this.normalizeUsage(accumulatedUsage) : undefined,
          }
          break
        }
        case 'content_block_start': {
          const block = data.content_block as Record<string, unknown> | undefined
          if (block?.type !== 'tool_use') break
          currentToolIndex = (data.index as number) ?? 0
          yield {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: currentToolIndex,
                      id: String(block.id ?? ''),
                      type: 'function',
                      function: { name: String(block.name ?? ''), arguments: '' },
                    },
                  ],
                },
                finishReason: null,
              },
            ],
          }
          break
        }
        case 'content_block_delta': {
          const delta = data.delta as Record<string, unknown> | undefined
          if (!delta) break
          if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            yield { choices: [{ delta: { reasoningContent: delta.thinking }, finishReason: null }] }
          } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            yield { choices: [{ delta: { content: delta.text }, finishReason: null }] }
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            yield {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: (data.index as number) ?? currentToolIndex,
                        function: { arguments: delta.partial_json },
                      },
                    ],
                  },
                  finishReason: null,
                },
              ],
            }
          }
          break
        }
        case 'message_delta': {
          const delta = data.delta as Record<string, unknown> | undefined
          const usage = data.usage as Record<string, unknown> | undefined
          // 结束事件通常只携带输出量，保留开始事件给出的输入量。
          if (usage) accumulatedUsage = { ...accumulatedUsage, ...usage }
          yield {
            choices: [
              {
                delta: {},
                finishReason: this.mapStopReason(delta?.stop_reason as string | undefined),
              },
            ],
            usage: Object.keys(accumulatedUsage).length
              ? this.normalizeUsage(accumulatedUsage)
              : undefined,
          }
          break
        }
        case 'error': {
          const error = data.error as Record<string, unknown> | undefined
          throw new AppError('LLM_ERROR', {
            message: typeof error?.message === 'string' ? error.message : 'Anthropic 流式响应异常',
            data: { provider: 'anthropic', retryable: temporaryUpstreamCode(error?.type) },
          })
        }
        default:
          break
      }
    }
  }

  /** 列出可用模型 */
  async listModels(): Promise<string[]> {
    const url = providerApiUrl(this.getBase(), '/models')
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) await this.handleError(response, '获取模型列表')

    const data = (await response.json()) as { data?: Array<{ id: string }> }
    return (data.data ?? []).map((m) => m.id).sort()
  }

  // ── 内部方法: 请求构建 ──

  /** 获取 API 基址 */
  private getBase(): string {
    const base = this.config.apiBase?.trim().replace(/\/$/, '')
    if (!base || base === 'https://api.openai.com') {
      return ANTHROPIC_DEFAULT_BASE
    }
    return base
  }

  /** 构建请求头 */
  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}),
      'anthropic-version': '2023-06-01',
    }
  }

  /** 构建请求体 */
  private buildBody(
    systemPrompt: string,
    messages: Array<Record<string, unknown>>,
    opts: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const thinkingBudget =
      opts.reasoningEffort && opts.reasoningEffort !== 'off'
        ? THINKING_BUDGETS[opts.reasoningEffort]
        : undefined
    const maxTokens = opts.maxTokens ?? this.config.maxTokens ?? 4096
    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      max_tokens: maxTokens + (thinkingBudget ?? 0),
      stream,
    }

    if (systemPrompt) body.system = systemPrompt
    if (!thinkingBudget && typeof opts.temperature === 'number') body.temperature = opts.temperature
    if (!thinkingBudget && typeof opts.topP === 'number') body.top_p = opts.topP
    if (thinkingBudget) {
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
      if (opts.returnNativeReasoning) {
        ;(body.thinking as Record<string, unknown>).display = 'summarized'
      }
    }
    if (opts.stop?.length) body.stop_sequences = opts.stop

    // 工具定义 → Anthropic tools 格式
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))

      // 工具选择策略映射
      if (opts.toolChoice) {
        if (opts.toolChoice === 'auto') body.tool_choice = { type: 'auto' }
        else if (opts.toolChoice === 'none') body.tool_choice = { type: 'none' }
        else if (opts.toolChoice === 'required') body.tool_choice = { type: 'any' }
        else if (typeof opts.toolChoice === 'object') {
          body.tool_choice = { type: 'tool', name: opts.toolChoice.function.name }
        }
      }
    }

    return body
  }

  // ── 内部方法: 消息转换 ──

  /**
   * 将 OpenAI 消息格式转为 Anthropic 格式
   *
   * - system → 提取到顶层 system 参数
   * - tool → 转为 tool_result content block
   * - assistant with tool_calls → 转为 tool_use content blocks
   * - 合并相邻同角色消息 (Anthropic 要求交替)
   */
  private convertMessages(messages: ChatMessage[]): {
    systemPrompt: string
    anthropicMessages: Array<Record<string, unknown>>
  } {
    let systemPrompt = ''
    const rawMessages: Array<Record<string, unknown>> = []

    for (const msg of messages) {
      // system → 顶层
      if (msg.role === 'system') {
        systemPrompt += (typeof msg.content === 'string' ? msg.content : '') + '\n'
        continue
      }

      // tool → tool_result (user 角色)
      if (msg.role === 'tool') {
        rawMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId,
              // 兜底防御：剥离 tool 返回里可能混入的 base64 data URI，避免爆 token / 污染上下文。
              content: typeof msg.content === 'string' ? stripBase64DataUris(msg.content) : '',
            },
          ],
        })
        continue
      }

      // assistant + toolCalls → tool_use blocks
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const content = anthropicContent(msg.content)
        const blocks: Array<Record<string, unknown>> =
          typeof content === 'string'
            ? content
              ? [{ type: 'text', text: content }]
              : []
            : [...content]
        for (const tc of msg.toolCalls) {
          let input: Record<string, unknown>
          try {
            input = JSON.parse(tc.function.arguments) as Record<string, unknown>
          } catch {
            input = {}
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          })
        }
        rawMessages.push({ role: 'assistant', content: blocks })
        continue
      }

      // 普通消息
      rawMessages.push({
        role: msg.role,
        content: anthropicContent(msg.content),
      })
    }

    // 合并相邻同角色消息 (Anthropic 不允许连续同角色)
    const merged = this.mergeAdjacentRoles(rawMessages)

    return { systemPrompt: systemPrompt.trim(), anthropicMessages: merged }
  }

  /**
   * 合并相邻同角色消息
   *
   * Anthropic 要求消息列表严格交替 user/assistant。
   * 连续的同角色消息合并为一条。
   */
  private mergeAdjacentRoles(
    messages: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    if (messages.length <= 1) return messages

    const merged: Array<Record<string, unknown>> = []

    for (const msg of messages) {
      const prev = merged[merged.length - 1]
      if (prev && prev.role === msg.role) {
        // 合并内容
        const prevContent = prev.content
        const currContent = msg.content

        if (typeof prevContent === 'string' && typeof currContent === 'string') {
          prev.content = prevContent + '\n' + currContent
        } else if (Array.isArray(prevContent) && Array.isArray(currContent)) {
          prev.content = [...prevContent, ...currContent]
        } else if (Array.isArray(prevContent) && typeof currContent === 'string') {
          ;(prevContent as Array<Record<string, unknown>>).push({ type: 'text', text: currContent })
        } else if (typeof prevContent === 'string' && Array.isArray(currContent)) {
          prev.content = [
            { type: 'text', text: prevContent },
            ...(currContent as Array<Record<string, unknown>>),
          ]
        }
      } else {
        merged.push({ ...msg })
      }
    }

    return merged
  }

  // ── 内部方法: 响应规范化 ──

  /** 将 Anthropic 非流式响应转为 OpenAI ChatCompletion */
  private toCompletion(data: Record<string, unknown>): ChatCompletion {
    const contentBlocks = (data.content ?? []) as Array<Record<string, unknown>>
    let textContent = ''
    let reasoningContent = ''
    const toolCalls: ToolCall[] = []

    for (const block of contentBlocks) {
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        reasoningContent += block.thinking
      } else if (block.type === 'text') {
        textContent += (block.text as string) ?? ''
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: (block.id as string) ?? '',
          type: 'function',
          function: {
            name: (block.name as string) ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
    }

    const message: ChatCompletion['choices'][0]['message'] = {
      role: 'assistant',
      content: textContent || null,
      reasoningContent: reasoningContent || undefined,
    }
    if (toolCalls.length) message.toolCalls = toolCalls

    // 提取 usage
    const rawUsage = data.usage as Record<string, unknown> | undefined

    return {
      choices: [
        {
          message,
          finishReason: this.mapStopReason(data.stop_reason as string | undefined),
        },
      ],
      usage: rawUsage ? this.normalizeUsage(rawUsage) : undefined,
    }
  }

  /** 规范化 Anthropic Usage → UsageInfo */
  private normalizeUsage(raw: Record<string, unknown>): UsageInfo | undefined {
    const fresh = tokenCount(raw.input_tokens)
    const cached = reportedCacheUsage(raw)
    const cachedRead = tokenCount(raw.cache_read_input_tokens) ?? cached.cachedRead
    const cachedWrite = tokenCount(raw.cache_creation_input_tokens) ?? cached.cachedWrite
    // Anthropic 的 input_tokens 不含缓存读取和创建，先合并成统一输入口径。
    return normalizeTokenUsage({
      input: fresh === undefined ? undefined : fresh + (cachedRead ?? 0) + (cachedWrite ?? 0),
      output: raw.output_tokens,
      cachedRead,
      cachedWrite,
    })
  }

  /** 映射 Anthropic 停止原因 → OpenAI 格式 */
  private mapStopReason(reason?: string): string {
    if (!reason) return 'stop'
    const mapping: Record<string, string> = {
      end_turn: 'stop',
      stop_sequence: 'stop',
      max_tokens: 'length',
      tool_use: 'tool_calls',
    }
    return mapping[reason] ?? reason
  }

  // ── 内部方法: 错误处理 ──

  /** 发送请求 (带超时) */
  private async fetchWithTimeout(
    url: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetchLlmResponse(
        url,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(payload),
        },
        { timeout: timeoutMs, signal },
        'anthropic',
      )
    } catch (err) {
      if (err instanceof AppError) throw err
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new AppError('LLM_TIMEOUT', {
          message: `Anthropic 请求超时 (${Math.round(timeoutMs / 1000)}s)`,
          data: { provider: 'anthropic', model: this.config.modelId, retryable: true },
        })
      }
      if (signal?.aborted) throw err
      throw new AppError('LLM_ERROR', {
        message: `Anthropic 网络错误: ${err instanceof Error ? err.message : String(err)}`,
        data: { provider: 'anthropic', model: this.config.modelId, retryable: true },
      })
    }
  }

  /** 处理 HTTP 错误响应 → AppError */
  private async handleError(response: Response, method: string): Promise<never> {
    const text = await response.text().catch(() => '(无法读取响应体)')
    const code = response.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_ERROR'

    // 尝试解析 retry-after
    const retryMs = parseRetryAfterMs(response.headers.get('retry-after'))

    logger.error(__t('logs.llm', 'Anthropic {0} 失败', [method]), {
      status: response.status,
      body: text.slice(0, 300),
      model: this.config.modelId,
    })

    throw new AppError(code, {
      message: `Anthropic API 错误 (${response.status}): ${text.slice(0, 200)}`,
      data: {
        provider: 'anthropic',
        model: this.config.modelId,
        status: response.status,
        retryable: RETRYABLE_STATUSES.has(response.status),
        retryAfter: retryMs,
      },
    })
  }
}
