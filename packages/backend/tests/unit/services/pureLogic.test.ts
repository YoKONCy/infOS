import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelRoleResolver } from '@infos/backend/services/llm/modelRoles'
import {
  loadMemoryRuntimeConfig,
  shouldRunAutoRag,
} from '@infos/backend/services/memory/memoryRuntimeConfig'
import { AssetRegistry } from '@infos/backend/core/assetRegistry'
import type { PathResolver } from '@infos/backend/core/pathResolver'

function createModelDeps(
  configs: Record<string, string | null>,
  models: Record<number, Record<string, unknown>>,
) {
  const configRepo = {
    get: vi.fn((key: string) => Promise.resolve(configs[key] ?? null)),
  }
  const modelRepo = {
    findById: vi.fn((id: number) => Promise.resolve(models[id] ?? null)),
  }
  return { configRepo, modelRepo }
}

describe('记忆运行配置', () => {
  it('高级管线开启但 ContextRNN 关闭时，也强制关闭反馈训练', async () => {
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        channels: {
          desktop: { contextPairs: 20, enableAutoRag: true, retrievalLimit: 8 },
          group: { contextPairs: 20, enableAutoRag: true, retrievalLimit: 3 },
        },
        advanced: { enableSaPpr: true, enableContextRnn: false, enableFeedback: true },
      }),
    )
    const config = await loadMemoryRuntimeConfig({ get })
    expect(config.advanced.enableSaPpr).toBe(true)
    expect(config.advanced.enableContextRnn).toBe(false)
    expect(config.advanced.enableFeedback).toBe(false)
  })
  it('应迁移旧字段并将旧retrievalLimit=0转换为关闭自动RAG', async () => {
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        channels: {
          desktop: { contextMessages: 12, retrievalLimit: 0 },
          group: { contextPairs: 18, retrievalLimit: 5 },
        },
        scorerBatchSize: 8,
        retrievalMinScore: 0.3,
      }),
    )

    const config = await loadMemoryRuntimeConfig({ get })

    expect(config).toMatchObject({
      channels: {
        desktop: { contextPairs: 12, enableAutoRag: false },
        group: { contextPairs: 18, enableAutoRag: true, retrievalLimit: 5 },
      },
      advanced: {
        enableSaPpr: false,
        enableFista: false,
        enableDpp: false,
        enableContextRnn: false,
        enableLeiden: false,
        enableFeedback: false,
      },
    })
    expect(shouldRunAutoRag(true, config.channels.desktop)).toBe(false)
    expect(shouldRunAutoRag(true, config.channels.group)).toBe(true)
    expect(shouldRunAutoRag(false, config.channels.group)).toBe(false)
  })

  it('应深度补全高级配置并在关闭SA-PPR时强制关闭所有子模块', async () => {
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        channels: {
          desktop: { contextPairs: 20, enableAutoRag: true, retrievalLimit: 8 },
          group: { contextPairs: 20, enableAutoRag: true, retrievalLimit: 3 },
        },
        advanced: {
          enableSaPpr: false,
          enableFista: true,
          enableContextRnn: true,
          enableLeiden: true,
          enableFeedback: true,
        },
      }),
    )

    const config = await loadMemoryRuntimeConfig({ get })

    expect(config.advanced).toMatchObject({
      enableSaPpr: false,
      enableFista: false,
      enableDpp: false,
      enableContextRnn: false,
      enableLeiden: false,
      enableFeedback: false,
    })
  })
})

