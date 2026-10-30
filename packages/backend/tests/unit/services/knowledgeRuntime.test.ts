import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareBuiltinTask } from '@infos/backend/services/prompt/taskPrompts'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import { KnowledgeRepository } from '@infos/backend/repositories/knowledge.repo'
import { MemoryStoreRegistry } from '@infos/backend/repositories/storeRegistry'
import { KnowledgeIndex } from '@infos/backend/services/knowledge/knowledgeIndex'
import { KnowledgeService } from '@infos/backend/services/knowledge/knowledgeService'
import { createKnowledgeRouter } from '@infos/backend/routers/knowledge.router'
import { errorHandler } from '@infos/backend/middleware/errorHandler'
import { getBuiltinToolDefinitions } from '@infos/backend/tools'
import { searchKnowledgeTool, setKnowledgeToolDeps } from '@infos/backend/tools/knowledge'
import { RegistryToolExecutor } from '@infos/backend/services/agent/toolExecutor'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'
import type { KernelScheduleInput } from '@infos/backend/kernel/kernelScheduler'
import type {
  ApiResponse,
  KnowledgeDocumentInfo,
  KnowledgeSearchResult,
  KernelExecutionSnapshot,
} from '@infos/shared'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture(vectors = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'infos-knowledge-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const resolver = {
    resolve: (alias: string) =>
      alias === '@data' ? root : path.join(root, alias.replace('@data/', '')),
  }
  const embeddingConfig = { apiBase: 'https://embedding.test/v1', model: 'summary-a', dimension: 4 }
  const embedding = {
    isAvailable: vectors,
    getConfig: () => embeddingConfig,
    getDimension: () => embeddingConfig.dimension,
    embed: vi.fn(async (_texts: string[], _signal?: AbortSignal) => [[1, 0, 0, 0]]),
    embedOne: vi.fn(async () => [1, 0, 0, 0]),
  }
  const jobs: Array<{
    input: KernelScheduleInput
    snapshot: KernelExecutionSnapshot
    controller: AbortController
  }> = []
  const listeners = new Set<(snapshot: KernelExecutionSnapshot) => void>()
  const emit = (snapshot: KernelExecutionSnapshot) => {
    for (const listener of listeners) listener(snapshot)
  }
  // 仅控制外部调度时机，整理、SQLite 提交和检索使用真实实现。
  const scheduler = {
    subscribe: (listener: (snapshot: KernelExecutionSnapshot) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    submit: vi.fn(async (input: KernelScheduleInput) => {
      const snapshot = {
        descriptor: { executionId: randomUUID(), ...input },
        state: 'queued',
      } as unknown as KernelExecutionSnapshot
      jobs.push({ input, snapshot, controller: new AbortController() })
      return snapshot
    }),
    cancel: vi.fn(async (id: string) => {
      const job = jobs.find((item) => item.snapshot.descriptor.executionId === id)
      if (!job || !['queued', 'running'].includes(job.snapshot.state)) return false
      job.controller.abort()
      job.snapshot.state = 'cancelled'
      emit(job.snapshot)
      return true
    }),
  }
  const llm = {
    preparePromptMessages: prepareBuiltinTask,
    chatText: vi.fn().mockResolvedValue(
      JSON.stringify({
        parts: [
          {
            start: 1,
            end: 1,
            title: '操作规范',
            summary: '蓝莓项目使用唯一操作规范。',
            keywords: ['蓝莓', '操作规范'],
          },
        ],
      }),
    ),
  }
  const getModel = vi.fn(async () => ({
    provider: 'openai',
    modelId: 'organizer',
    apiKey: 'mock',
    contextWindowTokens: 32_000,
  }))
  const open = async () => {
    const db = createDrizzleConnection(path.join(root, 'infos.db'))
    const stores = new MemoryStoreRegistry(resolver as never, embedding.getDimension())
    const repo = new KnowledgeRepository(db)
    const index = new KnowledgeIndex(
      repo,
      stores,
      embedding as never,
      path.join(root, 'knowledge', 'sources'),
    )
    const service = new KnowledgeService(
      repo,
      index,
      llm as never,
      getModel,
      embedding as never,
      scheduler as never,
    )
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await service.dispose()
      stores.closeAll()
      closeDrizzleConnection(db)
    }
    cleanups.push(close)
    await service.initialize()
    const app = new Hono()
    app.onError(errorHandler)
    app.route('/', createKnowledgeRouter({ knowledgeService: service } as never))
    return { db, repo, stores, index, service, app, close }
  }
  const resources = await open()
  const run = async (job = jobs.find((item) => item.snapshot.state === 'queued')!) => {
    if (job.controller.signal.aborted) return
    job.snapshot.state = 'running'
    try {
      await job.input.run({
        descriptor: job.snapshot.descriptor,
        signal: job.controller.signal,
      } as never)
      job.snapshot.state = job.controller.signal.aborted ? 'cancelled' : 'completed'
    } catch (cause) {
      job.snapshot.state = job.controller.signal.aborted ? 'cancelled' : 'failed'
      throw cause
    } finally {
      emit(job.snapshot)
    }
  }
  return {
    ...resources,
    root,
    embedding,
    embeddingConfig,
    jobs,
    llm,
    run,
    scheduler,
    reopen: async () => {
      await resources.close()
      return open()
    },
  }
}

