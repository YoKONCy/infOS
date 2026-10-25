import { t as __t } from '../../lib/i18n'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { EventNoteDraftInput, MemoryBackgroundPolicy } from '@infos/shared'
import { MemoryBackgroundControl } from './memoryBackgroundControl'
import { MemoryAgentScope } from './memoryAgentScope'
import type { EventNoteRepository } from '../../repositories/eventNote.repo'
import type { ThreadRepository } from '../../repositories/thread.repo'
import type { EventMemoryService } from './eventMemoryService'
import type { ModelConfig } from '../llm/llmService'
import { tokenCounter } from '../tokenizer/tokenCounter'
import { createLogger } from '../../lib/logger'

const logger = createLogger('EventMemoryFallbackService')
const INTERVAL_SECONDS = 8 * 60 * 60
type MemoryMessage = Awaited<ReturnType<ThreadRepository['findMessagesByPairIds']>>[number]
type ExtractionMessage = {
  role: string
  content: string
  timestamp: string
  pairId: string | null
}

export interface BackgroundEventExtractor {
  promptTokens?(agentId: string, channel: string): Promise<number>
  extract(input: {
    agentId: string
    threadId: string
    channel: string
    messages: ExtractionMessage[]
    signal?: AbortSignal
  }): Promise<EventNoteDraftInput[]>
}

interface MemoryCycle {
  runtimeSeconds: number
  throughMessageId: number
}

interface MemoryBatch {
  agentId: string
  threadId: string
  channel: string
  pairIds: string[]
}

export interface EventMemoryFallbackOptions {
  agents?: MemoryAgentScope
  background?: MemoryBackgroundPolicy
  intervalSeconds?: number
  safeInputTokens?: number
  getModelConfig?: () => Promise<ModelConfig | null>
  reservedPromptTokens?: number
  reservedOutputTokens?: number
  capacityRatio?: number
  retrySeconds?: number
  now?: () => Date
}

/** 按 Agent 的累计在线时长补记；轮数、窗口退出、休眠与日界均不触发模型。 */
export class EventMemoryFallbackService {
  private lastTickMs: number
  private previousAgents?: Set<string>
  private pendingRuntime = new Map<string, number>()
  private clockWrite: Promise<void> = Promise.resolve()
  private ticking?: Promise<void>
  private scanIncomplete = false
  private readonly options: Required<EventMemoryFallbackOptions>
  private readonly runtimeNow: () => number

  constructor(
    private repo: EventNoteRepository,
    private threads: ThreadRepository,
    private eventMemory: EventMemoryService,
    private extractor: BackgroundEventExtractor,
    options: EventMemoryFallbackOptions = {},
  ) {
    this.options = {
      agents: options.agents ?? new MemoryAgentScope(),
      background: options.background ?? new MemoryBackgroundControl(),
      intervalSeconds: options.intervalSeconds ?? INTERVAL_SECONDS,
      safeInputTokens: options.safeInputTokens ?? 0,
      getModelConfig: options.getModelConfig ?? (async () => null),
      reservedPromptTokens: options.reservedPromptTokens ?? 4_000,
      reservedOutputTokens: options.reservedOutputTokens ?? 2_000,
      capacityRatio: options.capacityRatio ?? 0.8,
      retrySeconds: options.retrySeconds ?? 5 * 60,
      now: options.now ?? (() => new Date()),
    }
    this.runtimeNow = options.now ? () => this.options.now().getTime() : () => performance.now()
    this.lastTickMs = this.runtimeNow()
  }

