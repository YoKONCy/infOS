import { t as __t } from '../../lib/i18n'
import type { EventNote, EventNoteRelation, MemoryBackgroundPolicy } from '@infos/shared'
import { MemoryBackgroundControl } from './memoryBackgroundControl'
import { MemoryAgentScope } from './memoryAgentScope'
import type { EventMemoryService } from './eventMemoryService'
import type { EventNoteRepository } from '../../repositories/eventNote.repo'
import type { MemoryStoreRegistry } from '../../repositories/storeRegistry'
import { createLogger } from '../../lib/logger'
import { MemoryForgottenError } from '../maintenance/privacyPolicy'

const logger = createLogger('EventReflectionService')

export interface ReflectionDecision {
  links: Array<{
    targetId: string
    relation: Extract<EventNoteRelation, 'caused_by' | 'same_event' | 'same_topic'>
    weight?: number
  }>
  removeLinks: Array<{
    targetId: string
    relation: Extract<EventNoteRelation, 'caused_by' | 'same_event' | 'same_topic'>
  }>
  archive: boolean
  revision?: Partial<
    Pick<
      EventNote,
      'narrative' | 'importance' | 'affect' | 'participants' | 'places' | 'objects' | 'topics'
    >
  >
  archiveOverlaps?: string[]
}

export interface EventReflectionModel {
  reflect(input: {
    event: EventNote
    candidates: EventNote[]
    signal?: AbortSignal
  }): Promise<ReflectionDecision>
}

export interface EventReflectionOptions {
  agents?: MemoryAgentScope
  background?: MemoryBackgroundPolicy
  canMaintain?: () => boolean
  temporalCandidates?: number
  entityTerms?: number
  entityCandidates?: number
  mixedCandidates?: number
  vectorCandidates?: number
  maxCandidates?: number
  now?: () => Date
}

export class EventReflectionService {
  private running = false
  private deletionController = new AbortController()
  private readonly options: Required<EventReflectionOptions>

  constructor(
    private eventMemory: EventMemoryService,
    private stores: MemoryStoreRegistry,
    private model: EventReflectionModel,
    private repo: EventNoteRepository,
    options: EventReflectionOptions = {},
  ) {
    this.options = {
      agents: options.agents ?? new MemoryAgentScope(),
      background: options.background ?? new MemoryBackgroundControl(),
      canMaintain: options.canMaintain ?? (() => true),
      temporalCandidates: options.temporalCandidates ?? 3,
      entityTerms: options.entityTerms ?? 10,
      entityCandidates: options.entityCandidates ?? 10,
      mixedCandidates: options.mixedCandidates ?? 10,
      vectorCandidates: options.vectorCandidates ?? 10,
      maxCandidates: options.maxCandidates ?? 24,
      now: options.now ?? (() => new Date()),
    }
  }

  /** 删除开始后取消旧上下文；尚存事件的任务由后续调度重新读取最新数据。 */
  invalidateForDeletion(): void {
    this.deletionController.abort(new Error('记忆已清理，已取消旧关系维护'))
    this.deletionController = new AbortController()
  }

  async enqueue(agentId: string, eventId: string): Promise<void> {
    if (
      !this.options.agents.isAvailable(agentId) ||
      !this.options.background.enabled ||
      !this.options.canMaintain()
    )
      return
    await this.repo.enqueueReflectionTask({
      id: `reflection:${agentId}:${eventId}`,
      agentId,
      eventId,
    })
  }

  async enqueueDailyBackfill(): Promise<number> {
    if (!this.options.background.enabled || !this.options.canMaintain()) return 0
    return this.repo.enqueueMissingReflectionTasks((id) => this.options.agents.isAvailable(id))
  }

  async drain(): Promise<void> {
    if (this.running || !this.options.background.enabled || !this.options.canMaintain()) return
    const signal = AbortSignal.any([this.options.background.signal, this.deletionController.signal])
    this.running = true
    try {
      const tasks = await this.repo.pendingReflectionTasks(100, this.options.now())
      for (const task of tasks) {
        if (signal.aborted) return
        if (!this.options.agents.isAvailable(task.agentId)) {
          await this.repo.discardReflectionDecision(task.agentId, task.eventId)
          await this.repo.completeReflectionTask(task.id)
          continue
        }
        const agentSignal = this.options.agents.signal(task.agentId)
        try {
          await this.reflect(task.agentId, task.eventId)
          if (signal.aborted) return
          await this.repo.completeReflectionTask(task.id)
        } catch (error) {
          if (signal.aborted) return
          if (agentSignal.aborted || !this.options.agents.isAvailable(task.agentId)) {
            await this.repo.discardReflectionDecision(task.agentId, task.eventId)
            await this.repo.completeReflectionTask(task.id)
            continue
          }
          if (error instanceof MemoryForgottenError) {
            await this.repo.discardReflectionDecision(task.agentId, task.eventId)
            const current = await this.repo.findById(task.eventId)
            if (!current || this.repo.isMemoryForgotten(current))
              await this.repo.completeReflectionTask(task.id)
            else await this.repo.retryReflectionTask(task.id)
            continue
          }
          await this.repo.failReflectionTask(task.id, String(error))
          logger.warn(__t('logs.memory', '事件关系维护失败，已记录重试退避'), {
            taskId: task.id,
            error,
          })
        }
      }
    } finally {
      this.running = false
    }
  }

