import { t as __t } from './i18n'
import type {
  ChatMessage,
  ChatOptions,
  ChatCompletion,
  LlmService,
  ModelConfig,
  ToolCall,
  ToolDefinition,
} from '@infos/backend/applicationHostAbi'
import {
  createLogger,
  promptFingerprint,
  modelOutputReservation,
  preparePromptReplay,
  canonicalTools,
  trimOldestPromptRound,
  promptMessagesForPersistence,
  safeModelDiagnostic,
} from '@infos/backend/applicationHostAbi'
import type { SocialTurnRecord } from '@infos/shared'
import { currentSocialRecovery, socialDelay, socialFailure } from './socialRecovery'
import { MAX_SOCIAL_IMAGES } from './socialImageReader'
import { prepareSocialVision } from './socialVision'
import { requestSocialModel } from './socialModelRequest'

type Message = ChatMessage & { pinned?: boolean; history?: boolean }
type ToolSummary = NonNullable<SocialTurnRecord['generationSummary']>['tools'][number]
const logger = createLogger('SocialGeneration')
const MAX_TOOL_ROUNDS = 5
const MAX_CONTINUATIONS = 2
const MAX_CLOSING_FAILURES = 2
const MAX_MODEL_RESPONSES = MAX_TOOL_ROUNDS + MAX_CONTINUATIONS + MAX_CLOSING_FAILURES

interface GenerationState {
  messages: Message[]
  /** 已接收的模型响应数，不包含网络重试。 */
  round: number
  toolRounds?: number
  closingReason?: string
  closingHintAdded?: boolean
  closingFailures?: number
  lastToolFailure?: { fingerprint: string; count: number }
  toolCalls?: number
  toolSummary?: ToolSummary[]
  pending?: ToolCall[]
  textTools?: boolean
  index: number
  toolStarted?: boolean
  retries: number
  continuations: number
  prefix: string
  reply?: string
  entryCorrections?: number
  pendingImages?: string[]
}
export interface SocialGenerationOptions {
  replayScope?: string
  replayCurrentKeys?: string[]
  replayReply?: () => string
  replayDeliveries?: () => Array<{ key: string; reply: string }>
  beforeModelRequest?: (round: number) => Promise<void>
  usageContext?: ChatOptions['usageContext']
  tools?: ToolDefinition[]
  toolExecutor?: (
    name: string,
    args: Record<string, unknown>,
    callId?: string,
    context?: { closing: boolean },
  ) => Promise<string>
  orchestrationTool?: string
  isTerminalTool?: (name: string) => boolean
  currentMessageIndex?: number
  historyMessageIndices?: number[]
  signal?: AbortSignal
}
interface Helpers {
  parseTextToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }>
  stripThinkingBlocks(text: string): string
  stripToolCallTags(text: string): string
  compactImageToolResult(text: string): string
  extractImagesFromToolResult(text: string): string[]
  parseTerminalAcceptance(text: string): boolean
}