function jsonRequest(app: Hono, endpoint: string, body: unknown) {
  return app.request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('文档知识库持久化与 API', () => {
  it('备份恢复省略锁文件后可重新初始化，并检索已恢复的 SQLite 正文', async () => {
    const { app, run, close, reopen, stores } = await fixture()
    const response = await jsonRequest(app, '/documents', {
      kind: 'text',
      title: '恢复验收资料',
      content: '蓝莓项目的唯一操作规范是先保存资料再进行检索。',
    })
    const payload = (await response.json()) as ApiResponse<KnowledgeDocumentInfo>
    expect(response.status).toBe(202)
    await run()
    const target = stores.resolveSharedStorePath('knowledge')
    await close()
    await rm(`${target}.lock`)
    const restored = await reopen()
    const result = await restored.index.search({ keywords: ['蓝莓'] })
    expect(result.items.map((item) => item.documentId)).toContain(payload.data!.id)
    expect(restored.service.detail(payload.data!.id)).toMatchObject({ status: 'ready', partCount: 1 })
  })

  it('激活新维度后保留旧索引，重启可初始化，显式重建才切换文件维度', async () => {
    const resources = await fixture()
    const { stores, service, index, embeddingConfig } = resources
    const target = stores.resolveSharedStorePath('knowledge')
    expect(stores.describeStore(target).dimension).toBe(4)
    embeddingConfig.dimension = 8
    stores.setDimension(8)
    expect(() => service.embeddingChanged()).not.toThrow()
    expect(stores.describeStore(target).dimension).toBe(4)
    await service.initialize()
    expect(stores.describeStore(target).dimension).toBe(4)
    await index.resetPhysicalStoreForMaintenance()
    expect(stores.describeStore(target)).toMatchObject({ exists: true, dimension: 8, nodeCount: 0 })
  })

  it('文本入库立即返回202，后台完成后真实BM25和ripgrep都能检索，删除后不再召回', async () => {
    const { app, service, repo, jobs, run, llm, embedding } = await fixture()
    const response = await jsonRequest(app, '/documents', {
      kind: 'text',
      title: '蓝莓资料',
      content: '蓝莓项目的唯一操作规范是先保存资料再进行检索。',
    })
    expect(response.status).toBe(202)
    const payload = (await response.json()) as ApiResponse<KnowledgeDocumentInfo>
    const id = payload.data!.id
    expect(repo.get(id)?.status).toBe('queued')
    expect(repo.hasReadyParts()).toBe(false)
    expect(jobs).toHaveLength(1)
    expect(llm.chatText).not.toHaveBeenCalled()
    await run()
    expect(repo.hasReadyParts()).toBe(true)
    expect(service.detail(id)).toMatchObject({
      status: 'ready',
      vectorStatus: 'skipped',
      partCount: 1,
    })
    expect(embedding.embed).not.toHaveBeenCalled()
    const lexical = await service.index.search({ keywords: ['蓝莓'] })
    expect(lexical.items.map((hit) => hit.documentId)).toContain(id)
    expect(lexical.items[0]?.matchedBy).toContain('bm25')
    const exact = await service.index.search({ regex: '唯一操作规范' })
    expect(exact.items[0]?.excerpt).toContain('唯一操作规范')
    const invalid = await jsonRequest(app, '/search', { keywords: ['蓝莓'], limit: 21 })
    expect(invalid.status).toBe(400)
    await service.delete(id)
    expect(repo.hasReadyParts()).toBe(false)
    expect((await service.index.search({ keywords: ['蓝莓'] })).items).toEqual([])
    expect(repo.parts(id)).toEqual([])
  })

  it('multipart UTF-8文本上传走相同入库管线', async () => {
    const { app, service, run } = await fixture()
    const form = new FormData()
    form.set('file', new File(['蓝莓操作规范。'], 'guide.md', { type: 'text/markdown' }))
    const response = await app.request('/documents/upload', { method: 'POST', body: form })
    expect(response.status).toBe(202)
    const payload = (await response.json()) as ApiResponse<KnowledgeDocumentInfo>
    const id = payload.data!.id
    await run()
    expect(service.detail(id)).toMatchObject({
      title: 'guide.md',
      sourceKind: 'file',
      source: 'guide.md',
      status: 'ready',
    })
  })

  it('更新发生在LLM请求在途时，迟到结果不能覆盖新版本', async () => {
    const { service, repo, jobs, run, llm } = await fixture()
    const first = await service.import({
      title: '蓝莓资料',
      content: '旧版本资料。',
      sourceKind: 'text',
    })
    let finish!: (value: string) => void
    llm.chatText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const running = run(jobs[0])
    await vi.waitFor(() => expect(llm.chatText).toHaveBeenCalledTimes(1))
    const updated = await service.import({
      title: '蓝莓资料',
      content: '新版本蓝莓资料。',
      sourceKind: 'text',
      replaceId: first.id,
    })
    finish(
      JSON.stringify({
        parts: [{ start: 1, end: 1, title: '旧版本', summary: '过期摘要。', keywords: ['旧版本'] }],
      }),
    )
    await running
    expect(updated.revision).toBe(2)
    expect(repo.get(first.id)).toMatchObject({
      revision: 2,
      content: '新版本蓝莓资料。',
      status: 'queued',
    })
    expect(repo.parts(first.id)).toEqual([])
    await run(jobs[1])
    expect(service.detail(first.id)).toMatchObject({ revision: 2, status: 'ready' })
    expect(repo.parts(first.id)[0]?.summary).toBe('蓝莓项目使用唯一操作规范。')
  })

  it('关闭并重新打开 SQLite 后，保留就绪资料、恢复排队任务并标记中断任务', async () => {
    const { service, repo, llm, run, jobs, reopen } = await fixture()
    const ready = await service.import({
      title: '已完成',
      content: '蓝莓规范已持久化。',
      sourceKind: 'text',
    })
    await run()
    const partId = repo.parts(ready.id)[0]!.id
    const queued = await service.import({
      title: '待整理',
      content: '尚未执行的资料。',
      sourceKind: 'text',
    })
    const interrupted = await service.import({
      title: '中断',
      content: '被重启打断的资料。',
      sourceKind: 'text',
    })
    // 模拟上次进程退出时已写入 SQLite 的处理中状态。
    repo.update(interrupted.id, 1, { status: 'processing' })
    llm.chatText.mockClear()

    const reopened = await reopen()
    expect(llm.chatText).not.toHaveBeenCalled()
    expect(reopened.service.detail(ready.id).status).toBe('ready')
    expect(reopened.service.detail(interrupted.id).status).toBe('failed')
    expect(reopened.service.detail(queued.id).status).toBe('queued')
    expect(
      jobs.filter((job) => job.snapshot.state === 'queued').map((job) => job.input.taskId),
    ).toEqual([`knowledge:${queued.id}`])
    const expanded = await reopened.index.search({ partIds: [String(partId)], expand: true })
    expect(expanded.items[0]?.content).toBe('蓝莓规范已持久化。')

    await run()
    expect(reopened.service.detail(queued.id).status).toBe('ready')
    await reopened.service.retry(interrupted.id)
    await run()
    expect(reopened.service.detail(interrupted.id)).toMatchObject({ status: 'ready', revision: 2 })
  })

  it('只对摘要生成向量，原文继续完整保存并可展开', async () => {
    const { service, repo, embedding, run } = await fixture(true)
    const content = '蓝莓项目的完整操作规范，包含摘要中没有的操作细节。'
    const document = await service.import({ title: '规范', content, sourceKind: 'text' })
    await run()
    expect(embedding.embed.mock.calls.map(([texts]) => texts)).toEqual([
      ['蓝莓项目使用唯一操作规范。'],
    ])
    expect(service.detail(document.id).vectorStatus).toBe('ready')
    const partId = repo.parts(document.id)[0]!.id
    const result = await service.index.search({ partIds: [String(partId)], expand: true })
    expect(result.items[0]?.content).toBe(content)
    const semantic = await service.index.search({ keywords: ['蓝莓'] })
    expect(semantic.items[0]?.matchedBy).toContain('vector')
  })

  it('摘要向量失败不会丢失资料，仍能通过关键词和正则检索', async () => {
    const { service, embedding, run } = await fixture(true)
    embedding.embed.mockRejectedValueOnce(new Error('向量服务不可用'))
    const doc = await service.import({
      title: '蓝莓规范',
      content: '蓝莓唯一操作规范。',
      sourceKind: 'text',
    })
    await run()
    expect(service.detail(doc.id)).toMatchObject({
      status: 'ready',
      vectorStatus: 'failed',
      partCount: 1,
    })
    const lexical = await service.index.search({ keywords: ['蓝莓'] })
    expect(lexical.items.map((hit) => hit.documentId)).toContain(doc.id)
    expect(lexical.items[0]?.matchedBy).not.toContain('vector')
    const exact = await service.index.search({ regex: '唯一操作规范' })
    expect(exact.items[0]?.excerpt).toContain('唯一操作规范')
  })

  it.each([4, 8])('换成 %i 维的新模型时旧向量失效，重建只处理摘要', async (dimension) => {
    const { service, stores, embedding, embeddingConfig, llm, run } = await fixture(true)
    const doc = await service.import({
      title: '蓝莓规范',
      content: '蓝莓项目的操作规范。',
      sourceKind: 'text',
    })
    await run()
    embeddingConfig.model = 'summary-b'
    embeddingConfig.dimension = dimension
    if (dimension !== 4) stores.resetAllForDimension(dimension)
    embedding.embed.mockResolvedValue([[0, 1, ...Array(dimension - 2).fill(0)]])
    embedding.embedOne.mockResolvedValue([0, 1, ...Array(dimension - 2).fill(0)])
    embedding.embedOne.mockClear()
    llm.chatText.mockClear()

    service.embeddingChanged()
    expect(service.detail(doc.id).vectorStatus).toBe('stale')
    const fallback = await service.index.search({ keywords: ['蓝莓'] })
    expect(fallback.items.map((hit) => hit.documentId)).toContain(doc.id)
    expect(fallback.items[0]?.matchedBy).not.toContain('vector')
    expect(embedding.embedOne).not.toHaveBeenCalled()

    await service.reindex()
    await run()
    expect(service.detail(doc.id).vectorStatus).toBe('ready')
    expect(llm.chatText).not.toHaveBeenCalled()
    const rebuilt = await service.index.search({ keywords: ['蓝莓'] })
    expect(rebuilt.items[0]?.matchedBy).toContain('vector')
  })

  it('真实注册的知识工具能按片段编号展开长文，执行器不截断 JSON', async () => {
    const { service, repo, index } = await fixture()
    const body = '原文资料\n'.repeat(3000)
    const now = new Date().toISOString()
    const doc = repo.create({
      id: randomUUID(),
      title: '长文',
      sourceKind: 'text',
      source: '',
      content: body,
      contentHash: 'fixture',
      tokenCount: 12_000,
      status: 'processing',
      vectorStatus: 'skipped',
      createdAt: now,
      updatedAt: now,
    })
    repo.publish(
      doc.id,
      1,
      [
        {
          ordinal: 0,
          title: '正文',
          summary: '原文摘要',
          keywordsJson: '["原文"]',
          startOffset: 0,
          endOffset: body.length,
          tokenCount: 12_000,
        },
      ],
      'skipped',
    )
    index.rebuild()
    setKnowledgeToolDeps(service)
    const registry = new ToolRegistry()
    const definition = getBuiltinToolDefinitions().find((tool) => tool.name === 'search_knowledge')!
    registry.register(definition, (args, ctx) => searchKnowledgeTool.execute(args, ctx))
    const executor = new RegistryToolExecutor(registry)
    const result = await executor.execute(
      'search_knowledge',
      {
        part_ids: [String(repo.parts(doc.id)[0]!.id)],
        document_id: doc.id,
        expand: true,
      },
      'desktop',
    )
    expect(result.isError).toBe(false)
    const output = JSON.parse(result.output) as KnowledgeSearchResult
    expect(output.items[0]?.content).toBe(body)
    expect(output.truncated).toBe(false)
    const invalid = await executor.execute(
      'search_knowledge',
      { keywords: ['原文'], limit: 21 },
      'desktop',
    )
    expect(invalid.isError).toBe(true)
  })
})
