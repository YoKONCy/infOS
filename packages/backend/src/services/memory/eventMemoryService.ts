import { t as __t } from '../../lib/i18n'
import { randomUUID } from 'node:crypto'
import type {
  ConversationCoverage,
  EventNote,
  EventNoteArchiveFilter,
  EventNoteArchiveResult,
  EventNoteDetail,
  EventNoteDraftInput,
  EventNoteManualEditInput,
  EventNoteQuery,
  EventNoteQueryPath,
  EventNoteQueryResult,
  EventNoteRelation,
  EventNoteRelationView,
  EventMemoryGraphSnapshot,
} from '@infos/shared'
import type { TransactionOperation } from 'triviumdb'
import type { EmbeddingService } from '../embedding/embeddingService'
import type { ContextRnnRuntime } from '../retrieval/contextRnnRuntime'
import { isContextRnnFeedbackEnabled, type MemoryRuntimeConfig } from './memoryRuntimeConfig'
import type { MemoryStoreRegistry } from '../../repositories/storeRegistry'
import {
  EventNoteRepository,
  type StoredEventNote,
  type ManualEventRevision,
} from '../../repositories/eventNote.repo'
import { createLogger } from '../../lib/logger'
import { tokenCounter } from '../tokenizer/tokenCounter'
import type { PrivacyPolicy } from '../maintenance/privacyPolicy'

const logger = createLogger('EventMemoryService')
const SYMMETRIC_RELATIONS = new Set<EventNoteRelation>(['same_event', 'same_topic'])

interface TdbEventPayload extends EventNote {
  kind: 'event_note'
  operationId: string
}

interface TdbEntityPayload {
  kind: 'event_entity'
  id: string
  entityType: 'person' | 'place' | 'object'
  name: string
}

type TdbMemoryPayload = TdbEventPayload | TdbEntityPayload

interface CreateEventInput extends EventNoteDraftInput {
  agentId: string
  eventAt: string
  origin: EventNote['origin']
}

interface EventWriteOptions {
  signal?: AbortSignal
  coverageOwnerId?: string
  deferCoverage?: boolean
  maintenance?: boolean
}

export interface AutomaticRagProgress {
  stage: 'embedding' | 'retrieval' | 'reranking' | 'timeline' | 'completed'
  status?: 'running' | 'completed' | 'failed'
  failureKind?: 'embedding' | 'rag'
  message: string
  candidateCount?: number
  resultCount?: number
}

export class AutomaticRagStageError extends Error {
  constructor(
    readonly failureKind: 'embedding' | 'rag',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AutomaticRagStageError'
  }
}

export interface AutomaticRagTrace {
  agentId: string
  channel: string
  query: string
  queryEmbedding: number[]
  notes: EventNote[]
  contextBias?: Float32Array
  rnnGeneration?: number
}

export class EventMemoryService {
  private packageHooks?: import('../../packages/packageAgentFlow').PackageFlowEmitter
  setPackageHooks(hooks: import('../../packages/packageAgentFlow').PackageFlowEmitter): void {
    this.packageHooks = hooks
  }
  private manualEdits = new Map<string, Promise<EventNote>>()
  private background?: import('@infos/shared').MemoryBackgroundPolicy
  setBackgroundPolicy(policy: import('@infos/shared').MemoryBackgroundPolicy): void {
    this.background = policy
  }
  private privacy?: PrivacyPolicy
  private retrievalRevision = 0
  setPrivacyPolicy(policy: PrivacyPolicy): void {
    this.privacy = policy
  }
  invalidateForDeletion(): void {
    this.retrievalRevision++
    this.automaticRagTraces.clear()
    this.contextRnnRuntime?.invalidate()
  }
  async restore(id: string): Promise<void> {
    const note = await this.repo.findById(id)
    if (!note) throw new Error('ARCHIVE_RESTORE_NOT_FOUND')
    if (note.replacedBy) throw new Error('ARCHIVE_RESTORE_CONFLICT')
    this.privacy?.assertMemory(note)
    await this.repo.restore(id)
    const latest = await this.repo.findById(id)
    if (!latest) throw new Error('ARCHIVE_RESTORE_NOT_FOUND')
    if (latest.replacedBy || latest.status !== 'active') throw new Error('ARCHIVE_RESTORE_CONFLICT')
    this.privacy?.assertMemory(latest)
    this.invalidateForDeletion()
    const store = this.stores.getAgentStore(note.agentId, 'main')
    const node = store.get<TdbEventPayload>(note.tdbId)
    if (!node) {
      await this.rebuildAgentStore(note.agentId, true)
      return
    }
    store.updatePayload(note.tdbId, { ...node.payload, status: 'active' })
    store.flush()
  }
  private nextTdbId?: number
  private onCommitted?: (note: EventNote) => void | Promise<void>
  private contextRnnRuntime?: ContextRnnRuntime
  private getRuntimeConfig?: () => Promise<MemoryRuntimeConfig>
  private automaticRagTraces = new Map<string, AutomaticRagTrace>()

  constructor(
    private repo: EventNoteRepository,
    private stores: MemoryStoreRegistry,
    private embeddings: EmbeddingService,
  ) {}

  setCommitListener(listener: (note: EventNote) => void | Promise<void>): void {
    this.onCommitted = listener
  }

  setAdvancedRetrieval(
    contextRnnRuntime: ContextRnnRuntime,
    getRuntimeConfig: () => Promise<MemoryRuntimeConfig>,
  ): void {
    this.contextRnnRuntime = contextRnnRuntime
    this.getRuntimeConfig = getRuntimeConfig
  }

  /** 配置保存后立即停用 RNN，清除不能继续用于训练的旧检索轨迹。 */
  syncAdvancedRetrievalConfig(config: MemoryRuntimeConfig): void {
    const advanced = this.embeddings.isAvailable
      ? config.advanced
      : { ...config.advanced, enableContextRnn: false, enableFeedback: false }
    this.contextRnnRuntime?.configure(advanced)
    if (!isContextRnnFeedbackEnabled(advanced)) this.automaticRagTraces.clear()
  }

  takeAutomaticRagTrace(traceId: string): AutomaticRagTrace | undefined {
    const trace = this.automaticRagTraces.get(traceId)
    this.automaticRagTraces.delete(traceId)
    return trace
  }

  async applyRetrievalFeedback(traceId: string, reply: string): Promise<void> {
    const trace = this.takeAutomaticRagTrace(traceId)
    if (!this.embeddings.isAvailable || this.background?.enabled === false) return
    const backgroundSignal = this.background?.signal
    const runtime = this.contextRnnRuntime
    if (!trace || !runtime || !this.getRuntimeConfig) return
    const { agentId, channel } = trace
    const beforeLoad = runtime.generation
    const config = await this.getRuntimeConfig()
    if (
      runtime.generation !== beforeLoad ||
      !this.embeddings.isAvailable ||
      backgroundSignal?.aborted
    )
      return
    this.syncAdvancedRetrievalConfig(config)
    if (!runtime.feedbackEnabled || trace.rnnGeneration === undefined) return
    const rnn = runtime.peek(trace.rnnGeneration)
    if (!rnn) return
    const normalizedReply = reply.toLocaleLowerCase()
    const positive = trace.notes.some((note) => {
      const terms = [...note.topics, ...note.participants]
        .map((term) => term.trim().toLocaleLowerCase())
        .filter((term) => term.length >= 2)
      return terms.some((term) => normalizedReply.includes(term))
    })
    const target =
      trace.contextBias && trace.notes[0]
        ? await this.safeVector(trace.notes[0].narrative)
        : undefined
    // Embedding 请求期间可能关闭管线；迟到反馈不得重新创建实例或修改已停用的权重。
    if (!runtime.feedbackEnabled || runtime.peek(trace.rnnGeneration) !== rnn) return
    rnn.trainMinGru(agentId, channel, new Float32Array(trace.queryEmbedding), positive)
    if (trace.contextBias && target) {
      rnn.updateOutputWeights(
        rnn.getHiddenState(agentId, channel),
        trace.contextBias,
        new Float32Array(target),
        positive,
      )
    }
  }

