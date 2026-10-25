import { errorHandler } from '@infos/backend/middleware/errorHandler'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRouter } from '@infos/backend/routers/agent.router'
import { createMemoryRouter } from '@infos/backend/routers/memory.router'
import { createMcpRouter } from '@infos/backend/routers/mcp.router'
import { createVoiceRouter as rawcreateVoiceRouter } from '@infos/backend/routers/voice.router'
import { createSchedulerRouter } from '@infos/backend/routers/scheduler.router'
import { ApplicationRealmManager } from '@infos/backend/applications/applicationRealm'
import { ApplicationToolManager } from '@infos/backend/applications/applicationToolManager'
import type { ApplicationAdapterManifest } from '@infos/shared'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'

afterEach(() => vi.useRealTimers())

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>
}

function createAgent() {
  return {
    id: 'pero',
    name: 'Pero',
    description: '猫娘助手',
    avatarPath: 'avatar.png',
    socialTraits: ['活泼'],
  }
}

describe('AgentRouter', () => {
  it.each(['', '?includeAdvanced=true'])(
    '主应用工具列表不暴露子应用私有工具，仅保留明确声明的宿主入口 %s',
    async (query) => {
      const toolRegistry = new ToolRegistry()
      const applicationRealms = new ApplicationRealmManager(toolRegistry)
      const realm = applicationRealms.register({
        realmId: 'social:test',
        appId: 'social',
        principalId: 'application:social',
        instanceId: 'test',
      })
      const definition = (name: string) => ({
        name,
        description: '测试工具',
        parameters: { type: 'object', properties: {} },
      })
      toolRegistry.register(definition('interact_with_social'), async () => '已委派')
      realm.registerTool(definition('social_group'), async () => '应用内部操作')
      realm.registerTool(definition('social_public_entry'), async () => '公开入口', {
        hostProjection: true,
      })
      const router = createAgentRouter({
        toolRegistry,
        applicationRealms,
        applicationTools: new ApplicationToolManager(),
      } as never)
      try {
        const response = await router.request(`http://test/tools${query}`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as { data: Array<{ name: string }> }
        expect(body.data.map((tool) => tool.name)).toEqual([
          'interact_with_social',
          'social_public_entry',
        ])
        expect(applicationRealms.toolDefinitions('social:test').map((tool) => tool.name)).toContain(
          'social_group',
        )
      } finally {
        await realm.dispose()
      }
    },
  )

  it('只列出已启动子应用的工具并标明来源，未上线的声明不出现', async () => {
    const toolRegistry = new ToolRegistry()
    const applicationRealms = new ApplicationRealmManager(toolRegistry)
    const applicationTools = new ApplicationToolManager()
    const realm = applicationRealms.register({
      realmId: 'demo',
      appId: 'demo',
      principalId: 'application:demo',
      instanceId: 'test',
    })
    const projection = (name: string) => ({
      name,
      endpointId: 'main',
      operation: 'do',
      audience: 'host_agent' as const,
      availability: 'while_ready' as const,
      invocation: 'invoke' as const,
      description: '子应用工具',
      parameters: { type: 'object', properties: {} },
      display: { label: name },
    })
    const declaration = applicationTools.declare(realm, {
      id: 'demo',
      name: 'Demo',
      toolProjections: [projection('demo_online'), projection('demo_offline')],
    } as unknown as ApplicationAdapterManifest)
    declaration.online('demo_online', async () => 'ok')
    const router = createAgentRouter({ toolRegistry, applicationRealms, applicationTools } as never)
    try {
      const response = await router.request('http://test/tools')
      const body = (await response.json()) as {
        data: Array<{ name: string; channels: string[]; source?: unknown }>
      }
      const source = { kind: 'application', appId: 'demo', appName: 'Demo' }
      expect(body.data).toEqual([
        expect.objectContaining({ name: 'demo_online', source, channels: ['desktop'] }),
      ])
    } finally {
      await realm.dispose()
    }
  })

  function createCtx() {
    const agent = createAgent()
    return {
      runtimeStateService: {
        // AIOS: 不再有后端全局活跃 Agent；getActiveAgent 返回 null 时回退 defaultAgentId
        getActiveAgent: vi.fn(() => null),
      },
      agentManager: {
        // AIOS 架构迁移：activeAgentId 已重命名为 defaultAgentId
        defaultAgentId: 'pero',
        listAgents: vi.fn(() => [agent]),
        getDefaultAgent: vi.fn(() => agent),
        getAvatarData: vi.fn(() => ({
          mime: 'image/png',
          buffer: new Uint8Array([1, 2, 3]).buffer,
        })),
        getAvatarUrl: vi.fn((id: string) => (id === 'pero' ? '/agents/pero/avatar' : undefined)),
        // setActiveAgent 已废弃：PUT /api/agents/active 路由已移除，不再支持运行时切换全局活跃 Agent
        getAgent: vi.fn((id: string) => (id === 'pero' ? agent : null)),
        // B6-3: GET /:id 返回完整可编辑详情（四页签字段）
        getAgentDetail: vi.fn((id: string) =>
          id === 'pero'
            ? {
                ...agent,
                ownerAppellation: '主人',
                systemPrompt: '我是 Pero。',
                channelPatches: {},
                socialBinding: {},
                toolPolicies: {},
                waifuTexts: {},
                isUser: false,
                isEnabled: true,
                isActive: true,
              }
            : null,
        ),
        createAgent: vi.fn((body: Record<string, unknown>) => body),
        updateAgent: vi.fn((id: string, patch: Record<string, unknown>) => ({
          ...agent,
          ...patch,
          id,
        })),
        deleteAgent: vi.fn(),
        enableAgent: vi.fn((id: string) => id === 'pero'),
        disableAgent: vi.fn((id: string) => id === 'pero'),
        reloadAgents: vi.fn(),
        getWaifuTexts: vi.fn((id: string) =>
          Promise.resolve(id === 'pero' ? { idle: ['喵'] } : null),
        ),
        getWritableCapabilitiesPath: vi.fn(() => '/tmp/pero-capabilities.yaml'),
      },
      cleanupDeletedAgent: vi.fn(),
      strongholdService: {
        ensureAgentLocation: vi.fn(() => Promise.resolve({ agentId: 'pero', roomId: 'living' })),
      },
      capabilityGate: {
        getAgentModes: vi.fn(() => ['chat']),
        getAgentSkills: vi.fn(() => ['memory']),
        // B6-3: 能力矩阵结构化读取（前端高级页表单化编辑）
        getChannels: vi.fn(() => ({
          desktop: { tools: [], skills: [], promptFragments: [] },
        })),
        writeChannels: vi.fn(),
        reloadAll: vi.fn(),
      },
      skillLoader: {
        getAllManifests: vi.fn(() => [
          { id: 'memory', name: '记忆管理', description: '管理长期记忆' },
        ]),
      },
      companionSchedulerService: {
        isRunning: vi.fn(() => false),
        start: vi.fn(),
        stop: vi.fn(() => Promise.resolve()),
      },
    }
  }

  it('应当管理 Agent 查询、头像和能力配置', async () => {
    const ctx = createCtx()
    const router = createAgentRouter(ctx as never)

    const list = await router.request('http://test/')
    const active = await router.request('http://test/active')
    const avatar = await router.request('http://test/pero/avatar')
    // AIOS 架构下 PUT /api/agents/active 已移除，不再支持运行时切换全局活跃 Agent
    const detail = await router.request('http://test/pero')
    const capabilities = await router.request('http://test/pero/capabilities')
    const texts = await router.request('http://test/pero/texts')

    expect(await readJson(list)).toMatchObject({
      code: 'OK',
      data: [{ id: 'pero', avatarUrl: '/agents/pero/avatar' }],
    })
    expect(await readJson(active)).toMatchObject({ code: 'OK', data: { id: 'pero' } })
    expect(avatar.headers.get('content-type')).toBe('image/png')
    expect(await avatar.arrayBuffer()).toHaveProperty('byteLength', 3)
    expect(await readJson(detail)).toMatchObject({
      code: 'OK',
      data: { id: 'pero' },
    })
    expect(await readJson(capabilities)).toMatchObject({
      code: 'OK',
      data: {
        agentId: 'pero',
        channels: { desktop: { tools: [], skills: [], promptFragments: [] } },
        skills: [{ id: 'memory', name: '记忆管理', description: '管理长期记忆' }],
      },
    })
    expect(await readJson(texts)).toMatchObject({ code: 'OK', data: { idle: ['喵'] } })
  })

  it('应当创建、删除、启用、禁用和重载 Agent', async () => {
    const ctx = createCtx()
    const router = createAgentRouter(ctx as never)

    const created = await router.request('http://test/', {
      method: 'POST',
      body: JSON.stringify({ id: 'neko', name: 'Neko', description: '测试' }),
      headers: { 'content-type': 'application/json' },
    })
    const deleted = await router.request('http://test/neko', { method: 'DELETE' })
    const enabled = await router.request('http://test/pero/enable', { method: 'POST' })
    const disabled = await router.request('http://test/pero/disable', { method: 'POST' })
    const reloaded = await router.request('http://test/reload', { method: 'POST' })

    expect(created.status).toBe(201)
    expect(await readJson(created)).toMatchObject({
      code: 'CREATED',
      data: { id: 'neko', name: 'Neko' },
    })
    expect(ctx.strongholdService.ensureAgentLocation).toHaveBeenCalledWith('neko')
    expect(ctx.strongholdService.ensureAgentLocation).toHaveBeenCalledWith('pero')
    expect(await readJson(deleted)).toMatchObject({ code: 'OK' })
    expect(ctx.agentManager.deleteAgent).toHaveBeenCalledWith('neko')
    expect(ctx.agentManager.enableAgent).toHaveBeenCalledWith('pero')
    expect(ctx.agentManager.disableAgent).toHaveBeenCalledWith('pero')
    expect(ctx.agentManager.reloadAgents).toHaveBeenCalledOnce()
    expect(await readJson(enabled)).toMatchObject({ code: 'OK' })
    expect(await readJson(disabled)).toMatchObject({ code: 'OK' })
    expect(await readJson(reloaded)).toMatchObject({ code: 'OK', data: [{ id: 'pero' }] })
  })

  it('应当处理缺失头像和非法创建请求', async () => {
    const ctx = createCtx()
    ctx.agentManager.getAvatarData.mockReturnValueOnce(null as never)
    const router = createAgentRouter(ctx as never)

    const avatar = await router.request('http://test/pero/avatar')
    const invalid = await router.request('http://test/', {
      method: 'POST',
      body: JSON.stringify({ id: 'Bad ID', name: '' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(avatar.status).toBe(404)
    expect(await readJson(avatar)).toMatchObject({ code: 'NOT_FOUND' })
    expect(invalid.status).toBe(400)
  })

  it('没有头像时列表和角色详情都不发布头像地址', async () => {
    const ctx = createCtx()
    ctx.agentManager.getAvatarUrl.mockReturnValue(undefined)
    const router = createAgentRouter(ctx as never)
    const list = (await (await router.request('http://test/')).json()) as {
      data: Array<{ avatarUrl?: string }>
    }
    const detail = (await (await router.request('http://test/pero')).json()) as {
      data: { avatarUrl?: string }
    }
    expect(list.data[0]).not.toHaveProperty('avatarUrl')
    expect(detail.data).not.toHaveProperty('avatarUrl')
  })
})

describe('SchedulerRouter', () => {
  it('应当返回调度器时间基准、运行状态和任务元数据', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const task = {
      name: 'cleanup',
      displayName: '临时文件清理',
      description: '清理过期缓存、上传文件与临时资源',
      intervalMs: 3_600_000,
      running: false,
      nextDueAt: Date.now() + 3_600_000,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastOutcome: null,
      stats: { totalRuns: 0, successCount: 0, errorCount: 0, averageDurationMs: 0 },
    }
    const ctx = {
      scheduler: {
        isPeriodicStarted: true,
        getPeriodicScheduleStatus: vi.fn(() => [task]),
        triggerPeriodicNow: vi.fn(),
      },
    }
    const router = createSchedulerRouter(ctx as never)

    const status = await readJson(await router.request('http://test/status'))
    const tasks = await readJson(await router.request('http://test/tasks'))

    expect(status).toMatchObject({
      code: 'OK',
      data: { schedulerRunning: true, serverNow: Date.now(), taskCount: 1, activeTasks: 0 },
    })
    expect(tasks).toMatchObject({
      code: 'OK',
      data: {
        schedulerRunning: true,
        serverNow: Date.now(),
        total: 1,
        items: [expect.objectContaining(task)],
      },
    })
    vi.useRealTimers()
  })
})

describe('MemoryRouter', () => {
  const first = {
    id: 'event-1',
    agentId: 'pero',
    narrative: '我和用户确认了新版事件记忆。',
    eventAt: '2026-08-27T10:00:00.000Z',
    createdAt: '2026-08-27T10:01:00.000Z',
    importance: 8,
    affect: { tones: ['认真'], valence: 7, arousal: 6 },
    participants: ['用户'],
    places: [],
    objects: [],
    topics: ['事件记忆'],
    origin: {
      mode: 'active',
      threadId: 'thread-1',
      pairIds: ['pair-1'],
      messageIds: ['1', '2'],
      channel: 'desktop',
    },
    status: 'active',
  }

  function archiveResult() {
    return {
      items: [first],
      page: 1,
      pageSize: 30,
      total: 1,
      pageCount: 1,
      facets: {
        channels: [{ value: 'desktop', count: 1 }],
        statuses: [{ value: 'active', count: 1 }],
        modes: [{ value: 'active', count: 1 }],
        tones: [{ value: '认真', count: 1 }],
        participants: [{ value: '用户', count: 1 }],
        places: [],
        objects: [],
        topics: [{ value: '事件记忆', count: 1 }],
      },
      stats: { active: 1, archived: 0, averageImportance: 8, topicCount: 1 },
    }
  }

  function createCtx() {
    return {
      eventMemoryService: {
        archiveQuery: vi.fn(() => Promise.resolve(archiveResult())),
        archive: vi.fn(() => Promise.resolve()),
        graphSnapshot: vi.fn(() =>
          Promise.resolve({
            nodes: [first],
            edges: [{ sourceId: first.id, targetId: 'event-2', relation: 'same_topic', weight: 1 }],
            truncated: false,
          }),
        ),
        detail: vi.fn((id: string) =>
          Promise.resolve(
            id === first.id
              ? {
                  ...first,
                  relations: [
                    { sourceId: first.id, targetId: 'event-2', relation: 'same_topic', weight: 1 },
                  ],
                }
              : undefined,
          ),
        ),
      },
      privacyDeletionService: { deleteMemory: vi.fn(async () => {}) },
      threadRepo: {
        findMessagesByPairIds: vi.fn(() =>
          Promise.resolve([
            {
              id: 1,
              role: 'user',
              content: '原始消息',
              timestamp: first.eventAt,
              pairId: 'pair-1',
            },
          ]),
        ),
      },
    }
  }

  it('应将档案过滤参数解析为组合过滤并返回分页与facets', async () => {
    const ctx = createCtx()
    const router = createMemoryRouter(ctx as never)

    const list = await readJson(
      await router.request(
        'http://test/?agentId=pero&query=%E4%BA%8B%E4%BB%B6&channels=desktop&statuses=active&topics=%E4%BA%8B%E4%BB%B6%E8%AE%B0%E5%BF%86&importanceMin=6&importanceMax=9&sort=eventAt&order=desc&page=2&pageSize=20',
      ),
    )

    expect(list).toMatchObject({
      code: 'OK',
      data: {
        items: [{ id: 'event-1' }],
        page: 1,
        total: 1,
        pageCount: 1,
        facets: { channels: [{ value: 'desktop', count: 1 }] },
        stats: { active: 1, averageImportance: 8 },
      },
    })
    expect(ctx.eventMemoryService.archiveQuery).toHaveBeenCalledWith({
      agentId: 'pero',
      query: '事件',
      channels: ['desktop'],
      statuses: ['active'],
      modes: undefined,
      tones: undefined,
      participants: undefined,
      places: undefined,
      objects: undefined,
      topics: ['事件记忆'],
      importanceMin: 6,
      importanceMax: 9,
      eventAtFrom: undefined,
      eventAtTo: undefined,
      createdAtFrom: undefined,
      createdAtTo: undefined,
      sort: 'eventAt',
      order: 'desc',
      page: 2,
      pageSize: 20,
    })
  })

  it('includeArchived兼容参数应映射为状态白名单', async () => {
    const ctx = createCtx()
    const router = createMemoryRouter(ctx as never)

    await router.request('http://test/?agentId=pero&includeArchived=true')

    expect(ctx.eventMemoryService.archiveQuery).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ['active', 'archived'] }),
    )
  })

  it('详情、来源和图谱快照应正常返回', async () => {
    const ctx = createCtx()
    const router = createMemoryRouter(ctx as never)

    const detail = await readJson(await router.request('http://test/event-1'))
    const source = await readJson(await router.request('http://test/event-1/source'))
    const graph = await readJson(
      await router.request('http://test/graph?agentId=pero&includeArchived=true&limit=120'),
    )

    expect(detail).toMatchObject({ code: 'OK', data: { id: 'event-1' } })
    expect(source).toMatchObject({
      code: 'OK',
      data: { available: true, messages: [{ content: '原始消息' }] },
    })
    expect(graph).toMatchObject({
      code: 'OK',
      data: {
        nodes: [{ id: 'event-1' }],
        edges: [{ sourceId: 'event-1', relation: 'same_topic' }],
        truncated: false,
      },
    })
    expect(ctx.eventMemoryService.graphSnapshot).toHaveBeenCalledWith('pero', {
      includeArchived: true,
      status: 'active',
      limit: 120,
    })
  })

  it('来源消息已删除时应返回available=false且不返回原文', async () => {
    const ctx = createCtx()
    ctx.threadRepo.findMessagesByPairIds.mockResolvedValueOnce([])
    const router = createMemoryRouter(ctx as never)

    const source = await readJson(await router.request('http://test/event-1/source'))

    expect(source).toMatchObject({ code: 'OK', data: { available: false, messages: [] } })
  })

  it('不存在事件返回404，旧写入、搜索和导入API不可达，删除API执行隐私清理', async () => {
    const ctx = createCtx()
    const router = createMemoryRouter(ctx as never)
    expect((await router.request('http://test/missing')).status).toBe(404)
    expect((await router.request('http://test/', { method: 'POST' })).status).toBe(404)
    expect((await router.request('http://test/import', { method: 'POST' })).status).toBe(404)
    expect((await router.request('http://test/search', { method: 'POST' })).status).toBe(404)
    expect((await router.request('http://test/event-1', { method: 'DELETE' })).status).toBe(200)
    expect(ctx.privacyDeletionService.deleteMemory).toHaveBeenCalledWith('event-1', false)
    expect(ctx.eventMemoryService.archive).not.toHaveBeenCalled()
  })
})

describe('McpRouter', () => {
  function createCtx(hasManager = true) {
    return {
      mcpConfigService: {
        list: vi.fn(() =>
          Promise.resolve([{ id: 1, name: 'fs', args: ['--root'], env: { A: 'B' } }]),
        ),
        create: vi.fn((body: Record<string, unknown>) => Promise.resolve({ id: 2, ...body })),
        update: vi.fn((id: number, body: Record<string, unknown>) =>
          Promise.resolve({ id, ...body }),
        ),
        delete: vi.fn(() => Promise.resolve()),
        toggle: vi.fn((id: number) => Promise.resolve({ id, enabled: false })),
      },
      mcpManager: hasManager
        ? {
            disconnectOne: vi.fn(() => Promise.resolve()),
            connectAll: vi.fn(() => Promise.resolve()),
            reconnectOne: vi.fn(() =>
              Promise.resolve({
                name: 'fs',
                status: 'connected',
                tools: [{ name: 'read' }],
                error: undefined,
              }),
            ),
            getStatus: vi.fn(() => ({
              totalServers: 1,
              connectedServers: 1,
              totalTools: 1,
              connections: [],
            })),
            getAllTools: vi.fn(() => [{ name: 'read' }]),
          }
        : undefined,
      mcpRegistrySynchronizer: {
        sync: vi.fn(),
      },
      skillLoader: {
        getAllManifests: vi.fn(() => [{ id: 'skill-a' }]),
        loadSkillContent: vi.fn((id: string) => (id === 'skill-a' ? '内容' : null)),
        reloadAll: vi.fn(),
        importFromPath: vi.fn(() => 'skill-b'),
        deleteById: vi.fn(),
      },
    }
  }

  it('应当管理 MCP 配置、连接状态和工具列表', async () => {
    const ctx = createCtx()
    const router = createMcpRouter(ctx as never)

    const configs = await router.request('http://test/configs')
    const created = await router.request('http://test/configs', {
      method: 'POST',
      body: JSON.stringify({ name: 'shell', command: 'node' }),
      headers: { 'content-type': 'application/json' },
    })
    const updated = await router.request('http://test/configs/1', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
      headers: { 'content-type': 'application/json' },
    })
    const toggled = await router.request('http://test/configs/1/toggle', { method: 'POST' })
    const connected = await router.request('http://test/connect', { method: 'POST' })
    const reconnected = await router.request('http://test/fs/reconnect', { method: 'POST' })
    const status = await router.request('http://test/status')
    const tools = await router.request('http://test/tools')
    const deleted = await router.request('http://test/configs/1', { method: 'DELETE' })

    expect(await readJson(configs)).toMatchObject({
      code: 'OK',
      data: [{ args: ['--root'], env: { A: 'B' } }],
    })
    expect(created.status).toBe(201)
    expect(await readJson(created)).toMatchObject({
      code: 'CREATED',
      data: { id: 2, name: 'shell' },
    })
    expect(await readJson(updated)).toMatchObject({ code: 'OK', data: { id: 1, enabled: false } })
    expect(await readJson(toggled)).toMatchObject({ code: 'OK', data: { id: 1, enabled: false } })
    expect(await readJson(connected)).toMatchObject({ code: 'OK', data: { totalServers: 1 } })
    expect(await readJson(reconnected)).toMatchObject({
      code: 'OK',
      data: { name: 'fs', status: 'connected', toolCount: 1 },
    })
    expect(await readJson(status)).toMatchObject({ code: 'OK', data: { connectedServers: 1 } })
    expect(await readJson(tools)).toMatchObject({ code: 'OK', data: [{ name: 'read' }] })
    expect(await readJson(deleted)).toMatchObject({ code: 'OK', data: { deleted: true } })
    expect(ctx.mcpConfigService.delete).toHaveBeenCalledWith(1)
  })

  it('应当管理 Skill 内容、重载、导入和删除', async () => {
    const ctx = createCtx()
    const router = createMcpRouter(ctx as never)

    const skills = await router.request('http://test/skills')
    const content = await router.request('http://test/skills/skill-a/content')
    const reloaded = await router.request('http://test/skills/reload', { method: 'POST' })
    const imported = await router.request('http://test/skills/import', {
      method: 'POST',
      body: JSON.stringify({ sourcePath: 'C:/skills/demo' }),
      headers: { 'content-type': 'application/json' },
    })
    const deleted = await router.request('http://test/skills/skill-a', { method: 'DELETE' })

    expect(await readJson(skills)).toMatchObject({ code: 'OK', data: [{ id: 'skill-a' }] })
    expect(await readJson(content)).toMatchObject({
      code: 'OK',
      data: { id: 'skill-a', content: '内容' },
    })
    expect(await readJson(reloaded)).toMatchObject({ code: 'OK' })
    expect(await readJson(imported)).toMatchObject({
      code: 'OK',
    })
    expect(await readJson(deleted)).toMatchObject({ code: 'OK' })
  })

  it('应当在 MCP Manager 缺失时返回未初始化状态', async () => {
    const router = createMcpRouter(createCtx(false) as never)

    const status = await router.request('http://test/status')
    const tools = await router.request('http://test/tools')

    expect(await readJson(status)).toMatchObject({
      code: 'OK',
      data: { totalServers: 0 },
    })
    expect(await readJson(tools)).toMatchObject({ code: 'OK', data: [] })
  })
})

