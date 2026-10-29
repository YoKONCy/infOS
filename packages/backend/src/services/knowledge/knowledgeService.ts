import { t as __t } from '../../lib/i18n'
import { createHash, randomUUID } from 'node:crypto'
import type {
  KernelExecutionId,
  KnowledgeDocumentDetail,
  KnowledgeDocumentInfo,
  KnowledgeSourceKind,
} from '@infos/shared'
import type { KnowledgeRepository, KnowledgeDocumentRow } from '../../repositories/knowledge.repo'
import type { LlmService, ModelConfig } from '../llm/llmService'
import type { EmbeddingService } from '../embedding/embeddingService'
import type { KernelScheduler, KernelScheduledExecutionContext } from '../../kernel/kernelScheduler'
import { AppError } from '../../lib/appError'
import { createLogger } from '../../lib/logger'
import { KnowledgeIndex, knowledgeEmbeddingKey, validKnowledgeVector } from './knowledgeIndex'
import { normalizeKnowledgeText } from './knowledgeText'
import { organizeKnowledge } from './knowledgeOrganizer'
import type { PrivacyPolicy } from '../maintenance/privacyPolicy'

const logger = createLogger('KnowledgeService')
type Job = { revision: number; cancelled: boolean; executionId?: KernelExecutionId }

export class KnowledgeService {
  private privacy?: PrivacyPolicy
  private deletePermanently?: (id: string) => Promise<void>
  setPrivacyPolicy(policy: PrivacyPolicy, purge: (id: string) => Promise<void>): void {
    this.privacy = policy
    this.deletePermanently = purge
    this.repo.setPrivacyPolicy(policy)
  }
  private jobs = new Map<string, Job>()
  private reindexJob: Job | null = null
  private disposed = false
  private clearing = false
  private generation = 0
  private readonly unsubscribe: () => void

  constructor(
    readonly repo: KnowledgeRepository,
    readonly index: KnowledgeIndex,
    private readonly llm: LlmService,
    private readonly getModel: () => Promise<ModelConfig | null>,
    private readonly embedding: EmbeddingService,
    private readonly scheduler: KernelScheduler,
  ) {
    this.unsubscribe = scheduler.subscribe((snapshot) => {
      if (!['failed', 'cancelled', 'timed_out', 'completed'].includes(snapshot.state)) return
      for (const [id, job] of this.jobs) {
        if (job.executionId !== snapshot.descriptor.executionId) continue
        this.jobs.delete(id)
        const row = this.repo.get(id)
        if (row?.revision === job.revision && ['queued', 'processing'].includes(row.status)) {
          this.repo.update(id, job.revision, {
            status: 'failed',
            error:
              snapshot.state === 'timed_out'
                ? '整理超时，请换用更快的模型或拆分文档后重试'
                : '整理任务被中断，请重试',
          })
        }
      }
      if (this.reindexJob?.executionId === snapshot.descriptor.executionId) {
        this.reindexJob = null
        this.repo.failPendingVectors('向量索引任务被中断，请重建索引')
      }
    })
  }

  async initialize(): Promise<void> {
    this.repo.recover()
    this.embeddingChanged()
    for (const row of this.repo.pending()) await this.enqueue(row)
  }

  detail(id: string): KnowledgeDocumentDetail {
    const row = this.requireDocument(id)
    return {
      ...this.repo.info(row),
      parts: this.repo.parts(id).map((part) => this.repo.partInfo(part)),
    }
  }

  private requireDocument(id: string): KnowledgeDocumentRow {
    const row = this.repo.get(id)
    if (!row) throw new AppError('NOT_FOUND', { message: '这份资料已不存在' })
    return row
  }