/** 社交 ReAct 恢复到已保存的工具位置，不重新执行此前已完成的工具。 */
export async function runSocialGeneration(
  llm: LlmService,
  input: ChatMessage[],
  model: ModelConfig,
  opts: SocialGenerationOptions,
  helpers: Helpers,
): Promise<string> {
  const recovery = currentSocialRecovery()
  const signal = opts.signal ?? recovery?.signal
  prepareSocialVision(input, signal)
  const current = input[opts.currentMessageIndex ?? input.length - 1]
  if (current) current.cacheControl = { kind: 'current', currentKeys: opts.replayCurrentKeys ?? [] }
  const replay =
    opts.replayScope && opts.replayCurrentKeys?.length
      ? preparePromptReplay(opts.replayScope, input, { model, tools: canonicalTools(opts.tools) })
      : undefined
  const prepared = replay?.messages ?? input
  if (opts.replayScope)
    logger.info(__t('apps.social.logs', '社交跨轮轨迹续接'), {
      scope: opts.replayScope,
      reused: replay?.reused ?? false,
      reason: replay?.reason ?? '当前入站来源未完整绑定，使用规范历史',
      restoring: Boolean(recovery?.record.checkpoint.generation),
    })
  let currentIndex = -1
  for (let index = prepared.length - 1; index >= 0; index--) {
    if (prepared[index]?.cacheControl?.kind === 'current') {
      currentIndex = index
      break
    }
  }
  const state: GenerationState = (recovery?.record.checkpoint.generation as
    | GenerationState
    | undefined) ?? {
    messages: prepared.map((message, index) => ({
      ...message,
      pinned: index === currentIndex,
      history:
        message.cacheControl?.kind === 'history' ||
        (!replay?.reused && opts.historyMessageIndices?.includes(index)),
    })),
    round: 0,
    index: 0,
    retries: 0,
    continuations: 0,
    prefix: '',
  }
  // 旧恢复记录的 round 同时计入工具轮与截断续写，迁移时拆开计数。
  state.toolRounds ??= Math.max(0, state.round - state.continuations)
  state.closingFailures ??= 0
  state.toolCalls ??= 0
  state.toolSummary ??= []
  const save = async () => {
    signal?.throwIfAborted()
    if (recovery) {
      recovery.record.generationSummary = {
        modelResponses: state.round,
        toolRounds: state.toolRounds!,
        continuations: state.continuations,
        closingReason: state.closingReason,
        toolCalls: state.toolCalls!,
        tools: state.toolSummary!.map((item) => ({ ...item })),
      }
      recovery.record.checkpoint.generation = {
        ...state,
        messages: promptMessagesForPersistence(state.messages),
      }
      await recovery.save()
    }
  }
  const finish = (reply: string) => {
    if (!signal?.aborted)
      replay?.commit(state.messages, opts.replayReply?.() || reply, opts.replayDeliveries?.())
    return reply
  }
  if (
    opts.orchestrationTool &&
    !(recovery?.record.checkpoint.orchestration as { active?: string } | undefined)?.active
  ) {
    // 旧版普通文字检查点只作为模型观察保留，必须经新入口重新提交，不能直接投递。
    state.reply = undefined
  }
  if (state.reply !== undefined) return finish(state.reply)
  if (!opts.orchestrationTool && state.toolStarted && recovery?.record.checkpoint.terminalOutcome) {
    state.toolStarted = false
    state.reply = ''
    await save()
    return finish('')
  }
  if (state.toolStarted && opts.orchestrationTool) {
    // 编排器拥有逐步骤日志，恢复时由它核验已完成及结果未知的写操作。
    const active = (recovery?.record.checkpoint.orchestration as { active?: string } | undefined)
      ?.active
    if (!active) {
      const interrupted = state.pending?.[state.index]
      if (interrupted) {
        const result = JSON.stringify({
          success: false,
          uncertain: true,
          error:
            '旧版工具执行中断，实际结果尚未确认。没有重新执行，请先核验，不能直接换入口重复提交。',
        })
        state.messages.push(
          state.textTools
            ? { role: 'user', content: `[工具结果 ${interrupted.function.name}]：${result}` }
            : { role: 'tool', toolCallId: interrupted.id, content: result },
        )
        traceTool(interrupted, {}, 'unknown', 0)
        state.index++
      }
      state.closingReason = 'legacy_tool_result_unknown'
    }
    state.toolStarted = false
    await save()
  }
  if (state.toolStarted) throw new Error('工具执行结果无法确认，已停止自动重试，避免重复操作')
  const budget = (model.contextWindowTokens ?? 131_072) - modelOutputReservation(model) - 1024
  if (budget < 256) throw new Error('模型上下文不足以容纳配置的输出与思考预留，请调整模型额度')
  const policy = recovery?.record.checkpoint.policy as
    | { modelIdleMinutes?: number; modelRequestMinutes?: number; maxRetries?: number }
    | undefined
  const options: ChatOptions = {
    usageContext: opts.usageContext,
    signal,
    maxRetries: 0,
    timeout: (policy?.modelIdleMinutes ?? 10) * 60_000,
    totalTimeout: (policy?.modelRequestMinutes ?? 30) * 60_000,
  }
  const retryLimit = policy?.maxRetries ?? 2

  function traceTool(
    call: ToolCall,
    args: Record<string, unknown>,
    status: ToolSummary['status'],
    durationMs: number,
  ): void {
    const action =
      typeof args.action === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(args.action)
        ? args.action
        : undefined
    const name = call.function.name.replace(/[^a-z0-9_:.-]/gi, '').slice(0, 100) || '未知工具'
    state.toolCalls = state.toolCalls! + 1
    state.toolSummary!.push({ round: state.round, name, action, status, durationMs })
    state.toolSummary = state.toolSummary!.slice(-32)
    logger.info(__t('apps.social.logs', '社交工具调用摘要'), {
      turnId: recovery?.record.id,
      round: state.round,
      tool: name,
      action,
      status,
      durationMs,
    })
  }

  function closeTools(reason: string): void {
    state.closingReason ??= reason
    if (state.closingHintAdded) return
    state.closingHintAdded = true
    state.messages.push({
      role: 'user',
      pinned: true,
      content: opts.orchestrationTool
        ? '本轮业务工具阶段已结束。social_act 入口仍可用，但不能新增 call 业务操作。请依据真实结果，用 reply、PASS、等待或观察收尾；不要把未完成操作描述为成功。普通文字不会发送。'
        : '本轮已结束工具阶段，不再执行任何工具。请依据已经收到的结果直接生成最终回复；' +
          '如有失败或未完成，简短如实说明，不要声称未执行的操作已完成。' +
          '不要输出工具调用或 <tool_call> 标签；如果无需回应，仅输出 PASS。',
    })
    logger.info(__t('apps.social.logs', '社交工具阶段结束，正在生成最终回复'), {
      turnId: recovery?.record.id,
      reason: state.closingReason,
      toolRounds: state.toolRounds,
    })
  }

  function fit(tools: ToolDefinition[] | undefined, ratio = 1): void {
    prepareSocialVision(state.messages, signal)
    let limit = Math.floor(budget * ratio)
    const hardLimit = limit
    const count = () => llm.estimateInputTokens(model, state.messages, { ...options, tools })
    if (count() <= limit) return
    limit = Math.floor(limit * 0.75)
    while (count() > limit && trimOldestPromptRound(state.messages)) {
      /* 整轮裁剪 */
    }
    if (recovery) recovery.record.error = '正在缩减上下文'
    // 先缩小结构化历史区，保持人设、当前请求及提示词框架完整。
    for (const keep of [16, 8, 0]) {
      for (const message of state.messages)
        if (message.role === 'system' && typeof message.content === 'string') {
          message.content = message.content.replace(
            /<chat_history>[\s\S]*?<\/chat_history>/g,
            (block) => {
              const entries =
                block.match(/<(?:user|assistant)\b[^>]*>[\s\S]*?<\/(?:user|assistant)>/g) ?? []
              return `<chat_history>\n${keep ? entries.slice(-keep).join('\n') : '较早聊天记录已退出本轮上下文，需要时请查询历史。'}\n</chat_history>`
            },
          )
        }
      if (count() <= limit) return
    }
    // 原生历史只移除本轮请求之前的旧轮次，不能拆开工具调用与结果。
    while (count() > limit) {
      const start = state.messages.findIndex((message) => message.history && !message.pinned)
      if (start < 0) break
      let end = start
      let replied = false
      while (
        end < state.messages.length &&
        state.messages[end]!.history &&
        !state.messages[end]!.pinned
      ) {
        if (replied && state.messages[end]!.role === 'user') break
        if (state.messages[end]!.role === 'assistant') replied = true
        end++
      }
      state.messages.splice(start, end - start)
    }
    for (const maxChars of [4000, 1500, 500]) {
      for (const message of state.messages) {
        if (
          message.role === 'tool' &&
          typeof message.content === 'string' &&
          message.content.length > maxChars
        )
          message.content = `${message.content.slice(0, maxChars)}\n[工具结果因输入预算缩减；需要时请缩小范围重新查询。]`
        if (!message.pinned && Array.isArray(message.content))
          message.content = message.content.filter((part) => part.type === 'text')
      }
      if (count() <= limit) return
    }
    // 历史中的大工具轮整组移除，保留最近一次工具观察和对应协议字段。
    const starts = state.messages
      .map((message, index) =>
        message.role === 'assistant' && message.toolCalls?.length ? index : -1,
      )
      .filter((index) => index >= 0)
    for (let index = starts.length - 2; index >= 0 && count() > limit; index--) {
      const start = starts[index]!,
        end = starts[index + 1]!
      if (!state.messages.slice(start, end).some((message) => message.pinned))
        state.messages.splice(start, end - start)
    }
    if (count() > hardLimit)
      throw new Error(
        `社交输入容量不足：约 ${count()} Token，可用 ${hardLimit} Token。当前请求或必要工具定义过大，请缩小内容范围。`,
      )
  }

  for (;;) {
    signal?.throwIfAborted()
    if (state.pending) {
      for (; state.index < state.pending.length; state.index++) {
        signal?.throwIfAborted()
        const call = state.pending[state.index]!
        let args: Record<string, unknown> = {}
        let result: string
        if (
          (state.closingReason && call.function.name !== opts.orchestrationTool) ||
          state.reply !== undefined
        ) {
          // 同批尚未执行的调用也要停止，并补齐对应结果，保持原生工具协议成对。
          result = JSON.stringify({
            success: false,
            error: '本轮已提前结束工具阶段，此调用尚未执行，请直接生成最终回复',
            code: 'SOCIAL_TOOLS_CLOSED',
          })
          traceTool(call, args, 'blocked', 0)
        } else {
          const unavailable =
            !opts.toolExecutor ||
            !opts.tools?.some((tool) => tool.function.name === call.function.name)
          if (unavailable && !opts.orchestrationTool)
            throw new Error(`工具 ${call.function.name} 已不可用，恢复任务已停止`)
          try {
            args = JSON.parse(call.function.arguments || '{}')
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              throw new Error('工具参数必须是对象')
            }
          } catch {
            if (!opts.orchestrationTool)
              throw new Error(`工具 ${call.function.name} 的参数不完整，已阻止执行`)
            args = { __invalid_arguments: true }
          }
          const startedAt = Date.now()
          state.toolStarted = true
          await save()
          try {
            result = await opts.toolExecutor!(call.function.name, args, call.id, {
              closing: Boolean(state.closingReason),
            })
          } catch (error) {
            signal?.throwIfAborted()
            if (opts.orchestrationTool) {
              // 编排步骤已各自兜底；参数错误等入口异常也只回传本次工具，不终止 ReAct。
              result = JSON.stringify({
                success: false,
                error: {
                  code: 'SOCIAL_ACT_INVALID',
                  message: error instanceof Error ? error.message : String(error),
                  retryable: false,
                },
              })
            } else {
              traceTool(call, args, 'unknown', Date.now() - startedAt)
              await save()
              // 无法证明工具没有副作用时，不自动重放；取消后也不提交迟到结果。
              throw new Error(
                `工具 ${call.function.name} 未确认完成，已停止重复执行：${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
          signal?.throwIfAborted()
          state.toolStarted = false
          let failed = false
          let uncertain = false
          try {
            const parsed = JSON.parse(result) as {
              success?: boolean
              error?: unknown
              uncertain?: boolean
            } | null
            failed =
              parsed?.success === false || (parsed?.error !== undefined && parsed.error !== null)
            uncertain = parsed?.uncertain === true
          } catch {
            // 非结构化结果不猜测成功与失败，仍原样交给模型观察。
          }
          let orchestrationUncertain = false
          if (call.function.name === opts.orchestrationTool) {
            const control = JSON.parse(result) as {
              status?: string
              had_errors?: boolean
              observations?: Array<{ status?: string }>
            }
            if (control.status === 'waiting') {
              // 不提交未完成的工具结果，也不推进调用位置；唤醒后重新进入同一持久化计划。
              await save()
              return ''
            }
            if (control.status === 'completed') state.reply = ''
            failed ||= control.had_errors === true
            orchestrationUncertain =
              control.observations?.some((item) => item.status === 'uncertain') === true
          }
          traceTool(
            call,
            args,
            uncertain || orchestrationUncertain ? 'unknown' : failed ? 'error' : 'completed',
            Date.now() - startedAt,
          )
          if (uncertain) {
            state.closingReason ??= 'tool_result_unknown'
          } else if (failed) {
            const fingerprint = promptFingerprint([call.function.name, args])
            const count =
              state.lastToolFailure?.fingerprint === fingerprint
                ? state.lastToolFailure.count + 1
                : 1
            state.lastToolFailure = { fingerprint, count }
            if (count >= 2) state.closingReason ??= 'repeated_tool_error'
          } else {
            state.lastToolFailure = undefined
          }
        }
        const images = helpers.extractImagesFromToolResult(result)
        state.messages.push(
          state.textTools
            ? {
                role: 'user',
                content: `[工具结果 ${call.function.name}]：${helpers.compactImageToolResult(result)}`,
              }
            : {
                role: 'tool',
                content: helpers.compactImageToolResult(result),
                toolCallId: call.id,
              },
        )
        state.pendingImages = [...new Set([...(state.pendingImages ?? []), ...images])].slice(
          0,
          MAX_SOCIAL_IMAGES,
        )
        if (state.index === state.pending.length - 1 && state.pendingImages.length)
          state.messages.push({
            role: 'user',
            pinned: true,
            content: [
              {
                type: 'text',
                text: __t(
                  'apps.social.ui',
                  '以下是本次实际提供的图片（最多 3 张），超出上限的图片未查看：',
                ),
              },
              ...state.pendingImages.map((url) => ({
                type: 'image_url' as const,
                image_url: { url },
              })),
            ],
          })
        state.index++
        if (opts.isTerminalTool?.(call.function.name) && helpers.parseTerminalAcceptance(result))
          state.reply = ''
        await save()
        state.index--
      }
      state.pending = undefined
      state.pendingImages = undefined
      state.index = 0
      await save()
      if (state.reply !== undefined) return finish(state.reply)
    }
    if (state.toolRounds! >= MAX_TOOL_ROUNDS) closeTools('tool_budget')
    else if (state.closingReason) closeTools(state.closingReason)
    const closing = Boolean(state.closingReason)
    // 保持定义前缀稳定，也兼容要求 tool_choice 与 tools 同时存在的服务商。
    // 编排模式保持入口可用，由执行边界禁止新增业务操作；兼容不支持强制工具选择的思考模型。
    const tools = opts.tools?.length ? opts.tools : undefined
    if (state.round >= MAX_MODEL_RESPONSES) {
      throw new Error('社交模型已达到有限请求预算，仍未生成可发送回复；工具摘要已保留')
    }
    fit(tools)
    await save()
    let completion: ChatCompletion
    let inputRecovery = false
    for (;;) {
      try {
        if (!model.fallbackModels?.length) await opts.beforeModelRequest?.(state.round + 1)
        completion = await requestSocialModel(llm, model, state.messages, {
          ...options,
          tools,
          toolChoice:
            opts.orchestrationTool && tools ? 'auto' : closing && tools ? 'none' : undefined,
          usageContext: { ...options.usageContext, step: state.round + 1 },
          beforeAttempt: model.fallbackModels?.length
            ? async () => {
                await opts.beforeModelRequest?.(state.round + 1)
              }
            : options.beforeAttempt,
        })
        break
      } catch (error) {
        signal?.throwIfAborted()
        const failure = socialFailure(error)
        if (
          !inputRecovery &&
          /context.{0,50}(?:length|limit|exceed)|maximum context|输入.{0,20}(?:超|容量)|too many tokens/i.test(
            failure.message,
          )
        ) {
          inputRecovery = true
          logger.warn(__t('apps.social.logs', '社交输入容量不足，正在缩减历史后重试'), {
            turnId: recovery?.record.id,
            round: state.round + 1,
          })
          fit(tools, 0.65)
          await save()
          continue
        }
        if (!failure.retryable || state.retries + (recovery?.record.attempts ?? 1) > retryLimit) {
          logger.warn(__t('apps.social.logs', '社交模型请求已停止重试'), {
            turnId: recovery?.record.id,
            round: state.round + 1,
            retries: state.retries,
            maxRetries: retryLimit,
            retryable: failure.retryable,
            reason: safeModelDiagnostic(failure.message),
          })
          throw error
        }
        state.retries++
        const delayMs = Math.min(30_000, 1000 * 2 ** state.retries)
        logger.warn(__t('apps.social.logs', '社交模型请求失败，等待重试'), {
          turnId: recovery?.record.id,
          round: state.round + 1,
          retry: state.retries,
          maxRetries: retryLimit,
          delayMs,
          reason: safeModelDiagnostic(failure.message),
        })
        if (recovery) recovery.record.error = '模型请求失败，正在重试'
        await save()
        await socialDelay(delayMs, signal)
      }
    }
    signal?.throwIfAborted()
    const choice = completion.choices[0]
    if (!choice) throw new Error('社交模型未返回有效结果')
    const message = choice.message
    state.round++
    if (recovery) recovery.record.error = undefined
    await save()
    const truncated = /length|max_tokens|max_output_tokens/i.test(choice.finishReason ?? '')
    if (truncated) {
      if (state.continuations >= MAX_CONTINUATIONS)
        throw new Error('本次模型输出多次达到 Token 上限，已停止；请拆分任务')
      state.continuations++
      // 截断的工具参数绝不执行；向 Agent 说明超限后重新请求完整工具调用。
      if (!message.toolCalls?.length)
        state.prefix += helpers.stripToolCallTags(
          helpers.stripThinkingBlocks(message.content ?? ''),
        )
      state.messages.push({
        role: 'assistant',
        content: message.content || null,
        reasoningContent: message.reasoningContent,
        nativeReasoning: message.nativeReasoning,
      })
      state.messages.push({
        role: 'user',
        pinned: true,
        content: closing
          ? opts.orchestrationTool
            ? '此次输出已达到 Token 上限。请缩短参数，调用 social_act 回复、PASS、等待或观察收尾；不要再新增业务操作。'
            : '此次输出已达到 Token 上限。请续接并简短完成最终回复，不再调用任何工具。'
          : message.toolCalls?.length
            ? '此次输出 Token 超限，工具参数未完整生成，因此尚未执行。请缩小操作并重新输出完整工具调用。'
            : '此次输出 Token 超限，请从截断位置继续，不要重复已经输出的内容。',
      })
      await save()
      continue
    }
    const visibleText = helpers.stripThinkingBlocks(message.content ?? '')
    let calls = message.toolCalls?.length ? message.toolCalls : undefined
    state.textTools = false
    if (!calls?.length && opts.toolExecutor) {
      const parsed = helpers.parseTextToolCalls(visibleText)
      if (parsed.length) {
        state.textTools = true
        calls = parsed.map((call, index) => ({
          id: `text-${state.round}-${index}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }))
      }
    }
    if (
      closing &&
      !opts.orchestrationTool &&
      (calls?.length || !helpers.stripToolCallTags(visibleText).trim())
    ) {
      for (const call of calls ?? []) traceTool(call, {}, 'blocked', 0)
      state.closingFailures = state.closingFailures! + 1
      // 拒绝的调用不能形成孤立 tool_calls，更不能在收尾阶段产生外部副作用。
      state.messages.push({
        role: 'assistant',
        content: helpers.stripToolCallTags(visibleText) || '（未生成可发送的正文）',
        reasoningContent: message.reasoningContent,
        nativeReasoning: message.nativeReasoning,
      })
      state.messages.push({
        role: 'user',
        pinned: true,
        content:
          '刚才没有生成最终正文；其中任何工具调用均未执行。现在只能回复自然语言或 PASS。' +
          '请基于已知结果收尾，不要继续请求工具，也不要把未执行操作描述为成功。',
      })
      await save()
      if (state.closingFailures! >= MAX_CLOSING_FAILURES) {
        throw new Error(
          '社交模型在明确禁用工具后仍未生成最终正文，已结束有限收尾；未执行额外工具，调用摘要已保留',
        )
      }
      continue
    }
    if (!calls?.length || !opts.toolExecutor) {
      state.messages.push({
        role: 'assistant',
        content: message.content,
        reasoningContent: message.reasoningContent,
        nativeReasoning: message.nativeReasoning,
      })
      if (opts.orchestrationTool) {
        logger.warn(
          __t('apps.social.logs', '社交模型返回普通文字，尚未发送，正在要求通过入口提交'),
          {
            turnId: recovery?.record.id,
            round: state.round,
            correction: (state.entryCorrections ?? 0) + 1,
            preview: safeModelDiagnostic(visibleText, 240),
          },
        )
        state.entryCorrections = (state.entryCorrections ?? 0) + 1
        state.messages.push({
          role: 'user',
          pinned: true,
          content:
            '刚才的普通文字未发送。请调用 social_act 提交行为：日常回复用 {"reply":"正文"}；不参与用 {"action":"pass"}；查询放入 steps。不要把普通文字当作已发送消息。',
        })
        await save()
        if (state.entryCorrections >= 2)
          throw new Error('社交模型未按协议调用 social_act，有限纠正已结束；普通文字未发送')
        continue
      }
      state.reply = state.prefix + helpers.stripToolCallTags(visibleText)
      await save()
      return finish(state.reply)
    }
    state.messages.push({
      role: 'assistant',
      content: state.textTools ? helpers.stripToolCallTags(message.content ?? '') : message.content,
      reasoningContent: message.reasoningContent,
      nativeReasoning: message.nativeReasoning,
      ...(state.textTools ? {} : { toolCalls: calls }),
    })
    state.toolRounds = state.toolRounds! + 1
    state.pending = calls
    state.index = 0
    await save()
  }
}
