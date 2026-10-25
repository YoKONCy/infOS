import { t as __t } from '../lib/i18n'
/**
 * 应用启动生命周期
 *
 * 在 createAppContext 返回后、HTTP 服务启动前执行的异步初始化。
 * lifespan() 中的初始化逻辑。
 *
 * 包含:
 * 1. KernelScheduler 周期计划启动
 * 2. Gateway 语音与对话事件注册
 *
 * @module packages/backend/src/lifecycle/startup
 */

import type { AppContext } from '../container'
import type { GatewayEnvelope } from '../services/gateway/types'
import { createEnvelope } from '../services/gateway/types'
import { createLogger } from '../lib/logger'
import { ConversationSurfaceSession } from '../projections/conversationSurfaceSession'
import { runChatStream } from '../services/conversation/chatStreamRunner'

const logger = createLogger('Startup')

/**
 * 执行启动后异步初始化
 *
 * @param ctx - 已初始化的应用上下文
 */
export async function runStartupTasks(ctx: AppContext): Promise<void> {
  logger.info(__t('logs.lifecycle', '正在执行启动后任务...'))

  ctx.conversationQueue.setRunner((input) =>
    runChatStream(ctx, input, async (event) => {
      if (event.event !== 'surface') return
      try {
        await ctx.gatewayHub.pushSurface(JSON.parse(event.data))
      } catch (error) {
        logger.warn(__t('logs.lifecycle', '队列消息观察推送失败，后台继续执行'), {
          error: String(error),
        })
      }
    }),
  )
  ctx.conversationQueue.start()

  // 退役 companion 持久通道：旧会话按产品决策统一软删除。
  try {
    await ctx.threadService.deleteThreadsByChannel('companion')
  } catch (err) {
    logger.warn(__t('logs.lifecycle', '旧陪伴会话清理失败: {0}', [err]))
  }

  // ── 1. 启动后台调度器 ──
  ctx.scheduler.startPeriodic()
  logger.success(__t('logs.lifecycle', '后台调度器已启动'))

  // ── 2. 执行 Outbox 保留清理；死信始终保留供审计和人工重放 ──
  try {
    const result = await ctx.outboxLifecycle.maintain()
    const diagnostics = await ctx.outboxLifecycle.diagnostics()
    logger.info(
      __t('logs.lifecycle', 'Outbox生命周期维护完成: kernelDeleted={0}, kernelDead={1}', [
        result.outboxDeleted,
        diagnostics.kernel.dead_letter ?? 0,
      ]),
    )
  } catch (err) {
    logger.warn(__t('logs.lifecycle', 'Outbox生命周期维护失败: {0}', [err]))
  }

  // ── 5. 注册 Gateway 语音管道事件处理 ──
  registerVoicePipelineHandler(ctx)
  logger.success(__t('logs.lifecycle', '语音管道 Gateway 触发已注册'))

  // ── 5. 注册 Gateway 对话事件处理 (action:chat) ──
  registerChatHandler(ctx)
  logger.success(__t('logs.lifecycle', '对话 Gateway RPC 已注册'))

  // ── 6. 注册 abort 事件处理 (前端中断对话) ──
  // AIOS: 改用 RuntimeStateService 按 threadId 取消任务
  ctx.gatewayHub.on('abort', (envelope: GatewayEnvelope) => {
    const threadId =
      (envelope.payload?.threadId as string) || (envelope.payload?.sessionId as string) || 'default'
    ctx.runtimeStateService.cancelTask(threadId)
    logger.info(__t('logs.lifecycle', '对话已中断: thread={0}', [threadId]))
  })
  logger.success(__t('logs.lifecycle', '对话中断 Gateway 触发已注册'))

  logger.success(__t('logs.lifecycle', '启动后任务执行完毕'))
}