  async create(
    input: CreateEventInput,
    operationId: string = randomUUID(),
    options: EventWriteOptions = {},
  ): Promise<EventNote> {
    options.signal?.throwIfAborted()
    const existing = await this.repo.findOperation(operationId)
    if (existing?.operation === 'create') {
      const payload = existing.payload as { note: EventNote; tdbId: number }
      await this.applyCreate(operationId, payload.note, payload.tdbId, true, options.signal)
      if (options.coverageOwnerId) await this.commitCoverage(payload.note, options, input.origin)
      await this.onCommitted?.(payload.note)
      return payload.note
    }
    this.validateDraft(input)
    await this.packageHooks?.emitHook('memory:beforeCreate', { input, operationId })
    const note: EventNote = {
      id: randomUUID(),
      agentId: input.agentId,
      narrative: input.narrative.trim(),
      eventAt: input.eventAt,
      createdAt: new Date().toISOString(),
      importance: input.importance,
      affect: input.affect,
      participants: input.participants ?? [],
      places: input.places ?? [],
      objects: input.objects ?? [],
      topics: input.topics ?? [],
      origin: input.origin,
      status: 'active',
    }
    const tdbId = await this.allocateTdbId()
    await this.repo.prepareCreate(operationId, note, tdbId)
    await this.applyCreate(operationId, note, tdbId, true, options.signal)
    options.signal?.throwIfAborted()
    if (!options.deferCoverage) {
      const coverage = this.coverageFor([note], note.origin.mode)
      if (options.coverageOwnerId) {
        await this.repo.commitCoverageUnderClaim(coverage, options.coverageOwnerId)
      } else {
        await this.repo.saveCoverage(coverage)
      }
    }
    await this.onCommitted?.(note)
    await this.packageHooks?.emitHook('memory:afterCreate', { note, operationId })
    return note
  }

  /** 人工修订独立于聊天记事：不新增覆盖记录，也不触发反思改写。 */
  edit(id: string, input: EventNoteManualEditInput): Promise<EventNote> {
    const key = `${id}:${input.operationId}`
    const running = this.manualEdits.get(key)
    if (running) return running
    const pending = this.editOnce(id, input).finally(() => this.manualEdits.delete(key))
    this.manualEdits.set(key, pending)
    return pending
  }

  private async editOnce(id: string, input: EventNoteManualEditInput): Promise<EventNote> {
    const existing = await this.repo.findOperation(input.operationId)
    if (existing) {
      const payload = existing.payload as {
        target: StoredEventNote
        replacement: EventNote
        newTdbId: number
        relations: EventNoteRelationView[]
        manualEdit?: ManualEventRevision
      }
      if (existing.operation !== 'revise' || !payload.manualEdit || payload.target.id !== id)
        throw new Error('ARCHIVE_EDIT_CONFLICT')
      const latest = await this.repo.findById(payload.replacement.id)
      if (!latest || latest.replacedBy) throw new Error('ARCHIVE_EDIT_CONFLICT')
      if (existing.status !== 'committed') {
        await this.applyRevise(
          input.operationId,
          payload.target,
          payload.replacement,
          payload.newTdbId,
          payload.relations,
          undefined,
          payload.manualEdit,
        )
      }
      this.invalidateForDeletion()
      return { ...payload.replacement, status: latest.status }
    }
    this.validateDraft(input)
    const target = await this.repo.findById(id)
    if (!target || target.replacedBy || target.status !== input.expectedStatus)
      throw new Error('ARCHIVE_EDIT_CONFLICT')
    if (await this.repo.hasPendingWrite(id)) throw new Error('ARCHIVE_EDIT_PENDING')
    const generation = this.privacy?.generation
    const revision = this.retrievalRevision
    const store = this.stores.getAgentStore(target.agentId, 'main')
    if (!store.contains(target.tdbId)) throw new Error('ARCHIVE_EDIT_PENDING')
    if (input.regenerateVector && !this.embeddings.isAvailable)
      throw new Error('ARCHIVE_EDIT_EMBEDDING_UNAVAILABLE')
    // 向量先准备完再创建修订事务，模型失败不会产生半份人工修订。
    const vector = input.regenerateVector
      ? await this.safeVector(input.narrative.trim())
      : Array.from(store.get(target.tdbId)?.vector ?? [])
    if (input.regenerateVector && !this.embeddings.isAvailable)
      throw new Error('ARCHIVE_EDIT_EMBEDDING_UNAVAILABLE')
    if (vector.length !== this.stores.getDimension()) throw new Error('ARCHIVE_EDIT_NOT_READY')
    if (generation !== this.privacy?.generation || revision !== this.retrievalRevision)
      throw new Error('ARCHIVE_EDIT_CONFLICT')
    const replacement: EventNote = {
      id: randomUUID(),
      agentId: target.agentId,
      eventAt: target.eventAt,
      status: target.status,
      narrative: input.narrative.trim(),
      createdAt: new Date().toISOString(),
      importance: input.importance,
      affect: input.affect,
      participants: input.participants ?? target.participants,
      places: input.places ?? target.places,
      objects: input.objects ?? target.objects,
      topics: input.topics ?? target.topics,
      origin: {
        ...target.origin,
        manualEdit: {
          actor: 'user',
          previousId: target.id,
          editedAt: new Date().toISOString(),
        },
      },
    }
    const newTdbId = await this.allocateTdbId()
    const relations = await this.repo.listRelations(id)
    const manualEdit: ManualEventRevision = { actor: 'user', vector }
    const prepared = await this.repo.prepareRevise(
      input.operationId,
      target,
      replacement,
      newTdbId,
      relations,
      manualEdit,
    )
    if (!prepared) return this.editOnce(id, input)
    await this.applyRevise(
      input.operationId,
      target,
      replacement,
      newTdbId,
      relations,
      undefined,
      manualEdit,
    )
    this.invalidateForDeletion()
    return replacement
  }

  async revise(
    targetId: string,
    input: CreateEventInput,
    operationId: string = randomUUID(),
    options: EventWriteOptions = {},
  ): Promise<EventNote> {
    options.signal?.throwIfAborted()
    const existing = await this.repo.findOperation(operationId)
    if (existing?.operation === 'revise') {
      const payload = existing.payload as {
        target: StoredEventNote
        replacement: EventNote
        newTdbId: number
        relations: EventNoteRelationView[]
      }
      await this.applyRevise(
        operationId,
        payload.target,
        payload.replacement,
        payload.newTdbId,
        payload.relations,
        options.signal,
      )
      if (options.coverageOwnerId)
        await this.commitCoverage(payload.replacement, options, input.origin)
      if (!options.maintenance) {
        await this.onCommitted?.(payload.replacement)
      }
      return payload.replacement
    }
    this.validateDraft(input)
    const target = await this.repo.findById(targetId)
    if (!target || target.replacedBy) throw new Error('目标事件不存在或已被修订')
    if (target.agentId !== input.agentId) throw new Error('不能修订其他 Agent 的事件')

    const replacement: EventNote = {
      id: randomUUID(),
      agentId: target.agentId,
      narrative: input.narrative.trim(),
      eventAt: target.eventAt,
      createdAt: new Date().toISOString(),
      importance: input.importance,
      affect: input.affect,
      participants: input.participants ?? target.participants,
      places: input.places ?? target.places,
      objects: input.objects ?? target.objects,
      topics: input.topics ?? target.topics,
      origin: {
        ...target.origin,
        manualEdit: undefined,
        pairIds: [...new Set([...target.origin.pairIds, ...input.origin.pairIds])],
        messageIds: [...new Set([...target.origin.messageIds, ...input.origin.messageIds])],
      },
      status: 'active',
    }
    const newTdbId = await this.allocateTdbId()
    const relations = await this.repo.listRelations(targetId)
    await this.repo.prepareRevise(operationId, target, replacement, newTdbId, relations)
    await this.applyRevise(operationId, target, replacement, newTdbId, relations, options.signal)
    options.signal?.throwIfAborted()
    await this.commitCoverage(replacement, options, input.origin)
    // 关系维护产生的修订已在当前任务中处理，不得再次触发自身。
    if (!options.maintenance) await this.onCommitted?.(replacement)
    return replacement
  }

