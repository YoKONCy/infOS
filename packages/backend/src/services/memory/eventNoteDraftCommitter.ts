import type { EventNoteDraftInput } from '@infos/shared'
import { conversationSourceKey } from '@infos/shared'
import { MemoryForgottenError } from '../maintenance/privacyPolicy'
import type { ToolCallRecord } from '../pipeline/types'
import type { ThreadRepository } from '../../repositories/thread.repo'
import { MemorySourceStaleError, type EventNoteRepository } from '../../repositories/eventNote.repo'
import type { EventMemoryService } from './eventMemoryService'
import { validateEventNoteNarrative } from './eventNoteNarrative'

interface DraftEnvelope {
  action: 'write' | 'revise'
  targetId?: string
  draft: EventNoteDraftInput
}

interface DraftCommitInput {
  toolCalls: ToolCallRecord[]
  agentId: string
  threadId: string
  pairId: string
  channel: string
  assistantMessageId: number
  assistantTimestamp: string | number | Date
  sceneRoomId?: string
  expectedGeneration?: number
  sourceRevisions?: Record<string, number>
  assistantRevision?: number
}

export class EventNoteDraftCommitter {
  private pending = new Map<string, Promise<void>>()
  constructor(
    private eventMemory: EventMemoryService,
    private eventRepo: EventNoteRepository,
    private threads: ThreadRepository,
  ) {}

  commit(params: DraftCommitInput): Promise<void> {
    const key = `${params.channel}:${params.agentId}:${params.assistantMessageId}`
    const existing = this.pending.get(key)
    if (existing) return existing
    const operation = this.commitOnce(params).finally(() => this.pending.delete(key))
    this.pending.set(key, operation)
    return operation
  }

  /** 消息事实和 Outbox 同事务落盘，重启后按稳定操作编号补齐显式记事。 */
  async consumeMessage(messageId: number, scene: boolean): Promise<void> {
    const source = await this.threads.memoryDraftMessage(messageId, scene)
    if (!source || !Array.isArray(source.metadata.toolCalls) || typeof source.metadata.threadGeneration !== 'number') return
    if (source.revision !== 1) return
    if (!scene && source.metadata.inputPersistence === 'ephemeral' && !source.metadata.proactive) return
    const thread = await this.threads.getThread(source.threadId)
    if (!thread || thread.agentId !== source.agentId || thread.generation !== source.metadata.threadGeneration) return
    try {
      await this.commit({ toolCalls: source.metadata.toolCalls as ToolCallRecord[],
        agentId: source.agentId, threadId: source.threadId, pairId: source.pairId,
        channel: scene ? 'group' : thread.channel, sceneRoomId: source.sceneRoomId,
        assistantMessageId: messageId, assistantTimestamp: source.timestamp ?? new Date(), expectedGeneration: thread.generation,
        sourceRevisions: source.metadata.memorySourceRevisions as Record<string, number> | undefined,
        assistantRevision: 1,
      })
    } catch (error) {
      if (error instanceof MemoryForgottenError || error instanceof MemorySourceStaleError) return
      const current = await this.threads.getThread(source.threadId)
      if (!current || current.status !== 'active' || current.generation !== source.metadata.threadGeneration) return
      throw error
    }
  }

  async consumeExecution(id: string): Promise<void> {
    const execution = this.threads.conversations.get(id)
    if (!execution || !['completed', 'waiting', 'paused'].includes(execution.status)) return
    const thread = await this.threads.getThread(execution.threadId)
    if (!thread || thread.generation !== execution.generation) return
    const metadata = JSON.parse(execution.metadataJson)
    const sources = JSON.parse(execution.inputSourcesJson) as import('@infos/shared').ConversationSource[]
    const output = this.threads.conversations.publications(id).at(-1)
    const anchor = output?.id ?? sources.at(-1)?.messageId
    if (!anchor) return
    const publicationSources = (metadata.publicationRevisions ?? []) as import('@infos/shared').ConversationSource[]
    try {
      await this.commit({
        agentId: execution.agentId, threadId: execution.threadId, pairId: id, channel: thread.channel,
        toolCalls: metadata.toolCalls ?? [], assistantMessageId: anchor,
        assistantRevision: output?.revision ?? sources.at(-1)?.revision ?? 1,
        assistantTimestamp: output?.timestamp ?? execution.completedAt ?? execution.startedAt,
        expectedGeneration: execution.generation,
        sourceRevisions: Object.fromEntries([...sources, ...publicationSources].map((source) => [String(source.messageId), source.revision])),
      })
    } catch (error) {
      if (error instanceof MemorySourceStaleError || error instanceof MemoryForgottenError) return
      throw error
    }
  }

