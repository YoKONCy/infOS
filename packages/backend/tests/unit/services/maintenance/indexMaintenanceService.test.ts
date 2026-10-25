import { describe, expect, it, vi } from 'vitest'
import { IndexMaintenanceService } from '@infos/backend/services/maintenance/indexMaintenanceService'
import type { KernelScheduleInput } from '@infos/backend/kernel/kernelScheduler'

function fixture() {
  const agents = [{ id: 'pero' }]
  const context = {
    agentManager: {
      listAgents: () => agents,
      getAgent: (id: string) => agents.find((agent) => agent.id === id),
    },
    storeRegistry: {
      listStoredAgentIds: () => ['pero', 'lin'],
      getDimension: () => 768,
      resolveAgentStorePath: (id: string, scope: string) => `${id}/${scope}`,
      resolveSharedStorePath: (scope: string) => scope,
      describeStore: () => ({ exists: true, dimension: 768, nodeCount: 1 }),
      rebuildSocialStore: vi.fn(),
      isMaintaining: () => false,
      storeDiagnostics: () => [],
      withMaintenance: async (_path: string, operation: () => unknown) => operation(),
    },
    embeddingService: { getConfig: () => config, isAvailable: true },
    eventMemoryService: { rebuildAgentStore: vi.fn(async () => {}) },
    factsRepo: { rebuildStore: vi.fn(async () => {}) },
    knowledgeService: { reindex: vi.fn(async () => {}), repo: { readyDocuments: () => [] } },
    kernelScheduler: {
      get: () => ({ state: 'queued' }),
      submit: vi.fn(async (_input: KernelScheduleInput) => ({
        descriptor: { executionId: 'rebuild-1' },
      })),
      subscribe: () => () => {},
    },
  }
  const config = { model: '测试模型', dimension: 768 }
  return { agents, context, service: new IndexMaintenanceService(context as never) }
}

describe('已删除角色的索引维护边界', () => {
  it('部分目标失败时进度仍记录全部已处理目标，并保留每个原始错误', async () => {
    const { service, context } = fixture()
    context.eventMemoryService.rebuildAgentStore.mockRejectedValue(new Error('主记忆发布失败'))
    context.factsRepo.rebuildStore.mockRejectedValue(Object.assign(new Error('共享文件占用'), { code: 'EPERM', path: 'facts.tdb.wal' }))
    context.knowledgeService.reindex.mockRejectedValue(new Error('文档向量失败'))
    await service.rebuild('all')
    const input = context.kernelScheduler.submit.mock.calls[0]![0]
    await expect(input.run({ signal: new AbortController().signal } as never)).rejects.toThrow()
    const job = service.status().jobs[0]!
    // 单角色包含主记忆、社交图谱，加上两套共享库；只有社交目标成功。
    expect(job).toMatchObject({ processed: 4, total: 4, completed: 1, failed: 3 })
    expect(Object.fromEntries(job.results.map((item) => [item.scope, item.state]))).toEqual({
      main: 'failed', social: 'completed', facts: 'failed', knowledge: 'failed',
    })
    expect(job.results.find((item) => item.scope === 'facts')?.error).toMatchObject({ code: 'EPERM', path: 'facts.tdb.wal' })
  })
  it('磁盘残留 lin 的向量库不能让已删除角色重新出现在列表', () => {
    const { service } = fixture()
    const indexes = service.status().indexes
    expect(indexes).toHaveLength(4)
    expect(indexes.filter((item) => item.agentId).map((item) => item.agentId)).toEqual([
      'pero',
      'pero',
    ])
    expect(indexes.some((item) => item.agentId === 'lin')).toBe(false)
  })

  it('拒绝为只有残留库、没有角色档案的 lin 重建索引', async () => {
    const { service, context } = fixture()
    await expect(service.rebuild('social', 'lin')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(context.kernelScheduler.submit).not.toHaveBeenCalled()
  })

  it('排队期间角色被删除后不能再为它重建图谱', async () => {
    const { service, context, agents } = fixture()
    await service.rebuild('social', 'pero')
    agents.splice(0)
    const input = context.kernelScheduler.submit.mock.calls[0]![0]
    await expect(input.run({ signal: new AbortController().signal } as never)).rejects.toThrow()
    expect(service.status().jobs[0]).toMatchObject({ processed: 1, completed: 0, failed: 1,
      results: [{ state: 'failed', error: { code: 'STORE_OPERATION_FAILED', message: '角色已删除，已停止该角色的索引重建' } }] })
    expect(context.storeRegistry.rebuildSocialStore).not.toHaveBeenCalled()
  })
})