  async archive(id: string, operationId: string = randomUUID()): Promise<void> {
    const note = await this.repo.findById(id)
    if (!note) throw new Error('事件不存在')
    if (note.status === 'archived') return
    await this.packageHooks?.emitHook('memory:beforeDelete', { note, operationId })
    const inserted = await this.repo.createOperation(operationId, note.agentId, 'archive', {
      id,
      tdbId: note.tdbId,
    })
    if (inserted) await this.repo.archive(id)
    this.privacy?.assertMemory(note)
    this.retrievalRevision++
    const store = this.stores.getAgentStore(note.agentId, 'main')
    const node = store.get<TdbEventPayload>(note.tdbId)
    if (node) store.updatePayload(note.tdbId, { ...node.payload, status: 'archived', operationId })
    this.automaticRagTraces.clear()
    store.flush()
    await this.repo.markOperationCommitted(operationId)
  }

  async addRelation(
    sourceId: string,
    targetId: string,
    relation: EventNoteRelation,
    weight = 1,
    operationId: string = randomUUID(),
  ): Promise<void> {
    const source = await this.requireCurrent(sourceId)
    const target = await this.requireCurrent(targetId)
    if (source.agentId !== target.agentId) throw new Error('不能跨 Agent 建立事件关系')
    let src = source
    let dst = target
    if (SYMMETRIC_RELATIONS.has(relation) && source.id > target.id) [src, dst] = [target, source]
    const relationView = { sourceId: src.id, targetId: dst.id, relation, weight }
    const inserted = await this.repo.createOperation(operationId, src.agentId, 'link', relationView)
    if (inserted) await this.repo.addRelation(relationView)
    this.privacy?.assertPayload('memory', relationView)
    this.stores
      .getAgentStore(src.agentId, 'main')
      .upsertEdge(src.tdbId, dst.tdbId, relation, weight, { operationId })
    await this.repo.markOperationCommitted(operationId)
  }

  async removeRelation(
    sourceId: string,
    targetId: string,
    relation: EventNoteRelation,
    operationId: string = randomUUID(),
  ): Promise<void> {
    const source = await this.requireCurrent(sourceId)
    const target = await this.requireCurrent(targetId)
    let src = source
    let dst = target
    if (SYMMETRIC_RELATIONS.has(relation) && source.id > target.id) [src, dst] = [target, source]
    const inserted = await this.repo.createOperation(operationId, src.agentId, 'unlink', {
      sourceId: src.id,
      targetId: dst.id,
      relation,
    })
    if (inserted) await this.repo.removeRelation(src.id, dst.id, relation)
    this.privacy?.assertPayload('memory', { sourceId: src.id, targetId: dst.id })
    this.stores.getAgentStore(src.agentId, 'main').unlink(src.tdbId, dst.tdbId, relation)
    await this.repo.markOperationCommitted(operationId)
  }

