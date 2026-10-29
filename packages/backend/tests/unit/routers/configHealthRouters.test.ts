import { fileURLToPath } from 'node:url'
import { jsonBody } from '../../helpers/jsonBody'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfigRouter } from '@infos/backend/routers/config.router'
import { errorHandler } from '@infos/backend/middleware/errorHandler'
import type { AppContext } from '@infos/backend/container'

const appVersion = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../../../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }
).version
const logTransportState: { transport: unknown } = { transport: null }

vi.mock('@infos/backend/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getLogFileTransport: () => logTransportState.transport,
}))

import { createHealthRouter } from '@infos/backend/routers/health.router'
import { LogQueryService } from '@infos/backend/services/system/logQueryService'

function createConfigContext(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const readEmbedding = () => ({
    apiBase: store.get('embedding.apiBase') ?? '',
    apiKey: store.get('embedding.apiKey') ?? '',
    model: store.get('embedding.model') ?? '',
    dimension: Number(store.get('embedding.dimension') ?? 1536),
  })
  let active = readEmbedding()
  const ctx = {
    configRepo: {
      listAll: vi.fn((prefix = '') =>
        Promise.resolve(
          [...store.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value })),
        ),
      ),
      get: vi.fn((key: string) => Promise.resolve(store.get(key))),
      replaceMany: vi.fn(async (items: ReadonlyArray<readonly [string, string | undefined]>) => {
        for (const [key, value] of items) {
          if (value === undefined) store.delete(key)
          else store.set(key, value)
        }
      }),
      set: vi.fn((key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      }),
      delete: vi.fn((key: string) => {
        store.delete(key)
        return Promise.resolve()
      }),
    },
    embeddingService: {
      getConfig: vi.fn(() => active),
    },
    storeRegistry: { getDimension: () => active.dimension },
    reloadEmbeddingConfig: vi.fn(async () => {
      active = readEmbedding()
    }),
    reloadMemoryBackgroundConfig: vi.fn().mockResolvedValue(undefined),
    reloadTtsConfig: vi.fn().mockResolvedValue(undefined),
    reloadAsrConfig: vi.fn().mockResolvedValue(undefined),
    appManager: { notifyConfigChanged: vi.fn().mockResolvedValue(undefined) },
  }
  return ctx as unknown as AppContext & typeof ctx
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>
}