  private async commitOnce(params: DraftCommitInput): Promise<void> {
    const drafts = params.toolCalls.flatMap((call) => this.parseDraft(call))
    for (const [index, envelope] of drafts.entries()) {
      const operationId = `event-note:${params.agentId}:${params.threadId}:${params.pairId}:${envelope.action}:${envelope.targetId ?? 'new'}:${index}`
      const existing = await this.eventRepo.findOperation(operationId)
      if (params.expectedGeneration !== undefined)
        await this.threads.assertGeneration(params.threadId, params.expectedGeneration)
      const experiences = params.sceneRoomId
        ? await this.sceneSources(params, envelope.draft.scope)
        : []
      const pairIds = params.sceneRoomId ? experiences.map((item) => `experience:${item.id}`) : await this.resolvePairIds(
        params.agentId,
        params.threadId,
        params.pairId,
        envelope.draft.scope ?? 'current_execution',
      )
      if (!pairIds.length) throw new MemorySourceStaleError()
      if (existing?.status === 'committed') {
        const covered = await this.eventRepo.coveredPairIds(params.agentId, params.threadId)
        if (pairIds.every((id) => covered.has(id))) continue
      }
      const ownerId = `active:${params.channel}:${params.agentId}:${params.threadId}:${params.assistantMessageId}:${index}`
      const claimed = await this.eventRepo.claimCoverageRange({
        agentId: params.agentId,
        threadId: params.threadId,
        pairIds,
        ownerId,
        staleBefore: new Date(Date.now() - 30 * 60_000).toISOString(),
        allowCovered: true,
      })
      if (!claimed) throw new Error(`事件覆盖范围已被处理或占用: ${pairIds.join(',')}`)
      const messages = params.sceneRoomId ? [] : await this.threads.findMessagesByPairIds(params.threadId, pairIds)
      if (!params.sceneRoomId && messages.some((message) => message.id === params.assistantMessageId &&
        message.revision !== (params.assistantRevision ?? 1))) throw new MemorySourceStaleError()
      const messageIds = messages.map((message) => String(message.id))
      if (!params.sceneRoomId && !messageIds.includes(String(params.assistantMessageId)))
        messageIds.push(String(params.assistantMessageId))
      const input = {
        ...envelope.draft,
        agentId: params.agentId,
        eventAt: new Date(params.assistantTimestamp).toISOString(),
        origin: {
          mode: 'active' as const,
          threadId: params.threadId,
          pairIds,
          messageIds,
          channel: params.channel,
          experienceIds: experiences.map((item) => String(item.id)),
          generation: params.expectedGeneration,
          messageRevisions: {
            ...Object.fromEntries(messages.map((message) => [String(message.id), message.revision ?? 1])),
            ...params.sourceRevisions,
          },
        },
      }
      try {
        if (envelope.action === 'revise') {
          if (!envelope.targetId) throw new Error('修订事件必须指定目标EventNote ID')
          await this.eventMemory.revise(envelope.targetId, input, operationId, {
            coverageOwnerId: ownerId,
          })
        } else {
          await this.eventMemory.create(input, operationId, { coverageOwnerId: ownerId })
        }
      } finally {
        await this.eventRepo.releaseCoverageClaim(ownerId)
      }
    }
  }

  private parseDraft(call: ToolCallRecord): DraftEnvelope[] {
    if (call.isError) return []
    if (call.name === 'write_event_note') {
      return [{ action: 'write', draft: this.validateDraft(call.args) }]
    }
    if (call.name === 'revise_event_note') {
      const { targetId, ...draft } = call.args
      if (typeof targetId !== 'string' || !targetId.trim()) {
        throw new Error('修订事件必须指定目标EventNote ID')
      }
      return [{ action: 'revise', targetId, draft: this.validateDraft(draft) }]
    }
    return []
  }