/**
 * 注册 Gateway 语音管道处理
 *
 * 当前端通过 WS 发送 action:voice_pipeline 请求时:
 * 1. 从 payload 提取 audio (base64) + agentId + sessionId
 * 2. 调用 RealtimeSessionManager.processVoicePipeline()
 * 3. 将 TTS 音频结果通过 pushAudioChunk 推送给前端
 */
function registerVoicePipelineHandler(ctx: AppContext): void {
  ctx.gatewayHub.on('action:voice_pipeline', async (envelope: GatewayEnvelope) => {
    const payload = envelope.payload as Record<string, unknown>
    const audioBase64 = payload.audio as string | undefined
    const agentId =
      (payload.agentId as string) ||
      ctx.runtimeStateService.getActiveAgent() ||
      ctx.agentManager.defaultAgentId
    const sessionId = (payload.sessionId as string) || `voice_${Date.now()}`

    if (!audioBase64) {
      logger.warn(__t('logs.lifecycle', 'voice_pipeline: 缺少 audio 数据'))
      // 发送错误响应
      await ctx.gatewayHub.broadcast(
        createEnvelope('push', {
          action: 'voice_error',
          error: '缺少音频数据',
          sessionId,
        }),
      )
      return
    }

    try {
      // base64 → ArrayBuffer
      const buffer = Buffer.from(audioBase64, 'base64')
      const audioData = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      )

      logger.info(
        __t('logs.lifecycle', '语音管道启动: session={0}, agent={1}, audio={2}KB', [
          sessionId,
          agentId,
          (audioData.byteLength / 1024).toFixed(1),
        ]),
      )

      // 执行全链路管道: ASR → Agent → TTS
      const result = await ctx.realtimeSessionManager.processVoicePipeline(
        audioData,
        agentId,
        sessionId,
      )

      // 推送 ASR 识别结果
      await ctx.gatewayHub.broadcast(
        createEnvelope('push', {
          action: 'voice_transcript',
          sessionId,
          text: result.transcript,
        }),
      )

      // Voice回复通过统一 Surface投影。
      await ctx.gatewayHub.pushSurface({
        protocolVersion: 1,
        surfaceId: `voice:${sessionId}` as import('@infos/shared').SurfaceId,
        generation: sessionId,
        revision: 1,
        sequence: 1,
        operationId: `voice:${sessionId}:reply`,
        operation: {
          type: 'surface.open',
          threadId: sessionId,
          principalId: agentId,
          nodes: [
            {
              nodeId: `voice:${sessionId}:reply` as import('@infos/shared').SurfaceNodeId,
              kind: 'markdown',
              revision: 1,
              lifecycle: 'stable',
              props: { source: result.reply, phase: 'committed' },
            },
            {
              nodeId: `voice:${sessionId}:status` as import('@infos/shared').SurfaceNodeId,
              kind: 'status',
              revision: 1,
              lifecycle: 'transient',
              props: { state: 'completed' },
            },
          ],
        },
      })

      // 通过 active Input Seat 定向到目标 Audio Output Node。
      if (result.audio) {
        const principalId = String(payload.principalId ?? 'pero')
        const seat = ctx.nodeRegistry.getInputSeat(principalId, 'audio-output')
        if (!seat) throw new Error('AUDIO_OUTPUT_SEAT_UNAVAILABLE: 当前没有可用音频输出 Seat')
        await ctx.audioDeliveryService.deliver(
          result.audio,
          {
            principalId,
            correlationId: sessionId,
            targetNodeId: seat.nodeId,
            idempotencyKey: `voice:${sessionId}`,
          },
          seat.nodeId,
        )
      }

      logger.info(
        __t('logs.lifecycle', '语音管道完成: ASR={0}ms, Agent={1}ms, TTS={2}ms, 总计={3}ms', [
          result.timing.asrMs,
          result.timing.agentMs,
          result.timing.ttsMs,
          result.timing.totalMs,
        ]),
      )
    } catch (err) {
      logger.error(__t('logs.lifecycle', '语音管道错误: {0}', [err]))
      await ctx.gatewayHub.broadcast(
        createEnvelope('push', {
          action: 'voice_error',
          sessionId,
          error: (err as Error).message,
        }),
      )
    }
  })
}