describe('ModelRoleResolver', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('应当优先使用角色专用模型并保留未配置参数', async () => {
    const { configRepo, modelRepo } = createModelDeps(
      { 'model.task.scorer': '2' },
      {
        2: {
          provider: 'openai',
          modelId: 'gpt-secretary',
          apiKey: 'key',
          temperature: null,
          maxTokens: 1000,
        },
      },
    )
    const resolver = new ModelRoleResolver(configRepo as never, modelRepo as never)

    const config = await resolver.resolve('scorer')

    expect(config).toEqual({
      configId: undefined,
      provider: 'openai',
      modelId: 'gpt-secretary',
      apiKey: 'key',
      apiBase: null,
      temperature: undefined,
      topP: undefined,
      maxTokens: 1000,
      maxReActTurns: undefined,
      fallbackModels: [],
      stream: true,
      reasoningEffort: undefined,
      contextWindowTokens: undefined,
      usagePurpose: 'memory',
      returnNativeReasoning: false,
      wireApi: 'chat_completions',
      reasoningDialect: 'auto',
      enableVision: false,
      enableAudioInput: false,
    })
    expect(configRepo.get).toHaveBeenCalledWith('model.task.scorer')
  })

  it('应当在角色未配置时回退主模型并使用角色温度', async () => {
    const { configRepo, modelRepo } = createModelDeps(
      { 'model.main': '1' },
      { 1: { provider: 'gemini', modelId: 'main-model', apiKey: 'main-key', temperature: null } },
    )
    const resolver = new ModelRoleResolver(configRepo as never, modelRepo as never)

    const config = await resolver.resolve('reflection')

    expect(config).toMatchObject({
      provider: 'gemini',
      modelId: 'main-model',
      apiKey: 'main-key',
      temperature: undefined,
    })
  })

  it('应当使用全局供应商 API Key 作为模型配置兜底', async () => {
    const { configRepo, modelRepo } = createModelDeps(
      {
        'model.main': '1',
        'global.openai.apiKey': 'global-key',
        'global.openai.apiBase': 'https://api.example.com',
      },
      {
        1: {
          provider: 'openai',
          modelId: 'main-model',
          apiKey: null,
          apiBase: null,
          temperature: 0.8,
        },
      },
    )
    const resolver = new ModelRoleResolver(configRepo as never, modelRepo as never)

    const config = await resolver.resolve('main')

    expect(config).toMatchObject({
      apiKey: 'global-key',
      apiBase: 'https://api.example.com',
      temperature: 0.8,
    })
  })

  it('应当在数据库配置无效时回退环境变量或返回 null', async () => {
    vi.stubEnv('PERO_LLM_API_KEY', 'env-key')
    vi.stubEnv('PERO_LLM_MODEL', 'env-model')
    vi.stubEnv('PERO_LLM_PROVIDER', 'anthropic')
    const { configRepo, modelRepo } = createModelDeps({ 'model.main': 'abc' }, {})
    const resolver = new ModelRoleResolver(configRepo as never, modelRepo as never)

    const config = await resolver.resolve('reflection')
    vi.stubEnv('PERO_LLM_API_KEY', undefined)
    vi.stubEnv('PERO_LLM_MODEL', undefined)
    const missing = await resolver.resolve('main')

    expect(config).toMatchObject({
      provider: 'anthropic',
      modelId: 'env-model',
      apiKey: 'env-key',
    })
    expect(missing).toBeNull()
    expect(modelRepo.findById).not.toHaveBeenCalled()
  })

  it('环境变量指定免密模型时不要求 API Key', async () => {
    vi.stubEnv('PERO_LLM_API_KEY', undefined)
    vi.stubEnv('PERO_LLM_MODEL', 'gemma-4-31b-qat-q4')
    vi.stubEnv('PERO_LLM_PROVIDER', 'openai')
    vi.stubEnv('PERO_LLM_API_BASE', 'http://localhost:1234/v1')
    const { configRepo, modelRepo } = createModelDeps({}, {})
    const resolver = new ModelRoleResolver(configRepo as never, modelRepo as never)
    await expect(resolver.resolve('main')).resolves.toMatchObject({
      modelId: 'gemma-4-31b-qat-q4',
      apiKey: '',
      apiBase: 'http://localhost:1234/v1',
    })
  })

  it('据点管家任务应读取独立模型槽', async () => {
    const { configRepo, modelRepo } = createModelDeps(
      { 'model.task.butler': '3', 'model.main': '1' },
      {
        1: { provider: 'openai', modelId: 'main', apiKey: 'main-key' },
        3: { provider: 'openai', modelId: 'butler', apiKey: 'butler-key' },
      },
    )
    const resolver = new ModelRoleResolver(configRepo as never, modelRepo as never)

    const config = await resolver.resolve('butler')

    expect(config?.modelId).toBe('butler')
    expect(configRepo.get).toHaveBeenCalledWith('model.task.butler')
  })

  it('应当创建绑定到指定角色的 getter', async () => {
    const { configRepo, modelRepo } = createModelDeps(
      { 'model.main': '1' },
      { 1: { provider: 'openai', modelId: 'main', apiKey: 'key' } },
    )
    const resolver = new ModelRoleResolver(configRepo as never, modelRepo as never)

    const getMain = resolver.bind('main')

    await expect(getMain()).resolves.toMatchObject({ modelId: 'main' })
  })
})