  async import(input: {
    title: string
    content: string
    sourceKind: KnowledgeSourceKind
    source?: string
    replaceId?: string
  }): Promise<KnowledgeDocumentInfo> {
    const generation = this.generation
    if (!(await this.getModel()))
      throw new AppError('BAD_REQUEST', { message: '请先在模型配置中指定知识整理模型或主模型' })
    if (this.disposed || this.clearing)
      throw new AppError('RESOURCE_BUSY', { message: '知识库暂不可写入，请稍后重试' })
    if (generation !== this.generation)
      throw new AppError('RESOURCE_BUSY', { message: '资料库已清理，请重新导入' })
    const normalized = normalizeKnowledgeText(input.content)
    const fields = {
      title: input.title.trim().slice(0, 200) || __t('server.knowledge', '未命名资料'),
      sourceKind: input.sourceKind,
      source: input.source ?? '',
      ...normalized,
      contentHash: createHash('sha256').update(normalized.content).digest('hex'),
    }
    let row: KnowledgeDocumentRow
    let cancellation: Promise<void> | undefined
    if (input.replaceId) {
      this.requireDocument(input.replaceId)
      cancellation = this.cancel(input.replaceId)
      row = this.repo.replace(input.replaceId, fields)
    } else {
      const now = new Date().toISOString()
      row = this.repo.create({
        id: randomUUID(),
        ...fields,
        status: 'queued',
        vectorStatus: 'skipped',
        createdAt: now,
        updatedAt: now,
      })
    }
    try {
      this.index.rebuild()
    } catch (cause) {
      this.repo.update(row.id, row.revision, {
        status: 'failed',
        error: `索引准备失败：${(cause as Error).message}`,
      })
    }
    await cancellation?.catch((cause) =>
      logger.warn(__t('logs.knowledge', '旧资料任务取消失败：{0}', [(cause as Error).message])),
    )
    await this.enqueue(row)
    return this.repo.info(this.requireDocument(row.id))
  }

  async retry(id: string): Promise<KnowledgeDocumentInfo> {
    const row = this.requireDocument(id)
    if (row.status !== 'failed')
      throw new AppError('BAD_REQUEST', { message: '仅失败的整理任务需要重试' })
    return this.import({
      title: row.title,
      content: row.content,
      sourceKind: row.sourceKind as KnowledgeSourceKind,
      source: row.source,
      replaceId: id,
    })
  }

  async delete(id: string): Promise<void> {
    if (this.deletePermanently) return this.deletePermanently(id)
    this.requireDocument(id)
    const cancellation = this.cancel(id)
    this.repo.delete(id)
    this.index.rebuild()
    await cancellation
  }

  /** 永久清理时重建物理索引文件，避免删除节点的旧正文留在附属索引中。 */
  async purge(id: string): Promise<void> {
    this.generation++
    await this.cancel(id)
    if (this.reindexJob) {
      this.reindexJob.cancelled = true
      if (this.reindexJob.executionId) await this.scheduler.cancel(this.reindexJob.executionId)
      this.reindexJob = null
    }
    this.repo.delete(id)
    this.index.resetPhysicalStore()
  }

