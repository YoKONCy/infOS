/**
 * 表达层在上下文编译中的接入：调教预览、本轮表达素材与轮次记录。
 */
import type { EventNote, InteractionMode } from '@infos/shared'
import { AppError } from '../../lib/appError'
import type { AgentManager } from '../agent/agentManager'
import type { ExpressionService } from '../expression/service'
import type { ThreadChannel } from '../../repositories/thread.repo'
import type { ContextCompileOptions, ContextCompiler, LlmMessage } from './contextCompiler'

/** 表达调教的只读场景所用的虚拟 Thread：不读库、不持久化。 */
export function expressionPreviewThread(threadId: string, agentId: string, mode: InteractionMode) {
  return {
    id: threadId,
    agentId,
    channel: 'desktop' as const,
    interactionMode: mode,
    purpose: 'conversation',
    threadKind: 'side' as const,
    generation: 1,
    enabledSkills: [] as string[],
    contextPolicy: null,
    disabledTools: [],
  }
}

/** 表达调教预览：复用完整编译链，并标出每条消息对应的预设区块与手册位置。 */
export async function previewExpressionContext(
  compiler: Pick<ContextCompiler, 'compile'>,
  agentManager: Pick<AgentManager, 'getAgent'>,
  expression: () => ExpressionService | undefined,
  input: { agentId: string; mode: InteractionMode; message: string },
) {
  if (!agentManager.getAgent(input.agentId)) throw new AppError('NOT_FOUND')
  const compiled = await compiler.compile(`expression-preview:${input.agentId}`, input.agentId, {
    expressionPreview: { mode: input.mode },
    currentInput: { role: 'user', content: input.message },
    retrievalQuery: input.message,
    appendThreadMessages: false,
    disableWorkContext: true,
    disableToolContext: true,
    variableSessionId: `expression-preview:${input.agentId}`,
  })
  const handbook = expression()?.store.handbook.render(input.agentId) ?? ''
  // 系统消息和预设区块一一对应；数量对不上就不标名字，不去猜。
  const systemIds = (compiled.manifest.promptSegments ?? [])
    .filter((segment) => segment.role === 'system')
    .map((segment) => segment.id)
  const systemCount = compiled.messages.filter((message) => message.role === 'system').length
  let systemIndex = 0
  return {
    ...compiled,
    blockIds: compiled.messages.map((message) =>
      message.role === 'system'
        ? systemIds.length === systemCount
          ? systemIds[systemIndex++]
          : undefined
        : message.cacheControl?.key,
    ),
    // 手册嵌在表达层规则里，告诉界面在哪一块，不用猜。
    handbookMessageIndex: handbook
      ? compiled.messages.findIndex(
          (message) => typeof message.content === 'string' && message.content.includes(handbook),
        )
      : -1,
    handbookChars: [...handbook].length,
  }
}

/** 本轮表达素材，作为包上下文消息注入；领域执行与非对话 Thread 不注入。 */
export function expressionPackageMessage(
  expression: ExpressionService | undefined,
  options: ContextCompileOptions,
  input: {
    agentId: string
    threadId: string
    channel: ThreadChannel
    purpose: string
    generation?: number
    query: string
    notes: EventNote[]
    pairId?: string | null
  },
): LlmMessage | undefined {
  const expressionContent =
    !options.realmExecution && input.purpose === 'conversation'
      ? expression?.select({
          agentId: input.agentId,
          generation: input.generation,
          threadId: input.threadId,
          channel: input.channel,
          query: input.query,
          notes: input.notes,
          preview: Boolean(
            options.expressionPreview ||
            options.disableMemoryRetrieval ||
            options.disableReferenceRetrieval,
          ),
          runId: options.expressionRunId ?? options.currentPairId ?? input.pairId ?? undefined,
        })
      : ''
  return expressionContent
    ? {
        role: 'user',
        content: expressionContent,
        cacheControl: { kind: 'snapshot', key: 'expression' },
      }
    : undefined
}

/** 记录本轮用到的预设版本；临时输入与关闭召回的预览不记录。 */
export function recordExpressionTurn(
  expression: ExpressionService | undefined,
  options: ContextCompileOptions,
  input: { agentId: string; threadId: string; pairId?: string | null; promptRevision?: string },
): void {
  const expressionPairId = options.expressionRunId ?? options.currentPairId ?? input.pairId
  if (
    expressionPairId &&
    !options.expressionPreview &&
    !options.realmExecution &&
    !options.disableReferenceRetrieval
  )
    expression?.store.recordTurn(input.agentId, input.threadId, expressionPairId, input.promptRevision)
}