function createResolver(root: string, workshop = true): PathResolver {
  return {
    resolve: vi.fn((alias: string) =>
      join(
        root,
        alias.replace('@app/', 'app/').replace('@workshop', 'workshop').replace('@data/', 'data/'),
      ),
    ),
    isAvailable: vi.fn((alias: string) => alias === '@workshop' && workshop),
    // Workshop 多根支持（AssetRegistry 依赖）
    getRoots: vi.fn((prefix: string) =>
      prefix === '@workshop' && workshop ? [join(root, 'workshop')] : [],
    ),
  } as unknown as PathResolver
}

function writeAsset(dir: string, filename: string, data: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), JSON.stringify(data))
}

describe('AssetRegistry', () => {
  let root: string

  beforeEach(() => {
    root = join(tmpdir(), `infos-assets-${Date.now()}-${Math.random()}`)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('应当按官方、工坊、本地优先级扫描资产并允许后扫覆盖', async () => {
    // 目录布局对齐 AssetRegistry 当前实现：官方按打包路径、工坊按分类子目录、本地按 scanAssetRoot 分类
    writeAsset(
      join(root, 'app', 'backend', 'src', 'services', 'mdp', 'agents', 'pero'),
      'agent.json',
      {
        asset_id: 'pero.persona.default',
        type: 'persona',
        display_name: '官方 Pero',
        version: '1.0.0',
      },
    )
    writeAsset(join(root, 'workshop', 'agents', 'sub'), 'asset.json', {
      asset_id: 'pero.persona.default',
      type: 'persona',
      title: '工坊 Pero',
      workshopPublishedFileId: '123',
    })
    writeAsset(join(root, 'data', 'custom', 'prompts', 'local'), 'manifest.json', {
      asset_id: 'local.prompt.demo',
      type: 'prompt',
      displayName: '本地提示词',
    })

    const registry = new AssetRegistry(createResolver(root))
    await registry.scanAll()

    expect(registry.isScanned).toBe(true)
    expect(registry.getAsset('pero.persona.default')).toMatchObject({
      source: 'workshop',
      displayName: '工坊 Pero',
      workshopId: '123',
    })
    expect(registry.getAssetsByType('persona')).toHaveLength(1)
    expect(registry.getAssetsBySource('local')).toEqual([
      expect.objectContaining({ assetId: 'local.prompt.demo' }),
    ])
    expect(registry.getAllAssets()).toHaveLength(2)
  })

  it('应当跳过无效资产并支持重新扫描', async () => {
    writeAsset(
      join(root, 'app', 'backend', 'src', 'services', 'mdp', 'agents', 'bad'),
      'asset.json',
      {
        type: 'persona',
      },
    )
    const registry = new AssetRegistry(createResolver(root, false))

    await registry.scanAll()
    writeAsset(join(root, 'data', 'custom', 'packages', 'new'), 'description.json', {
      asset_id: 'new.mod.demo',
      type: 'mod',
      version: '2.0.0',
    })
    await registry.rescan()

    expect(registry.getAsset('missing')).toBeUndefined()
    expect(registry.getAssetsByType('mod')).toEqual([
      expect.objectContaining({ assetId: 'new.mod.demo', version: '2.0.0' }),
    ])
  })
})