  private async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    job.cancelled = true
    this.jobs.delete(id)
    if (job.executionId) await this.scheduler.cancel(job.executionId)
  }

  private async enqueue(row: KnowledgeDocumentRow): Promise<void> {
    const current = this.repo.version(row.id)
    if (
      this.disposed ||
      this.clearing ||
      this.jobs.has(row.id) ||
      current?.revision !== row.revision ||
      current.status !== 'queued'
    )
      return
    const job: Job = { revision: row.revision, cancelled: false }
    this.jobs.set(row.id, job)
    try {
      const snapshot = await this.scheduler.submit({
        principalId: 'system:knowledge',
        class: 'background',
        taskId: `knowledge:${row.id}`,
        resourceKey: 'knowledge:organize',
        budget: { maxDurationMs: 600_000, maxLlmCalls: 2 },
        run: async ({ signal, descriptor }) => {
          job.executionId = descriptor.executionId
          if (job.cancelled || this.disposed) return
          const active = () =>
            !job.cancelled &&
            !signal.aborted &&
            !this.privacy?.deleted('knowledge', row.id) &&
            this.repo.get(row.id)?.revision === row.revision
          try {
            const model = await this.getModel()
            if (!active()) return
            if (!model) throw new Error('未配置知识整理模型或主模型')
            this.repo.update(row.id, row.revision, {
              status: 'processing',
              modelName: model.modelId,
              error: null,
            })
            const parts = await organizeKnowledge(
              this.llm,
              model,
              row.title,
              row.content,
              row.tokenCount,
              signal,
            )
            if (!active()) return
            let vectorStatus = 'skipped'
            let vectorError: string | null = null
            if (this.embedding.isAvailable) {
              const key = knowledgeEmbeddingKey(this.embedding)
              try {
                const vectors = await this.embedding.embed(
                  parts.map((part) => part.summary),
                  signal,
                )
                if (!active()) return
                if (key !== knowledgeEmbeddingKey(this.embedding))
                  throw new Error('向量模型已变更，请重建索引')
                if (
                  vectors.length !== parts.length ||
                  vectors.some((v) => !validKnowledgeVector(v, this.embedding.getDimension()))
                )
                  throw new Error('向量数量或维度不正确')
                parts.forEach((part, i) => {
                  part.embeddingJson = JSON.stringify(vectors[i])
                  part.embeddingKey = key
                })
                vectorStatus = 'ready'
              } catch (cause) {
                vectorStatus = this.embedding.isAvailable ? 'failed' : 'skipped'
                vectorError = this.embedding.isAvailable
                  ? `摘要已整理，向量索引失败：${(cause as Error).message}`
                  : null
              }
            }
            if (!active()) return
            if (this.repo.publish(row.id, row.revision, parts, vectorStatus)) {
              this.repo.update(row.id, row.revision, { error: vectorError })
              this.index.rebuild()
            }
          } catch (cause) {
            if (!active()) return
            this.repo.update(row.id, row.revision, {
              status: 'failed',
              error: (cause as Error).message,
            })
            logger.warn(
              __t('logs.knowledge', '资料整理失败：{0}，{1}', [
                row.title,
                (cause as Error).message,
              ]),
            )
            throw cause
          }
        },
      })
      job.executionId = snapshot.descriptor.executionId
      if (job.cancelled || this.disposed) await this.scheduler.cancel(job.executionId)
    } catch (cause) {
      if (this.jobs.get(row.id) === job) this.jobs.delete(row.id)
      this.repo.update(row.id, row.revision, {
        status: 'failed',
        error: `整理未能排队：${(cause as Error).message}`,
      })
    }
  }

  /** 换模型后旧向量不参与查询；资料与摘要仍可用关键词检索。 */
  embeddingChanged(): void {
    const key = knowledgeEmbeddingKey(this.embedding)
    for (const row of this.repo.readyDocuments()) {
      const parts = this.repo.parts(row.id)
      const valid =
        parts.length > 0 &&
        parts.every((part) => {
          if (part.embeddingKey !== key || !part.embeddingJson) return false
          try {
            return validKnowledgeVector(
              JSON.parse(part.embeddingJson),
              this.embedding.getDimension(),
            )
          } catch {
            return false
          }
        })
      const vectorStatus = !this.embedding.isAvailable
        ? 'skipped'
        : valid
          ? 'ready'
          : row.vectorStatus === 'failed'
            ? 'failed'
            : 'stale'
      if (row.vectorStatus !== vectorStatus)
        this.repo.update(row.id, row.revision, {
          vectorStatus,
          error: row.vectorStatus === 'failed' ? row.error : null,
        })
    }
    this.index.configurationChanged()
  }

  async reindex(
    resetPhysical = false,
    execution?: Pick<KernelScheduledExecutionContext, 'signal' | 'descriptor'>,
  ): Promise<KernelExecutionId | undefined> {
    if (this.disposed || this.clearing)
      throw new AppError('RESOURCE_BUSY', { message: '知识库暂不可重建，请稍后重试' })
    if (this.reindexJob || (resetPhysical && this.jobs.size))
      throw new AppError('RESOURCE_BUSY', { message: '文档索引任务正在运行，请稍后重试' })
    if (resetPhysical) await this.index.resetPhysicalStoreForMaintenance(execution?.signal)
    else this.index.rebuild()
    if (!this.embedding.isAvailable) {
      this.embeddingChanged()
      return
    }
    const job: Job = { revision: 0, cancelled: false }
    this.reindexJob = job
    for (const row of this.repo.readyDocuments())
      this.repo.update(row.id, row.revision, { vectorStatus: 'pending', error: null })
    try {
      const run = async ({
        signal,
        descriptor,
      }: Pick<KernelScheduledExecutionContext, 'signal' | 'descriptor'>) => {
        job.executionId = descriptor.executionId
        if (job.cancelled || this.disposed) return
        const key = knowledgeEmbeddingKey(this.embedding)
        for (const row of this.repo.readyDocuments()) {
          if (!this.embedding.isAvailable) break
          if (signal.aborted || job.cancelled || this.disposed) return
          const parts = this.repo.parts(row.id)
          try {
            const vectors = await this.embedding.embed(
              parts.map((part) => part.summary),
              signal,
            )
            if (signal.aborted || job.cancelled || this.disposed) return
            if (!this.embedding.isAvailable) break
            if (key !== knowledgeEmbeddingKey(this.embedding))
              throw new Error('向量模型已变更，请重新重建索引')
            const current = this.repo.get(row.id)
            if (current?.revision !== row.revision || current.status !== 'ready') continue
            if (
              vectors.length !== parts.length ||
              vectors.some((v) => !validKnowledgeVector(v, this.embedding.getDimension()))
            )
              throw new Error('向量数量或维度不正确')
            parts.forEach((part, i) => this.repo.saveVector(part.id, vectors[i]!, key))
            this.repo.update(row.id, row.revision, { vectorStatus: 'ready', error: null })
          } catch (cause) {
            if (!this.embedding.isAvailable) {
              this.embeddingChanged()
              return
            }
            this.repo.update(row.id, row.revision, {
              vectorStatus: 'failed',
              error: `向量索引失败：${(cause as Error).message}`,
            })
          }
        }
        this.index.rebuild()
      }
      // 统一重建沿用调用方 Execution，避免占满调度槽后等待自己排队的子任务。
      if (execution) {
        await run(execution)
        return
      }
      const snapshot = await this.scheduler.submit({
        principalId: 'system:knowledge',
        class: 'background',
        taskId: 'knowledge:reindex',
        resourceKey: 'knowledge:organize',
        budget: { maxDurationMs: 600_000, maxLlmCalls: 0 },
        run,
      })
      job.executionId = snapshot.descriptor.executionId
      if (job.cancelled || this.disposed) await this.scheduler.cancel(job.executionId)
      return job.executionId
    } catch (cause) {
      this.reindexJob = null
      this.repo.failPendingVectors(`重建未能排队：${(cause as Error).message}`)
      throw cause
    } finally {
      if (execution && this.reindexJob === job) {
        this.reindexJob = null
        this.repo.failPendingVectors('索引重建被中断，请重试')
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribe()
    for (const id of [...this.jobs.keys()]) await this.cancel(id)
    if (this.reindexJob) {
      this.reindexJob.cancelled = true
      if (this.reindexJob.executionId) await this.scheduler.cancel(this.reindexJob.executionId)
    }
  }

  /** 恢复出厂设置时取消迟到任务，再清除主存与可重建索引。 */
  async clear(): Promise<{ documentCount: number; partCount: number }> {
    this.generation++
    this.clearing = true
    try {
      const cancellations = [...this.jobs.keys()].map((id) => this.cancel(id))
      if (this.reindexJob) {
        this.reindexJob.cancelled = true
        if (this.reindexJob.executionId)
          cancellations.push(this.scheduler.cancel(this.reindexJob.executionId).then(() => {}))
        this.reindexJob = null
      }
      const counts = this.repo.clear()
      this.index.resetPhysicalStore()
      await Promise.all(cancellations)
      return counts
    } finally {
      this.clearing = false
    }
  }
}
