import type { AppContext } from '../../container'
import type { PrepareTurnParams } from './conversationTurnService'
import type { QueuedTurnOutcome } from './conversationQueueService'
import { ConversationSurfaceSession } from '../../projections/conversationSurfaceSession'
import { AppError } from '../../lib/appError'

export type ChatStreamInput = Pick<
  PrepareTurnParams,
  | 'threadId'
  | 'agentId'
  | 'content'
  | 'attachmentIds'
  | 'imageMode'
  | 'workspaceContext'
  | 'generationType'
  | 'queueMessageId'
  | 'achievementSubjectId'
> &
  Pick<import('@infos/shared').QueuedConversationInput, 'taskResultEvent'>

/** 普通 SSE 与持久消息队列共用同一执行、Surface 和结算路径。调用方先取得 Thread 占用。 */
export async function runChatStream(
  ctx: AppContext,
  body: ChatStreamInput,
  writeEvent: (event: { event: string; data: string }) => Promise<void>,
): Promise<QueuedTurnOutcome> {
  const { threadId, content } = body
  const agentId = body.agentId ?? ctx.runtimeStateService.getTaskInfo(threadId)?.agentId ?? ''
  const signal = ctx.runtimeStateService.getAbortSignal(threadId)
  let outcome: QueuedTurnOutcome = { success: false, error: '执行尚未完成' }
  const startTime = Date.now()
  let toolCallCount = 0
  let fullContent = ''
  let mode: 'stream' | 'non_stream' = 'stream'
  let firstTokenMs: number | undefined
  let firstTokenAt: number | undefined
  const surfaceRef: { current: ConversationSurfaceSession | null } = { current: null }
  const writeSurface = async (frame: import('@infos/shared').SurfaceFrame) => {
    await writeEvent({ event: 'surface', data: JSON.stringify(frame) })
  }
  let runState = 'thinking'
  let runLabel = '正在思考……'
  const updateRunState = async (
    state: Parameters<ConversationSurfaceSession['status']>[0],
    message?: string,
    telemetry?: Parameters<ConversationSurfaceSession['status']>[2],
  ) => {
    if (!surfaceRef.current) return
    const labels: Record<string, string> = {
      thinking: '正在思考……',
      assembling: '正在生成工具调用……',
      calling: '正在等待工具回传……',
      generating: '正在打字……',
    }
    const label = message ?? labels[state]
    // 每个阶段只推送一次状态；后续文本增量不能重复创建状态帧。
    if (state === runState && label === runLabel && !telemetry) return
    runState = state
    runLabel = label ?? ''
    await writeSurface(surfaceRef.current.status(state, label, telemetry))
  }
  try {
    // 统一流式对话：创建 Pair、编译上下文、保存原始文本与工具调用都由服务处理。
    const gen = ctx.conversationTurnService.streamTurn({
      threadId,
      agentId,
      content,
      queueMessageId: body.queueMessageId,
      achievementSubjectId: body.achievementSubjectId,
      ...(body.taskResultEvent ? { inputPersistence: 'ephemeral' as const, proactive: true } : {}),
      attachmentIds: body.attachmentIds,
      imageMode: body.imageMode,
      workspaceContext: body.workspaceContext,
      generationType: body.generationType,
      signal,
      onRagProgress: async (progress) => {
        await writeEvent({
          event: 'rag_progress',
          data: JSON.stringify(progress),
        })
      },
      onExecutionStarted: async (execution) => {
        surfaceRef.current = new ConversationSurfaceSession(
          threadId,
          agentId,
          execution.executionId,
          true,
        )
        ctx.conversationQueue.setLive(threadId, surfaceRef.current)
        await writeSurface(surfaceRef.current.open())
      },
      onModelResolved: async (config) => {
        mode = config.stream === false ? 'non_stream' : 'stream'
        await updateRunState('thinking', undefined, { mode })
      },
    })

    let next = await gen.next()
    while (!next.done) {
      const chunk = next.value
      if (chunk.event === 'context_budget') {
        if (surfaceRef.current) await writeSurface(surfaceRef.current.contextBudget(chunk.data))
      } else if (chunk.event === 'thinking_start') {
        await updateRunState('thinking')
        const data = chunk.data
        if (surfaceRef.current)
          await writeSurface(surfaceRef.current.startThinking(data.blockId, data.turn))
      } else if (chunk.event === 'thinking_delta') {
        await updateRunState('thinking')
        const data = chunk.data
        if (surfaceRef.current)
          await writeSurface(surfaceRef.current.appendThinking(data.blockId, data.delta))
      } else if (chunk.event === 'thinking_end') {
        const data = chunk.data
        if (surfaceRef.current)
          await writeSurface(surfaceRef.current.completeThinking(data.blockId, data.durationMs))
      } else if (chunk.event === 'native_reasoning_start') {
        await updateRunState('thinking')
        const data = chunk.data
        if (surfaceRef.current)
          await writeSurface(
            surfaceRef.current.startNativeReasoning(data.blockId, data.mode, data.turn),
          )
      } else if (chunk.event === 'native_reasoning_delta') {
        await updateRunState('thinking')
        const data = chunk.data
        if (surfaceRef.current)
          await writeSurface(surfaceRef.current.appendNativeReasoning(data.blockId, data.delta))
      } else if (chunk.event === 'native_reasoning_end') {
        const data = chunk.data
        if (surfaceRef.current)
          await writeSurface(
            surfaceRef.current.completeNativeReasoning(data.blockId, data.durationMs),
          )
      } else if (chunk.event === 'tool_call_start') {
        await updateRunState('assembling')
        const data = chunk.data
        if (surfaceRef.current) await writeSurface(surfaceRef.current.startToolDraft(data.draftId))
      } else if (chunk.event === 'tool_call_delta') {
        await updateRunState('assembling')
        const data = chunk.data
        if (surfaceRef.current) {
          const frame = surfaceRef.current.appendToolDraft(
            data.draftId,
            data.nameDelta,
            data.argumentsDelta,
            data.receivedChars,
          )
          if (frame) await writeSurface(frame)
        }
      } else if (chunk.event === 'tool_file_baseline') {
        if (surfaceRef.current)
          await writeSurface(
            surfaceRef.current.fileBaseline(chunk.data.draftId, chunk.data.baseline),
          )
      } else if (chunk.event === 'tool_call_ready') {
        toolCallCount++
        const data = chunk.data
        if (surfaceRef.current) {
          await writeSurface(surfaceRef.current.finalizeToolDraft(data))
        }
      } else if (chunk.event === 'model_retry') {
        if (chunk.data.discardedTextCharacters)
          fullContent = fullContent.slice(0, -chunk.data.discardedTextCharacters)
        if (surfaceRef.current)
          for (const frame of surfaceRef.current.modelRetry(chunk.data)) await writeSurface(frame)
      } else if (chunk.event === 'narration_start') {
        await updateRunState('generating')
        const data = chunk.data
        if (surfaceRef.current) await writeSurface(surfaceRef.current.startNarration(data.blockId))
      } else if (chunk.event === 'narration_delta') {
        const data = chunk.data
        const now = Date.now()
        if (firstTokenMs === undefined) {
          firstTokenMs = now - startTime
          firstTokenAt = now
          await updateRunState('generating', undefined, { mode, firstTokenMs })
        }
        await updateRunState('generating')
        fullContent += data.delta
        if (surfaceRef.current)
          await writeSurface(surfaceRef.current.appendText(data.blockId, data.delta))
      } else if (chunk.event === 'narration_end') {
        if (surfaceRef.current)
          await writeSurface(surfaceRef.current.completeNarration(chunk.data.blockId))
      } else {
        if (chunk.event === 'tool_call') {
          const data = chunk.data as Parameters<ConversationSurfaceSession['toolCall']>[0]
          // 直接调用已有草稿节点；NIT 子工具没有模型参数流，单独建立关联节点。
          if (data.parentCallId && surfaceRef.current)
            await writeSurface(surfaceRef.current.toolCall(data))
          await updateRunState('calling')
        } else if (chunk.event === 'tool_result') {
          const data = chunk.data as {
            callId: string
            result: string
            isError: boolean
            durationMs?: number
            automaticApproval?: import('@infos/shared').AutomaticApprovalRecord
            parentCallId?: string
          }
          if (surfaceRef.current) {
            for (const frame of surfaceRef.current.toolResult(data)) await writeSurface(frame)
            await updateRunState(data.parentCallId ? 'calling' : 'thinking')
          }
        } else if (chunk.event === 'status') {
          const data = chunk.data as {
            state: Parameters<ConversationSurfaceSession['status']>[0]
            message?: string
          }
          await updateRunState(data.state, data.message)
        }
      }
      next = await gen.next()
    }

    const turnResult = next.value
    // streamTurn 自然结束时消息已持久化；最终 Surface 必须来自统一 Projection。
    const messageId = turnResult?.assistantMessage?.id
    if (!messageId) throw new Error('流式对话完成后缺少持久消息身份')
    ctx.conversationProjection.invalidate(threadId)
    const projection = await ctx.conversationProjection.getSnapshot(threadId)
    const committedMessage = projection.messages.find(
      (message) => message.messageId === String(messageId),
    )
    const committedSurface = projection.surfaces.find(
      (surface) => surface.messageId === String(messageId),
    )
    if (!committedMessage || !committedSurface) {
      throw new Error(`Conversation Projection 不完整: message=${messageId}`)
    }
    const completedAt = Date.now()
    const durationMs = completedAt - startTime
    const outputDurationMs = firstTokenAt ? completedAt - firstTokenAt : 0
    if (surfaceRef.current) {
      await writeSurface(
        surfaceRef.current.commit(projection, committedMessage, committedSurface, {
          mode,
          firstTokenMs,
          outputDurationMs,
          totalDurationMs: durationMs,
        }),
      )
    }

    outcome = {
      success: true,
      paused: Boolean(turnResult.executionPause),
      handoff: turnResult.handoff,
    }
    // 完成遥测与done事件
    await writeEvent({
      event: 'done',
      data: JSON.stringify({
        usage: {
          promptTokens: ctx.tokenCounter.countMessages(turnResult.initialPromptMessages),
          completionTokens:
            turnResult.generationStats?.outputTokens ?? ctx.tokenCounter.countTokens(fullContent),
        },
        generationStats: turnResult.generationStats,
        toolCallCount,
        executionPause: turnResult.executionPause,
        mode,
        firstTokenMs,
        outputDurationMs,
        durationMs,
        threadId,
        agentId,
      }),
    })
  } catch (err) {
    const appError = err instanceof AppError ? err : null
    const code = appError?.code ?? 'INTERNAL_ERROR'
    const message = appError?.message ?? (err instanceof Error ? err.message : String(err))
    outcome = { success: false, error: message }
    if (surfaceRef.current) {
      await writeSurface(surfaceRef.current.fail(code, message, fullContent))
    }
    await writeEvent({
      event: 'error',
      data: JSON.stringify({
        code,
        message,
        data: appError?.data,
      }),
    })
  } finally {
    if (signal?.aborted) outcome = { success: false, error: '用户已停止或执行已取消' }
    try {
      ctx.conversationQueue.afterTurn(threadId, outcome)
    } finally {
      ctx.conversationQueue.setLive(threadId)
      ctx.runtimeStateService.unregisterTask(threadId)
    }
  }
  return outcome
}
