import { errorHandler } from '@infos/backend/middleware/errorHandler'
import { AppError } from '@infos/backend/lib/appError'
import { describe, expect, it, vi } from 'vitest'
import { createChatRouter as rawcreateChatRouter } from '@infos/backend/routers/chat.router'

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>
}

/** 测试用 Thread 数据 */
function createThread() {
  return {
    id: 't1',
    agentId: 'pero',
    channel: 'desktop',
    interactionMode: 'work',
    purpose: 'conversation',
    disabledTools: [],
    platform: undefined,
    platformIdentifier: undefined,
    title: '测试 Thread',
    messageCount: 0,
    pairCount: 0,
    lastMessageAt: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 测试用消息列表（倒序，最新在前，与 listMessages 行为一致） */
function createMessages() {
  return [
    {
      id: 2,
      threadId: 't1',
      role: 'assistant',
      content: '回复',
      rawContent: null,
      pairId: 'p1',
      senderId: null,
      agentId: 'pero',
      revision: 1,
      metadataJson: '{}',
      timestamp: '2026-01-02T00:00:00.000Z',
      status: 'active',
    },
    {
      id: 1,
      threadId: 't1',
      role: 'user',
      content: '你好',
      rawContent: 'raw',
      pairId: 'p1',
      senderId: null,
      agentId: null,
      revision: 1,
      metadataJson: '{}',
      timestamp: '2026-01-01T00:00:00.000Z',
      status: 'active',
    },
  ]
}

function createCtx() {
  const thread = createThread()
  const messages = createMessages()
  return {
    conversationQueue: {
      beginHistoryChange: vi.fn(() => vi.fn()),
      pause: vi.fn(),
      afterTurn: vi.fn(),
      historyChanged: vi.fn(),
      setLive: vi.fn(),
    },
    runtimeDebug: { close: vi.fn(async () => undefined) },
    agentService: {
      chatWithCompiledMessages: vi.fn(() => Promise.resolve('回复')),
      chatStreamWithCompiledMessages: vi.fn(),
    },
    agentManager: {
      getAgent: vi.fn((agentId: string) => (agentId === 'pero' ? { id: 'pero' } : undefined)),
      listAgents: vi.fn(() => [{ id: 'pero' }]),
    },
    // AIOS: ThreadService 替代旧 SessionService + LogService
    threadService: {
      getThread: vi.fn(() => Promise.resolve(thread)),
      appendUserMessage: vi.fn(() => Promise.resolve(messages[1])),
      appendAssistantMessage: vi.fn(() => Promise.resolve(messages[0])),
      listThreads: vi.fn(() => Promise.resolve({ items: [thread], total: 1 })),
      listMessages: vi.fn(() => Promise.resolve({ items: messages, total: messages.length })),
      createThread: vi.fn(() => Promise.resolve(thread)),
      updateInteractionMode: vi.fn(async () => undefined),
      rewindThread: vi.fn(async () => ({ deletedMessageIds: [1, 2] })),
      previewThreadRewind: vi.fn(async () => ({
        pairCount: 1,
        pairIds: ['p1'],
        messageCount: 2,
        affectedPaths: [],
      })),
      getOrCreateLatest: vi.fn(() => Promise.resolve(thread)),
      editMessage: vi.fn(() => Promise.resolve(true)),
      deleteMessage: vi.fn(() => Promise.resolve(true)),
      deleteMessagePair: vi.fn(() => Promise.resolve(2)),
      rewindMessage: vi.fn(() =>
        Promise.resolve({
          deletedMessageIds: [1, 2],
          preview: { pairCount: 1, pairIds: ['pair-1'], messageCount: 2, affectedPaths: [] },
        }),
      ),
      deleteThread: vi.fn(() => Promise.resolve(true)),
    },
    // AIOS: ContextCompiler 编译上下文
    contextCompiler: {
      compile: vi.fn(() =>
        Promise.resolve({
          messages: [{ role: 'system', content: 'system prompt' }],
          manifest: {},
        }),
      ),
    },
    conversationTurnService: {
      executeTurn: vi.fn(() =>
        Promise.resolve({
          reply: '回复',
          rawContent: '回复',
          toolCalls: [],
          threadId: 't1',
          agentId: 'pero',
          assistantMessage: messages[0],
        }),
      ),
      streamTurn: vi.fn(),
    },
    conversationProjection: {
      invalidate: vi.fn(),
      getSnapshot: vi.fn(() =>
        Promise.resolve({
          threadId: 't1',
          agentId: 'pero',
          channel: 'desktop',
          messages: [],
          surfaces: [
            {
              surfaceId: 'conversation-message:2',
              messageId: '2',
              revision: 1,
              generation: 1,
              nodes: [],
            },
          ],
          revision: 1,
          generatedAt: '2026-01-02T00:00:00.000Z',
        }),
      ),
    },
    attachmentService: {
      listForMessages: vi.fn(() => Promise.resolve(new Map())),
    },
    toolRegistry: {
      getDefinitions: vi.fn((): Array<{ name: string; description: string }> => []),
      isChatEnabled: vi.fn(() => false),
      isRuntimeScoped: vi.fn(() => false),
    },
    applicationRealms: {
      isPrivateTool: vi.fn((_name: string) => false),
    },
    capabilityGate: {
      resolve: vi.fn(() => ({ allowedTools: new Set<string>() })),
    },
    flowStateService: {
      deleteThread: vi.fn(async () => undefined),
      get: vi.fn(),
      listByThread: vi.fn(),
      clear: vi.fn(),
      rollbackPairs: vi.fn(),
    },
    toolContextService: { deletePairs: vi.fn(), deleteThread: vi.fn() },
    backgroundTaskService: {
      hasActiveWork: vi.fn(() => Promise.resolve(false)),
    },
    // AIOS: RuntimeStateService 替代旧 TaskManager（按 threadId 索引）
    runtimeStateService: {
      getTaskInfo: vi.fn(() => null),
      getAbortSignal: vi.fn(() => new AbortController().signal),
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      cancelTask: vi.fn(() => true),
      listActiveTasks: vi.fn((): Array<{ threadId: string; state: string }> => []),
      pauseTask: vi.fn((threadId: string) => threadId === 't1'),
      resumeTask: vi.fn((threadId: string) => threadId === 't1'),
      injectInstruction: vi.fn((threadId: string) => threadId === 't1'),
    },
  }
}

describe('ChatRouter', () => {
  it('切换非工作模式、清除整条会话及删除历史均撤销当前调试', async () => {
    const ctx = createCtx()
    const router = createChatRouter(ctx as never)
    const headers = { 'content-type': 'application/json' }
    expect(
      (
        await router.request('/threads/t1/interaction-mode', {
          method: 'PUT',
          headers,
          body: '{"interactionMode":"chat"}',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await router.request('/threads/t1/rewind', {
          method: 'POST',
          headers,
          body: '{"wholeThread":true}',
        })
      ).status,
    ).toBe(200)
    expect((await router.request('/threads/t1', { method: 'DELETE' })).status).toBe(200)
    expect(ctx.runtimeDebug.close).toHaveBeenCalledTimes(3)
    expect(ctx.runtimeDebug.close).toHaveBeenLastCalledWith('t1')
  })
  it('group 会话工具应严格限制为 Channel 白名单，不得回退注册表全量工具', async () => {
    const ctx = createCtx()
    const registryTools = Array.from({ length: 44 }, (_, index) => ({
      name: index < 6 ? `group_tool_${index}` : `other_tool_${index}`,
      description: `工具 ${index}`,
    }))
    ctx.threadService.getThread.mockResolvedValue({
      ...createThread(),
      channel: 'group',
      disabledTools: [],
    } as never)
    ctx.toolRegistry.getDefinitions.mockReturnValue(registryTools)
    ctx.capabilityGate.resolve.mockReturnValue({
      allowedTools: new Set(registryTools.slice(0, 6).map((tool) => tool.name)),
    })
    const router = createChatRouter(ctx as never)

    const response = await router.request('http://test/threads/t1/tools')
    const body = (await response.json()) as {
      data: { tools: Array<{ name: string }> }
    }

    expect(body.data.tools).toHaveLength(6)
    expect(body.data.tools.map((tool) => tool.name)).toEqual(
      registryTools.slice(0, 6).map((tool) => tool.name),
    )
  })

  it('Char Ops应隐藏Realm私有工具并保留显式主Agent投影', async () => {
    const ctx = createCtx()
    const registryTools = [
      { name: 'main_tool', description: '主应用工具' },
      { name: 'realm_private', description: 'Realm私有工具' },
      { name: 'arca_document_inspect', description: 'Arca显式投影' },
    ]
    ctx.threadService.getThread.mockResolvedValue({
      ...createThread(),
      disabledTools: [],
    } as never)
    ctx.toolRegistry.getDefinitions.mockReturnValue(registryTools)
    ctx.applicationRealms.isPrivateTool.mockImplementation(
      (name: string) => name === 'realm_private',
    )
    ctx.capabilityGate.resolve.mockReturnValue({
      allowedTools: new Set(registryTools.map((tool) => tool.name)),
    })
    const router = createChatRouter(ctx as never)

    const response = await router.request('http://test/threads/t1/tools')
    const body = (await response.json()) as {
      data: { tools: Array<{ name: string }> }
    }

    expect(body.data.tools.map((tool) => tool.name)).toEqual(['main_tool', 'arca_document_inspect'])
  })

  it('应当执行非流式对话: 获取 Thread→追加用户消息→编译上下文→对话→追加 Agent 回复', async () => {
    const ctx = createCtx()
    const router = createChatRouter(ctx as never)

    // 不传 agentId，验证从 thread.agentId 取默认值的逻辑
    const response = await router.request('http://test/', {
      method: 'POST',
      body: JSON.stringify({ threadId: 't1', content: '你好' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(await readJson(response)).toMatchObject({
      code: 'OK',
      data: {
        threadId: 't1',
        messageId: '2',
        surface: expect.objectContaining({ surfaceId: 'conversation-message:2' }),
      },
    })
    expect(ctx.conversationTurnService.executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 't1',
        agentId: 'pero',
        signal: expect.any(AbortSignal),
        content: '你好',
        attachmentIds: undefined,
        imageMode: undefined,
        workspaceContext: undefined,
      }),
    )
  })

  it('应当停止生成、创建 Thread 并获取最新 Thread', async () => {
    const ctx = createCtx()
    const router = createChatRouter(ctx as never)

    const stopped = await router.request('http://test/stop', {
      method: 'POST',
      body: JSON.stringify({ threadId: 't1' }),
      headers: { 'content-type': 'application/json' },
    })
    const created = await router.request('http://test/threads', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'pero', channel: 'desktop', title: '新对话' }),
      headers: { 'content-type': 'application/json' },
    })
    const latest = await router.request('http://test/threads/latest', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'pero', channel: 'desktop' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(await readJson(stopped)).toMatchObject({ code: 'OK' })
    expect(ctx.runtimeStateService.cancelTask).toHaveBeenCalledWith('t1')
    expect(await readJson(created)).toMatchObject({
      code: 'OK',
      data: { thread: { id: 't1', agentId: 'pero' } },
    })
    expect(ctx.threadService.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'pero',
        channel: 'desktop',
        title: '新对话',
      }),
    )
    expect(await readJson(latest)).toMatchObject({
      code: 'OK',
      data: { thread: { id: 't1', agentId: 'pero' } },
    })
    expect(ctx.threadService.getOrCreateLatest).toHaveBeenCalledWith(
      'pero',
      'desktop',
      'conversation',
    )
  })

  it('应当查询 Thread 列表和 Thread 详情(含消息列表)', async () => {
    const ctx = createCtx()
    const router = createChatRouter(ctx as never)

    const list = await router.request(
      'http://test/threads?agentId=pero&channel=desktop&page=1&pageSize=10',
    )
    const detail = await router.request('http://test/threads/t1?page=1&pageSize=20')

    expect(await readJson(list)).toMatchObject({
      code: 'OK',
      data: { items: [{ id: 't1' }], total: 1 },
    })
    expect(ctx.threadService.listThreads).toHaveBeenCalledWith({
      agentId: 'pero',
      agentIds: undefined,
      channel: 'desktop',
      excludeChannels: ['social'],
      page: 1,
      pageSize: 10,
      // M05 §8.3: 普通聊天列表默认 conversation purpose（排除后台任务 Thread）
      purpose: 'conversation',
    })
    // 详情: messages 为 items（倒序，最新在前），total 为消息总数
    expect(await readJson(detail)).toMatchObject({
      code: 'OK',
      data: {
        thread: { id: 't1' },
        messages: [{ id: 2 }, { id: 1 }],
        total: 2,
      },
    })
    expect(ctx.threadService.getThread).toHaveBeenCalledWith('t1')
    expect(ctx.threadService.listMessages).toHaveBeenCalledWith({
      threadId: 't1',
      page: 1,
      pageSize: 20,
    })
  })

  it('应当编辑、删除单条消息和级联删除消息对', async () => {
    const ctx = createCtx()
    const router = createChatRouter(ctx as never)

    const patched = await router.request('http://test/threads/t1/messages/1', {
      method: 'PATCH',
      body: JSON.stringify({ content: '新内容' }),
      headers: { 'content-type': 'application/json' },
    })
    const deleted = await router.request('http://test/threads/t1/messages/1', {
      method: 'DELETE',
    })
    const pairDeleted = await router.request('http://test/threads/t1/messages/1/pair', {
      method: 'DELETE',
    })

    expect(await readJson(patched)).toMatchObject({ code: 'OK' })
    expect(ctx.threadService.editMessage).toHaveBeenCalledWith(1, '新内容', 't1', undefined)
    expect(await readJson(deleted)).toMatchObject({ code: 'OK' })
    expect(ctx.threadService.deleteMessage).toHaveBeenCalledWith(1)
    expect(await readJson(pairDeleted)).toMatchObject({
      code: 'OK',
      data: {
        deletedCount: 2,
        deletedMessageIds: [1, 2],
        projection: { threadId: 't1', messages: [] },
      },
    })
    expect(ctx.threadService.rewindMessage).toHaveBeenCalledWith('t1', 1)
    expect(ctx.conversationProjection.invalidate).toHaveBeenCalledWith('t1')
    expect(ctx.conversationProjection.getSnapshot).toHaveBeenCalledWith('t1')
  })

  it('应当管理活跃任务: 列出/暂停/恢复/注入', async () => {
    const ctx = createCtx()
    const router = createChatRouter(ctx as never)

    ctx.runtimeStateService.listActiveTasks.mockReturnValueOnce([
      { threadId: 't1', state: 'running' },
    ])
    const tasks = await router.request('http://test/tasks')
    const paused = await router.request('http://test/tasks/pause', {
      method: 'POST',
      body: JSON.stringify({ threadId: 't1' }),
      headers: { 'content-type': 'application/json' },
    })
    const missingPause = await router.request('http://test/tasks/pause', {
      method: 'POST',
      body: JSON.stringify({ threadId: 'missing' }),
      headers: { 'content-type': 'application/json' },
    })
    const resumed = await router.request('http://test/tasks/resume', {
      method: 'POST',
      body: JSON.stringify({ threadId: 't1' }),
      headers: { 'content-type': 'application/json' },
    })
    const injected = await router.request('http://test/tasks/inject', {
      method: 'POST',
      body: JSON.stringify({ threadId: 't1', instruction: '继续' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(await readJson(tasks)).toMatchObject({ code: 'OK', data: [{ threadId: 't1' }] })
    expect(await readJson(paused)).toMatchObject({ code: 'OK' })
    // pauseTask 返回 false 时路由返回 404
    expect(missingPause.status).toBe(404)
    expect(await readJson(resumed)).toMatchObject({ code: 'OK' })
    expect(await readJson(injected)).toMatchObject({ code: 'OK' })
    expect(ctx.runtimeStateService.pauseTask).toHaveBeenCalledWith('t1')
    expect(ctx.runtimeStateService.resumeTask).toHaveBeenCalledWith('t1')
    expect(ctx.runtimeStateService.injectInstruction).toHaveBeenCalledWith('t1', '继续')
  })

  it('应当拒绝非法对话、非法消息和缺失任务参数', async () => {
    const ctx = createCtx()
    // 让 service 返回失败值，触发 AppError NOT_FOUND
    ctx.threadService.editMessage.mockResolvedValueOnce(false)
    ctx.threadService.deleteMessage.mockResolvedValueOnce(false)
    ctx.threadService.rewindMessage.mockRejectedValueOnce(new AppError('NOT_FOUND'))
    const router = createChatRouter(ctx as never)

    // 非法对话: 缺 threadId 和 content → zValidator 400
    const invalidChat = await router.request('http://test/', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
      headers: { 'content-type': 'application/json' },
    })
    // 非法消息 ID (msgId=0) → AppError INVALID_PARAMETER → 对应 4xx
    const invalidPatchId = await router.request('http://test/threads/t1/messages/0', {
      method: 'PATCH',
      body: JSON.stringify({ content: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    // 空内容 (content 长度 0) → zValidator 400
    const missingPatch = await router.request('http://test/threads/t1/messages/1', {
      method: 'PATCH',
      body: JSON.stringify({ content: '' }),
      headers: { 'content-type': 'application/json' },
    })
    // 消息不存在: editMessage 返回 false → AppError NOT_FOUND → 对应 4xx
    const notFoundPatch = await router.request('http://test/threads/t1/messages/1', {
      method: 'PATCH',
      body: JSON.stringify({ content: '新内容' }),
      headers: { 'content-type': 'application/json' },
    })
    // 删除消息不存在 → AppError NOT_FOUND → 对应 4xx
    const notFoundDelete = await router.request('http://test/threads/t1/messages/1', {
      method: 'DELETE',
    })
    // 删除对话对不存在 → AppError NOT_FOUND → 对应 4xx
    const notFoundPair = await router.request('http://test/threads/t1/messages/1/pair', {
      method: 'DELETE',
    })
    // 缺 threadId → AppError MISSING_FIELD → 对应 4xx
    const missingPause = await router.request('http://test/tasks/pause', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    })
    // 空 instruction → AppError MISSING_FIELD → 对应 4xx
    const missingInject = await router.request('http://test/tasks/inject', {
      method: 'POST',
      body: JSON.stringify({ threadId: 't1', instruction: ' ' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(invalidChat.status).toBe(400)
    expect(invalidPatchId.status).toBe(400)
    expect(missingPatch.status).toBe(400)
    expect(notFoundPatch.status).toBe(404)
    expect(notFoundDelete.status).toBe(404)
    expect(notFoundPair.status).toBe(404)
    expect(missingPause.status).toBe(400)
    expect(missingInject.status).toBe(400)
  })
})

function createChatRouter(...args: Parameters<typeof rawcreateChatRouter>) {
  return rawcreateChatRouter(...args).onError(errorHandler)
}