  async reflect(agentId: string, eventId: string): Promise<void> {
    if (
      !this.options.agents.isAvailable(agentId) ||
      !this.options.background.enabled ||
      !this.options.canMaintain()
    )
      return
    const signal = AbortSignal.any([
      this.options.background.signal,
      this.deletionController.signal,
      this.options.agents.signal(agentId),
    ])
    const decisionId = `reflection:decision:${agentId}:${eventId}`
    const current = await this.repo.findById(eventId)
    signal.throwIfAborted()
    if (!current || this.repo.isMemoryForgotten(current)) {
      await this.repo.discardReflectionDecision(agentId, eventId)
      return
    }
    const saved = await this.repo.findOperation(decisionId)
    if (saved?.status === 'committed') return
    // 决策先持久化，修订之后即使中断，也能继续原来的关系操作，不再调用模型。
    const pending = saved?.payload as
      | {
          event: EventNote
          candidates: EventNote[]
          decision: ReflectionDecision
        }
      | undefined
    // 旧决策不能让已删除事件继续存活；修订产生的旧版本仍允许接续原事务。
    const event = this.snapshot(pending?.event ?? current)
    if (!event || event.agentId !== agentId || event.status !== 'active') return
    if (this.repo.isMemoryForgotten(event)) {
      await this.repo.discardReflectionDecision(agentId, eventId)
      return this.reflect(agentId, eventId)
    }
    const snapshots = pending?.candidates ?? (await this.collectCandidates(event))
    const candidates = (
      await Promise.all(snapshots.map((candidate) => this.repo.findById(candidate.id)))
    ).filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(
        candidate &&
        candidate.agentId === agentId &&
        !candidate.replacedBy &&
        !this.repo.isMemoryForgotten(candidate),
      ),
    )
    signal.throwIfAborted()
    if (pending && candidates.length !== snapshots.length) {
      // 旧修订正文也可能吸收已遗忘候选的信息，不能只过滤关系 ID 后继续重放。
      await this.repo.discardReflectionDecision(agentId, eventId)
      return this.reflect(agentId, eventId)
    }
    const decision = pending?.decision ?? (await this.model.reflect({ event, candidates, signal }))
    signal.throwIfAborted()
    // 即使模型忽略取消信号，也不能在事件或候选消失后持久化其旧快照。
    const afterModel = await this.repo.findById(eventId)
    if (
      !afterModel ||
      this.repo.isMemoryForgotten(afterModel) ||
      (!pending && (afterModel.status !== 'active' || afterModel.replacedBy))
    ) {
      await this.repo.discardReflectionDecision(agentId, eventId)
      return
    }
    const survivingCandidates = (
      await Promise.all(candidates.map((candidate) => this.repo.findById(candidate.id)))
    ).filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(
        candidate &&
        candidate.agentId === agentId &&
        !candidate.replacedBy &&
        !this.repo.isMemoryForgotten(candidate),
      ),
    )
    signal.throwIfAborted()
    if (survivingCandidates.length !== candidates.length) {
      await this.repo.discardReflectionDecision(agentId, eventId)
      return this.reflect(agentId, eventId)
    }
    const candidateIds = new Set(survivingCandidates.map((candidate) => candidate.id))
    const currentDecision: ReflectionDecision = {
      ...decision,
      links: decision.links.filter((link) => candidateIds.has(link.targetId)),
      removeLinks: decision.removeLinks.filter((link) => candidateIds.has(link.targetId)),
      archiveOverlaps: decision.archiveOverlaps?.filter((id) => candidateIds.has(id)),
    }
    if (!saved)
      await this.repo.createOperation(decisionId, agentId, 'reflection_decision', {
        event: this.snapshot(event),
        candidates: survivingCandidates.map((candidate) => this.snapshot(candidate)),
        decision: currentDecision,
      })
    signal.throwIfAborted()
    let maintainedEvent: EventNote = event
    if (decision.revision) {
      maintainedEvent = await this.eventMemory.revise(
        event.id,
        {
          narrative: decision.revision.narrative ?? event.narrative,
          importance: decision.revision.importance ?? event.importance,
          affect: decision.revision.affect ?? event.affect,
          participants: decision.revision.participants ?? event.participants,
          places: decision.revision.places ?? event.places,
          objects: decision.revision.objects ?? event.objects,
          topics: decision.revision.topics ?? event.topics,
          agentId: event.agentId,
          eventAt: event.eventAt,
          origin: event.origin,
        },
        `reflection:revise:${event.id}`,
        { maintenance: true, signal },
      )
    }
    for (const link of decision.removeLinks) {
      signal.throwIfAborted()
      if (candidateIds.has(link.targetId)) {
        await this.eventMemory.removeRelation(
          maintainedEvent.id,
          link.targetId,
          link.relation,
          `reflection:unlink:${maintainedEvent.id}:${link.relation}:${link.targetId}`,
        )
      }
    }
    for (const link of decision.links) {
      signal.throwIfAborted()
      if (candidateIds.has(link.targetId) && link.targetId !== maintainedEvent.id) {
        await this.eventMemory.addRelation(
          maintainedEvent.id,
          link.targetId,
          link.relation,
          link.weight ?? 1,
          `reflection:link:${maintainedEvent.id}:${link.relation}:${link.targetId}`,
        )
      }
    }
    for (const targetId of new Set(decision.archiveOverlaps ?? [])) {
      signal.throwIfAborted()
      if (!candidateIds.has(targetId)) continue
      await this.eventMemory.addRelation(
        maintainedEvent.id,
        targetId,
        'same_event',
        1,
        `reflection:overlap-link:${maintainedEvent.id}:${targetId}`,
      )
      await this.eventMemory.archive(
        targetId,
        `reflection:overlap-archive:${maintainedEvent.id}:${targetId}`,
      )
    }
    signal.throwIfAborted()
    if (decision.archive)
      await this.eventMemory.archive(maintainedEvent.id, `reflection:archive:${maintainedEvent.id}`)
    signal.throwIfAborted()
    if (maintainedEvent.id !== event.id) {
      const replacementTaskId = `reflection:${agentId}:${maintainedEvent.id}`
      await this.repo.enqueueReflectionTask({
        id: replacementTaskId,
        agentId,
        eventId: maintainedEvent.id,
      })
      await this.repo.completeReflectionTask(replacementTaskId)
    }
    await this.repo.markOperationCommitted(decisionId)
  }

  /** 不把详情页的前后事件或图谱邻居夹带进持久决策。 */
  private snapshot(note: EventNote): EventNote {
    return {
      id: note.id,
      agentId: note.agentId,
      narrative: note.narrative,
      eventAt: note.eventAt,
      createdAt: note.createdAt,
      importance: note.importance,
      affect: note.affect,
      participants: note.participants,
      places: note.places,
      objects: note.objects,
      topics: note.topics,
      origin: note.origin,
      status: note.status,
    }
  }

  validateAndRepair(agentId: string): { valid: boolean; repaired: boolean } {
    if (
      !this.options.agents.isAvailable(agentId) ||
      !this.options.background.enabled ||
      !this.options.canMaintain()
    )
      return { valid: true, repaired: false }
    const store = this.stores.getAgentStore(agentId, 'main')
    const report = store.validateGraph()
    if (report.valid) return { valid: true, repaired: false }
    store.repairGraphIndexes()
    return { valid: store.validateGraph().valid, repaired: true }
  }

  private async collectCandidates(event: EventNote): Promise<EventNote[]> {
    const timeline = await this.eventMemory.query({
      agentId: event.agentId,
      mode: 'recent',
      includeArchived: true,
      limit: 100,
    })
    const ordered = [...timeline].sort(
      (a, b) => a.eventAt.localeCompare(b.eventAt) || a.id.localeCompare(b.id),
    )
    const position = ordered.findIndex((note) => note.id === event.id)
    const temporalCount = this.options.temporalCandidates
    const before = Math.floor(temporalCount / 2)
    const temporal =
      position < 0
        ? []
        : ordered.slice(
            Math.max(0, position - before),
            Math.min(ordered.length, position + 1 + (temporalCount - before)),
          )
    const entityTerms = [...event.participants, ...event.places, ...event.objects, ...event.topics]
    const entityGroups = await Promise.all(
      entityTerms.slice(0, this.options.entityTerms).map((query) =>
        this.eventMemory.query({
          agentId: event.agentId,
          query,
          mode: 'entity',
          includeArchived: true,
          limit: this.options.entityCandidates,
        }),
      ),
    )
    const mixed = await this.eventMemory.query({
      agentId: event.agentId,
      query: event.narrative,
      mode: 'mixed',
      includeArchived: true,
      limit: this.options.mixedCandidates,
    })
    const vector = await this.eventMemory.query({
      agentId: event.agentId,
      query: event.narrative,
      mode: 'semantic',
      includeArchived: true,
      limit: this.options.vectorCandidates,
    })
    const merged = [...temporal, ...entityGroups.flat(), ...mixed, ...vector]
    return [
      ...new Map(
        merged.filter((note) => note.id !== event.id).map((note) => [note.id, note]),
      ).values(),
    ].slice(0, this.options.maxCandidates)
  }
}
