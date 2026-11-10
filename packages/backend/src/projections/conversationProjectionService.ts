import { t as __t } from '../lib/i18n'
import type {
  ConversationMessageProjection,
  ConversationProjectionSnapshot,
  KernelEventEnvelope,
  SurfaceDescriptor,
} from '@infos/shared'
import type { ThreadService } from '../services/thread/threadService'
import type { ApprovalService } from '../services/execution/approvalService'
import type { AgentInputService } from '../services/execution/agentInputService'
import type { AttachmentService } from '../services/attachment/attachmentService'

import { ConversationSurfaceProjector } from './conversationSurfaceProjector'
import { splitSpokenReply } from '../nit/spokenReplyFilter'
import { parseAutomaticApproval } from '@infos/shared'

interface CachedProjection {
  snapshot: ConversationProjectionSnapshot
  dirty: boolean
  /** 构建时 Thread 的消息计数与最后消息时间；用户消息落盘不发提交事件，靠它发现缓存过期。 */
  stamp: string
}

/**
 * Conversation 的可重建读模型。
 *
 * 权威数据仍来自 Thread/Attachment 领域表；Outbox 事件只负责使缓存失效。
 */
export class ConversationProjectionService {
  private readonly cache = new Map<string, CachedProjection>()
  private readonly processedEvents = new Set<string>()
  private readonly surfaceProjector = new ConversationSurfaceProjector()

  constructor(
    private readonly threadService: ThreadService,
    private readonly attachmentService: AttachmentService,
    private readonly approvalService?: ApprovalService,
    private readonly agentInputService?: AgentInputService,
  ) {}

  consume(event: KernelEventEnvelope<string, unknown>): void {
    if (this.processedEvents.has(event.eventId)) return
    this.processedEvents.add(event.eventId)
    if (this.processedEvents.size > 10_000)
      this.processedEvents.delete(this.processedEvents.values().next().value!)
    if (event.type !== 'conversation.message.committed' && event.type !== 'conversation.execution.settled') return
    const payload = event.payload as { threadId?: string }
    if (!payload.threadId) return
    const cached = this.cache.get(payload.threadId)
    if (cached) cached.dirty = true
  }