/**
 * 注册 Gateway 对话处理 (action:chat)
 *
 * AIOS 新版架构：前端通过 WS 发送 request('chat', { content, threadId?, agentId? })。
 * 兼容旧版 payload：若收到 messages 数组，则取最后一条 user 消息的 content。
 *
 * 处理流程：
 * 1. 获取或创建 desktop Thread（若 payload 未带 threadId）
 * 2. 追加用户消息到 Thread
 * 3. ConversationTurnService 写入消息并编译上下文
 * 4. RuntimeStateService 注册任务（替代旧 TaskManager）
 * 5. ConversationTurnService.streamTurn() 执行流式对话并统一持久化消息对
 * 6. 将 Execution 事件转换为统一 SurfaceFrame 并通过 Gateway 推送
 * 7. 结束流并发送 RPC 响应
 * 8. 对话完成后提交权威 Projection与 Surface
 * 9. 异步合成 TTS 并定向播放
 */
/**
 * 合成 TTS，并通过 Audio Asset 与 active Input Seat 定向播放。
 *
 * desktop 文本对话路径默认走 TTS；无有效 Seat 或 Provider 时安全跳过。
 */
const speechGenerations = new Map<string, number>()
const speechControllers = new Map<string, AbortController>()

async function synthesizeAndDeliverTts(
  ctx: AppContext,
  spokenReply: string,
  sessionId: string,
  principalId: string,
  generation: number,
): Promise<void> {
  if (speechGenerations.get(principalId) !== generation) return
  const controller = new AbortController()
  speechControllers.get(principalId)?.abort()
  speechControllers.set(principalId, controller)
  try {
    if (!ctx.ttsService.availableFor(principalId)) {
      logger.debug(__t('logs.lifecycle', 'TTS 不可用，跳过桌面对话语音合成'))
      return
    }

    const seat = ctx.nodeRegistry.getInputSeat(principalId, 'audio-output')
    if (!seat) {
      logger.debug(
        __t('logs.lifecycle', '当前没有可用音频输出 Seat，跳过 TTS 播放: principal={0}', [
          principalId,
        ]),
      )
      return
    }
    if (!ctx.audioDeliveryService.canDeliverTo(seat.nodeId)) {
      logger.debug(
        __t('logs.lifecycle', '音频输出节点尚未就绪，跳过 TTS 播放: node={0}', [seat.nodeId]),
      )
      return
    }

    const ttsText = spokenReply
    if (!ttsText.trim()) {
      logger.debug(__t('logs.lifecycle', 'TTS 文本清洗后为空，跳过合成'))
      return
    }

    const audio = await ctx.ttsService.synthesize({
      text: ttsText,
      agentId: principalId,
      signal: controller.signal,
    })
    if (speechGenerations.get(principalId) !== generation) return
    const receipt = await ctx.audioDeliveryService.deliver(
      audio,
      {
        principalId,
        correlationId: sessionId,
        targetNodeId: seat.nodeId,
        idempotencyKey: `chat:${sessionId}:${generation}`,
      },
      seat.nodeId,
      {
        caption: spokenReply,
        threadId: sessionId,
        isCurrent: () => speechGenerations.get(principalId) === generation,
      },
    )
    logger.info(
      __t('logs.lifecycle', '桌面对话 TTS 已定向播放: {0}KB, session={1}, node={2}, state={3}', [
        (audio.audio.byteLength / 1024).toFixed(1),
        sessionId,
        receipt.targetNodeId,
        receipt.state,
      ]),
    )
  } catch (err) {
    if (controller.signal.aborted) return
    logger.warn(__t('logs.lifecycle', '桌面对话 TTS 失败: {0}', [err]))
  } finally {
    if (speechControllers.get(principalId) === controller) speechControllers.delete(principalId)
  }
}

