import { t as __t } from '../../../lib/i18n'
/**
 * OpenAI 兼容 Provider
 *
 * 绝大多数 LLM 厂商 (DeepSeek / SiliconFlow / 火山 / Groq / DashScope 等)
 * 均走 OpenAI 兼容协议，本 Provider 统一处理。
 *
 * 支持：
 * - 非流式 / 流式对话
 * - Function Calling (工具调用)
 * - 流式 Tool Call 增量拼接
 * - 统一错误转 AppError
 *
 * @module packages/backend/src/services/llm/providers/openaiProvider
 */

import { providerApiUrl } from './providerUrl'
import { normalizeTokenUsage, reportedCacheUsage, reportedCacheInput, tokenCount } from '../usage'
import { combinedOutputLimit, fetchLlmResponse } from '../requestPolicy'
import { compactNativeReasoning } from '../reasoning'
import {
  geminiReasoningEffort,
  geminiThinkingFamily,
  isGoogleGeminiEndpoint,
} from '../geminiThinking'
import type {
  LlmProvider,
  ChatMessage,
  ChatOptions,
  ChatCompletion,
  ChatDelta,
  ProviderConfig,
  UsageInfo,
} from '../types'
import { AppError } from '../../../lib/appError'
import { normalizeSystemMessages, sanitizeToolParameters, stripBase64DataUris } from '../sanitize'
import { createLogger } from '../../../lib/logger'
import { temporaryUpstreamCode } from '../retryPolicy'
import { modelNetworkDetails, safeModelDiagnostic, unsupportedModelMedia } from '../diagnostics'
import { upstreamHttpError, upstreamWebPage } from '../../../lib/upstreamHttpError'

const logger = createLogger('OpenAiProvider')

/** HTTP 状态码 → ResponseCode 映射 */
const STATUS_TO_CODE: Record<number, 'LLM_ERROR' | 'LLM_RATE_LIMITED' | 'LLM_TIMEOUT'> = {
  429: 'LLM_RATE_LIMITED',
  504: 'LLM_TIMEOUT',
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(value)
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now())
}

export class OpenAiProvider implements LlmProvider {
  constructor(private config: ProviderConfig) {}

  getInputTokenPayload(messages: ChatMessage[], opts: ChatOptions): Record<string, unknown> {
    const payload = this.buildPayload(messages, opts, false)
    return {
      messages: payload.messages,
      tools: payload.tools,
      response_format: payload.response_format,
    }
  }

  /**
   * 非流式调用
   *
   * 发送完整请求，等待完整响应。
   * 适用于 Scorer / Reflection 等后台任务。
   */
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatCompletion> {
    const url = this.buildUrl('/chat/completions')
    const payload = this.buildPayload(messages, opts, false)

    const response = await this.fetchWithTimeout(
      url,
      payload,
      opts.timeout ?? 600_000,
      opts.signal,
      opts.totalTimeout,
    )

    if (!response.ok || upstreamWebPage(response)) {
      await this.handleError(response, 'chat')
    }

    const data = (await response.json()) as Record<string, unknown>
    return this.normalizeCompletion(data)
  }