  async getSnapshot(
    threadId: string,
    options: { beforeCursor?: string; pageSize?: number } = {},
  ): Promise<ConversationProjectionSnapshot> {
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 60))
    const beforeMessageId = options.beforeCursor ? Number(options.beforeCursor) : undefined
    const useCache = beforeMessageId === undefined && pageSize === 60
    const cached = useCache ? this.cache.get(threadId) : undefined

    const thread = await this.threadService.getThread(threadId)
    if (!thread) throw new Error(`Conversation Projection 找不到 Thread: ${threadId}`)
    // 用户消息在回合开始时就已落盘，但只有回复提交才会发失效事件；
    // 计数或最后消息时间变化说明缓存已落后，否则第二轮起快照会缺少刚发出的消息。
    const stamp = `${thread.messageCount}:${thread.lastMessageAt ?? ''}`
    if (cached && !cached.dirty && cached.stamp === stamp && cached.snapshot.threadGeneration === thread.generation) return cached.snapshot
    const result = await this.threadService.listMessages({
      threadId,
      beforeMessageId: Number.isSafeInteger(beforeMessageId) ? beforeMessageId : undefined,
      pageSize,
    })
    const ordered = [...result.items].reverse()
    const executions = thread.threadKind === 'main'
      ? this.threadService.conversations.forProjection(threadId, thread.generation,
          ordered.flatMap((message) => message.executionId ? [message.executionId] : []),
          ordered[0]?.timestamp ? new Date(ordered[0].timestamp).toISOString() : undefined,
          beforeMessageId && ordered.at(-1)?.timestamp ? new Date(ordered.at(-1)!.timestamp).toISOString() : undefined)
      : []
    const traces = new Map<number, Record<string, unknown>>()
    const publications = new Map(executions.map((execution) =>
      [execution.id, this.threadService.conversations.publications(execution.id)]))
    const processPositions = new Map<string, number>()
    const separateProcess = (status: string) => ['failed', 'interrupted', 'paused'].includes(status)
    for (const execution of executions) {
      const last = publications.get(execution.id)?.at(-1)
      if (last && !separateProcess(execution.status)) traces.set(last.id, { ...JSON.parse(execution.metadataJson),
        kernelExecutionId: execution.kernelExecutionId, settled: execution.completedAt !== null })
    }
    const attachments = await this.attachmentService.listForMessages(
      ordered.map((message) => message.id),
    )
    const messages = ordered.map<ConversationMessageProjection>((message) => {
      const trace = traces.get(message.id)
      if (trace) {
        const publication = JSON.parse(message.metadataJson)
        const metadata = { ...publication, ...trace, spokenReply: publication.spokenReply }
        if (Array.isArray(metadata.contentBlocks)) metadata.contentBlocks = metadata.contentBlocks.filter(
          (block: import('@infos/shared').ConversationContentBlock) => block.kind !== 'narration' || block.phase !== 'final',
        )
        message = { ...message, rawContent: String(trace.rawContent ?? ''), metadataJson: JSON.stringify(metadata) }
      }
      const parsed = message.role === 'assistant' ? splitSpokenReply(message.content) : undefined
      return {
        messageId: String(message.id),
        threadId: message.threadId,
        role: message.role,
        content: parsed?.content ?? message.content,
        spokenReply:
          this.parseSpokenReply(message.metadataJson) || parsed?.spokenReply || undefined,
        rawContent: message.rawContent,
        pairId: message.pairId,
        publicationId: message.publicationId,
        executionId: message.executionId,
        sourceMessages: this.parseSourceMessages(message.metadataJson),
        senderId: message.senderId,
        agentId: message.agentId,
        revision: message.revision,
        imageTranscription: this.isImageTranscription(message.metadataJson),
        status: message.status,
        failureMessage: this.parseFailureMessage(message.metadataJson),
        executionPause: this.parseExecutionPause(message.metadataJson),
        timestamp: message.timestamp,
        outputTokens: this.parseOutputTokens(message.metadataJson),
        generationStats: this.parseGenerationStats(message.metadataJson),
        contentBlocks: this.parseContentBlocks(message.metadataJson),
        toolCalls: this.parseToolCalls(message.metadataJson),
        attachments: (attachments.get(message.id) ?? []).map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.originalName,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          caption: item.caption,
          origin: item.origin,
        })),
      }
    })
    for (const execution of executions) {
      const last = publications.get(execution.id)?.at(-1)
      if (last && !separateProcess(execution.status)) continue
      const metadata = execution.metadataJson
      const details = JSON.parse(metadata)
      if (!separateProcess(execution.status) && !details.contentBlocks?.length && !details.toolCalls?.length) continue
      const sources = JSON.parse(execution.inputSourcesJson) as import('@infos/shared').ConversationSource[]
      const previous = ordered.filter((message) => new Date(message.timestamp).getTime() <= new Date(execution.startedAt).getTime()).at(-1)?.id ?? 0
      processPositions.set(`execution:${execution.id}`, (last?.id ?? Math.max(previous, ...sources.map((source) => source.messageId))) + 0.5)
      messages.push({
        messageId: `execution:${execution.id}`, threadId, role: 'assistant', content: '',
        executionRecord: true, executionId: execution.id, agentId: thread.agentId,
        sourceMessages: JSON.parse(execution.inputSourcesJson), revision: 1, imageTranscription: false,
        status: execution.status, timestamp: execution.completedAt ?? execution.startedAt,
        rawContent: JSON.parse(metadata).rawContent,
        failureMessage: this.parseFailureMessage(metadata),
        executionPause: this.parseExecutionPause(metadata),
        generationStats: this.parseGenerationStats(metadata),
        contentBlocks: this.parseContentBlocks(metadata).map((block) => block.kind === 'narration'
          ? { ...block, phase: 'progress' as const } : block),
        toolCalls: this.parseToolCalls(metadata), attachments: [],
      })
    }
    messages.sort((left, right) => (processPositions.get(left.messageId) ?? Number(left.messageId)) -
      (processPositions.get(right.messageId) ?? Number(right.messageId)))
    const surfaces: SurfaceDescriptor[] = messages.map((message) => ({
      ...this.surfaceProjector.projectMessage(message, message.agentId ?? thread.agentId),
      processCollapsed: thread.threadKind === 'main' && message.role === 'assistant',
      threadGeneration: thread.generation,
      executionId: executions.find((execution) => execution.id === message.executionId)?.kernelExecutionId ?? undefined,
      revision: message.revision + (traces.get(Number(message.messageId))?.settled ? 1 : 0),
    }))
    const approvals = (this.approvalService?.list({ status: 'pending' }) ?? []).filter(
      (approval) => approval.threadId === threadId && !approval.taskId,
    )
    for (const approval of approvals) {
      surfaces.push({
        surfaceId: `conversation-approval:${approval.id}` as import('@infos/shared').SurfaceId,
        generation: `conversation-approval:${approval.id}`,
        threadId,
        principalId: approval.agentId,
        revision: 1,
        sequence: 0,
        state: 'committed',
        nodes: [
          {
            nodeId:
              `conversation-approval:${approval.id}:approval` as import('@infos/shared').SurfaceNodeId,
            kind: 'approval',
            lifecycle: 'interactive',
            revision: 1,
            props: {
              approvalId: approval.id,
              principalId: approval.agentId,
              threadId,
              toolName: approval.toolName,
              title: approval.reason,
              summary: approval.argsSummary,
              riskLevel: approval.riskLevel,
            },
          },
        ],
      })
    }
    for (const input of this.agentInputService?.list({ status: 'pending', threadId }) ?? []) {
      if (input.taskId) continue
      surfaces.push({
        surfaceId: `conversation-input:${input.id}` as import('@infos/shared').SurfaceId,
        generation: `conversation-input:${input.id}`,
        threadId,
        principalId: input.agentId,
        revision: 1,
        sequence: 0,
        state: 'committed',
        nodes: [
          {
            nodeId: `conversation-input:${input.id}:input` as import('@infos/shared').SurfaceNodeId,
            kind: 'input',
            lifecycle: 'interactive',
            revision: 1,
            props: {
              inputId: input.id,
              inputKind: 'agent_question',
              principalId: input.agentId,
              title: __t('server.projections', '想问问你'),
              question: input.question,
              questions: input.questions,
              context:
                input.context || input.responseMessage
                  ? { message: [input.context, input.responseMessage].filter(Boolean).join('\n') }
                  : null,
              options: input.options,
              allowFreeText: input.allowFreeText,
              required: input.required,
              actions: input.required
                ? [
                    {
                      id: 'answer',
                      label: __t('server.projections', '回答并继续'),
                      tone: 'primary',
                    },
                  ]
                : [
                    { id: 'skip', label: __t('server.projections', '暂时跳过'), tone: 'neutral' },
                    {
                      id: 'answer',
                      label: __t('server.projections', '回答并继续'),
                      tone: 'primary',
                    },
                  ],
            },
          },
        ],
      })
    }
    const snapshot: ConversationProjectionSnapshot = {
      threadGeneration: thread.generation,
      protocolVersion: 1,
      threadId,
      principalId: thread.agentId,
      revision: ordered.reduce(
        (revision, message) => revision + message.id,
        result.total + executions.filter((execution) => execution.completedAt !== null).length,
      ),
      generatedAt: new Date().toISOString(),
      messages,
      surfaces,
      totalMessages: result.total,
      deletedMessageIds: thread.threadKind === 'main' ? this.threadService.getDeletedMessageIds(threadId).map(String) : undefined,
      pageSize,
      hasMoreBefore: result.hasMoreBefore,
      beforeCursor: ordered[0] ? String(ordered[0].id) : undefined,
    }
    await this.threadService.assertGeneration(threadId, thread.generation)
    if (useCache) this.cache.set(threadId, { snapshot, dirty: false, stamp })
    return snapshot
  }

  invalidate(threadId: string): void {
    const cached = this.cache.get(threadId)
    if (cached) cached.dirty = true
  }

  private parseSpokenReply(metadataJson: string): string | undefined {
    try {
      const value = (JSON.parse(metadataJson) as { spokenReply?: unknown }).spokenReply
      return typeof value === 'string' && value.length <= 240 ? value : undefined
    } catch {
      return undefined
    }
  }

  private parseExecutionPause(
    metadataJson: string,
  ): ConversationMessageProjection['executionPause'] {
    try {
      const value = JSON.parse(metadataJson).executionPause
      if (
        value?.kind !== 'desktop' ||
        !['code', 'message', 'toolName', 'callId', 'pausedAt'].every(
          (key) => typeof value[key] === 'string',
        )
      )
        return undefined
      return {
        kind: 'desktop',
        code: value.code,
        message: value.message,
        toolName: value.toolName,
        callId: value.callId,
        pausedAt: value.pausedAt,
      }
    } catch {
      return undefined
    }
  }

  private isImageTranscription(metadataJson: string): boolean {
    try {
      return (JSON.parse(metadataJson) as { kind?: string }).kind === 'image_transcription'
    } catch {
      return false
    }
  }

  private parseSourceMessages(metadataJson: string): import('@infos/shared').ConversationSource[] | undefined {
    try {
      const value = JSON.parse(metadataJson).sourceMessages
      return Array.isArray(value) ? value.filter((source) => source &&
        Number.isSafeInteger(source.messageId) && source.messageId > 0 &&
        Number.isSafeInteger(source.revision) && source.revision > 0) : undefined
    } catch {
      return undefined
    }
  }

  private parseFailureMessage(metadataJson: string): string | undefined {
    try {
        const parsed = JSON.parse(metadataJson) as { failure?: { message?: unknown }; failureMessage?: string }
        return typeof parsed.failure?.message === 'string' ? parsed.failure.message : parsed.failureMessage
    } catch {
      return undefined
    }
  }

  private parseOutputTokens(metadataJson: string): number | undefined {
    try {
      const parsed = JSON.parse(metadataJson) as { tokenUsage?: { outputTokens?: unknown } }
      const value = parsed.tokenUsage?.outputTokens
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  private parseGenerationStats(
    metadataJson: string,
  ): ConversationMessageProjection['generationStats'] {
    try {
      const value = JSON.parse(metadataJson).generationStats
      if (
        !value ||
        !Number.isSafeInteger(value.outputTokens) ||
        value.outputTokens < 0 ||
        !Number.isFinite(value.modelDurationMs) ||
        value.modelDurationMs < 0 ||
        !Number.isSafeInteger(value.modelCalls) ||
        value.modelCalls < 1 ||
        typeof value.estimated !== 'boolean'
      )
        return undefined
      return {
        outputTokens: value.outputTokens,
        modelDurationMs: value.modelDurationMs,
        modelCalls: value.modelCalls,
        estimated: value.estimated,
      }
    } catch {
      return undefined
    }
  }

  private parseContentBlocks(metadataJson: string): ConversationMessageProjection['contentBlocks'] {
    try {
      const parsed = JSON.parse(metadataJson) as { contentBlocks?: unknown }
      if (!Array.isArray(parsed.contentBlocks)) return []
      const blocks: ConversationMessageProjection['contentBlocks'] = []
      for (const value of parsed.contentBlocks) {
        if (!value || typeof value !== 'object') continue
        const item = value as Record<string, unknown>
        const blockId = typeof item.blockId === 'string' ? item.blockId : ''
        const sequence = typeof item.sequence === 'number' ? item.sequence : 0
        const turn = typeof item.turn === 'number' ? item.turn : 0
        if (!blockId) continue
        if (item.kind === 'model_retry' && item.retry && typeof item.retry === 'object') {
          const retry = item.retry as Record<string, unknown>
          if (
            typeof retry.retryId !== 'string' ||
            typeof retry.reason !== 'string' ||
            !['waiting', 'retrying', 'recovered', 'failed', 'cancelled'].includes(
              String(retry.state),
            ) ||
            !['attempt', 'maxRetries', 'delayMs', 'startedAt', 'updatedAt'].every(
              (key) => typeof retry[key] === 'number' && Number.isFinite(retry[key]),
            )
          )
            continue
          blocks.push({
            blockId,
            sequence,
            turn,
            kind: 'model_retry',
            retry: {
              retryId: retry.retryId,
              state: retry.state as import('@infos/shared').ModelRetryInfo['state'],
              attempt: retry.attempt as number,
              maxRetries: retry.maxRetries as number,
              delayMs: retry.delayMs as number,
              reason: retry.reason,
              startedAt: retry.startedAt as number,
              updatedAt: retry.updatedAt as number,
              partialResponse: retry.partialResponse === true,
            },
          })
          continue
        }
        if (item.kind === 'thinking' && typeof item.content === 'string') {
          blocks.push({
            blockId,
            sequence,
            turn,
            kind: 'thinking',
            content: item.content,
            durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
          })
          continue
        }
        if (item.kind === 'native_reasoning' && typeof item.content === 'string') {
          blocks.push({
            blockId,
            sequence,
            turn,
            kind: 'native_reasoning',
            content: item.content,
            mode: item.mode === 'non_stream' ? 'non_stream' : 'stream',
            durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
          })
          continue
        }
        if (item.kind === 'narration' && typeof item.content === 'string') {
          blocks.push({
            blockId,
            sequence,
            turn,
            kind: 'narration',
            phase: item.phase === 'progress' ? 'progress' : 'final',
            content: item.content,
          })
          continue
        }
        if (
          item.kind !== 'tool' ||
          typeof item.callId !== 'string' ||
          typeof item.name !== 'string'
        )
          continue
        blocks.push({
          blockId,
          sequence,
          turn,
          kind: 'tool',
          callId: item.callId,
          parentCallId: typeof item.parentCallId === 'string' ? item.parentCallId : undefined,
          name: item.name,
          args: typeof item.args === 'string' ? item.args : JSON.stringify(item.args ?? {}),
          result: typeof item.result === 'string' ? item.result : undefined,
          automaticApproval: parseAutomaticApproval(item.automaticApproval),
          isError: typeof item.isError === 'boolean' ? item.isError : undefined,
          durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
        })
      }
      return blocks.sort((left, right) => left.sequence - right.sequence)
    } catch {
      return []
    }
  }

  private parseToolCalls(metadataJson: string): ConversationMessageProjection['toolCalls'] {
    try {
      const parsed = JSON.parse(metadataJson) as { toolCalls?: Array<Record<string, unknown>> }
      if (!Array.isArray(parsed.toolCalls)) return []
      return parsed.toolCalls
        .filter((item) => typeof item.name === 'string')
        .map((item) => ({
          callId: typeof item.callId === 'string' ? item.callId : undefined,
          parentCallId: typeof item.parentCallId === 'string' ? item.parentCallId : undefined,
          name: item.name as string,
          args: typeof item.args === 'string' ? item.args : JSON.stringify(item.args ?? {}),
          result: typeof item.result === 'string' ? item.result : undefined,
          automaticApproval: parseAutomaticApproval(item.automaticApproval),
          isError: typeof item.isError === 'boolean' ? item.isError : undefined,
          durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
        }))
    } catch {
      return []
    }
  }
}