describe('createConfigRouter', () => {
  it('配置保存完成后通知运行中的应用更新主人身份', async () => {
    const ctx = createConfigContext()
    const router = createConfigRouter(ctx)
    const response = await router.request('http://test/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'social', value: '{"ownerQq":"123456"}' }),
    })
    expect(response.status).toBe(200)
    expect(await ctx.configRepo.get('social')).toBe('{"ownerQq":"123456"}')
    expect(ctx.appManager.notifyConfigChanged).toHaveBeenCalledWith(['social'])
  })

  it('后台记忆和向量开关独立保存并触发对应的热更新', async () => {
    const ctx = createConfigContext()
    const router = createConfigRouter(ctx)
    router.onError(errorHandler)
    for (const key of ['memory.background.enabled', 'embedding.enabled']) {
      const response = await router.request('/', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value: 'false' }),
      })
      expect(response.status).toBe(200)
      expect(await ctx.configRepo.get(key)).toBe('false')
    }
    expect(ctx.reloadMemoryBackgroundConfig).toHaveBeenCalledOnce()
    expect(ctx.reloadEmbeddingConfig).toHaveBeenCalledOnce()
  })

  it('拒绝将非法字符串写入开关配置', async () => {
    const ctx = createConfigContext()
    const router = createConfigRouter(ctx)
    router.onError(errorHandler)
    const response = await router.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'embedding.enabled', value: '随便写' }),
    })
    expect(response.status).toBe(400)
    expect(ctx.configRepo.set).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('应当真实激活候选Embedding并在维度一致后保存', async () => {
    const ctx = createConfigContext()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const router = createConfigRouter(ctx)
    router.onError(errorHandler)

    const response = await router.request('/embedding/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'api',
        model: 'embedding-test',
        dimension: 4,
        apiBase: 'https://embedding.test/v1',
        apiKey: 'candidate-key',
        reranker: { enabled: false },
      }),
    })
    const body = await readJson(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      code: 'OK',
      data: { model: 'embedding-test', dimension: 4 },
    })
    expect((body.data as { durationMs: number }).durationMs).toEqual(expect.any(Number))
    expect(fetch).toHaveBeenCalledWith(
      'https://embedding.test/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: jsonBody({
          input: ['infOS Embedding 模型激活与维度校验'],
          model: 'embedding-test',
          dimensions: 4,
        }),
      }),
    )
    expect(await ctx.configRepo.get('embedding.model')).toBe('embedding-test')
    expect(await ctx.configRepo.get('embedding.dimension')).toBe('4')
    expect(ctx.embeddingService.getConfig()).toMatchObject({
      model: 'embedding-test',
      dimension: 4,
    })
    expect(ctx.reloadEmbeddingConfig).toHaveBeenCalledTimes(1)
  })

  it('应当在Embedding实际维度不匹配时拒绝保存', async () => {
    const ctx = createConfigContext()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const router = createConfigRouter(ctx)
    router.onError(errorHandler)

    const response = await router.request('/embedding/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'api',
        model: 'embedding-test',
        dimension: 4,
        apiBase: 'https://embedding.test/v1',
        apiKey: 'candidate-key',
        reranker: { enabled: false },
      }),
    })

    expect(response.status).toBe(502)
    expect(await readJson(response)).toMatchObject({
      code: 'EMBEDDING_ERROR',
      data: { expectedDimension: 4, actualDimension: 3 },
    })
    expect(ctx.configRepo.set).not.toHaveBeenCalled()
    expect(ctx.reloadEmbeddingConfig).not.toHaveBeenCalled()
  })

  it('应当透传Embedding API错误且不保存候选配置', async () => {
    const ctx = createConfigContext()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('无效的 API Key', { status: 401 })),
    )
    const router = createConfigRouter(ctx)
    router.onError(errorHandler)

    const response = await router.request('/embedding/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'api',
        model: 'embedding-test',
        dimension: 4,
        apiBase: 'https://embedding.test/v1',
        apiKey: 'bad-key',
        reranker: { enabled: false },
      }),
    })

    expect(response.status).toBe(502)
    expect(await readJson(response)).toMatchObject({
      code: 'EMBEDDING_ERROR',
    })
    expect(ctx.configRepo.set).not.toHaveBeenCalled()
    expect(ctx.reloadEmbeddingConfig).not.toHaveBeenCalled()
  })

  it('应当列出配置并按前缀过滤', async () => {
    const ctx = createConfigContext({ 'embedding.model': 'a', 'tts.voice': 'b' })
    const router = createConfigRouter(ctx)

    const response = await router.request('/?prefix=embedding.')
    const body = await readJson(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ code: 'OK' })
    expect(body.data).toEqual({ items: [{ key: 'embedding.model', value: 'a' }], total: 1 })
  })

  it('应当获取单个配置并在缺失时返回 NOT_CONFIGURED', async () => {
    const ctx = createConfigContext({ theme: 'dark' })
    const router = createConfigRouter(ctx)

    const found = await router.request('/theme')
    const missing = await router.request('/missing')

    expect(await readJson(found)).toMatchObject({
      code: 'OK',
      data: { key: 'theme', value: 'dark' },
    })
    expect(missing.status).toBe(200)
    expect(await readJson(missing)).toMatchObject({
      code: 'NOT_CONFIGURED',
      data: { key: 'missing', value: null },
    })
  })

  it('应当设置配置并触发对应服务热更新', async () => {
    const ctx = createConfigContext()
    const router = createConfigRouter(ctx)

    const response = await router.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'embedding.provider', value: 'openai' }),
    })

    expect(response.status).toBe(200)
    expect(ctx.configRepo.set).toHaveBeenCalledWith('embedding.provider', 'openai')
    expect(ctx.reloadEmbeddingConfig).toHaveBeenCalledTimes(1)
    expect(ctx.reloadTtsConfig).not.toHaveBeenCalled()
    expect(await readJson(response)).toMatchObject({
      code: 'OK',
      data: { key: 'embedding.provider', value: 'openai' },
    })
  })

  it('应当删除存在的配置并拒绝删除不存在的配置', async () => {
    const ctx = createConfigContext({ theme: 'dark' })
    const router = createConfigRouter(ctx)

    const deleted = await router.request('/theme', { method: 'DELETE' })
    const missing = await router.request('/theme', { method: 'DELETE' })

    expect(deleted.status).toBe(200)
    expect(await readJson(deleted)).toMatchObject({ code: 'OK' })
    expect(missing.status).toBe(404)
    expect(await readJson(missing)).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('应当批量获取和批量设置配置，并合并热更新调用', async () => {
    const ctx = createConfigContext({ a: '1' })
    const router = createConfigRouter(ctx)

    const batchGet = await router.request('/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: ['a', 'missing'] }),
    })
    const batchSet = await router.request('/batch', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { key: 'tts.voice', value: 'v1' },
          { key: 'tts.speed', value: '1.0' },
          { key: 'asr.model', value: 'm1' },
        ],
      }),
    })

    expect(await readJson(batchGet)).toMatchObject({
      code: 'OK',
      data: { a: '1', missing: null },
    })
    expect(await readJson(batchSet)).toMatchObject({
      code: 'OK',
      data: { count: 3 },
    })
    expect(ctx.reloadTtsConfig).toHaveBeenCalledTimes(1)
    expect(ctx.reloadAsrConfig).toHaveBeenCalledTimes(1)
  })

  it('应当导出配置并按覆盖策略导入配置', async () => {
    const ctx = createConfigContext({ a: '1' })
    const router = createConfigRouter(ctx)

    const exported = await router.request('/export', { method: 'POST' })
    const imported = await router.request('/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { a: '2', b: '3' }, overwrite: false }),
    })

    expect(await readJson(exported)).toMatchObject({
      code: 'OK',
      data: { a: '1' },
    })
    expect(await readJson(imported)).toMatchObject({
      code: 'OK',
      data: { imported: 1, skipped: 1 },
    })
    expect(ctx.configRepo.set).toHaveBeenCalledWith('b', '3')
    expect(ctx.configRepo.set).not.toHaveBeenCalledWith('a', '2')
  })
})