  /** 独立轻量心跳持续落盘，不因正在调用补记模型而漏计运行时间。 */
  checkpointRuntime(enabledAgentIds: string[]): Promise<void> {
    enabledAgentIds = enabledAgentIds.filter((id) => this.options.agents.isAvailable(id))
    const now = this.runtimeNow()
    const elapsed = Math.max(0, (now - this.lastTickMs) / 1000)
    const enabled = this.options.background.enabled
    // 心跳每 30 秒到达；系统挂起或时钟跳变形成的大间隔不计入在线时间。
    const delta = enabled && elapsed <= 90 ? Math.floor(elapsed) : 0
    const previous = this.previousAgents
    if (elapsed > 90 || !enabled) this.lastTickMs = now
    else if (delta > 0) this.lastTickMs += delta * 1000
    this.previousAgents = enabled ? new Set(enabledAgentIds) : new Set()
    if (enabled && delta > 0) {
      for (const agentId of new Set(enabledAgentIds)) {
        if (previous && !previous.has(agentId)) continue
        this.pendingRuntime.set(agentId, (this.pendingRuntime.get(agentId) ?? 0) + delta)
      }
    }
    const write = this.clockWrite
      .catch(() => undefined)
      .then(async () => {
        for (const [agentId, seconds] of [...this.pendingRuntime]) {
          if (!this.options.agents.isAvailable(agentId)) {
            this.pendingRuntime.delete(agentId)
            continue
          }
          await this.repo.advanceTimer(`background-runtime:${agentId}`, seconds)
          const remaining = (this.pendingRuntime.get(agentId) ?? 0) - seconds
          if (remaining > 0) this.pendingRuntime.set(agentId, remaining)
          else this.pendingRuntime.delete(agentId)
        }
      })
    this.clockWrite = write
    return write
  }

  tick(enabledAgentIds: string[], executionSignal?: AbortSignal): Promise<void> {
    if (this.ticking) return this.ticking
    const signal = AbortSignal.any([
      this.options.background.signal,
      ...(executionSignal ? [executionSignal] : []),
    ])
    this.ticking = (async () => {
      await this.checkpointRuntime(enabledAgentIds)
      if (!this.options.background.enabled || signal.aborted) return
      this.scanIncomplete = false
      for (const agentId of new Set(enabledAgentIds)) {
        signal.throwIfAborted()
        if (!this.options.agents.isAvailable(agentId)) continue
        const agentSignal = AbortSignal.any([signal, this.options.agents.signal(agentId)])
        const runtime = await this.repo.readTimer(`background-runtime:${agentId}`)
        const reviewed = await this.repo.readTimer(`background-reviewed-runtime:${agentId}`)
        if (agentSignal.aborted) continue
        if (runtime - reviewed < this.options.intervalSeconds) continue
        try {
          await this.reviewAgent(agentId, runtime, reviewed, agentSignal)
        } catch (error) {
          if (signal.aborted) return
          if (agentSignal.aborted) continue
          this.scanIncomplete = true
          logger.warn(__t('logs.memory', '定时补记尚未完成，保留周期进度等待重试'), {
            agentId,
            error,
          })
        }
      }
    })()
      .catch((error) => {
        if (!signal.aborted) throw error
      })
      .finally(() => {
        this.ticking = undefined
      })
    return this.ticking
  }

  get hasPendingWork(): boolean {
    return this.scanIncomplete
  }

  private async reviewAgent(
    agentId: string,
    runtimeSeconds: number,
    reviewed: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const cycleId = `background:cycle:${agentId}:${reviewed}`
    const saved = await this.repo.findOperation(cycleId)
    const cycle = (saved?.payload as MemoryCycle | undefined) ?? {
      runtimeSeconds,
      throughMessageId: await this.threads.latestMemoryMessageId(),
    }
    signal.throwIfAborted()
    // 固定本周期边界；分批和失败重试都不会顺带追赶后来追加的对话。
    if (!saved) await this.repo.createOperation(cycleId, agentId, 'background_cycle', cycle)
    let incomplete = false
    for (let page = 1; ; page++) {
      signal.throwIfAborted()
      const result = await this.threads.listThreads({
        agentId,
        purpose: 'conversation',
        pageSize: 100,
        page,
      })
      for (const thread of result.items) {
        signal.throwIfAborted()
        const messages = await this.threads.queryMemoryMessagesThrough(
          thread.id,
          cycle.throughMessageId,
        )
        const covered = await this.repo.coveredPairIds(agentId, thread.id)
        const segments = this.eligibleSegments(messages, covered)
        if (!segments.length) continue
        const scheduleKey = `${agentId}:${thread.id}`
        if (
          (await this.repo.memoryScheduleTime(`retry:${scheduleKey}`)) >
          this.options.now().getTime()
        ) {
          incomplete = true
          continue
        }
        try {
          const capacity = await this.capacityTokens(agentId, thread.channel)
          const costs = this.pairTokenCosts(messages, new Set(segments.flat()))
          for (const segment of segments) {
            for (const pairIds of this.sliceByCapacity(costs, segment, capacity)) {
              signal.throwIfAborted()
              if (
                !(await this.process(
                  { agentId, threadId: thread.id, channel: thread.channel, pairIds },
                  capacity,
                  signal,
                ))
              ) {
                incomplete = true
              }
            }
          }
          await this.repo.setMemoryScheduleTime(`retry:${scheduleKey}`, 0)
          await this.repo.resetTimer(`fallback-failures:${scheduleKey}`)
        } catch (error) {
          if (signal.aborted) throw error
          incomplete = true
          const failures = await this.repo.advanceTimer(`fallback-failures:${scheduleKey}`, 1)
          const delay = Math.min(
            60 * 60,
            this.options.retrySeconds * 2 ** Math.min(failures - 1, 8),
          )
          await this.repo.setMemoryScheduleTime(
            `retry:${scheduleKey}`,
            this.options.now().getTime() + delay * 1000,
          )
          logger.warn(__t('logs.memory', '后台事件补记失败，已延迟重试'), {
            agentId,
            threadId: thread.id,
            retrySeconds: delay,
            error,
          })
        }
      }
      if (page * 100 >= result.total || !result.items.length) break
    }
    signal.throwIfAborted()
    if (incomplete) {
      this.scanIncomplete = true
      return
    }
    await this.repo.markOperationCommitted(cycleId)
    await this.repo.checkpointTimer(`background-reviewed-runtime:${agentId}`, cycle.runtimeSeconds)
    logger.info(__t('logs.memory', 'Agent 八小时补记周期已完成'), {
      agentId,
      throughMessageId: cycle.throughMessageId,
    })
  }

