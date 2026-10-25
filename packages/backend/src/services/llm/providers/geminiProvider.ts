import { t as __t } from '../../../lib/i18n'
/**
 * Gemini 原生 Provider
 *
 * 使用 Google GenAI REST API 直接调用，
 * 输出统一转换为 OpenAI 格式的 ChatCompletion / ChatDelta。
 *
 * 支持：
 * - 非流式 / 流式对话
 * - Function Calling (工具调用)
 * - 自定义 apiBase (兼容代理)
 * - 统一 AppError 错误处理
 *
 * @module packages/backend/src/services/llm/providers/geminiProvider
 */

import { providerApiUrl } from './providerUrl'
import { normalizeTokenUsage, tokenCount } from '../usage'
import { combinedOutputLimit, fetchLlmResponse } from '../requestPolicy'
import { geminiReasoningEffort, geminiThinkingConfig } from '../geminiThinking'
import type {
  LlmProvider,
  ChatMessage,
  ContentPart,
  ChatOptions,
  ChatCompletion,
  ChatDelta,
  ProviderConfig,
  ToolCall,
  UsageInfo,
} from '../types'
import { AppError } from '../../../lib/appError'
import { geminiAudioPart } from '../geminiAudio'
import { sanitizeToolParameters, stripBase64DataUris } from '../sanitize'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('GeminiProvider')

/** Gemini 默认 API 基址 */
const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com'

/** Gemini 安全设置 — 全部关闭 */
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(value)
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now())
}

// ── Gemini API 类型 ──

interface GeminiPart {
  text?: string
  /** 原生思考摘要块。 */
  thought?: boolean
  /** 图片或音频的多模态块（base64）。 */
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface GeminiContent {
  role: string
  parts: GeminiPart[]
}

interface GeminiToolDeclaration {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}

export class GeminiProvider implements LlmProvider {
  constructor(private config: ProviderConfig) {}

  getInputTokenPayload(messages: ChatMessage[], opts: ChatOptions): Record<string, unknown> {
    const { systemInstruction, contents } = this.convertMessages(messages)
    const body = this.buildBody(systemInstruction, contents, opts)
    return { systemInstruction: body.systemInstruction, contents: body.contents, tools: body.tools }
  }

  /**
   * 非流式调用
   */
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatCompletion> {
    const { systemInstruction, contents } = this.convertMessages(messages)
    const url = this.buildUrl('generateContent')
    const body = this.buildBody(systemInstruction, contents, opts)

    const response = await this.fetchWithTimeout(url, body, opts.timeout ?? 600_000, opts.signal)

    if (!response.ok) {
      await this.handleError(response, 'chat')
    }

    const data = (await response.json()) as Record<string, unknown>
    return this.toCompletion(data)
  }

  /**
   * 流式调用
   */
  async *chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatDelta> {
    const { systemInstruction, contents } = this.convertMessages(messages)
    const url = this.buildUrl('streamGenerateContent', { alt: 'sse' })
    const body = this.buildBody(systemInstruction, contents, opts)

    const response = await this.fetchWithTimeout(url, body, opts.timeout ?? 600_000, opts.signal)

    if (!response.ok) {
      await this.handleError(response, 'chatStream')
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new AppError('LLM_ERROR', {
        message: 'Gemini 响应体为空',
        data: { provider: 'gemini', model: this.config.modelId },
      })
    }

    const decoder = new TextDecoder()
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
          const jsonStr = trimmed.slice(6)

          try {
            const chunk = JSON.parse(jsonStr) as Record<string, unknown>
            const delta = this.toDelta(chunk)
            if (delta) yield delta
          } catch {
            // 跳过解析错误
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /** 列出可用模型 */
  async listModels(): Promise<string[]> {
    const base = this.getBase()
    const url = new URL(providerApiUrl(base, '/models', 'v1beta'))
    if (this.config.apiKey) url.searchParams.set('key', this.config.apiKey)
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) await this.handleError(response, '获取模型列表')
    const data = (await response.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
    }
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => (m.name ?? '').replace('models/', ''))
      .filter(Boolean)
  }

  // ── 内部方法: URL & 请求构建 ──

  /** 获取 API 基址 (支持自定义代理) */
  private getBase(): string {
    const base = this.config.apiBase?.trim().replace(/\/$/, '')
    if (!base || base === 'https://api.openai.com') {
      return GEMINI_DEFAULT_BASE
    }
    return base
  }

  /** 构建 API URL */
  private buildUrl(method: string, params?: Record<string, string>): string {
    const base = this.getBase()
    const searchParams = new URLSearchParams({
      ...(this.config.apiKey ? { key: this.config.apiKey } : {}),
      ...params,
    })
    return `${providerApiUrl(base, `/models/${encodeURIComponent(this.config.modelId)}:${method}`, 'v1beta')}?${searchParams}`
  }

  /** 构建请求体 */
  private buildBody(
    systemInstruction: string | null,
    contents: GeminiContent[],
    opts: ChatOptions,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {},
      safetySettings: SAFETY_SETTINGS,
    }

