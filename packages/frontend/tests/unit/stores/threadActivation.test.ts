import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {
  ApiResponse,
  ConversationProjectionSnapshot,
  SurfaceId,
  SurfaceNodeId,
} from '@infos/shared'
import type { ThreadInfo } from '@infos/frontend/api/modules/threadsApi'
import { useThreadStore } from '@infos/frontend/stores/useThreadStore'
import { useCompositorStore } from '@infos/frontend/stores/useCompositorStore'
import { ApiError } from '@infos/frontend/api/errors'

const api = vi.hoisted(() => ({
  latest: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  projection: vi.fn(),
  error: vi.fn(),
  edit: vi.fn(),
}))

vi.mock('@infos/frontend/api/modules/threadsApi', () => ({
  threadsApi: {
    getLatest: api.latest,
    get: api.get,
    getProjection: api.projection,
    create: api.create,
  },
}))
vi.mock('@infos/frontend/api/modules/chatApi', () => ({ chatApi: { editMessage: api.edit } }))
vi.mock('@infos/frontend/lib/logger', () => ({ logger: { error: api.error } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function thread(agentId: string, id = `${agentId}-thread`): ThreadInfo {
  return {
    id,
    agentId,
    channel: 'desktop',
    threadKind: 'side',
    generation: 1,
    canDelete: true,
    canFork: true,
    canReset: false,
    title: '当前会话',
    messageCount: 0,
    pairCount: 0,
    lastMessageAt: null,
    status: 'active',
    contextPolicy: null,
    disabledTools: [],
    enabledSkills: [],
    interactionMode: 'work',
    autoExecuteTools: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function latestResponse(agentId: string): ApiResponse<{ thread: ThreadInfo }> {
  return { code: 'OK', message: '获取成功', data: { thread: thread(agentId) } }
}

function projectionResponse(record: ThreadInfo): ApiResponse<ConversationProjectionSnapshot> {
  return {
    code: 'OK',
    message: '获取成功',
    data: {
      protocolVersion: 1,
      threadId: record.id,
      principalId: record.agentId,
      revision: 1,
      generatedAt: record.updatedAt,
      messages: [],
      surfaces: [],
      hasMoreBefore: false,
    },
  }
}

const records = new Map([
  ['pero-thread', thread('pero')],
  ['nana-thread', thread('nana')],
  ['selected-thread', thread('pero', 'selected-thread')],
])

function recordFor(id: string): ThreadInfo {
  const record = records.get(id)
  if (!record) throw new Error(`缺少会话样本：${id}`)
  return record
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  api.latest.mockImplementation(async ({ agentId }: { agentId: string }) => latestResponse(agentId))
  api.get.mockImplementation(async (id: string) => ({
    code: 'OK',
    message: '获取成功',
    data: { thread: recordFor(id), messages: [], total: 0 },
  }))
  api.projection.mockImplementation(async (id: string) => projectionResponse(recordFor(id)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('最近会话激活与初始化竞态', () => {
  it('删除缓存会话后重新进入角色，从有效来源恢复并排除旧快照', async () => {
    const store = useThreadStore()
    await store.loadThreadMessages('selected-thread', 'pero')
    store.forgetThread('selected-thread', 'pero')
    store.clearThread()
    api.get.mockClear()
    api.projection.mockClear()

    await expect(store.ensureLatestThread('pero')).resolves.toBe('pero-thread')

    expect(api.get).toHaveBeenCalledWith('pero-thread', expect.any(Object))
    expect(api.get).not.toHaveBeenCalledWith('selected-thread', expect.any(Object))
    expect(store.threadId).toBe('pero-thread')
  })

  it('已记住的会话返回 NOT_FOUND 后清理选择并回退到有效会话', async () => {
    const selection = new Map<string, string>()
    const storage = {
      getItem: (key: string) => selection.get(key) ?? null,
      setItem: (key: string, value: string) => { selection.set(key, value) },
      removeItem: vi.fn((key: string) => { selection.delete(key) }),
    }
    vi.stubGlobal('sessionStorage', storage)
    const store = useThreadStore()
    await store.loadThreadMessages('selected-thread', 'pero')
    store.clearThread()
    api.get.mockImplementation(async (id: string) => {
      if (id === 'selected-thread') throw new ApiError('NOT_FOUND', '会话已删除')
      return { code: 'OK', data: { thread: recordFor(id), messages: [], total: 0 } }
    })

    await expect(store.ensureLatestThread('pero')).resolves.toBe('pero-thread')
    expect(storage.removeItem).toHaveBeenCalledWith('infos:conversation:pero')
    expect(selection.get('infos:conversation:pero')).toBe('pero-thread')
    expect(store.historyError).toBeNull()
    expect(store.threadId).toBe('pero-thread')
  })

  it('删除正在加载的目标后，迟到投影结束为已失效请求', async () => {
    const store = useThreadStore()
    await store.loadThreadMessages('pero-thread', 'pero')
    const delayed = deferred<ReturnType<typeof projectionResponse>>()
    api.projection.mockReturnValueOnce(delayed.promise)
    const loading = store.loadThreadMessages('selected-thread', 'pero')

    store.forgetThread('selected-thread', 'pero')
    delayed.resolve(projectionResponse(recordFor('selected-thread')))

    await expect(loading).resolves.toEqual({ status: 'superseded' })
    expect(store.threadId).toBe('pero-thread')
    expect(store.isLoadingHistory).toBe(false)
  })

  it('取消断流恢复后，迟到快照不能覆盖当前消息或重新占用界面', async () => {
    const store = useThreadStore()
    await store.loadThreadMessages('pero-thread', 'pero')
    const delayed = deferred<ReturnType<typeof projectionResponse>>()
    api.projection.mockReturnValueOnce(delayed.promise)
    const controller = new AbortController()
    const restoring = store.loadThreadMessages('pero-thread', 'pero', controller.signal)
    expect(store.isLoadingHistory).toBe(true)
    controller.abort()
    expect(store.isLoadingHistory).toBe(false)
    store.addMessage({
      id: '停止后保留的消息',
      role: 'user',
      content: '保留此内容',
      timestamp: '2026-10-20T00:00:00Z',
    })
    delayed.resolve(projectionResponse(recordFor('pero-thread')))
    await expect(restoring).resolves.toEqual({ status: 'superseded' })
    expect(store.messages.some((message) => message.content === '保留此内容')).toBe(true)
    expect(store.isLoadingHistory).toBe(false)
  })

  it('审批后原执行提交时用持久消息替换占位，不残留第二条回复', () => {
    const store = useThreadStore()
    const compositor = useCompositorStore()
    store.startThread('pero-thread', 'desktop', 'pero')
    store.addMessage({
      id: 'placeholder',
      role: 'assistant',
      content: '',
      timestamp: '2026-10-18T00:00:00Z',
      isStreaming: true,
    })
    store.streamingMessageId = 'placeholder'
    store.generationState = 'tool_calling'
    const surfaceId = 'running' as SurfaceId
    store.applySurfaceFrame({
      protocolVersion: 1,
      surfaceId,
      generation: 'g',
      revision: 1,
      sequence: 1,
      operationId: 'open',
      operation: { type: 'surface.open', threadId: 'pero-thread', principalId: 'pero' },
    })
    compositor.flush()
    const snapshot = projectionResponse(recordFor('pero-thread')).data!
    const message: ConversationProjectionSnapshot['messages'][number] = {
      messageId: '42',
      threadId: 'pero-thread',
      role: 'assistant',
      content: '工具执行完成',
      revision: 1,
      status: 'completed',
      imageTranscription: false,
      timestamp: '2026-10-18T00:00:00Z',
      toolCalls: [],
      contentBlocks: [],
      attachments: [],
    }
    const surface: ConversationProjectionSnapshot['surfaces'][number] = {
      surfaceId: 'conversation-message:42' as SurfaceId,
      generation: 'saved',
      messageId: '42',
      threadId: 'pero-thread',
      principalId: 'pero',
      state: 'committed',
      nodes: [],
      revision: 1,
      sequence: 0,
    }
    snapshot.messages = [message]
    snapshot.surfaces = [surface]
    store.applySurfaceFrame({
      protocolVersion: 1,
      surfaceId,
      generation: 'g',
      revision: 2,
      sequence: 2,
      operationId: 'commit',
      operation: { type: 'surface.commit', snapshot, message, surface },
    })
    store.finishStreaming()
    expect(store.messages.map((item) => item.id)).toEqual(['42'])
    expect(store.generationState).toBe('idle')
    expect(compositor.get('running')).toBeUndefined()
    compositor.$dispose()
    store.$dispose()
  })

  it('切换历史会话不能携带上一会话等待工具的流式占位', async () => {
    const store = useThreadStore()
    store.startThread('pero-thread', 'desktop', 'pero')
    store.addMessage({
      id: '旧流式占位',
      role: 'assistant',
      content: '',
      timestamp: '2026-10-18T00:00:00Z',
      isStreaming: true,
    })
    store.streamingMessageId = '旧流式占位'
    store.generationState = 'tool_calling'
    await store.loadThreadMessages('selected-thread', 'pero')
    expect(store.threadId).toBe('selected-thread')
    expect(store.messages).toEqual([])
    expect(store.streamingMessageId).toBeNull()
    expect(store.generationState).toBe('idle')
  })

  it('输入计数随状态补丁更新，只读取当前 Thread 与角色的活动执行', () => {
    const store = useThreadStore()
    const compositor = useCompositorStore()
    store.startThread('pero-thread', 'desktop', 'pero')
    const budget = {
      usedTokens: 9_000,
      maxInputTokens: 30_000,
      contextWindowTokens: 32_000,
      modelId: 'test-model',
      turn: 1,
      estimated: true,
      updatedAt: 100,
    }
    const install = (id: string, threadId: string, principalId: string, usedTokens: number) =>
      compositor.install({
        surfaceId: id as SurfaceId,
        generation: 'generation-1',
        threadId,
        principalId,
        state: 'open',
        revision: 1,
        sequence: 1,
        nodes: [
          {
            nodeId: `${id}:status` as SurfaceNodeId,
            kind: 'status',
            lifecycle: 'transient',
            revision: 1,
            props: {
              state: 'thinking',
              contextBudget: { ...budget, usedTokens, updatedAt: usedTokens },
            },
          },
        ],
      })
    install('current', 'pero-thread', 'pero', 9_000)
    install('another-thread', 'selected-thread', 'pero', 25_000)
    install('another-agent', 'pero-thread', 'nana', 26_000)
    expect(store.liveContextBudget?.usedTokens).toBe(9_000)
    compositor.enqueue({
      protocolVersion: 1,
      surfaceId: 'current' as SurfaceId,
      generation: 'generation-1',
      revision: 2,
      sequence: 2,
      operationId: 'budget-2',
      operation: {
        type: 'surface.patch-node',
        nodeId: 'current:status' as SurfaceNodeId,
        patch: { contextBudget: { ...budget, usedTokens: 15_000, turn: 2, updatedAt: 30_000 } },
      },
    })
    compositor.flush()
    expect(store.liveContextBudget).toMatchObject({ usedTokens: 15_000, turn: 2 })
    store.startThread('selected-thread', 'desktop', 'pero')
    expect(store.liveContextBudget?.usedTokens).toBe(25_000)
    store.startThread('nana-thread', 'desktop', 'nana')
    expect(store.liveContextBudget).toBeNull()
    store.$dispose()
    compositor.$dispose()
  })

  it('临时 ID 持久化后按原始出现位置定位，重复正文不能编辑到前一条', async () => {
    const store = useThreadStore()
    await store.ensureLatestThread('pero')
    const origin = { id: 'msg_pending', role: 'user' as const, content: '相同文字', timestamp: '' }
    // 模拟编辑弹窗打开后，服务端已经把临时 ID 替换为持久化 ID。
    store.messages = ['1', '2'].map((id) => ({ ...origin, id }))
    const response = projectionResponse(recordFor('pero-thread'))
    response.data!.messages = [1, 2].map((id) => ({
      messageId: String(id),
      threadId: 'pero-thread',
      role: 'user' as const,
      content: '相同文字',
      rawContent: null,
      imageTranscription: false,
      contentBlocks: [],
      pairId: `pair-${id}`,
      senderId: null,
      agentId: 'pero',
      revision: 1,
      status: 'active',
      timestamp: '',
      toolCalls: [],
      attachments: [],
    }))
    api.projection.mockResolvedValueOnce(response)
    const resolved = await store.resolvePersistedMessage(origin.id, {
      message: origin,
      occurrenceFromEnd: 0,
    })
    expect(resolved.id).toBe('2')
  })

  it('保存失败保留本地内容；保存响应晚到时不能覆盖新会话', async () => {
    const store = useThreadStore()
    await store.ensureLatestThread('pero')
    store.messages = [{ id: '1', role: 'user', content: '原文', timestamp: '', revision: 1 }]
    api.edit.mockRejectedValueOnce(new Error('保存失败'))
    await expect(store.editMessage('1', '新文')).rejects.toThrow('保存失败')
    expect(store.messages[0]?.content).toBe('原文')
    const saving = deferred<ReturnType<typeof projectionResponse>>()
    api.edit.mockReturnValueOnce(saving.promise)
    const pending = store.editMessage('1', '新文')
    await Promise.resolve()
    await store.loadThreadMessages('selected-thread', 'pero')
    saving.resolve(projectionResponse(recordFor('pero-thread')))
    await pending
    expect(store.threadId).toBe('selected-thread')
    expect(store.messages).toEqual([])
  })
  it('导航期间的后台刷新不会取消目标会话，加载结束后仍可正常刷新', async () => {
    const store = useThreadStore()
    await store.ensureLatestThread('pero')
    const projection = deferred<ReturnType<typeof projectionResponse>>()
    api.projection.mockReturnValueOnce(projection.promise)
    const selecting = store.loadThreadMessages('selected-thread', 'pero')
    const requests = api.projection.mock.calls.length
    await store.refreshCurrentThread('pero')
    expect(api.projection).toHaveBeenCalledTimes(requests)
    expect(store.navigationTarget?.threadId).toBe('selected-thread')
    projection.resolve(projectionResponse(recordFor('selected-thread')))
    await expect(selecting).resolves.toEqual({ status: 'loaded', threadId: 'selected-thread' })
    await store.refreshCurrentThread('nana')
    expect(api.projection).toHaveBeenCalledTimes(requests)
    await store.refreshCurrentThread('pero')
    expect(api.projection).toHaveBeenCalledTimes(requests + 1)
  })

  it('只在真实导航期间暴露目标，刷新当前会话不重复触发切换', async () => {
    const store = useThreadStore()
    await store.ensureLatestThread('pero')
    const switching = store.loadThreadMessages('selected-thread', 'pero')
    expect(store.navigationTarget).toEqual({ agentId: 'pero', threadId: 'selected-thread' })
    await switching
    expect(store.navigationTarget).toBeNull()
    const refreshing = store.refreshCurrentThread()
    expect(store.navigationTarget).toBeNull()
    await refreshing
  })

  it('新建会话期间改选历史会话，晚到的新建结果不能抢回页面', async () => {
    const store = useThreadStore()
    await store.ensureLatestThread('pero')
    const created = deferred<ApiResponse<{ thread: ThreadInfo }>>()
    api.create.mockReturnValue(created.promise)
    const creating = store.createNewThread('pero')
    expect(store.navigationTarget?.agentId).toBe('pero')
    await store.loadThreadMessages('selected-thread', 'pero')
    created.resolve({
      code: 'OK',
      message: '创建成功',
      data: { thread: thread('pero', 'new-thread') },
    })
    await expect(creating).resolves.toBe('new-thread')
    expect(store.threadId).toBe('selected-thread')
    expect(store.navigationTarget).toBeNull()
    expect(store.isLoadingHistory).toBe(false)
  })
  it('重复进入页面复用已加载会话，显式刷新优先读取已选会话', async () => {
    const store = useThreadStore()
    await store.ensureLatestThread('pero')
    await store.ensureLatestThread('pero')
    expect(api.latest).toHaveBeenCalledTimes(1)
    expect(api.projection).toHaveBeenCalledTimes(1)
    await store.loadLatestThread('pero')
    expect(api.latest).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledWith('pero-thread', { page: 1, pageSize: 1 })
    expect(api.projection).toHaveBeenCalledTimes(2)
  })
  it('主窗口与聊天组件同时恢复同一角色时共用一次请求', async () => {
    const latest = deferred<ReturnType<typeof latestResponse>>()
    api.latest.mockReturnValue(latest.promise)
    const store = useThreadStore()

    const restoring = store.loadLatestThread('pero')
    const activating = store.ensureLatestThread('pero')
    expect(api.latest).toHaveBeenCalledTimes(1)
    latest.resolve(latestResponse('pero'))

    await expect(restoring).resolves.toEqual({ status: 'loaded', threadId: 'pero-thread' })
    await expect(activating).resolves.toBe('pero-thread')
    expect(api.projection).toHaveBeenCalledTimes(1)
    expect(store.threadId).toBe('pero-thread')
    expect(store.historyError).toBeNull()
  })

  it('默认角色同步后，旧角色请求正常退出且不报激活失败', async () => {
    const oldLatest = deferred<ReturnType<typeof latestResponse>>()
    api.latest.mockImplementation(({ agentId }: { agentId: string }) =>
      agentId === 'pero' ? oldLatest.promise : Promise.resolve(latestResponse(agentId)),
    )
    const store = useThreadStore()

    const previous = store.ensureLatestThread('pero')
    await expect(store.ensureLatestThread('nana')).resolves.toBe('nana-thread')
    oldLatest.resolve(latestResponse('pero'))

    await expect(previous).resolves.toBeNull()
    expect(store.agentId).toBe('nana')
    expect(store.threadId).toBe('nana-thread')
    expect(api.error).not.toHaveBeenCalled()
  })

  it('旧角色 Projection 迟到时不能覆盖正在恢复的新角色', async () => {
    const oldProjection = deferred<ReturnType<typeof projectionResponse>>()
    const projectionStarted = deferred<void>()
    const nextLatest = deferred<ReturnType<typeof latestResponse>>()
    api.latest.mockImplementation(({ agentId }: { agentId: string }) =>
      agentId === 'nana' ? nextLatest.promise : Promise.resolve(latestResponse(agentId)),
    )
    api.projection.mockImplementation((id: string) => {
      if (id === 'pero-thread') {
        projectionStarted.resolve()
        return oldProjection.promise
      }
      return Promise.resolve(projectionResponse(recordFor(id)))
    })
    const store = useThreadStore()

    const previous = store.ensureLatestThread('pero')
    await projectionStarted.promise
    const current = store.ensureLatestThread('nana')
    oldProjection.resolve(projectionResponse(recordFor('pero-thread')))

    await expect(previous).resolves.toBeNull()
    expect(store.agentId).toBe('nana')
    expect(store.threadId).toBe('')
    expect(store.isLoadingHistory).toBe(true)
    nextLatest.resolve(latestResponse('nana'))
    await expect(current).resolves.toBe('nana-thread')
  })

  it('用户选中的历史会话不能被迟到的最近会话查询覆盖', async () => {
    const latest = deferred<ReturnType<typeof latestResponse>>()
    api.latest.mockReturnValue(latest.promise)
    const store = useThreadStore()

    const restoring = store.ensureLatestThread('pero')
    await store.loadThreadMessages('selected-thread', 'pero')
    latest.resolve(latestResponse('pero'))

    await expect(restoring).resolves.toBeNull()
    expect(store.threadId).toBe('selected-thread')
    expect(api.projection).toHaveBeenCalledTimes(1)
  })

  it('真实接口失败保留原始异常，不改写成笼统的激活失败', async () => {
    const error = new Error('后端暂时不可用')
    api.latest.mockRejectedValue(error)
    const store = useThreadStore()

    await expect(store.ensureLatestThread('pero')).rejects.toBe(error)
    expect(store.historyError).toBe(error.message)
    expect(store.isLoadingHistory).toBe(false)
  })

  it('消息投影失败也向调用方保留原始错误', async () => {
    const error = new Error('Conversation Projection 读取失败')
    api.projection.mockRejectedValue(error)
    const store = useThreadStore()

    await expect(store.ensureLatestThread('pero')).rejects.toBe(error)
    expect(store.historyError).toBe(error.message)
    expect(store.threadId).toBe('')
  })
})