  private async capacityTokens(agentId: string, channel: string): Promise<number> {
    if (this.options.safeInputTokens > 0) {
      const capacity = Math.floor(this.options.safeInputTokens * this.options.capacityRatio)
      if (capacity < 64) throw new Error('后台补记输入预算不足以容纳来源标识与正文')
      return capacity
    }
    const config = await this.options.getModelConfig()
    if (!config?.contextWindowTokens) throw new Error('后台事件补记模型未配置上下文窗口')
    const promptReserve = Math.max(
      this.options.reservedPromptTokens,
      (await this.extractor.promptTokens?.(agentId, channel)) ?? 0,
    )
    const outputReserve = Math.max(this.options.reservedOutputTokens, config.maxTokens ?? 0)
    const safeInput = config.contextWindowTokens - promptReserve - outputReserve
    if (safeInput <= 0) throw new Error('后台事件补记模型上下文窗口不足以容纳人格与预留内容')
    const capacity = Math.floor(safeInput * this.options.capacityRatio)
    if (capacity < 64) throw new Error('后台补记输入预算不足以容纳来源标识与正文')
    return capacity
  }

  private completedPairs(messages: MemoryMessage[]): string[] {
    const users = new Set(
      messages.filter((message) => message.role === 'user').map((message) => message.pairId),
    )
    const assistants = new Set(
      messages.filter((message) => message.role === 'assistant').map((message) => message.pairId),
    )
    return [...new Set(messages.map((message) => message.pairId))].filter(
      (id): id is string => Boolean(id) && users.has(id) && assistants.has(id),
    )
  }

  private eligibleSegments(messages: MemoryMessage[], covered: Set<string>): string[][] {
    const ordered = [...new Set(messages.map((message) => message.pairId))].filter(
      (id): id is string => Boolean(id),
    )
    const complete = new Set(this.completedPairs(messages))
    return this.uncoveredSegments(
      ordered,
      new Set([...covered, ...ordered.filter((id) => !complete.has(id))]),
    )
  }

  private uncoveredSegments(pairIds: string[], blocked: Set<string>): string[][] {
    const segments: string[][] = []
    let current: string[] = []
    for (const pairId of pairIds) {
      if (blocked.has(pairId)) {
        if (current.length) segments.push(current)
        current = []
      } else current.push(pairId)
    }
    if (current.length) segments.push(current)
    return segments
  }

  private pairTokenCosts(messages: MemoryMessage[], selected: Set<string>): Map<string, number> {
    const costs = new Map<string, number>()
    for (const message of messages) {
      if (message.pairId && selected.has(message.pairId))
        costs.set(
          message.pairId,
          (costs.get(message.pairId) ?? 0) + tokenCounter.countTokens(message.content) + 48,
        )
    }
    return costs
  }

