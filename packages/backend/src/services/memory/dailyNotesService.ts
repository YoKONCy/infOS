import { existsSync, readFileSync } from 'node:fs'
import type { EventNote, MemoryBackgroundPolicy } from '@infos/shared'
import { MemoryBackgroundControl } from './memoryBackgroundControl'
import { MemoryAgentScope } from './memoryAgentScope'
import type { PathResolver } from '../../core/pathResolver'
import type { EventMemoryService } from './eventMemoryService'
import type { EventNoteRepository } from '../../repositories/eventNote.repo'
import type { ThreadRepository } from '../../repositories/thread.repo'
import type { AgentManager } from '../agent/agentManager'
import type { LocalWorkspaceService } from '../workspace/workspaceService'
import type { LlmService, ModelConfig } from '../llm/llmService'
import { tokenCounter } from '../tokenizer/tokenCounter'
import { formatEventTime } from './eventMemoryTime'

const RETRY_MINUTES = [10, 30, 60] as const

export class DailyNotesService {
  private agents = new MemoryAgentScope()
  setAgentScope(agents: MemoryAgentScope): void {
    this.agents = agents
  }
  private background: MemoryBackgroundPolicy = new MemoryBackgroundControl()
  setBackgroundPolicy(policy: MemoryBackgroundPolicy): void {
    this.background = policy
  }
  async pauseBackground(): Promise<void> {
    this.generation++
    for (const controller of this.controllers) controller.abort(new Error('长记忆后台任务已关闭'))
    this.controllers.clear()
    await Promise.allSettled([...this.writes])
  }
  private generation = 0
  private controllers = new Set<AbortController>()
  private writes = new Set<Promise<void>>()
  async invalidateForDeletion(): Promise<void> {
    this.generation++
    for (const controller of this.controllers)
      controller.abort(new Error('日记来源已发生删除，已停止旧任务'))
    this.controllers.clear()
    await Promise.allSettled([...this.writes])
  }
  async removeGeneratedFile(agentId: string, name: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}(?:-part-\d+)?\.md$/.test(name)) throw new Error('日记文件名不合法')
    try {
      await this.workspace.deleteFile(agentId, `dailynotes/${name}`, 'desktop')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('文件不存在:')) throw error
    }
  }
  constructor(
    private eventMemory: EventMemoryService,
    private agentManager: AgentManager,
    private workspace: LocalWorkspaceService,
    private pathResolver: PathResolver,
    private llm: LlmService,
    private getModelConfig: (agentId: string) => Promise<ModelConfig | null>,
    private repo: EventNoteRepository,
    private threads?: Pick<ThreadRepository, 'findMessagesByPairIds'>,
    private collectApplicationSummaries?: (agentId: string, date: string) => Promise<string[]>,
    private now: () => Date = () => new Date(),
  ) {}

  setApplicationSummaryCollector(
    collector: (agentId: string, date: string) => Promise<string[]>,
  ): void {
    this.collectApplicationSummaries = collector
  }

  async generate(agentId: string, date: string, sourceIncomplete = false): Promise<string[]> {
    if (!this.agents.isAvailable(agentId) || !this.background.enabled) return []
    const agentSignal = this.agents.signal(agentId)
    const backgroundSignal = this.background.signal
    const generation = this.generation
    await this.repo.ensureDailyNoteTask({
      id: `daily-note:${agentId}:${date}`,
      agentId,
      date,
      sourceIncomplete,
    })
    const task = await this.repo.dailyNoteTask(agentId, date)
    if (agentSignal.aborted) return []
    if (!task || task.status === 'completed') return task?.writtenFiles ?? []
    if (task.status === 'exhausted') return []
    const now = this.now()
    if (task.nextAttemptAt && task.nextAttemptAt > now.toISOString()) return []

    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, backgroundSignal, agentSignal])
    this.controllers.add(controller)
    try {
      signal.throwIfAborted()
      const notes = (
        await this.eventMemory.query({
          agentId,
          mode: 'time_range',
          includeArchived: true,
          limit: 10_000,
        })
      )
        .filter((note) => this.localDate(new Date(note.eventAt)) === date)
        .sort((a, b) => a.eventAt.localeCompare(b.eventAt))
      const reviewedInteractions = await this.reviewedInteractions(agentId, date)
      const applicationSummaries = this.collectApplicationSummaries
        ? await this.collectApplicationSummaries(agentId, date)
        : []
      const chunks = this.chunk(notes, reviewedInteractions, applicationSummaries, 20_000)
      const written: string[] = []
      for (const [index, chunk] of chunks.entries()) {
        signal.throwIfAborted()
        const content = await this.render(
          agentId,
          date,
          chunk.notes,
          chunk.reviewedInteractions,
          chunk.applicationSummaries,
          signal,
        )
        signal.throwIfAborted()
        if (generation !== this.generation) throw new Error('日记来源已删除，已阻止迟到写入')
        const fileName = chunks.length === 1 ? `${date}.md` : `${date}-part-${index + 1}.md`
        // 写入前登记本服务拥有的输出文件，崩溃或删除并发时仍能找到副本。
        await this.repo.recordDailyNoteFile(task.id, fileName)
        signal.throwIfAborted()
        const writing = this.workspace
          .write(agentId, `dailynotes/${fileName}`, content, 'desktop')
          .then(() => {})
        this.writes.add(writing)
        try {
          await writing
        } finally {
          this.writes.delete(writing)
        }
        signal.throwIfAborted()
        if (generation !== this.generation) return []
        written.push(fileName)
      }
      signal.throwIfAborted()
      await this.repo.completeDailyNoteTask(task.id, written)
      return written
    } catch (error) {
      if (generation !== this.generation || backgroundSignal.aborted || agentSignal.aborted)
        return []
      const retryMinutes = RETRY_MINUTES[task.attempts]
      const nextAttemptAt =
        retryMinutes === undefined
          ? null
          : new Date(now.getTime() + retryMinutes * 60_000).toISOString()
      await this.repo.failDailyNoteTask(task.id, String(error), nextAttemptAt)
      throw error
    } finally {
      this.controllers.delete(controller)
    }
  }

  private async render(
    agentId: string,
    date: string,
    notes: EventNote[],
    reviewedInteractions: string[],
    applicationSummaries: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const config = await this.getModelConfig(agentId)
    signal?.throwIfAborted()
    if (!config) throw new Error('日记生成模型未配置')
    const profile = this.agentManager.getAgent(agentId)
    const promptPath =
      profile?.promptPath ?? this.pathResolver.resolve(`@data/agents/${agentId}/system_prompt.md`)
    const persona = existsSync(promptPath) ? readFileSync(promptPath, 'utf-8') : ''
    const promptNotes = notes.map((note) => ({
      ...note,
      eventAt: formatEventTime(note.eventAt),
      createdAt: formatEventTime(note.createdAt),
    }))
    const diary = await this.llm.chatText(
      config,
      [
        {
          role: 'system',
          content: `你是${agentId}。以下是你的人格设定：\n${persona}\n请严格以第一人称和该人格写当天日记。只能根据事件记忆，不得写系统状态、任务错误或技术审计信息。输出Markdown正文，不要代码围栏。`,
        },
        {
          role: 'user',
          content: `日期：${date}\n事件记忆：\n${JSON.stringify(promptNotes)}\n已审阅但未形成事件的互动：\n${JSON.stringify(reviewedInteractions)}\nApplication当日摘要：\n${JSON.stringify(applicationSummaries)}`,
        },
      ],
      {
        signal,
        promptTask: 'memory.diary',
        promptVariables: {
          agent_id: agentId,
          persona_definition: persona,
          owner_appellation: profile?.ownerAppellation ?? '主人',
        },
        promptSources: ['persona_definition'],
        temperature: 0.6,
        maxTokens: 3000,
        usageContext: { agentId, purpose: 'memory' },
      },
    )
    return `# ${date}\n\n${diary.trim()}\n`
  }

  private async reviewedInteractions(agentId: string, date: string): Promise<string[]> {
    if (!this.threads) return []
    const coverages = (await this.repo.reviewedNoEventCoverages(agentId))
      .filter((coverage) => this.localDate(new Date(coverage.coveredAt)) === date)
      .sort((a, b) => a.coveredAt.localeCompare(b.coveredAt))
    const interactions: string[] = []
    for (const coverage of coverages) {
      const messages = await this.threads.findMessagesByPairIds(coverage.threadId, coverage.pairIds)
      const content = messages
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n')
        .trim()
      if (content) interactions.push(content)
    }
    return interactions
  }

  private chunk(
    notes: EventNote[],
    reviewedInteractions: string[],
    applicationSummaries: string[],
    tokenLimit: number,
  ): Array<{
    notes: EventNote[]
    reviewedInteractions: string[]
    applicationSummaries: string[]
  }> {
    const sources = [
      ...notes.map((note) => ({
        kind: 'note' as const,
        value: note,
        tokens: tokenCounter.countTokens(JSON.stringify(note)),
      })),
      ...reviewedInteractions.map((value) => ({
        kind: 'reviewed' as const,
        value,
        tokens: tokenCounter.countTokens(value),
      })),
      ...applicationSummaries.map((value) => ({
        kind: 'application' as const,
        value,
        tokens: tokenCounter.countTokens(value),
      })),
    ]
    if (!sources.length) return []
    const chunks: Array<{
      notes: EventNote[]
      reviewedInteractions: string[]
      applicationSummaries: string[]
    }> = []
    let current = {
      notes: [] as EventNote[],
      reviewedInteractions: [] as string[],
      applicationSummaries: [] as string[],
    }
    let tokens = 0
    for (const source of sources) {
      if (tokens && tokens + source.tokens > tokenLimit) {
        chunks.push(current)
        current = { notes: [], reviewedInteractions: [], applicationSummaries: [] }
        tokens = 0
      }
      if (source.kind === 'note') current.notes.push(source.value)
      else if (source.kind === 'reviewed') current.reviewedInteractions.push(source.value)
      else current.applicationSummaries.push(source.value)
      tokens += source.tokens
    }
    chunks.push(current)
    return chunks
  }

  private localDate(value: Date): string {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  }
}