  /**
   * 流式调用
   *
   * 逐 chunk 流式返回增量内容。
   * 支持文本增量和 Tool Call 增量。
   */
  async *chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatDelta> {
    const url = this.buildUrl('/chat/completions')
    const payload = this.buildPayload(messages, opts, true)

    const response = await this.fetchWithTimeout(
      url,
      payload,
      opts.timeout ?? 600_000,
      opts.signal,
      opts.totalTimeout,
    )

    if (!response.ok || upstreamWebPage(response)) {
      await this.handleError(response, 'chatStream')
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new AppError('LLM_ERROR', {
        message: 'OpenAI 响应体为空',
        data: { provider: 'openai', model: this.config.modelId, retryable: true },
      })
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let terminalSeen = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // SSE chunk 可能在任意字节边界截断，必须先进入 buffer，再按换行拆出完整 data 行。
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            if (!terminalSeen) yield { choices: [{ delta: {}, finishReason: 'stop' }] }
            return
          }

          let chunk: Record<string, unknown>
          try {
            chunk = JSON.parse(data) as Record<string, unknown>
          } catch {
            // 少数兼容厂商会混入非 JSON 行；跳过坏行，避免整个流式会话被中断。
            logger.debug(__t('logs.llm', '跳过无法解析的 SSE 数据: {0}', [data.slice(0, 100)]))
            continue
          }
          if (chunk.error && typeof chunk.error === 'object') {
            const error = chunk.error as Record<string, unknown>
            throw new AppError('LLM_ERROR', {
              message:
                typeof error.message === 'string'
                  ? safeModelDiagnostic(error.message)
                  : '上游流式请求异常',
              data: {
                provider: 'openai',
                retryable:
                  !unsupportedModelMedia(String(error.message ?? '')) &&
                  (temporaryUpstreamCode(error.code) || temporaryUpstreamCode(error.type)),
              },
            })
          }
          const delta = this.normalizeDelta(chunk)
          terminalSeen ||= delta.choices.some((choice) => !!choice.finishReason)
          yield delta
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /** 仅在模型列表路由不受支持时探测兼容端点，真实失败必须交给前端。 */
  async listModels(): Promise<string[]> {
    const modelList = await this.tryFetchModels('/models')
    const models = modelList ?? (await this.tryFetchModels('/embeddings'))
    if (models === null)
      throw new AppError('LLM_ERROR', {
        message: '服务商未提供可用的模型列表接口，请手动填写模型名称',
        data: { provider: 'openai', operation: 'list_models', retryable: false },
      })
    return [...new Set(models)].sort()
  }

  /** null 只代表 404/405 路由不受支持；空数组代表服务商确实返回空列表。 */
  private async tryFetchModels(endpoint: string): Promise<string[] | null> {
    const url = this.buildUrl(endpoint)
    try {
      const response = await fetch(url, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        if ([404, 405].includes(response.status) && upstreamWebPage(response, text) !== 'challenge')
          return null
        throw upstreamHttpError(
          response,
          text,
          '获取模型列表',
          STATUS_TO_CODE[response.status] ?? 'LLM_ERROR',
        )
      }
      if (upstreamWebPage(response)) {
        throw upstreamHttpError(
          response,
          await response.text().catch(() => ''),
          '获取模型列表',
          'LLM_ERROR',
        )
      }

      const data = (await response.json()) as Record<string, unknown>
      const list = data?.data ?? data?.models
      if (!Array.isArray(list))
        throw new AppError('LLM_ERROR', {
          message: '模型列表响应格式不正确，未找到 data 或 models 数组',
          data: { provider: 'openai', operation: 'list_models', retryable: false },
        })
      const models = list.flatMap((item) => {
        const id = typeof item === 'string' ? item : (item?.id ?? item?.name)
        return typeof id === 'string' && id.trim() ? [id.trim()] : []
      })
      if (list.length && !models.length)
        throw new AppError('LLM_ERROR', {
          message: '模型列表响应不包含有效模型名称，请检查服务商接口',
          data: { provider: 'openai', operation: 'list_models', retryable: false },
        })
      return models
    } catch (err) {
      const error =
        err instanceof AppError
          ? err
          : new AppError(
              err instanceof Error && err.name === 'TimeoutError' ? 'LLM_TIMEOUT' : 'LLM_ERROR',
              {
                message:
                  err instanceof SyntaxError
                    ? '模型列表响应不是有效的 JSON，请检查 API 基址'
                    : `获取模型列表失败：${err instanceof Error ? err.message : String(err)}`,
                data: { provider: 'openai', operation: 'list_models', retryable: false },
              },
            )
      logger.warn(__t('logs.llm', '获取模型列表失败'), {
        endpoint,
        reason: error.message,
        details: error.data,
      })
      throw error
    }
  }

  // ── 内部方法: 请求构建 ──

  /** 构建 API URL */
  private buildUrl(endpoint: string): string {
    return providerApiUrl(this.config.apiBase, endpoint)
  }

  /** 构建请求头 */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }
    return headers
  }

  /** 构建请求体 */
  private buildPayload(
    messages: ChatMessage[],
    opts: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const dialect = this.resolveReasoningDialect()
    const reasoningEffort = geminiReasoningEffort(this.config.modelId, opts.reasoningEffort)
    const payload: Record<string, unknown> = {
      model: this.config.modelId,
      messages: this.serializeMessages(
        normalizeSystemMessages(messages),
        dialect === 'deepseek' && reasoningEffort !== 'off',
      ),
      stream,
    }

    if (typeof opts.temperature === 'number') payload.temperature = opts.temperature
    if (typeof opts.topP === 'number') payload.top_p = opts.topP
    const nativeReasoning =
      dialect === 'openai' && /^(?:o\d|gpt-[56])(?:[.-]|$)/i.test(this.config.modelId)
    const limit = combinedOutputLimit(
      { ...opts, reasoningEffort },
      /^(?:o\d|gpt-[56])(?:[.-]|$)|reasoner|thinking|gemini-(?:2\.5|[3-9])/i.test(
        this.config.modelId,
      ),
    )
    if (limit !== undefined)
      payload[nativeReasoning ? 'max_completion_tokens' : 'max_tokens'] = limit
    if (reasoningEffort) {
      const effort = reasoningEffort === 'off' ? 'none' : reasoningEffort
      payload.reasoning_effort = effort
      if (dialect === 'deepseek') {
        payload.thinking = { type: reasoningEffort === 'off' ? 'disabled' : 'enabled' }
      } else if (dialect === 'openrouter') {
        payload.reasoning = {
          effort,
          exclude: opts.returnNativeReasoning !== true,
        }
      }
    }
    if (isGoogleGeminiEndpoint(this.config.apiBase) && geminiThinkingFamily(this.config.modelId)) {
      // 等级由 reasoning_effort 传递，此处只控制摘要，不重复发送等级或预算。
      payload.extra_body = {
        google: { thinking_config: { include_thoughts: opts.returnNativeReasoning === true } },
      }
    }
    // returnNativeReasoning只控制响应中的原生思考是否向上层展示，不能单独改变请求模式。
    // 部分OpenAI兼容网关会把未知thinking/reasoning参数错误报告为API Key无效。
    if (opts.tools?.length) {
      payload.tools = opts.tools.map((tool) => ({
        ...tool,
        function: {
          ...tool.function,
          parameters: sanitizeToolParameters(tool.function.parameters),
        },
      }))
    }
    if (opts.toolChoice !== undefined) payload.tool_choice = opts.toolChoice
    if (opts.responseFormat) payload.response_format = opts.responseFormat
    if (opts.stop?.length) payload.stop = opts.stop

    // 流式模式下请求返回 usage (部分厂商支持)
    if (stream) {
      payload.stream_options = { include_usage: true }
    }

    return payload
  }

  /**
   * 序列化消息为 OpenAI 格式
   *
   * 将内部 camelCase 的 toolCalls / toolCallId 转为 snake_case。
   */
  private serializeMessages(
    messages: ChatMessage[],
    requireReasoningContent = false,
  ): Array<Record<string, unknown>> {
    const serialized: Array<Record<string, unknown>> = []
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!
      serialized.push(this.serializeMessage(message, requireReasoningContent))
      if (message.role !== 'assistant' || !message.toolCalls?.length) continue

      // Gemini的OpenAI兼容层严格要求同一assistant工具轮中的每个function call
      // 都在紧随其后的响应轮中拥有且仅拥有一个function response。
      const segment: ChatMessage[] = []
      let cursor = index + 1
      while (cursor < messages.length && messages[cursor]!.role !== 'assistant') {
        segment.push(messages[cursor]!)
        cursor++
      }
      const responses = new Map<string, ChatMessage>()
      for (const candidate of segment) {
        if (
          candidate.role === 'tool' &&
          candidate.toolCallId &&
          !responses.has(candidate.toolCallId)
        ) {
          responses.set(candidate.toolCallId, candidate)
        }
      }
      for (const call of message.toolCalls) {
        const response = responses.get(call.id)
        serialized.push(
          this.serializeMessage(
            response ?? {
              role: 'tool',
              toolCallId: call.id,
              content: `工具 ${call.function.name} 未返回结果。`,
            },
            requireReasoningContent,
          ),
        )
      }
      // 截图等补充user/system消息必须放在完整工具响应组之后，不能拆开函数调用轮。
      for (const candidate of segment) {
        if (candidate.role !== 'tool')
          serialized.push(this.serializeMessage(candidate, requireReasoningContent))
      }
      index = cursor - 1
    }
    return serialized
  }

  private serializeMessage(
    msg: ChatMessage,
    requireReasoningContent = false,
  ): Record<string, unknown> {
    // 兜底防御：tool 返回的字符串内容若混入 base64 data URI (如截图泄漏)，统一剥离避免爆 token。
    // 合法图片以 image_url 数组块形式存在 (非字符串)，不受影响。
    const content =
      msg.role === 'tool' && typeof msg.content === 'string'
        ? stripBase64DataUris(msg.content)
        : msg.content

    const serialized: Record<string, unknown> = {
      role: msg.role,
      content,
    }

    if (msg.name) serialized.name = msg.name
    const legacyReasoning = msg.nativeReasoning?.filter(
      (item) => item.format === 'reasoning_content',
    )
    const reasoningContent =
      msg.reasoningContent ??
      (legacyReasoning?.length
        ? legacyReasoning.map((item) => item.text ?? '').join('')
        : undefined)
    if (reasoningContent !== undefined) {
      serialized.reasoning_content = reasoningContent
    } else if (requireReasoningContent && msg.role === 'assistant') {
      // 历史正文、无思考工具轮与合成消息也须满足 DeepSeek 思考协议；不伪造缺失的思考。
      serialized.reasoning_content = ''
    }
    const details = msg.nativeReasoning
      ? compactNativeReasoning(msg.nativeReasoning).find(
          (item) => item.format === 'reasoning_details',
        )?.opaque
      : undefined
    if (details) serialized.reasoning_details = details
    if (msg.toolCallId) serialized.tool_call_id = msg.toolCallId

    if (msg.toolCalls?.length) {
      serialized.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: tc.function,
      }))
    }

    return serialized
  }

  // ── 内部方法: 响应规范化 ──

  /** 规范化非流式响应为统一格式 */
  private normalizeCompletion(data: Record<string, unknown>): ChatCompletion {
    const rawChoices = (data.choices ?? []) as Array<Record<string, unknown>>
    const rawUsage = data.usage as Record<string, unknown> | undefined

    return {
      choices: rawChoices.map((choice) => {
        const rawMsg = choice.message as Record<string, unknown>
        const rawToolCalls = rawMsg?.tool_calls as Array<Record<string, unknown>> | undefined

        const reasoning = this.extractReasoning(rawMsg)
        return {
          message: {
            role: 'assistant' as const,
            content: (rawMsg?.content as string | null) ?? null,
            reasoningContent: reasoning.text || undefined,
            nativeReasoning: reasoning.payloads.length ? reasoning.payloads : undefined,
            toolCalls: rawToolCalls?.map((tc) => ({
              id: tc.id as string,
              type: 'function' as const,
              function: tc.function as { name: string; arguments: string },
            })),
          },
          finishReason: (choice.finish_reason as string) ?? undefined,
        }
      }),
      usage: rawUsage ? this.normalizeUsage(rawUsage) : undefined,
    }
  }

  /** 规范化流式增量为统一格式 */
  private normalizeDelta(data: Record<string, unknown>): ChatDelta {
    const rawChoices = (data.choices ?? []) as Array<Record<string, unknown>>
    const rawUsage = data.usage as Record<string, unknown> | undefined

    return {
      choices: rawChoices.map((choice) => {
        const rawDelta = (choice.delta ?? {}) as Record<string, unknown>
        const rawToolCalls = rawDelta.tool_calls as Array<Record<string, unknown>> | undefined

        const reasoning = this.extractReasoning(rawDelta)
        return {
          delta: {
            role: rawDelta.role as string | undefined,
            content: rawDelta.content as string | undefined,
            ...(reasoning.text ? { reasoningContent: reasoning.text } : {}),
            ...(reasoning.payloads.length ? { nativeReasoning: reasoning.payloads } : {}),
            // 流式 Function Calling 会把同一个工具调用拆成多段 delta，上层按 index 继续拼接参数字符串。
            // 部分厂商在 streaming delta 中可能不返回 id，通过 index 匹配。
            toolCalls: rawToolCalls?.map((tc) => ({
              index: (tc.index as number) ?? 0,
              id:
                (tc.id as string | undefined) ??
                `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: tc.type as 'function' | undefined,
              function: tc.function as { name?: string; arguments?: string } | undefined,
            })),
          },
          finishReason: (choice.finish_reason as string | null) ?? null,
        }
      }),
      usage: rawUsage ? this.normalizeUsage(rawUsage) : undefined,
    }
  }

  private resolveReasoningDialect(): 'openai' | 'deepseek' | 'openrouter' | 'generic' {
    const configured = this.config.reasoningDialect
    if (configured && configured !== 'auto') return configured
    const base = this.config.apiBase.toLowerCase()
    if (base.includes('deepseek')) return 'deepseek'
    if (base.includes('openrouter')) return 'openrouter'
    if (base.includes('openai.com')) return 'openai'
    return 'generic'
  }

  private extractReasoning(source: Record<string, unknown>): {
    text: string
    payloads: NonNullable<ChatCompletion['choices'][number]['message']['nativeReasoning']>
  } {
    const payloads: NonNullable<ChatCompletion['choices'][number]['message']['nativeReasoning']> =
      []
    let text = ''
    if (typeof source.reasoning_content === 'string') {
      text += source.reasoning_content
    }
    if (typeof source.reasoning === 'string') text += source.reasoning
    if (Array.isArray(source.reasoning_details)) {
      for (const detail of source.reasoning_details) {
        if (!detail || typeof detail !== 'object') continue
        const item = detail as Record<string, unknown>
        const detailText =
          typeof item.text === 'string'
            ? item.text
            : typeof item.summary === 'string'
              ? item.summary
              : ''
        text += detailText
      }
      payloads.push({
        format: 'reasoning_details',
        text: text || undefined,
        opaque: source.reasoning_details,
      })
    } else if (typeof source.reasoning === 'string') {
      payloads.push({ format: 'reasoning_details', text: source.reasoning })
    }
    return { text, payloads }
  }

  /** 规范化 Usage 信息 (snake_case → camelCase) */
  private normalizeUsage(raw: Record<string, unknown>): UsageInfo | undefined {
    const output = raw.completion_tokens_details as Record<string, unknown> | undefined
    return normalizeTokenUsage({
      input:
        tokenCount(raw.prompt_tokens) ?? tokenCount(raw.input_tokens) ?? reportedCacheInput(raw),
      output: tokenCount(raw.completion_tokens) ?? raw.output_tokens,
      total: raw.total_tokens,
      ...reportedCacheUsage(raw),
      reasoning: output?.reasoning_tokens,
    })
  }

  // ── 内部方法: 错误处理 ──

  /** 发送请求 (带超时) */
  private async fetchWithTimeout(
    url: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    totalTimeout?: number,
  ): Promise<Response> {
    try {
      return await fetchLlmResponse(
        url,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(payload),
        },
        { timeout: timeoutMs, totalTimeout, signal },
        'openai',
      )
    } catch (err) {
      if (err instanceof AppError) throw err
      // 超时或网络错误
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new AppError('LLM_TIMEOUT', {
          message: `OpenAI 请求超时 (${Math.round(timeoutMs / 1000)}s)`,
          data: { provider: 'openai', model: this.config.modelId, retryable: true },
        })
      }
      if (signal?.aborted) throw err
      const details = modelNetworkDetails(err)
      let endpoint = 'API 基址不可解析'
      try {
        endpoint = new URL(url).origin
      } catch {
        /* 不让诊断覆盖原始网络错误。 */
      }
      logger.warn(__t('logs.llm', 'OpenAI 网络请求失败'), {
        model: this.config.modelId,
        endpoint,
        details,
      })
      throw new AppError('LLM_ERROR', {
        message: `OpenAI 网络错误: ${details.join('；') || '连接失败'}`,
        data: {
          provider: 'openai',
          model: this.config.modelId,
          retryable: true,
          networkDetails: details,
        },
        cause: err,
      })
    }
  }

  /** 处理 HTTP 错误响应 → AppError */
  private async handleError(response: Response, method: string): Promise<never> {
    const text = await response.text().catch(() => '(无法读取响应体)')
    const code = STATUS_TO_CODE[response.status] ?? 'LLM_ERROR'
    if (upstreamWebPage(response, text)) {
      const error = upstreamHttpError(response, text, '模型 API', code)
      logger.error(__t('logs.llm', 'OpenAI {0} 失败', [method]), {
        status: response.status,
        reason: error.message,
        model: this.config.modelId,
      })
      throw new AppError(code, {
        message: error.message,
        data: {
          ...(error.data as object),
          provider: 'openai',
          model: this.config.modelId,
          retryable: false,
        },
      })
    }
    let upstreamMessage = text
    try {
      const body = JSON.parse(text) as { error?: { message?: string }; message?: string }
      upstreamMessage = body.error?.message ?? body.message ?? text
    } catch {
      /* 非 JSON 错误保留服务商原文。 */
    }
    const freeLimit =
      response.status === 429 && /free users|token plan|insufficient_quota/i.test(upstreamMessage)
    const invalidMedia = unsupportedModelMedia(upstreamMessage)
    upstreamMessage = safeModelDiagnostic(upstreamMessage)
    const message = freeLimit
      ? '模型服务已达到免费用户调用限制，请稍后重试或检查上游套餐。'
      : `模型服务请求失败 (${response.status}): ${upstreamMessage.slice(0, 500)}`

    // 尝试解析 retryAfter (429 场景)
    const retryMs = parseRetryAfterMs(response.headers.get('retry-after'))

    logger.error(__t('logs.llm', 'OpenAI {0} 失败', [method]), {
      status: response.status,
      body: safeModelDiagnostic(text, 300),
      model: this.config.modelId,
    })

    throw new AppError(code, {
      message,
      data: {
        provider: 'openai',
        model: this.config.modelId,
        status: response.status,
        retryable: !freeLimit && !invalidMedia && RETRYABLE_STATUSES.has(response.status),
        upstreamMessage,
        retryAfter: retryMs,
      },
    })
  }
}