  private sliceByCapacity(
    costs: Map<string, number>,
    pairIds: string[],
    capacity: number,
  ): string[][] {
    const slices: string[][] = []
    let current: string[] = []
    let tokens = 0
    for (const pairId of pairIds) {
      const cost = costs.get(pairId) ?? 0
      if (current.length && tokens + cost > capacity) {
        slices.push(current)
        current = []
        tokens = 0
      }
      current.push(pairId)
      tokens += cost
    }
    if (current.length) slices.push(current)
    return slices
  }

  /** 普通轮次整体入批；单轮过大时切分正文，全部片段完成后才标记整轮覆盖。 */
  private extractionBatches(messages: MemoryMessage[], capacity: number): ExtractionMessage[][] {
    const batches: ExtractionMessage[][] = []
    let current: ExtractionMessage[] = []
    let tokens = 0
    for (const message of messages) {
      let remaining = message.content
      do {
        const available = capacity - tokens - 48
        if (available <= 0 && current.length) {
          batches.push(current)
          current = []
          tokens = 0
          continue
        }
        const budget = Math.max(1, available)
        let length = remaining.length
        if (tokenCounter.countTokens(remaining) > budget) {
          let low = 1
          let high = remaining.length
          while (low < high) {
            const middle = Math.ceil((low + high) / 2)
            if (tokenCounter.countTokens(remaining.slice(0, middle)) <= budget) low = middle
            else high = middle - 1
          }
          length = low
          // 不从 Unicode 代理对中间切开图片名、表情与其他补充平面文字。
          if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1]!)) length--
          if (length <= 0 || tokenCounter.countTokens(remaining.slice(0, length)) > budget) {
            if (current.length) {
              batches.push(current)
              current = []
              tokens = 0
              continue
            }
            throw new Error('补记输入预算不足以容纳单个字符')
          }
        }
        const content = remaining.slice(0, length)
        current.push({
          role: message.role,
          content,
          timestamp: message.timestamp ?? this.options.now().toISOString(),
          pairId: message.pairId,
        })
        tokens += tokenCounter.countTokens(content) + 48
        remaining = remaining.slice(length)
        if (remaining.length) {
          batches.push(current)
          current = []
          tokens = 0
        }
      } while (remaining.length)
    }
    if (current.length) batches.push(current)
    return batches
  }

  private async process(
    task: MemoryBatch,
    capacity: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted()
    const thread = await this.threads.getThread(task.threadId)
    if (!thread || thread.status !== 'active' || thread.agentId !== task.agentId) return true
    const covered = await this.repo.coveredPairIds(task.agentId, task.threadId)
    const available = await this.threads.findMessagesByPairIds(task.threadId, task.pairIds)
    const complete = new Set(this.completedPairs(available))
    const pairIds = task.pairIds.filter((id) => !covered.has(id) && complete.has(id))
    if (!pairIds.length) return true
    const segments = this.uncoveredSegments(
      task.pairIds,
      new Set(task.pairIds.filter((id) => !pairIds.includes(id))),
    )
    if (segments.length > 1) {
      let completed = true
      for (const segment of segments) {
        if (!(await this.process({ ...task, pairIds: segment }, capacity, signal)))
          completed = false
      }
      return completed
    }
    const selected = new Set(pairIds)
    const messages = available.filter((message) => message.pairId && selected.has(message.pairId))
    const revision = this.messageRevision(messages)
    const ownerId = `background:${task.agentId}:${task.threadId}:${randomUUID()}`
    const claimed = await this.repo.claimCoverageRange({
      agentId: task.agentId,
      threadId: task.threadId,
      pairIds,
      ownerId,
      staleBefore: new Date(this.options.now().getTime() - 30 * 60_000).toISOString(),
    })
    if (!claimed) return false
    logger.info(__t('logs.memory', '开始八小时定时补记批次'), {
      agentId: task.agentId,
      threadId: task.threadId,
      pairs: pairIds.length,
    })
    try {
      const aggregateId = `background:extract:v2:${task.agentId}:${task.threadId}:${revision}`
      const aggregate = await this.repo.findOperation(aggregateId)
      const cachedDrafts = (aggregate?.payload as { drafts: EventNoteDraftInput[] } | undefined)
        ?.drafts
      const drafts: EventNoteDraftInput[] = cachedDrafts ?? []
      const batches = cachedDrafts ? [] : this.extractionBatches(messages, capacity)
      const extractionIds: string[] = []
      for (const [index, batch] of (cachedDrafts ? [] : batches).entries()) {
        signal.throwIfAborted()
        await this.repo.renewCoverageClaim(ownerId)
        // 位置与正文共同标识片段；相同正文出现在不同位置时仍须分别审阅。
        const partHash = createHash('sha256').update(JSON.stringify(batch)).digest('hex')
        const extractionId = `background:extract:v2:${task.agentId}:${task.threadId}:${revision}:${index}:${partHash}`
        const saved = await this.repo.findOperation(extractionId)
        const pending = saved?.payload as { drafts: EventNoteDraftInput[] } | undefined
        const result =
          pending?.drafts ?? (await this.extractor.extract({ ...task, messages: batch, signal }))
        signal.throwIfAborted()
        const current = await this.threads.getThread(task.threadId)
        const currentMessages = await this.threads.findMessagesByPairIds(task.threadId, pairIds)
        signal.throwIfAborted()
        if (
          !current ||
          current.status !== 'active' ||
          this.messageRevision(currentMessages) !== revision
        )
          return false
        if (!saved)
          await this.repo.createOperation(extractionId, task.agentId, 'background_extraction', {
            agentId: task.agentId,
            drafts: result,
            origin: {
              threadId: task.threadId,
              pairIds,
              messageIds: messages.map((message) => String(message.id)),
            },
          })
        extractionIds.push(extractionId)
        drafts.push(...result)
        logger.info(__t('logs.memory', '定时补记模型分批已完成'), {
          agentId: task.agentId,
          batch: index + 1,
          batches: batches.length,
        })
      }
      const latest = await this.threads.findMessagesByPairIds(task.threadId, pairIds)
      const currentThread = await this.threads.getThread(task.threadId)
      signal.throwIfAborted()
      if (
        !currentThread ||
        currentThread.status !== 'active' ||
        this.messageRevision(latest) !== revision
      ) {
        logger.info(__t('logs.memory', '补记期间来源已变化，放弃旧结果并保留本周期待处理状态'), {
          threadId: task.threadId,
        })
        return false
      }
      const notes = []
      const messageIds = messages.map((message) => String(message.id))
      if (!aggregate)
        await this.repo.createOperation(aggregateId, task.agentId, 'background_extraction', {
          agentId: task.agentId,
          drafts,
          origin: { threadId: task.threadId, pairIds, messageIds },
        })
      for (const [index, draft] of drafts.entries()) {
        signal.throwIfAborted()
        notes.push(
          await this.eventMemory.create(
            {
              ...draft,
              agentId: task.agentId,
              eventAt: new Date(messages.at(-1)!.timestamp ?? this.options.now()).toISOString(),
              origin: {
                mode: 'background',
                threadId: task.threadId,
                pairIds,
                messageIds,
                channel: task.channel,
              },
            },
            `background:${task.agentId}:${task.threadId}:${revision}:${index}`,
            { deferCoverage: true, signal },
          ),
        )
      }
      signal.throwIfAborted()
      await this.repo.commitCoverageUnderClaim(
        {
          id: randomUUID(),
          agentId: task.agentId,
          threadId: task.threadId,
          pairIds,
          messageIds,
          outcome: notes.length ? 'event_recorded' : 'reviewed_no_event',
          eventNoteIds: notes.map((note) => note.id),
          mode: 'background',
          coveredAt: this.options.now().toISOString(),
        },
        ownerId,
      )
      for (const id of extractionIds) {
        signal.throwIfAborted()
        await this.repo.markOperationCommitted(id)
      }
      signal.throwIfAborted()
      await this.repo.markOperationCommitted(aggregateId)
      logger.info(__t('logs.memory', '后台定时补记批次已落盘'), {
        agentId: task.agentId,
        pairs: pairIds.length,
        events: notes.length,
      })
      return true
    } finally {
      await this.repo.releaseCoverageClaim(ownerId)
    }
  }

  private messageRevision(messages: MemoryMessage[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify(
          messages.map((message) => [
            message.id,
            message.pairId,
            message.role,
            message.revision,
            message.content,
          ]),
        ),
      )
      .digest('hex')
  }
}