function registerChatHandler(ctx: AppContext): void {
  ctx.gatewayHub.on('action:stop_speech', async (envelope: GatewayEnvelope) => {
    const payload = envelope.payload as Record<string, unknown>
    const principalId =
      typeof payload.agentId === 'string'
        ? payload.agentId
        : ctx.runtimeStateService.getActiveAgent() || ctx.agentManager.defaultAgentId
    speechGenerations.set(principalId, (speechGenerations.get(principalId) ?? 0) + 1)
    speechControllers.get(principalId)?.abort()
    await ctx.audioDeliveryService.cancel(principalId)
    if (envelope.id && envelope.sourceId)
      await ctx.gatewayHub.sendResponse(envelope.id, envelope.sourceId, { stopped: true })
  })
  ctx.gatewayHub.on('action:chat', async (envelope: GatewayEnvelope) => {
    const payload = envelope.payload as Record<string, unknown>
    const agentId =
      (payload.agentId as string) ||
      ctx.runtimeStateService.getActiveAgent() ||
      ctx.agentManager.defaultAgentId
    const requestId = envelope.id
    const speechGeneration = (speechGenerations.get(agentId) ?? 0) + 1
    speechGenerations.set(agentId, speechGeneration)
    speechControllers.get(agentId)?.abort()
    const sourceNodeId = envelope.sourceId ?? ''

    // AIOS: 优先使用 threadId；兼容旧版 sessionId 字段
    const threadId = (payload.threadId as string) || (payload.sessionId as string) || ''
    const capabilityScope = payload.capabilityScope === 'ambient' ? 'ambient' : 'default'

    // AIOS: 优先使用 content；兼容旧版 messages 数组（取最后一条 user 消息）
    let content = (payload.content as string) || ''
    if (!content) {
      const messages = (payload.messages as Array<{ role: string; content: string }>) || []
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === 'user') {
          content = messages[i]!.content
          break
        }
      }
    }

    if (!content.trim()) {
      if (requestId && sourceNodeId) {
        await ctx.gatewayHub.sendError(requestId, sourceNodeId, '消息内容为空')
      }
      return
    }

    let threadIdResolved = threadId
    let ownsTask = false
    let completedTask = false
    const surfaceRef: { current: ConversationSurfaceSession | null } = { current: null }
    try {
      // ── 1. 获取或创建 Thread ──
      if (!threadIdResolved) {
        // 未指定 threadId 时，获取或创建 Agent 的最新 desktop Thread
        const thread = await ctx.threadService.getOrCreateLatest(agentId, 'desktop', 'conversation')
        threadIdResolved = thread.id
      } else {
        // 校验 Thread 是否存在
        const existing = await ctx.threadService.getThread(threadIdResolved)
        if (!existing) {
          // Thread 不存在则创建（兼容前端传入新 threadId 的场景）
          await ctx.threadService.createThread({
            id: threadIdResolved,
            agentId,
            channel: 'desktop',
          })
        }
      }

      // 活动时间统一由 ConversationTurnService 在用户回合入口更新。

      // ── 3. RuntimeStateService 注册任务（替代旧 TaskManager） ──
      ctx.runtimeStateService.registerTask(threadIdResolved, agentId)
      ownsTask = true

      // ── 4. 统一流式对话与 Surface 输出 ──
      const gen = ctx.conversationTurnService.streamTurn({
        threadId: threadIdResolved,
        agentId,
        content,
        signal: ctx.runtimeStateService.getAbortSignal(threadIdResolved),
        capabilityScope,
        onExecutionStarted: async (execution) => {
          surfaceRef.current = new ConversationSurfaceSession(
            threadIdResolved,
            agentId,
            execution.executionId,
            true,
          )
          ctx.conversationQueue.setLive(threadIdResolved, surfaceRef.current)
          await ctx.gatewayHub.pushSurface(surfaceRef.current.open())
        },
      })
      let fullReply = ''
      let runState = 'thinking'
      let runLabel = '正在思考……'
      const updateRunState = async (
        state: Parameters<ConversationSurfaceSession['status']>[0],
        message?: string,
      ) => {
        if (!surfaceRef.current) return
        const labels: Record<string, string> = {
          thinking: '正在思考……',
          assembling: '正在生成工具调用……',
          generating: '正在打字……',
          calling: '正在等待工具回传……',
        }
        const label = labels[state] ?? message ?? ''
        // 文本增量只在切换阶段时更新状态，避免每个字都推送重复状态帧。
        if (state === runState && label === runLabel) return
        runState = state
        runLabel = label
        await ctx.gatewayHub.pushSurface(surfaceRef.current.status(state, label))
      }
      let next = await gen.next()

      while (!next.done) {
        const chunk = next.value
        if (chunk.event === 'context_budget') {
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(surfaceRef.current.contextBudget(chunk.data))
          }
        } else if (chunk.event === 'thinking_start') {
          await updateRunState('thinking')
          const data = chunk.data
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(
              surfaceRef.current.startThinking(data.blockId, data.turn),
            )
          }
        } else if (chunk.event === 'thinking_delta') {
          await updateRunState('thinking')
          const data = chunk.data
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(
              surfaceRef.current.appendThinking(data.blockId, data.delta),
            )
          }
        } else if (chunk.event === 'thinking_end') {
          const data = chunk.data
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(
              surfaceRef.current.completeThinking(data.blockId, data.durationMs),
            )
          }
        } else if (chunk.event === 'native_reasoning_start') {
          await updateRunState('thinking')
          const data = chunk.data
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(
              surfaceRef.current.startNativeReasoning(data.blockId, data.mode, data.turn),
            )
          }
        } else if (chunk.event === 'native_reasoning_delta') {
          await updateRunState('thinking')
          const data = chunk.data
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(
              surfaceRef.current.appendNativeReasoning(data.blockId, data.delta),
            )
          }
        } else if (chunk.event === 'native_reasoning_end') {
          const data = chunk.data
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(
              surfaceRef.current.completeNativeReasoning(data.blockId, data.durationMs),
            )
          }
        } else if (chunk.event === 'model_retry') {
          if (chunk.data.discardedTextCharacters)
            fullReply = fullReply.slice(0, -chunk.data.discardedTextCharacters)
          if (surfaceRef.current)
            for (const frame of surfaceRef.current.modelRetry(chunk.data))
              await ctx.gatewayHub.pushSurface(frame)
        } else if (chunk.event === 'narration_start') {
          await updateRunState('generating')
          const data = chunk.data
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(surfaceRef.current.startNarration(data.blockId))
          }
        } else if (chunk.event === 'narration_delta') {
          await updateRunState('generating')
          const data = chunk.data
          fullReply += data.delta
          if (surfaceRef.current) {
            await ctx.gatewayHub.pushSurface(
              surfaceRef.current.appendText(data.blockId, data.delta),
            )
          }
        } else if (chunk.event === 'narration_end' && surfaceRef.current) {
          await ctx.gatewayHub.pushSurface(surfaceRef.current.completeNarration(chunk.data.blockId))
        } else if (chunk.event === 'tool_call_start' && surfaceRef.current) {
          await updateRunState('assembling')
          await ctx.gatewayHub.pushSurface(surfaceRef.current.startToolDraft(chunk.data.draftId))
        } else if (chunk.event === 'tool_call_delta' && surfaceRef.current) {
          await updateRunState('assembling')
          const frame = surfaceRef.current.appendToolDraft(
            chunk.data.draftId,
            chunk.data.nameDelta,
            chunk.data.argumentsDelta,
            chunk.data.receivedChars,
          )
          if (frame) await ctx.gatewayHub.pushSurface(frame)
        } else if (chunk.event === 'tool_file_baseline' && surfaceRef.current) {
          await ctx.gatewayHub.pushSurface(
            surfaceRef.current.fileBaseline(chunk.data.draftId, chunk.data.baseline),
          )
        } else if (chunk.event === 'tool_call_ready' && surfaceRef.current) {
          await ctx.gatewayHub.pushSurface(surfaceRef.current.finalizeToolDraft(chunk.data))
        } else if (chunk.event === 'tool_call') {
          const data = chunk.data as Parameters<ConversationSurfaceSession['toolCall']>[0]
          if (data.parentCallId && surfaceRef.current)
            await ctx.gatewayHub.pushSurface(surfaceRef.current.toolCall(data))
          await updateRunState('calling')
        } else if (chunk.event === 'tool_result' && surfaceRef.current) {
          const data = chunk.data as {
            callId: string
            result: string
            isError: boolean
            durationMs?: number
            parentCallId?: string
          }
          for (const frame of surfaceRef.current.toolResult(data)) {
            await ctx.gatewayHub.pushSurface(frame)
          }
          await updateRunState(data.parentCallId ? 'calling' : 'thinking')
        } else if (chunk.event === 'status' && surfaceRef.current) {
          const data = chunk.data as {
            state: Parameters<ConversationSurfaceSession['status']>[0]
            message?: string
          }
          await updateRunState(data.state, data.message)
        }
        next = await gen.next()
      }

      const turnResult = next.value
      const messageId = turnResult.assistantMessage?.id
      if (!messageId) throw new Error('桌宠对话完成后缺少持久消息身份')
      ctx.conversationProjection.invalidate(threadIdResolved)
      const projection = await ctx.conversationProjection.getSnapshot(threadIdResolved)
      const message = projection.messages.find((item) => item.messageId === String(messageId))
      const surface = projection.surfaces.find((item) => item.messageId === String(messageId))
      if (!message || !surface) throw new Error(`桌宠 Conversation Projection 不完整: ${messageId}`)
      if (surfaceRef.current) {
        await ctx.gatewayHub.pushSurface(surfaceRef.current.commit(projection, message, surface))
      }

      // ── 5. RPC 响应回送 ──
      if (requestId && sourceNodeId) {
        await ctx.gatewayHub.sendResponse(requestId, sourceNodeId, {
          success: true,
          reply: fullReply,
          spokenReply: turnResult.spokenReply ?? '',
          messageId: String(messageId),
          threadId: threadIdResolved,
        })
      }

      completedTask = !turnResult.executionPause
      // ── 9. desktop 对话 TTS: 异步合成并定向到 active Input Seat ──
      if (payload.speak !== false && !turnResult.handoff) {
        void synthesizeAndDeliverTts(
          ctx,
          turnResult.spokenReply ?? '',
          threadIdResolved,
          agentId,
          speechGeneration,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(__t('logs.lifecycle', 'Gateway chat 失败: {0}', [errMsg]))

      // 推送结构化错误到前端
      if (surfaceRef.current) {
        await ctx.gatewayHub.pushSurface(surfaceRef.current.fail('GATEWAY_CHAT_ERROR', errMsg))
      }

      // RPC 错误回送
      if (requestId && sourceNodeId) {
        await ctx.gatewayHub.sendError(requestId, sourceNodeId, errMsg)
      }
    } finally {
      // AIOS: 注销任务（按 threadId）
      if (ownsTask) {
        try {
          ctx.conversationQueue.afterTurn(threadIdResolved, { success: completedTask })
        } finally {
          ctx.conversationQueue.setLive(threadIdResolved)
          ctx.runtimeStateService.unregisterTask(threadIdResolved)
        }
      }
    }
  })
}