    // 系统指令
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }

    // 生成配置
    const genConfig = body.generationConfig as Record<string, unknown>
    if (typeof opts.temperature === 'number') genConfig.temperature = opts.temperature
    if (typeof opts.topP === 'number') genConfig.topP = opts.topP
    const outputLimit = combinedOutputLimit(
      {
        ...opts,
        reasoningEffort: geminiReasoningEffort(this.config.modelId, opts.reasoningEffort),
      },
      /gemini-(?:2\.5|[3-9])/i.test(this.config.modelId),
    )
    if (outputLimit !== undefined) genConfig.maxOutputTokens = outputLimit
    const thinkingConfig = geminiThinkingConfig(this.config.modelId, opts)
    if (thinkingConfig) genConfig.thinkingConfig = thinkingConfig
    if (opts.stop?.length) genConfig.stopSequences = opts.stop
    if (opts.responseFormat) {
      genConfig.responseMimeType = 'application/json'
    }

    // 工具定义 → Gemini 格式
    if (opts.tools?.length) {
      const declarations: GeminiToolDeclaration = {
        functionDeclarations: opts.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: sanitizeToolParameters(t.function.parameters),
        })),
      }
      body.tools = [declarations]
    }

    return body
  }

  // ── 内部方法: 消息转换 ──

  /**
   * 将 OpenAI 格式消息转为 Gemini 格式
   *
   * - system → systemInstruction
   * - user/assistant → contents
   * - assistant + toolCalls → functionCall parts
   * - tool → functionResponse
   */
  private convertMessages(messages: ChatMessage[]): {
    systemInstruction: string | null
    contents: GeminiContent[]
  } {
    let systemInstruction: string | null = null
    const contents: GeminiContent[] = []

    for (const msg of messages) {
      // system → 顶层 systemInstruction
      if (msg.role === 'system') {
        systemInstruction =
          (systemInstruction ?? '') + (typeof msg.content === 'string' ? msg.content : '') + '\n'
        continue
      }

      // tool → functionResponse (user 角色)
      if (msg.role === 'tool') {
        let responseData: Record<string, unknown>
        try {
          // 兜底防御：剥离 tool 返回里可能混入的 base64 data URI，避免爆 token / 污染上下文。
          // 合法图片以 inlineData 数组块形式传递 (非字符串)，不受影响。
          const sanitized =
            typeof msg.content === 'string' ? stripBase64DataUris(msg.content) : msg.content
          responseData =
            typeof sanitized === 'string' ? JSON.parse(sanitized) : { result: sanitized }
        } catch {
          responseData = { result: msg.content }
        }

        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.name ?? 'unknown',
                response: responseData,
              },
            },
          ],
        })
        continue
      }

      // assistant + toolCalls → functionCall parts
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const parts: GeminiPart[] = []
        if (msg.content && typeof msg.content === 'string') {
          parts.push({ text: msg.content })
        }
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments),
            },
          })
        }
        contents.push({ role: 'model', parts })
        continue
      }

      // 普通消息 (支持多模态: 字符串 / ContentPart[])
      const role = msg.role === 'assistant' ? 'model' : 'user'
      const parts = this.contentToParts(msg.content)
      if (parts.length > 0) {
        contents.push({ role, parts })
      }
    }

    return { systemInstruction: systemInstruction?.trim() ?? null, contents }
  }

  /**
   * 将消息内容 (字符串或多模态块) 转为 Gemini parts
   *
   * 重要: 截图等图片以 image_url 块形式放在 user 消息里，必须转为 Gemini 的 inlineData，
   * 否则会被丢弃，导致多模态模型根本「看不到」图片。
   */
  private contentToParts(content: string | ContentPart[] | null): GeminiPart[] {
    if (typeof content === 'string') {
      return content ? [{ text: content }] : []
    }
    if (!Array.isArray(content)) return []

    const parts: GeminiPart[] = []
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text) parts.push({ text: part.text })
      } else if (part.type === 'image_url') {
        const inline = this.dataUriToInline(part.image_url.url)
        if (inline) parts.push({ inlineData: inline })
      } else if (part.type === 'input_audio') {
        parts.push(geminiAudioPart(part))
      }
    }
    return parts
  }

  /** 解析 data URI → Gemini inlineData (mimeType + base64) */
  private dataUriToInline(url: string): { mimeType: string; data: string } | null {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(url)
    if (!match) return null
    return { mimeType: match[1]!, data: match[2]! }
  }

  // ── 内部方法: 响应规范化 ──

  /** 将 Gemini 非流式响应转为 OpenAI ChatCompletion */
  private toCompletion(data: Record<string, unknown>): ChatCompletion {
    const candidates = (data.candidates ?? []) as Array<Record<string, unknown>>
    const candidate = candidates[0]

    if (!candidate) {
      return {
        choices: [{ message: { role: 'assistant', content: '' }, finishReason: 'stop' }],
        usage: this.extractUsage(data),
      }
    }

    const content = candidate.content as { parts?: GeminiPart[] } | undefined
    const parts = content?.parts ?? []

    let textContent = ''
    let reasoningContent = ''
    const toolCalls: ToolCall[] = []

    for (const part of parts) {
      if (part.text && part.thought) reasoningContent += part.text
      else if (part.text) textContent += part.text
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        })
      }
    }

    const finishReason = this.mapFinishReason(candidate.finishReason as string | undefined)

    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: textContent || null,
            reasoningContent: reasoningContent || undefined,
            toolCalls: toolCalls.length ? toolCalls : undefined,
          },
          finishReason,
        },
      ],
      usage: this.extractUsage(data),
    }
  }

  /** 将 Gemini 流式 chunk 转为 OpenAI ChatDelta */
  private toDelta(data: Record<string, unknown>): ChatDelta | null {
    const candidates = (data.candidates ?? []) as Array<Record<string, unknown>>
    const candidate = candidates[0]
    if (!candidate) return null

    const content = candidate.content as { parts?: GeminiPart[] } | undefined
    const parts = content?.parts ?? []

    // 提取文本增量
    let text = ''
    let reasoningContent = ''
    const toolCalls: Array<{
      index: number
      id?: string
      type?: 'function'
      function?: { name?: string; arguments?: string }
    }> = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      if (part.text && part.thought) reasoningContent += part.text
      else if (part.text) text += part.text
      if (part.functionCall) {
        toolCalls.push({
          index: i,
          id: `call_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        })
      }
    }

    // 没有文本也没有工具调用，跳过
    if (
      !text &&
      !reasoningContent &&
      !toolCalls.length &&
      !candidate.finishReason &&
      !data.usageMetadata
    )
      return null

    return {
      choices: [
        {
          delta: {
            content: text || undefined,
            reasoningContent: reasoningContent || undefined,
            toolCalls: toolCalls.length ? toolCalls : undefined,
          },
          finishReason: this.mapFinishReason(candidate.finishReason as string | undefined) ?? null,
        },
      ],
      usage: this.extractUsage(data),
    }
  }

  /** 提取 Token 使用量 */
  private extractUsage(data: Record<string, unknown>): UsageInfo | undefined {
    const raw = data.usageMetadata as Record<string, unknown> | undefined
    if (!raw) return undefined
    const visible = tokenCount(raw.candidatesTokenCount)
    const reasoning = tokenCount(raw.thoughtsTokenCount)
    // Gemini 将思考单列，统一输出口径需包含这部分，不能只统计可见回答。
    return normalizeTokenUsage({
      input: raw.promptTokenCount,
      output: visible === undefined ? undefined : visible + (reasoning ?? 0),
      total: raw.totalTokenCount,
      cachedRead: raw.cachedContentTokenCount,
      reasoning,
    })
  }

  /** 映射 Gemini 停止原因 → OpenAI 格式 */
  private mapFinishReason(reason?: string): string | undefined {
    if (!reason) return undefined
    const mapping: Record<string, string> = {
      STOP: 'stop',
      MAX_TOKENS: 'length',
      SAFETY: 'content_filter',
      RECITATION: 'content_filter',
    }
    return mapping[reason] ?? reason.toLowerCase()
  }

  // ── 内部方法: 错误处理 ──

  /** 发送请求 (带超时) */
  private async fetchWithTimeout(
    url: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body, 'utf8') > 20 * 1024 * 1024)
      throw new AppError('PAYLOAD_TOO_LARGE', {
        message: __t('server.audio-input', 'Gemini 内联请求超过 20MB，请减少附件后重试'),
      })
    try {
      return await fetchLlmResponse(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        { timeout: timeoutMs, signal },
        'gemini',
      )
    } catch (err) {
      if (err instanceof AppError) throw err
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new AppError('LLM_TIMEOUT', {
          message: `Gemini 请求超时 (${Math.round(timeoutMs / 1000)}s)`,
          data: { provider: 'gemini', model: this.config.modelId, retryable: true },
        })
      }
      if (signal?.aborted) throw err
      throw new AppError('LLM_ERROR', {
        message: `Gemini 网络错误: ${err instanceof Error ? err.message : String(err)}`,
        data: { provider: 'gemini', model: this.config.modelId, retryable: true },
      })
    }
  }

  /** 处理 HTTP 错误响应 → AppError */
  private async handleError(response: Response, method: string): Promise<never> {
    const text = await response.text().catch(() => '(无法读取响应体)')
    const retryMs = parseRetryAfterMs(response.headers.get('retry-after'))

    logger.error(__t('logs.llm', 'Gemini {0} 失败', [method]), {
      status: response.status,
      body: text.slice(0, 300),
      model: this.config.modelId,
    })

    throw new AppError(response.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_ERROR', {
      message: `Gemini API 错误 (${response.status}): ${text.slice(0, 200)}`,
      data: {
        provider: 'gemini',
        model: this.config.modelId,
        status: response.status,
        retryable: RETRYABLE_STATUSES.has(response.status),
        retryAfter: retryMs,
      },
    })
  }
}
