import type { AppContext } from '../../container'
import { AppError } from '../../lib/appError'
import type { KernelExecutionId, IndexScope, IndexMaintenanceTarget } from '@infos/shared'
import { t as __t } from '../../lib/i18n'
import { storeDiagnostic } from '../../lib/storeDiagnostics'

export type { IndexScope } from '@infos/shared'
type Target = { scope: IndexScope; agentId?: string }
type Job = {
  executionId?: KernelExecutionId
  scope: IndexScope | 'all'
  agentId?: string
  completed: number
  processed: number
  failed: number
  total: number
  results: IndexMaintenanceTarget[]
  error?: string
}
const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

/** 主存保持不变，统一调度记忆、社交图谱、共享事实和文档索引的重建。 */
export class IndexMaintenanceService {
  private jobs: Job[] = []
  private pending = false
  constructor(private readonly ctx: AppContext) {}

  status() {
    const agents = this.ctx.agentManager.listAgents()
    // 磁盘残留索引不代表角色仍然存在，角色列表以 AgentManager 为准。
    const ids = agents.map((agent) => agent.id)
    const targets: Target[] = [
      ...ids.flatMap((agentId): Target[] => [
        { scope: 'main', agentId },
        { scope: 'social', agentId },
      ]),
      { scope: 'facts' },
      { scope: 'knowledge' },
    ]
    return {
      dimension: this.ctx.storeRegistry.getDimension(),
      model: this.ctx.embeddingService.getConfig().model,
      embeddingAvailable: this.ctx.embeddingService.isAvailable,
      busy: this.pending,
      indexes: targets.map((target) => {
        const path = target.agentId
          ? this.ctx.storeRegistry.resolveAgentStorePath(
              target.agentId,
              target.scope as 'main' | 'social',
            )
          : this.ctx.storeRegistry.resolveSharedStorePath(target.scope as 'facts' | 'knowledge')
        try {
          if (this.ctx.storeRegistry.isMaintaining(path))
            return { ...target, exists: true, dimension: null, nodeCount: null, maintenance: true }
          return { ...target, ...this.ctx.storeRegistry.describeStore(path), warnings: this.ctx.storeRegistry.storeDiagnostics(path) }
        } catch (error) {
          return { ...target, exists: true, dimension: null, nodeCount: null, error: String(error), diagnostic: storeDiagnostic(error) }
        }
      }),
      jobs: this.jobs.map((job) => {
        const snapshot = job.executionId ? this.ctx.kernelScheduler.get(job.executionId) : null
        return { ...job, state: snapshot?.state ?? 'queued' }
      }),
    }
  }

  async rebuild(scope: IndexScope | 'all', agentId?: string) {
    if (this.pending) throw new AppError('RESOURCE_BUSY', { message: '已有索引重建任务正在进行' })
    const known = this.ctx.agentManager.listAgents().map((agent) => agent.id)
    if (agentId && !known.includes(agentId))
      throw new AppError('NOT_FOUND', { message: '角色不存在' })
    const ids = agentId ? [agentId] : known
    const targets: Target[] = []
    for (const kind of (scope === 'all'
      ? ['main', 'social', 'facts', 'knowledge']
      : [scope]) as IndexScope[]) {
      if (kind === 'main' || kind === 'social')
        targets.push(...ids.map((id) => ({ scope: kind, agentId: id })))
      else targets.push({ scope: kind })
    }
    const job: Job = { scope, agentId, total: targets.length, completed: 0, processed: 0, failed: 0,
      results: targets.map((target): IndexMaintenanceTarget => ({ ...target, state: 'queued' })) }
    this.pending = true
    this.jobs = [...this.jobs.slice(-9), job]
    const dimension = this.ctx.storeRegistry.getDimension()
    const embeddingConfig = this.ctx.embeddingService.getConfig()
    let unsubscribe = () => {}
    try {
      const snapshot = await this.ctx.kernelScheduler.submit({
        principalId: 'system:index-maintenance',
        class: 'maintenance',
        taskId: `index:rebuild:${scope}`,
        resourceKey: 'index:rebuild',
        budget: { maxDurationMs: 1_800_000 },
        run: async (context) => {
          const { signal } = context
          try {
            for (const target of targets) {
              signal.throwIfAborted()
              if (
                dimension !== this.ctx.storeRegistry.getDimension() ||
                embeddingConfig !== this.ctx.embeddingService.getConfig()
              )
                throw new Error('向量配置已变化，请重新重建索引')
              const result = job.results.find((item) => item.scope === target.scope && item.agentId === target.agentId)!
              result.state = 'running'
              const storePath = target.agentId
                ? this.ctx.storeRegistry.resolveAgentStorePath(target.agentId, target.scope as 'main' | 'social')
                : this.ctx.storeRegistry.resolveSharedStorePath(target.scope as 'facts' | 'knowledge')
              try {
                if (target.agentId && !this.ctx.agentManager.getAgent(target.agentId))
                  throw new Error('角色已删除，已停止该角色的索引重建')
                if (target.scope === 'main')
                  await this.ctx.eventMemoryService.rebuildAgentStore(
                    target.agentId!,
                    false,
                    signal,
                  )
                else if (target.scope === 'social')
                  await this.ctx.storeRegistry.withMaintenance(storePath,
                    () => this.ctx.storeRegistry.rebuildSocialStore(target.agentId!), signal)
                else if (target.scope === 'facts') await this.ctx.factsRepo.rebuildStore(signal)
                else {
                  await this.ctx.knowledgeService.reindex(true, context)
                  signal.throwIfAborted()
                  if (
                    this.ctx.knowledgeService.repo
                      .readyDocuments()
                      .some((row) => row.vectorStatus === 'failed')
                  )
                    throw new Error('部分文档向量重建失败，请查看文档知识库')
                }
                signal.throwIfAborted()
                job.completed++
                result.state = 'completed'
              } catch (error) {
                result.state = signal.aborted ? 'cancelled' : 'failed'
                result.error = storeDiagnostic(error)
                signal.throwIfAborted()
                job.failed++
              } finally {
                job.processed++
                result.warnings = this.ctx.storeRegistry.storeDiagnostics(storePath)
              }
            }
            if (job.failed) throw new AggregateError(job.results.filter((item) => item.error).map((item) => item.error),
              __t('server.index-maintenance', '索引重建部分失败：成功 {0}，失败 {1}', [job.completed, job.failed]))
          } catch (error) {
            job.error = error instanceof Error ? error.message : String(error)
            throw error
          }
        },
      })
      job.executionId = snapshot.descriptor.executionId
      const finish = () => {
        this.pending = false
        unsubscribe()
      }
      unsubscribe = this.ctx.kernelScheduler.subscribe((value) => {
        if (value.descriptor.executionId === job.executionId && terminal.has(value.state)) finish()
      })
      if (terminal.has(this.ctx.kernelScheduler.get(job.executionId)?.state ?? '')) finish()
      return { executionId: job.executionId, total: job.total }
    } catch (error) {
      this.pending = false
      this.jobs = this.jobs.filter((value) => value !== job)
      unsubscribe()
      throw error
    }
  }
}