describe('VoiceRouter', () => {
  function createDeps() {
    return {
      ttsService: {
        isAvailable: true,
        synthesize: vi.fn(() =>
          Promise.resolve({ audio: new Uint8Array([1, 2]).buffer, mimeType: 'audio/mpeg' }),
        ),
      },
      asrService: {
        isAvailable: false,
        recognize: vi.fn((_input: { audio: ArrayBuffer; mimeType: string; language?: string }) =>
          Promise.resolve({ text: '你好', language: 'zh', confidence: 0.9, durationMs: 12 }),
        ),
      },
    }
  }

  it('应当合成语音、识别二进制音频并返回状态', async () => {
    const deps = createDeps()
    const router = createVoiceRouter(deps as never)

    const tts = await router.request('http://test/tts', {
      method: 'POST',
      body: JSON.stringify({ text: '你好', voice: 'alloy', speed: 1, format: 'mp3' }),
      headers: { 'content-type': 'application/json' },
    })
    const asr = await router.request('http://test/asr?language=zh', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'content-type': 'audio/webm' },
    })
    const status = await router.request('http://test/status')

    expect(tts.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await tts.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
    expect(deps.ttsService.synthesize).toHaveBeenCalledWith({
      text: '你好',
      voice: 'alloy',
      speed: 1,
      format: 'mp3',
      signal: expect.any(AbortSignal),
    })
    expect(await readJson(asr)).toMatchObject({
      code: 'OK',
      data: { text: '你好', language: 'zh' },
    })
    expect(new Uint8Array(deps.asrService.recognize.mock.calls[0]![0].audio)).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(deps.asrService.recognize).toHaveBeenCalledWith({
      audio: expect.any(ArrayBuffer),
      mimeType: 'audio/webm',
      language: 'zh',
    })
    expect(await readJson(status)).toMatchObject({
      code: 'OK',
      data: { tts: { available: true }, asr: { available: false } },
    })
  })

  it('应当识别 multipart 音频并拒绝空文本和空音频', async () => {
    const deps = createDeps()
    const router = createVoiceRouter(deps as never)
    const form = new FormData()
    form.set('audio', new File([new Uint8Array([1])], 'a.webm', { type: 'audio/webm' }))
    form.set('language', 'ja')

    const multipart = await router.request('http://test/asr', { method: 'POST', body: form })
    const emptyText = await router.request('http://test/tts', {
      method: 'POST',
      body: JSON.stringify({ text: '   ' }),
      headers: { 'content-type': 'application/json' },
    })
    const emptyAudio = await router.request('http://test/asr', {
      method: 'POST',
      body: new Uint8Array([]),
      headers: { 'content-type': 'audio/webm' },
    })

    expect(await readJson(multipart)).toMatchObject({ code: 'OK', data: { text: '你好' } })
    expect(deps.asrService.recognize).toHaveBeenCalledWith({
      audio: expect.any(ArrayBuffer),
      mimeType: 'audio/webm',
      language: 'ja',
    })
    expect(emptyText.status).toBe(400)
    expect(emptyAudio.status).toBe(400)
  })
})

function createVoiceRouter(...args: Parameters<typeof rawcreateVoiceRouter>) {
  return rawcreateVoiceRouter(...args).onError(errorHandler)
}