describe('createHealthRouter', () => {
  let root: string

  beforeEach(() => {
    root = join(tmpdir(), `infos-health-${Date.now()}-${Math.random()}`)
    mkdirSync(root, { recursive: true })
    logTransportState.transport = null
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    logTransportState.transport = null
  })

  it('应当返回健康状态与运行时信息', async () => {
    const router = createHealthRouter(new LogQueryService())

    const response = await router.request('/')
    const body = await readJson(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ code: 'OK' })
    expect(body.data).toMatchObject({
      status: 'ok',
      version: appVersion,
      platform: process.platform,
      nodeVersion: process.version,
    })
  })

  it('应当在未启用日志文件持久化时返回前置条件失败', async () => {
    const router = createHealthRouter(new LogQueryService())

    const list = await router.request('/logs')
    const content = await router.request('/logs/app.log')

    expect(list.status).toBe(422)
    expect(await readJson(list)).toMatchObject({
      code: 'PRECONDITION_FAILED',
      data: { reason: '未配置日志文件输出' },
    })
    expect(content.status).toBe(422)
    expect(await readJson(content)).toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
  })

  it('应当列出日志文件并返回指定日志尾部内容', async () => {
    writeFileSync(join(root, 'app.log'), '一\n二\n三\n')
    writeFileSync(join(root, 'ignore.txt'), '忽略')
    logTransportState.transport = {
      getLogDir: () => root,
      getLogPath: () => join(root, 'app.log'),
    }
    const router = createHealthRouter(new LogQueryService())

    const list = await router.request('/logs')
    const content = await router.request('/logs/app.log?lines=2')

    expect(await readJson(list)).toMatchObject({
      code: 'OK',
      data: { logDir: root, currentFile: 'app.log' },
    })
    expect(await readJson(content)).toMatchObject({
      code: 'OK',
      data: { filename: 'app.log', totalLines: 3, returnedLines: 2, lines: ['二', '三'] },
    })
  })

  it('应当拒绝非法日志文件名并处理缺失文件', async () => {
    logTransportState.transport = {
      getLogDir: () => root,
      getLogPath: () => join(root, 'app.log'),
    }
    const router = createHealthRouter(new LogQueryService())

    const illegal = await router.request('/logs/..%2Fsecret.log')
    const missing = await router.request('/logs/missing.log')

    expect(illegal.status).toBe(400)
    expect(await readJson(illegal)).toMatchObject({ code: 'BAD_REQUEST' })
    expect(missing.status).toBe(404)
    expect(await readJson(missing)).toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
