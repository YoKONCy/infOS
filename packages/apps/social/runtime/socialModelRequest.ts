import { t as __t } from './i18n'
import {
  appendNativeReasoning,
  compileModelRequest,
  createLogger,
  safeModelDiagnostic,
  modelNetworkDetails,
  type ChatCompletion,
  type ChatMessage,
  type ChatOptions,
  type LlmService,
  type ModelConfig,
  type ToolCall,
} from '@infos/backend/applicationHostAbi'
import { currentSocialRecovery } from './socialRecovery'

const logger = createLogger('SocialGeneration')

/** 尊重模型卡的流式配置；完整接收并验证参数后才执行工具，中断草稿不会进入后继轮次。 */
export async function requestSocialModel(
  llm: LlmService,
  model: ModelConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatCompletion> {
  const request = compileModelRequest(messages, Math.max(0, (options.usageContext?.step ?? 1) - 1))
  const recovery = currentSocialRecovery()
  const context = {
    turnId: recovery?.record.id,
    agentId: options.usageContext?.agentId,
    channelId: recovery?.record.channelId,
    round: options.usageContext?.step,
    model: model.modelId,
  }
  const startedAt = Date.now()
  const streaming =
    (model.stream !== false || !!model.fallbackModels?.length) &&
    typeof llm.chatConfigured === 'function'
  let lastDataAt: number | undefined
  let contentChars = 0,
    reasoningChars = 0,
    argumentChars = 0
  logger.info(__t('apps.social.logs', '社交模型请求开始'), {
    ...context,
    streaming,
    messages: messages.length,
    images: messages.reduce(
      (sum, message) =>
        sum +
        (Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'image_url').length
          : 0),
      0,
    ),
  })
  const timer = setInterval(() => {
    logger.info(__t('apps.social.logs', '社交模型仍在处理'), {
      ...context,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      stage:
        lastDataAt === undefined
          ? __t('apps.social.logs', '等待上游响应')
          : __t('apps.social.logs', '接收模型输出'),
      idleSeconds: Math.round((Date.now() - (lastDataAt ?? startedAt)) / 1000),
      contentChars,
      reasoningChars,
      argumentChars,
    })
  }, 30_000)
  timer.unref?.()
  try {
    let completion: ChatCompletion
    if (!streaming) completion = await llm.chat(model, request.messages, options)
    else {
      const message: ChatCompletion['choices'][number]['message'] = {
        role: 'assistant',
        content: '',
        nativeReasoning: [],
      }
      const calls = new Map<number, ToolCall>()
      let finishReason: string | undefined
      let usage: ChatCompletion['usage']
      for await (const event of llm.chatConfigured(model, request.messages, {
        ...options,
        retryPartialResponse: options.retryPartialResponse || !!model.fallbackModels?.length,
      })) {
        options.signal?.throwIfAborted()
        if (event.retry) {
          logger.info(__t('apps.social.logs', '社交模型重试记录'), {
            ...context,
            ...event.retry,
            reason: safeModelDiagnostic(event.retry.reason),
          })
          if (event.retry.state === 'waiting') {
            // 新尝试开始前清理整份草稿，不能把不同模型的工具参数拼起来执行。
            message.content = ''
            message.reasoningContent = undefined
            message.nativeReasoning = []
            calls.clear()
            finishReason = undefined
            usage = undefined
            contentChars = reasoningChars = argumentChars = 0
            lastDataAt = undefined
          }
          options.onRetry?.(event.retry)
          continue
        }
        if (event.usage) usage = event.usage
        const choice = event.choices[0]
        if (!choice) continue
        if (lastDataAt === undefined)
          logger.info(__t('apps.social.logs', '社交模型开始返回数据'), {
            ...context,
            elapsedMs: Date.now() - startedAt,
          })
        lastDataAt = Date.now()
        const delta = choice.delta
        message.content = (message.content ?? '') + (delta.content ?? '')
        message.reasoningContent = (message.reasoningContent ?? '') + (delta.reasoningContent ?? '')
        if (delta.nativeReasoning)
          appendNativeReasoning(message.nativeReasoning!, delta.nativeReasoning)
        for (const part of delta.toolCalls ?? []) {
          const call = calls.get(part.index) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          }
          if (part.id) call.id = part.id
          call.function.name += part.function?.name ?? ''
          call.function.arguments += part.function?.arguments ?? ''
          calls.set(part.index, call)
          argumentChars += part.function?.arguments?.length ?? 0
        }
        contentChars += delta.content?.length ?? 0
        reasoningChars += delta.reasoningContent?.length ?? 0
        finishReason = choice.finishReason ?? finishReason
      }
      options.signal?.throwIfAborted()
      if (!finishReason)
        throw Object.assign(new Error('上游连接已结束，但未收到模型完成标记；本次草稿未执行'), {
          data: { retryable: true },
        })
      if (calls.size) {
        message.toolCalls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call)
        if (message.toolCalls.some((call) => !call.id || !call.function.name))
          throw Object.assign(new Error('流式工具调用缺少完整标识或名称；本次草稿未执行'), {
            data: { retryable: true },
          })
      }
      completion = { choices: [{ message, finishReason }], usage }
    }
    if (request.prefill)
      for (const choice of completion.choices)
        if (choice.message.content || choice.message.toolCalls?.length)
          choice.message.content = request.prefill + (choice.message.content ?? '')
    const usage = completion.usage
    const cacheReported =
      usage?.inputReported !== false &&
      typeof usage?.cachedReadTokens === 'number' &&
      usage.promptTokens > 0 &&
      usage.cachedReadTokens >= 0 &&
      usage.cachedReadTokens <= usage.promptTokens
    logger.info(__t('apps.social.logs', '社交模型请求完成'), {
      ...context,
      elapsedMs: Date.now() - startedAt,
      inputTokens: usage?.inputReported === false ? undefined : usage?.promptTokens,
      cacheReported,
      cachedReadTokens: cacheReported ? usage!.cachedReadTokens : undefined,
      uncachedInputTokens: cacheReported
        ? usage!.promptTokens - usage!.cachedReadTokens!
        : undefined,
      cacheHitPercent: cacheReported
        ? Math.round((usage!.cachedReadTokens! / usage!.promptTokens) * 1000) / 10
        : undefined,
      finishReason: completion.choices[0]?.finishReason,
      tools: completion.choices[0]?.message.toolCalls?.map((call) => call.function.name) ?? [],
      contentChars: completion.choices[0]?.message.content?.length ?? 0,
      reasoningChars: completion.choices[0]?.message.reasoningContent?.length ?? 0,
    })
    return completion
  } catch (error) {
    logger.warn(__t('apps.social.logs', '社交模型请求失败'), {
      ...context,
      elapsedMs: Date.now() - startedAt,
      partialDraftDiscarded: Boolean(contentChars || reasoningChars || argumentChars),
      reason: safeModelDiagnostic(error instanceof Error ? error.message : String(error)),
      details: modelNetworkDetails(error),
    })
    throw error
  } finally {
    clearInterval(timer)
  }
}