  private async sceneSources(params: DraftCommitInput, scope: EventNoteDraftInput['scope']) {
    const current = () => this.threads.queryExperiences(params.threadId, 0, undefined, {
      roomId: params.sceneRoomId, pairId: params.pairId, throughMessageId: params.assistantMessageId,
    })
    if (scope !== 'current_uncovered_segment' && scope !== 'uncovered_sources') return current()
    const available = await this.threads.queryExperiences(params.threadId, 500, undefined, { throughMessageId: params.assistantMessageId })
    const covered = await this.eventRepo.coveredPairIds(params.agentId, params.threadId)
    const selected: typeof available = []
    for (let index = available.length - 1; index >= 0; index--) {
      const experience = available[index]!
      if (covered.has(`experience:${experience.id}`)) break
      selected.unshift(experience)
    }
    return selected.length ? selected : current()
  }

  private validateDraft(value: Record<string, unknown>): EventNoteDraftInput {
    const narrative = validateEventNoteNarrative(value.narrative)
    const importance = value.importance
    const affect = value.affect
    if (!Number.isInteger(importance) || Number(importance) < 0 || Number(importance) > 10) {
      throw new Error('事件重要度必须是0到10的整数')
    }
    if (!affect || typeof affect !== 'object') throw new Error('事件情感信息不能为空')
    const affectValue = affect as Record<string, unknown>
    const valence = affectValue.valence
    const arousal = affectValue.arousal
    if (!Number.isInteger(valence) || Number(valence) < 0 || Number(valence) > 10) {
      throw new Error('情感效价必须是0到10的整数')
    }
    if (!Number.isInteger(arousal) || Number(arousal) < 0 || Number(arousal) > 10) {
      throw new Error('情感唤醒度必须是0到10的整数')
    }
    const scope = value.scope ?? 'current_execution'
    if (!['current_execution', 'uncovered_sources', 'current_pair', 'current_uncovered_segment'].includes(String(scope))) {
      throw new Error('事件覆盖范围无效')
    }
    const strings = (input: unknown): string[] =>
      Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
    return {
      narrative,
      importance: Number(importance),
      affect: {
        tones: strings(affectValue.tones),
        valence: Number(valence),
        arousal: Number(arousal),
      },
      participants: strings(value.participants),
      places: strings(value.places),
      objects: strings(value.objects),
      topics: strings(value.topics),
      scope: scope as EventNoteDraftInput['scope'],
    }
  }

  private async resolvePairIds(
    agentId: string,
    threadId: string,
    currentPairId: string,
    scope: EventNoteDraftInput['scope'],
  ): Promise<string[]> {
    const thread = await this.threads.getThread(threadId)
    const continuousExecution = this.threads.conversations.get(currentPairId)
    if (thread?.threadKind === 'main' && continuousExecution) {
      const execution = continuousExecution
      if (!execution || ['revoked', 'reset', 'failed', 'interrupted'].includes(execution.status)) return []
      const inputs = JSON.parse(execution.inputSourcesJson) as import('@infos/shared').ConversationSource[]
      const output = this.threads.conversations.publications(currentPairId)
      const keys = [...inputs.map((source) => `message:${source.messageId}@${source.revision}`), ...output.map(conversationSourceKey)]
      if (scope !== 'uncovered_sources' && scope !== 'current_uncovered_segment') return [...new Set(keys)]
      const through = Math.max(0, ...inputs.map((source) => source.messageId), ...output.map((message) => message.id))
      const messages = await this.threads.queryMemoryMessagesThrough(threadId, through)
      const covered = await this.eventRepo.coveredPairIds(agentId, threadId)
      return messages.map((message) => message.pairId!).filter((key) => !covered.has(key))
    }
    if (scope !== 'current_uncovered_segment' && scope !== 'uncovered_sources') return [currentPairId]
    const covered = await this.eventRepo.coveredPairIds(agentId, threadId)
    const messages = await this.threads.queryActiveMessagePairs(threadId, 500)
    const ordered = [
      ...new Set(
        messages.map((message) => message.pairId).filter((id): id is string => Boolean(id)),
      ),
    ]
    const currentIndex = ordered.indexOf(currentPairId)
    if (currentIndex < 0) return [currentPairId]
    const segment: string[] = []
    for (let index = currentIndex; index >= 0; index--) {
      const pairId = ordered[index]!
      if (covered.has(pairId)) break
      segment.unshift(pairId)
    }
    return segment.length ? segment : [currentPairId]
  }
}