  /**
   * 核心记忆档案查询：关键词组合过滤 + 排序 + 分页 + facet 聚合。
   *
   * TDB 是运行时查询权威；这里在内存中对全量 EventNote 过滤，
   * 不触发 Embedding / 语义检索（语义 RAG 属于对话链路，不是档案浏览）。
   */
  async archiveQuery(filter: EventNoteArchiveFilter): Promise<EventNoteArchiveResult> {
    const agentIds = filter.agentIds?.length ? filter.agentIds : [filter.agentId]
    const all = agentIds.flatMap((agentId) => this.listTdbNotes(agentId))
    const statuses = new Set(filter.statuses?.length ? filter.statuses : ['active'])
    const stats = this.buildArchiveStats(all.filter((note) => statuses.has(note.status)))

    const needle = filter.query?.trim().toLocaleLowerCase()
    const channels = filter.channels?.length ? new Set(filter.channels) : null
    const modes = filter.modes?.length ? new Set(filter.modes) : null
    const tones = filter.tones?.length ? filter.tones.map((tone) => tone.toLocaleLowerCase()) : null
    const participants = filter.participants?.length
      ? filter.participants.map((value) => value.toLocaleLowerCase())
      : null
    const places = filter.places?.length
      ? filter.places.map((value) => value.toLocaleLowerCase())
      : null
    const objects = filter.objects?.length
      ? filter.objects.map((value) => value.toLocaleLowerCase())
      : null
    const topics = filter.topics?.length
      ? filter.topics.map((value) => value.toLocaleLowerCase())
      : null

    const filtered = all.filter((note) => {
      if (statuses && !statuses.has(note.status)) return false
      if (modes && !modes.has(note.origin.mode)) return false
      if (channels && !channels.has(note.origin.channel)) return false
      if (filter.importanceMin !== undefined && note.importance < filter.importanceMin) return false
      if (filter.importanceMax !== undefined && note.importance > filter.importanceMax) return false
      if (filter.eventAtFrom && note.eventAt < filter.eventAtFrom) return false
      if (filter.eventAtTo && note.eventAt > filter.eventAtTo) return false
      if (filter.createdAtFrom && note.createdAt < filter.createdAtFrom) return false
      if (filter.createdAtTo && note.createdAt > filter.createdAtTo) return false
      if (tones && !note.affect.tones.some((tone) => tones.includes(tone.toLocaleLowerCase()))) {
        return false
      }
      if (
        participants &&
        !participants.some((name) =>
          note.participants.some((value) => value.toLocaleLowerCase().includes(name)),
        )
      )
        return false
      if (
        places &&
        !places.some((name) =>
          note.places.some((value) => value.toLocaleLowerCase().includes(name)),
        )
      )
        return false
      if (
        objects &&
        !objects.some((name) =>
          note.objects.some((value) => value.toLocaleLowerCase().includes(name)),
        )
      )
        return false
      if (
        topics &&
        !topics.some((name) =>
          note.topics.some((value) => value.toLocaleLowerCase().includes(name)),
        )
      )
        return false
      if (needle) {
        const haystack = [
          note.narrative,
          ...note.topics,
          ...note.participants,
          ...note.places,
          ...note.objects,
        ]
        if (!haystack.some((value) => value.toLocaleLowerCase().includes(needle))) return false
      }
      return true
    })

    const sortKey = filter.sort ?? 'eventAt'
    const direction = filter.order === 'asc' ? 1 : -1
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'importance') {
        return (a.importance - b.importance) * direction || b.eventAt.localeCompare(a.eventAt)
      }
      if (sortKey === 'createdAt') {
        return a.createdAt.localeCompare(b.createdAt) * direction || a.id.localeCompare(b.id)
      }
      return a.eventAt.localeCompare(b.eventAt) * direction || a.id.localeCompare(b.id)
    })

    const page = Math.max(1, filter.page ?? 1)
    const pageSize = Math.max(1, Math.min(filter.pageSize ?? 30, 100))
    const total = sorted.length
    const pageCount = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, pageCount)
    const items = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)

    return {
      items,
      page: safePage,
      pageSize,
      total,
      pageCount,
      facets: this.buildArchiveFacets(filtered),
      stats,
    }
  }

  /**
   * 记忆图谱快照：直接从 TDB 批量读取节点与边，替代旧的逐节点 detail 调用。
   *
   * 旧实现对每个节点调用 detail()，每次 detail 又会从 SQLite 拉取全量时间轴
   * 定位前后事件，属于重量级 N+1；本方法纯内存读取，一次完成。
   */
  graphSnapshot(
    agentId: string,
    options?: { includeArchived?: boolean; status?: 'active' | 'archived'; limit?: number },
  ): EventMemoryGraphSnapshot {
    const limit = Math.max(1, Math.min(options?.limit ?? 300, 1000))
    const store = this.stores.getAgentStore(agentId, 'main')
    const tdbIdToNoteId = new Map<number, string>()
    const noteIdToTdbId = new Map<string, number>()
    const nodes: EventNote[] = []
    for (const id of store.allNodeIds()) {
      const payload = store.get<TdbEventPayload>(id)?.payload
      if (payload?.kind !== 'event_note') continue
      const note = payload as EventNote
      if (this.privacy?.deleted('memory', note.id)) continue
      if (options?.status && note.status !== options.status) continue
      if (!options?.includeArchived && note.status === 'archived') continue
      tdbIdToNoteId.set(id, note.id)
      noteIdToTdbId.set(note.id, id)
      nodes.push(note)
    }
    nodes.sort((a, b) => a.eventAt.localeCompare(b.eventAt) || a.id.localeCompare(b.id))
    const truncated = nodes.length > limit
    const visible = truncated ? nodes.slice(-limit) : nodes
    const visibleIds = new Set(visible.map((note) => note.id))

    const edges: EventNoteRelationView[] = []
    const seen = new Set<string>()
    for (const note of visible) {
      const tdbId = noteIdToTdbId.get(note.id)
      if (tdbId === undefined) continue
      for (const edge of store.getEdges(tdbId)) {
        const targetNoteId = tdbIdToNoteId.get(edge.targetId)
        if (!targetNoteId || !visibleIds.has(targetNoteId)) continue
        const key = `${note.id}:${edge.label}:${targetNoteId}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          sourceId: note.id,
          targetId: targetNoteId,
          relation: edge.label as EventNoteRelation,
          weight: edge.weight,
        })
      }
    }
    return { nodes: visible, edges, truncated }
  }

  private buildArchiveStats(all: EventNote[]): EventNoteArchiveResult['stats'] {
    let active = 0
    let archived = 0
    let importanceSum = 0
    const topics = new Set<string>()
    for (const note of all) {
      if (note.status === 'archived') archived++
      else active++
      importanceSum += note.importance
      for (const topic of note.topics) topics.add(topic)
    }
    return {
      active,
      archived,
      averageImportance: all.length ? Math.round((importanceSum / all.length) * 10) / 10 : 0,
      topicCount: topics.size,
    }
  }

  private buildArchiveFacets(filtered: EventNote[]): EventNoteArchiveResult['facets'] {
    const counter = () => {
      const map = new Map<string, number>()
      return {
        add(value: string) {
          if (!value) return
          map.set(value, (map.get(value) ?? 0) + 1)
        },
        list: () =>
          [...map.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN')),
      }
    }
    const channels = counter()
    const statuses = counter()
    const modes = counter()
    const tones = counter()
    const participants = counter()
    const places = counter()
    const objects = counter()
    const topics = counter()
    for (const note of filtered) {
      channels.add(note.origin.channel)
      statuses.add(note.status)
      modes.add(note.origin.mode)
      for (const tone of note.affect.tones) tones.add(tone)
      for (const name of note.participants) participants.add(name)
      for (const name of note.places) places.add(name)
      for (const name of note.objects) objects.add(name)
      for (const name of note.topics) topics.add(name)
    }
    return {
      channels: channels.list(),
      statuses: statuses.list(),
      modes: modes.list(),
      tones: tones.list().slice(0, 40),
      participants: participants.list().slice(0, 60),
      places: places.list().slice(0, 60),
      objects: objects.list().slice(0, 60),
      topics: topics.list().slice(0, 80),
    }
  }

  async query(input: EventNoteQuery): Promise<EventNote[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 100))
    const all = this.listTdbNotes(input.agentId).filter(
      (note) => input.includeArchived || note.status === 'active',
    )
    if (!input.query || input.mode === 'recent' || input.mode === 'time_range') {
      return all
        .filter(
          (note) =>
            (!input.from || note.eventAt >= input.from) && (!input.to || note.eventAt <= input.to),
        )
        .sort((a, b) => b.eventAt.localeCompare(a.eventAt) || b.id.localeCompare(a.id))
        .slice(0, limit)
    }
    if (input.mode === 'entity') {
      const needle = input.query.toLocaleLowerCase()
      return all
        .filter((note) =>
          [...note.participants, ...note.places, ...note.objects, ...note.topics].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          ),
        )
        .slice(0, limit)
    }
    if (input.mode === 'affective') {
      const needle = input.query.toLocaleLowerCase()
      return all
        .filter((note) =>
          note.affect.tones.some((tone) => tone.toLocaleLowerCase().includes(needle)),
        )
        .slice(0, limit)
    }
    const useVector = this.embeddings.isAvailable
    const vector = useVector
      ? await this.safeVector(input.query)
      : Array(this.stores.getDimension()).fill(0)
    const store = this.stores.ensureTextIndexReady(input.agentId, 'desktop')
    const hits =
      useVector && this.embeddings.isAvailable && input.mode === 'semantic'
        ? store.search(vector, limit * 3, 0, -1)
        : store.searchHybrid(
            vector,
            input.query,
            limit * 3,
            0,
            -1,
            useVector && this.embeddings.isAvailable ? 0.5 : 0,
          )
    const notes = hits
      .flatMap((hit) => {
        const node = store.get<TdbEventPayload>(hit.id)
        return node?.payload?.kind === 'event_note' &&
          !this.privacy?.deleted('memory', node.payload.id)
          ? [node.payload as EventNote]
          : []
      })
      .filter((note) => input.includeArchived || note.status === 'active')
    if (input.mode !== 'same_event' && input.mode !== 'logical') return notes.slice(0, limit)
    const relation = input.mode === 'same_event' ? 'same_event' : 'caused_by'
    const expanded = [...notes]
    for (const note of notes) {
      const node = this.findTdbNode(input.agentId, note.id)
      if (!node) continue
      const relatedIds = [
        ...store
          .getEdges(node.id)
          .filter((edge) => edge.label === relation)
          .map((edge) => edge.targetId),
        ...store
          .getIncomingEdges(node.id)
          .filter((edge) => edge.label === relation)
          .map((edge) => edge.sourceId),
      ]
      for (const id of relatedIds) {
        const related = store.get<TdbEventPayload>(id)?.payload
        if (
          related?.kind === 'event_note' &&
          !this.privacy?.deleted('memory', related.id) &&
          (input.includeArchived || related.status === 'active')
        )
          expanded.push(related)
      }
    }
    return [...new Map(expanded.map((note) => [note.id, note])).values()].slice(0, limit)
  }

  async queryDetailed(input: EventNoteQuery): Promise<EventNoteQueryResult> {
    const generation = this.privacy?.generation
    const revision = this.retrievalRevision
    const stale = () =>
      generation !== this.privacy?.generation || revision !== this.retrievalRevision
    const empty: EventNoteQueryResult = {
      notes: [],
      entities: [],
      paths: [],
      truncated: false,
      returnedTokens: 0,
    }
    const maxDepth = Math.max(0, Math.min(input.maxDepth ?? 2, 6))
    const maxNodes = Math.max(1, Math.min(input.maxNodes ?? input.limit ?? 20, 100))
    const maxReturnTokens = Math.max(1, Math.min(input.maxReturnTokens ?? 4_000, 32_000))
    const direction = input.direction ?? 'both'
    const labels = new Set<EventNoteRelation>(
      input.edgeLabels ?? [
        'temporal_next',
        'temporal_prev',
        'caused_by',
        'same_event',
        'same_topic',
        'involves_person',
        'involves_place',
        'involves_object',
      ],
    )
    const anchorLimit = Math.max(1, Math.min(input.limit ?? 10, maxNodes))
    const anchors = await this.query({ ...input, limit: anchorLimit })
    if (stale()) return empty
    const store = this.stores.getAgentStore(input.agentId, 'main')
    const payloadByTdbId = new Map<number, TdbMemoryPayload>()
    const tdbIdByNoteId = new Map<string, number>()
    for (const id of store.allNodeIds()) {
      const payload = store.get<TdbMemoryPayload>(id)?.payload
      if (payload?.kind !== 'event_note' && payload?.kind !== 'event_entity') continue
      if (payload.kind === 'event_note' && this.privacy?.deleted('memory', payload.id)) continue
      payloadByTdbId.set(id, payload)
      if (payload.kind === 'event_note') tdbIdByNoteId.set(payload.id, id)
    }

    const paths = new Map<number, EventNoteQueryPath['edges']>()
    const queue: Array<{ id: number; depth: number }> = []
    for (const anchor of anchors) {
      const id = tdbIdByNoteId.get(anchor.id)
      if (id === undefined || paths.has(id)) continue
      paths.set(id, [])
      queue.push({ id, depth: 0 })
    }
    let graphTruncated = false
    while (queue.length) {
      const current = queue.shift()!
      if (current.depth >= maxDepth) continue
      const outgoing =
        direction === 'incoming'
          ? []
          : store.getEdges(current.id).map((edge) => ({
              from: current.id,
              to: edge.targetId,
              label: edge.label,
              weight: edge.weight,
            }))
      const incoming =
        direction === 'outgoing'
          ? []
          : store.getIncomingEdges(current.id).map((edge) => ({
              from: edge.sourceId,
              to: current.id,
              label: edge.label,
              weight: edge.weight,
            }))
      for (const edge of [...outgoing, ...incoming]) {
        if (!labels.has(edge.label as EventNoteRelation)) continue
        const neighborId = edge.from === current.id ? edge.to : edge.from
        const neighbor = payloadByTdbId.get(neighborId)
        if (!neighbor) continue
        if (
          neighbor.kind === 'event_note' &&
          !input.includeArchived &&
          neighbor.status === 'archived'
        )
          continue
        if (paths.has(neighborId)) continue
        if (paths.size >= maxNodes) {
          graphTruncated = true
          continue
        }
        const source = payloadByTdbId.get(edge.from)
        const target = payloadByTdbId.get(edge.to)
        if (!source || !target) continue
        const path = [
          ...(paths.get(current.id) ?? []),
          {
            sourceId: source.id,
            targetId: target.id,
            fromEventId: source.id,
            toEventId: target.id,
            fromKind: source.kind,
            toKind: target.kind,
            relation: edge.label as EventNoteRelation,
            weight: edge.weight,
          },
        ]
        paths.set(neighborId, path)
        queue.push({ id: neighborId, depth: current.depth + 1 })
      }
    }

    const notes: EventNote[] = []
    const entities: Array<{ id: string; entityType: 'person' | 'place' | 'object'; name: string }> =
      []
    const resultPaths: EventNoteQueryPath[] = []
    let returnedTokens = 0
    let tokenTruncated = false
    for (const [id, path] of paths) {
      const payload = payloadByTdbId.get(id)
      if (!payload) continue
      const serialized = JSON.stringify({ payload, path })
      const tokens = tokenCounter.countTokens(serialized)
      if (returnedTokens + tokens > maxReturnTokens) {
        tokenTruncated = true
        break
      }
      if (payload.kind === 'event_note') notes.push(payload)
      else entities.push({ id: payload.id, entityType: payload.entityType, name: payload.name })
      resultPaths.push({ targetId: payload.id, edges: path })
      returnedTokens += tokens
    }
    const result: EventNoteQueryResult = {
      notes,
      entities,
      paths: resultPaths,
      truncated: graphTruncated || tokenTruncated,
      returnedTokens,
    }
    await this.repo.recordQueryAudit({
      id: randomUUID(),
      agentId: input.agentId,
      mode: input.mode ?? 'mixed',
      query: input,
      resultCount: notes.length + entities.length,
      returnedTokens,
      truncated: result.truncated,
      queriedAt: new Date().toISOString(),
    })
    await this.packageHooks?.emitHook('memory:afterRetrieve', { agentId: input.agentId, result })
    return stale() ? empty : result
  }

  async automaticRag(
    agentId: string,
    query: string,
    topK = 10,
    channel = 'desktop',
    traceId?: string,
    onProgress?: (progress: AutomaticRagProgress) => void | Promise<void>,
  ): Promise<EventNote[]> {
    const generation = this.privacy?.generation
    const revision = this.retrievalRevision
    const stale = () =>
      generation !== this.privacy?.generation || revision !== this.retrievalRevision
    const timeline = this.listTdbNotes(agentId)
      .filter((note) => note.status === 'active')
      .sort((a, b) => a.eventAt.localeCompare(b.eventAt) || a.id.localeCompare(b.id))
    const latest = timeline.at(-1)
    const runtime = this.contextRnnRuntime
    const beforeLoad = runtime?.generation
    const config = this.getRuntimeConfig ? await this.getRuntimeConfig() : undefined
    if (stale()) return []
    const configIsCurrent = beforeLoad === runtime?.generation
    if (config && configIsCurrent) this.syncAdvancedRetrievalConfig(config)
    const rnnGeneration = configIsCurrent ? runtime?.generation : undefined
    const advanced = config?.advanced
    let queryEmbedding: number[] = []
    let contextBias: Float32Array | undefined
    let usedRnnGeneration: number | undefined
    let hits: EventNote[]

    if (advanced?.enableSaPpr && this.embeddings.isAvailable) {
      await onProgress?.({ stage: 'embedding', message: __t('server.memory', '正在拉取记忆……') })
      queryEmbedding = await this.safeVector(query)
      if (stale()) return []
      if (advanced.enableContextRnn && rnnGeneration !== undefined) {
        const rnn = runtime?.acquire(rnnGeneration)
        if (rnn) {
          rnn.update(agentId, channel, queryEmbedding)
          contextBias = rnn.generateBias(agentId, channel)
          usedRnnGeneration = rnnGeneration
        }
      }
      const store = this.stores.ensureTextIndexReady(agentId, channel)
      await onProgress?.({
        stage: 'retrieval',
        message: __t('server.memory', '正在拉取记忆……'),
      })
      if (stale()) return []
      if (usedRnnGeneration !== undefined && !runtime?.peek(usedRnnGeneration)) {
        contextBias = undefined
        usedRnnGeneration = undefined
      }
      const advancedHits = store.searchAdvanced(queryEmbedding, {
        topK: Math.max(topK * 3, topK),
        expandDepth: advanced.expandDepth,
        minScore: advanced.minScore,
        teleportAlpha: advanced.teleportAlpha,
        enableAdvancedPipeline: true,
        enableSparseResidual: advanced.enableFista,
        enableDpp: advanced.enableDpp,
        enableTextHybridSearch: true,
        customQueryText: query,
        diffusionBias: contextBias ? Array.from(contextBias) : undefined,
      })
      const rerankers = [
        contextBias ? 'ContextRNN' : '',
        advanced.enableLeiden ? 'Leiden' : '',
        advanced.enableDpp ? 'DPP' : '',
      ].filter(Boolean)
      await onProgress?.({
        stage: 'reranking',
        message: rerankers.length
          ? __t('server.memory', '正在使用 {0} 重排 {1} 个候选', [
              rerankers.join(' + '),
              advancedHits.length,
            ])
          : __t('server.memory', '正在筛选 {0} 个候选', [advancedHits.length]),
        candidateCount: advancedHits.length,
      })
      if (stale()) return []
      const clusterBonus = advanced.enableLeiden
        ? this.leidenClusterBonus(store, contextBias ?? new Float32Array(queryEmbedding))
        : new Map<number, number>()
      hits = advancedHits
        .sort(
          (a, b) =>
            b.score + (clusterBonus.get(b.id) ?? 0) - (a.score + (clusterBonus.get(a.id) ?? 0)),
        )
        .flatMap((hit) => {
          const payload = store.get<TdbEventPayload>(hit.id)?.payload
          return payload?.kind === 'event_note' && payload.status === 'active'
            ? [payload as EventNote]
            : []
        })
        .slice(0, topK)
    } else {
      await onProgress?.({ stage: 'embedding', message: __t('server.memory', '正在拉取记忆……') })
      await onProgress?.({
        stage: 'retrieval',
        message: __t('server.memory', '正在拉取记忆……'),
      })
      hits = await this.query({ agentId, query, mode: 'mixed', limit: topK })
      await onProgress?.({
        stage: 'reranking',
        message: __t('server.memory', '基础召回已筛选出 {0} 个相关事件', [hits.length]),
        candidateCount: hits.length,
      })
    }

    await onProgress?.({
      stage: 'timeline',
      message: __t('server.memory', '正在补充时间轴末尾与命中事件直接前驱'),
      candidateCount: hits.length,
    })
    if (stale()) return []
    const index = new Map(timeline.map((note, i) => [note.id, i]))
    const result: EventNote[] = []
    if (latest) result.push(latest)
    for (const hit of hits) {
      result.push(hit)
      const position = index.get(hit.id)
      if (position !== undefined && position > 0) result.push(timeline[position - 1]!)
    }
    const notes = [...new Map(result.map((note) => [note.id, note])).values()].filter(
      (note) =>
        !this.privacy?.deleted('memory', note.id) &&
        this.findTdbNode(agentId, note.id)?.note.status === 'active',
    )
    if (
      traceId &&
      usedRnnGeneration !== undefined &&
      runtime?.feedbackEnabled &&
      runtime.peek(usedRnnGeneration)
    ) {
      this.automaticRagTraces.set(traceId, {
        agentId,
        channel,
        query,
        queryEmbedding,
        notes: hits,
        contextBias,
        rnnGeneration: usedRnnGeneration,
      })
    }
    await onProgress?.({
      stage: 'completed',
      message: __t('server.memory', '记忆上下文已就绪，共注入 {0} 个事件', [notes.length]),
      candidateCount: hits.length,
      resultCount: notes.length,
    })
    await this.packageHooks?.emitHook('memory:afterRetrieve', { agentId, notes, channel })
    return stale() ? [] : notes
  }

  private leidenClusterBonus(
    store: ReturnType<MemoryStoreRegistry['getAgentStore']>,
    direction: Float32Array,
  ): Map<number, number> {
    const clusters = store.leidenCluster({ withCentroids: true })
    if (!clusters.centroids.length) return new Map()
    const dimension = this.stores.getDimension()
    const centroids = new Map<number, Float32Array>()
    for (let offset = 0; offset < clusters.centroids.length; offset += dimension + 1) {
      const clusterId = clusters.centroids[offset]
      if (clusterId === undefined) break
      centroids.set(
        clusterId,
        new Float32Array(clusters.centroids.slice(offset + 1, offset + 1 + dimension)),
      )
    }
    const scores = new Map<number, number>()
    let maxScore = Number.NEGATIVE_INFINITY
    for (const [clusterId, centroid] of centroids) {
      let score = 0
      const length = Math.min(direction.length, centroid.length)
      for (let index = 0; index < length; index++) {
        score += direction[index]! * centroid[index]!
      }
      scores.set(clusterId, score)
      maxScore = Math.max(maxScore, score)
    }
    let scoreSum = 0
    for (const [clusterId, score] of scores) {
      const normalized = Math.exp(score - maxScore)
      scores.set(clusterId, normalized)
      scoreSum += normalized
    }
    const bonus = new Map<number, number>()
    for (let offset = 0; offset < clusters.nodeToCluster.length; offset += 2) {
      const nodeId = clusters.nodeToCluster[offset]
      const clusterId = clusters.nodeToCluster[offset + 1]
      if (nodeId !== undefined && clusterId !== undefined) {
        bonus.set(nodeId, scoreSum > 0 ? (scores.get(clusterId) ?? 0) / scoreSum : 0)
      }
    }
    return bonus
  }

  async detail(id: string): Promise<EventNoteDetail | undefined> {
    const note = await this.repo.findById(id)
    if (!note || note.replacedBy) return undefined
    const timeline = (
      await this.repo.list(note.agentId, {
        includeArchived: note.status === 'archived',
        ascending: true,
        limit: 10_000,
      })
    ).filter((item) => item.status === note.status)
    if (this.privacy?.deleted('memory', id)) return undefined
    const position = timeline.findIndex((item) => item.id === id)
    return {
      ...note,
      previous: position > 0 ? timeline[position - 1] : undefined,
      next: position >= 0 ? timeline[position + 1] : undefined,
      relations: await this.repo.listRelations(id),
    }
  }

  async replayPending(isAgentAvailable: (agentId: string) => boolean = () => true): Promise<void> {
    for (const operation of await this.repo.pendingOperations()) {
      // 已删除角色的未完成操作保持原状，不在启动时重新打开其记忆存储。
      if (!isAgentAvailable(operation.agentId)) continue
      if (
        this.background?.enabled === false &&
        /^(background:|reflection:)/.test(operation.operationId)
      )
        continue
      try {
        if (operation.operation === 'create') {
          const payload = operation.payload as { note: EventNote; tdbId: number }
          await this.applyCreate(operation.operationId, payload.note, payload.tdbId)
        } else if (operation.operation === 'revise') {
          const payload = operation.payload as {
            target: StoredEventNote
            replacement: EventNote
            newTdbId: number
            relations: EventNoteRelationView[]
            manualEdit?: ManualEventRevision
          }
          await this.applyRevise(
            operation.operationId,
            payload.target,
            payload.replacement,
            payload.newTdbId,
            payload.relations,
            undefined,
            payload.manualEdit,
          )
        }
      } catch (error) {
        await this.repo.markOperationFailed(operation.operationId, String(error))
        logger.warn(__t('logs.memory', '事件记忆事务重放失败: {0}', [operation.operationId]), {
          error,
        })
      }
    }
  }

  async rebuildAgentStore(agentId: string, offline = false, signal?: AbortSignal): Promise<void> {
    // 关闭向量时只重建文本和关系索引，保留仍可用的已有向量，不重新调用模型。
    offline ||= !this.embeddings.isAvailable
    const generation = this.privacy?.generation
    const config = this.embeddings.getConfig()
    const dimension = this.stores.getDimension()
    const guard = () => {
      signal?.throwIfAborted()
      if (
        generation !== this.privacy?.generation ||
        dimension !== this.stores.getDimension() ||
        (!offline && config !== this.embeddings.getConfig())
      )
        throw new Error('记忆或向量配置已变化，已停止旧索引重建')
    }
    guard()
    const vectors = new Map<string, number[]>()
    const vectorTexts = new Map<string, string>()
    if (offline) {
      const previous = this.stores.getAgentStore(agentId, 'main')
      for (const id of previous.allNodeIds()) {
        const node = previous.get<TdbMemoryPayload>(id)
        if (node?.payload.id) {
          vectors.set(node.payload.id, Array.from(node.vector))
          if ('narrative' in node.payload && typeof node.payload.narrative === 'string') vectorTexts.set(node.payload.id, node.payload.narrative)
        }
      }
    }
    const query = {
      includeArchived: true,
      ascending: true,
      limit: 100_000,
    }
    const notes = await this.repo.list(agentId, query)
    if (notes.length === query.limit) throw new Error('记忆数量超过单次重建上限，请分批处理')
    const insertOperations: TransactionOperation[] = []
    const texts = new Map<number, string>()
    const vectorFor = async (id: string, text: string) => {
      guard()
      const vector = offline
        ? ((vectorTexts.get(id) === text ? vectors.get(id) : undefined) ?? Array(dimension).fill(0))
        : await this.safeVector(text, signal)
      guard()
      if (vector.length !== dimension) throw new Error('记忆向量维度与当前配置不一致')
      return vector
    }
    for (const note of notes) {
      insertOperations.push({
        type: 'insertWithId',
        id: note.tdbId,
        vector: await vectorFor(note.id, note.narrative),
        payload: { ...note, kind: 'event_note', operationId: `rebuild:${note.id}` },
      })
    }
    const edgeOperations: TransactionOperation[] = []
    const entities = new Map<string, number>()
    const noteMap = new Map(notes.map((note) => [note.id, note]))
    const reservedIds = new Set(notes.map((note) => note.tdbId))
    for (let index = 1; index < notes.length; index++) {
      const previous = notes[index - 1]!
      const current = notes[index]!
      edgeOperations.push(
        {
          type: 'upsertEdge',
          src: previous.tdbId,
          dst: current.tdbId,
          label: 'temporal_next',
          weight: 1,
        },
        {
          type: 'upsertEdge',
          src: current.tdbId,
          dst: previous.tdbId,
          label: 'temporal_prev',
          weight: 1,
        },
      )
    }
    for (const note of notes) {
      texts.set(note.tdbId, note.narrative)
      for (const [entityType, relation, names] of [
        ['person', 'involves_person', note.participants],
        ['place', 'involves_place', note.places],
        ['object', 'involves_object', note.objects],
      ] as const) {
        for (const name of [...new Set(names.map((value) => value.trim()).filter(Boolean))]) {
          const key = `entity:${entityType}:${name.toLocaleLowerCase()}`
          let id = entities.get(key)
          if (id === undefined) {
            id = await this.allocateTdbId()
            while (reservedIds.has(id)) id = await this.allocateTdbId()
            reservedIds.add(id)
            entities.set(key, id)
            insertOperations.push({
              type: 'insertWithId',
              id,
              vector: await vectorFor(key, name),
              payload: { kind: 'event_entity', id: key, entityType, name },
            })
            texts.set(id, name)
          }
          edgeOperations.push({
            type: 'upsertEdge',
            src: note.tdbId,
            dst: id,
            label: relation,
            weight: 1,
          })
        }
      }
      for (const relation of await this.repo.listRelations(note.id)) {
        if (relation.sourceId !== note.id) continue
        const target = noteMap.get(relation.targetId)
        if (target && !target.replacedBy)
          edgeOperations.push({
            type: 'upsertEdge',
            src: note.tdbId,
            dst: target.tdbId,
            label: relation.relation,
            weight: relation.weight,
          })
      }
    }
    await this.stores.withMaintenance(this.stores.resolveAgentStorePath(agentId, 'main'), async () => {
      const current = await this.repo.list(agentId, query)
      guard()
      if (JSON.stringify(current) !== JSON.stringify(notes))
        throw new Error('重建期间记忆发生变化，请稍后重试')
      this.stores.replaceAgentStore(agentId, 'main', (store) => {
        if (insertOperations.length) store.commitTransaction(insertOperations)
        if (edgeOperations.length) store.commitTransaction(edgeOperations)
        for (const [id, text] of texts) store.indexText(id, text)
      })
    }, signal)
    this.invalidateForDeletion()
  }

  private async applyCreate(
    operationId: string,
    note: EventNote,
    tdbId: number,
    markCommitted = true,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const generation = this.privacy?.generation
    const indexRevision = this.retrievalRevision
    try {
      this.privacy?.assertMemory(note)
      const store = this.stores.getAgentStore(note.agentId, 'main')
      const vector = await this.safeVector(note.narrative, signal)
      signal?.throwIfAborted()
      if (generation !== this.privacy?.generation || indexRevision !== this.retrievalRevision)
        throw new Error('记忆数据或索引已变化，已停止旧写入')
      this.privacy?.assertMemory(note)
      const payload: TdbEventPayload = { ...note, kind: 'event_note', operationId }
      const timeline = await this.repo.list(note.agentId, {
        includeArchived: true,
        ascending: true,
        limit: 100_000,
      })
      const position = timeline.findIndex((item) => item.id === note.id)
      const previous = position > 0 ? timeline[position - 1] : undefined
      const next = position >= 0 ? timeline[position + 1] : undefined
      const operations: TransactionOperation[] = [
        { type: 'insertWithId', id: tdbId, vector, payload },
      ]
      if (previous)
        operations.push(
          {
            type: 'upsertEdge',
            src: previous.tdbId,
            dst: tdbId,
            label: 'temporal_next',
            weight: 1,
          },
          {
            type: 'upsertEdge',
            src: tdbId,
            dst: previous.tdbId,
            label: 'temporal_prev',
            weight: 1,
          },
        )
      if (next) {
        if (previous)
          operations.push(
            { type: 'unlinkLabel', src: previous.tdbId, dst: next.tdbId, label: 'temporal_next' },
            { type: 'unlinkLabel', src: next.tdbId, dst: previous.tdbId, label: 'temporal_prev' },
          )
        operations.push(
          { type: 'upsertEdge', src: tdbId, dst: next.tdbId, label: 'temporal_next', weight: 1 },
          { type: 'upsertEdge', src: next.tdbId, dst: tdbId, label: 'temporal_prev', weight: 1 },
        )
      }
      this.privacy?.assertMemory(note)
      if (generation !== this.privacy?.generation || indexRevision !== this.retrievalRevision)
        throw new Error('记忆数据或索引已变化，已停止旧写入')
      signal?.throwIfAborted()
      if (!store.contains(tdbId)) store.commitTransaction(operations)
      store.indexText(tdbId, note.narrative)
      await this.ensureEntityRelations(note, tdbId, undefined, signal)
      this.stores.markTextIndexDirty(this.stores.resolveAgentStorePath(note.agentId, 'main'))
      if (markCommitted) await this.repo.markOperationCommitted(operationId)
    } catch (error) {
      await this.repo.markOperationFailed(operationId, String(error))
      throw error
    }
  }

  private async applyRevise(
    operationId: string,
    target: StoredEventNote,
    replacement: EventNote,
    newTdbId: number,
    relations: EventNoteRelationView[],
    signal?: AbortSignal,
    manualEdit?: ManualEventRevision,
  ): Promise<void> {
    signal?.throwIfAborted()
    const generation = this.privacy?.generation
    const indexRevision = this.retrievalRevision
    try {
      this.privacy?.assertPayload('memory', { target, replacement })
      // 更晚的修订已接管该条目时，旧事务只结算，不得复活过期节点。
      const latest = await this.repo.findById(replacement.id)
      if (latest?.replacedBy) {
        await this.repo.markOperationCommitted(operationId)
        return
      }
      this.privacy?.assertPayload('memory', { target, replacement })
      const store = this.stores.getAgentStore(target.agentId, 'main')
      if (!store.contains(newTdbId)) {
        const vector = manualEdit?.vector ?? (await this.safeVector(replacement.narrative, signal))
        signal?.throwIfAborted()
        if (generation !== this.privacy?.generation || indexRevision !== this.retrievalRevision)
          throw new Error('记忆数据或索引已变化，已停止旧修订')
        this.privacy?.assertPayload('memory', { target, replacement })
        const operations: TransactionOperation[] = [
          {
            type: 'insertWithId',
            id: newTdbId,
            vector,
            payload: { ...replacement, kind: 'event_note', operationId },
          },
        ]
        for (const edge of store
          .getIncomingEdges(target.tdbId)
          .filter((edge) => !manualEdit || !edge.label.startsWith('involves_')))
          operations.push({
            type: 'upsertEdge',
            src: edge.sourceId,
            dst: newTdbId,
            label: edge.label,
            weight: edge.weight,
          })
        for (const edge of store
          .getEdges(target.tdbId)
          .filter((edge) => !manualEdit || !edge.label.startsWith('involves_')))
          operations.push({
            type: 'upsertEdge',
            src: newTdbId,
            dst: edge.targetId,
            label: edge.label,
            weight: edge.weight,
          })
        operations.push({ type: 'delete', id: target.tdbId })
        store.commitTransaction(operations)
      }
      // 索引失败后重放也必须补齐文本，不能只以节点已存在判断完成。
      store.indexText(newTdbId, replacement.narrative)
      // 新实体不额外调用向量模型，避免绕过用户的向量选项。
      if (manualEdit) await this.ensureEntityRelations(replacement, newTdbId, new Map(), signal)
      for (const relation of relations) {
        signal?.throwIfAborted()
        const sourceId = relation.sourceId === target.id ? replacement.id : relation.sourceId
        const targetId = relation.targetId === target.id ? replacement.id : relation.targetId
        await this.repo.removeRelation(relation.sourceId, relation.targetId, relation.relation)
        await this.repo.addRelation({ ...relation, sourceId, targetId })
      }
      await this.repo.markOperationCommitted(operationId)
    } catch (error) {
      await this.repo.markOperationFailed(operationId, String(error))
      throw error
    }
  }

  private async ensureEntityRelations(
    note: EventNote,
    noteTdbId: number,
    vectors?: Map<string, number[]>,
    signal?: AbortSignal,
  ): Promise<void> {
    const generation = this.privacy?.generation
    const indexRevision = this.retrievalRevision
    const store = this.stores.getAgentStore(note.agentId, 'main')
    const groups = [
      ['person', 'involves_person', note.participants],
      ['place', 'involves_place', note.places],
      ['object', 'involves_object', note.objects],
    ] as const
    for (const [entityType, relation, values] of groups) {
      for (const name of [...new Set(values.map((value) => value.trim()).filter(Boolean))]) {
        signal?.throwIfAborted()
        const id = `entity:${entityType}:${name.toLocaleLowerCase()}`
        let entityTdbId = this.findEntityTdbId(store, id)
        if (entityTdbId === undefined) {
          entityTdbId = await this.allocateTdbId()
          if (generation !== this.privacy?.generation || indexRevision !== this.retrievalRevision)
            throw new Error('记忆数据已变化，已停止旧任务')
          while (store.contains(entityTdbId)) {
            entityTdbId = await this.allocateTdbId()
            if (generation !== this.privacy?.generation || indexRevision !== this.retrievalRevision)
              throw new Error('记忆数据已变化，已停止旧任务')
          }
          const payload: TdbEntityPayload = { kind: 'event_entity', id, entityType, name }
          const vector = vectors
            ? (vectors.get(id) ?? Array(this.stores.getDimension()).fill(0))
            : await this.safeVector(name, signal)
          signal?.throwIfAborted()
          if (
            generation !== this.privacy?.generation ||
            indexRevision !== this.retrievalRevision ||
            this.privacy?.deleted('memory', note.id)
          )
            throw new Error('记忆来源已变化，已阻止迟到关系写入')
          store.insertWithId(entityTdbId, vector, payload)
          store.indexText(entityTdbId, name)
        }
        store.upsertEdge(noteTdbId, entityTdbId, relation, 1)
      }
    }
  }

  private findEntityTdbId(
    store: ReturnType<MemoryStoreRegistry['getAgentStore']>,
    entityId: string,
  ): number | undefined {
    for (const id of store.allNodeIds()) {
      const payload = store.get<TdbMemoryPayload>(id)?.payload
      if (payload?.kind === 'event_entity' && payload.id === entityId) return id
    }
    return undefined
  }

  private async commitCoverage(
    note: EventNote,
    options: EventWriteOptions,
    coverageOrigin: EventNote['origin'] = note.origin,
  ): Promise<void> {
    options.signal?.throwIfAborted()
    if (options.deferCoverage) return
    const coverageNote = { ...note, origin: coverageOrigin }
    const coverage = this.coverageFor([coverageNote], coverageOrigin.mode)
    if (options.coverageOwnerId) {
      await this.repo.commitCoverageUnderClaim(coverage, options.coverageOwnerId)
    } else {
      await this.repo.saveCoverage(coverage)
    }
  }

  private coverageFor(notes: EventNote[], mode: EventNote['origin']['mode']): ConversationCoverage {
    const origin = notes[0]!.origin
    return {
      id: randomUUID(),
      agentId: notes[0]!.agentId,
      threadId: origin.threadId,
      pairIds: [...new Set(notes.flatMap((note) => note.origin.pairIds))],
      messageIds: [...new Set(notes.flatMap((note) => note.origin.messageIds))],
      outcome: 'event_recorded',
      eventNoteIds: notes.map((note) => note.id),
      mode,
      coveredAt: new Date().toISOString(),
    }
  }

  private async requireCurrent(id: string): Promise<StoredEventNote> {
    const note = await this.repo.findById(id)
    if (!note || note.replacedBy) throw new Error('事件不存在或已被修订')
    return note
  }

  private validateDraft(input: EventNoteDraftInput): void {
    if (!input.narrative?.trim()) throw new Error('事件记叙不能为空')
    for (const [name, value] of [
      ['importance', input.importance],
      ['valence', input.affect?.valence],
      ['arousal', input.affect?.arousal],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > 10)
        throw new Error(`${name} 必须是0到10的整数`)
    }
  }

  private async allocateTdbId(): Promise<number> {
    if (this.nextTdbId === undefined) this.nextTdbId = (await this.repo.maxTdbId()) + 1
    return this.nextTdbId++
  }

  private listTdbNotes(agentId: string): EventNote[] {
    const store = this.stores.getAgentStore(agentId, 'main')
    return store.allNodeIds().flatMap((id) => {
      const payload = store.get<TdbEventPayload>(id)?.payload
      return payload?.kind === 'event_note' && !this.privacy?.deleted('memory', payload.id)
        ? [payload as EventNote]
        : []
    })
  }

  private findTdbNode(
    agentId: string,
    noteId: string,
  ): { id: number; note: EventNote } | undefined {
    const store = this.stores.getAgentStore(agentId, 'main')
    for (const id of store.allNodeIds()) {
      const payload = store.get<TdbEventPayload>(id)?.payload
      if (
        payload?.kind === 'event_note' &&
        payload.id === noteId &&
        !this.privacy?.deleted('memory', noteId)
      )
        return { id, note: payload }
    }
    return undefined
  }

  private async safeVector(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted()
    try {
      const vector = await this.embeddings.embedOne(text, signal)
      if (!vector.length && !this.embeddings.isAvailable)
        return new Array(this.stores.getDimension()).fill(0)
      if (vector.length !== this.stores.getDimension())
        throw new Error(
          `Embedding 维度不匹配：配置 ${this.stores.getDimension()} 维，实际 ${vector.length} 维`,
        )
      return vector
    } catch (error) {
      throw new AutomaticRagStageError('embedding', error)
    }
  }
}
