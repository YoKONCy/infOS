// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPinia, setActivePinia } from 'pinia'
const apiMocks = vi.hoisted(() => ({
  agentList: vi.fn(),
  // 后端权威活跃 Agent（fetchAgents 用它同步 activeAgentId）
  agentActive: vi.fn(),
  // 第七阶段修复（批次 C）：agentApi.setActive 已删除，改用 runtimeApi.setWindowAgent
  runtimeSetWindowAgent: vi.fn(),
  configGet: vi.fn(),
  configSet: vi.fn(),
  configBatch: vi.fn(),
  chatEditMessage: vi.fn(),
  chatDeleteMessage: vi.fn(),
  threadGet: vi.fn(),
  threadProjection: vi.fn(),
  loggerError: vi.fn(),
}))

// 第七阶段修复（批次 C）：useAgentStore.getWindowId 依赖 localStorage
// 测试环境（node）无 localStorage，需要提供最小 mock
const localStorageMock = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    clear: vi.fn(() => {
      store.clear()
    }),
  }
})
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
})

vi.mock('@infos/frontend/api/modules/agentApi', () => ({
  agentApi: {
    list: apiMocks.agentList,
    getActive: apiMocks.agentActive,
    // 第七阶段修复（批次 C）：setActive 已删除，不再 mock
  },
}))

// 第七阶段修复（批次 C）：新增 runtimeApi mock
vi.mock('@infos/frontend/api/modules/runtimeApi', () => ({
  runtimeApi: {
    setWindowAgent: apiMocks.runtimeSetWindowAgent,
  },
}))

vi.mock('@infos/frontend/api/modules/configApi', () => ({
  configApi: {
    get: apiMocks.configGet,
    set: apiMocks.configSet,
    batch: apiMocks.configBatch,
  },
}))

vi.mock('@infos/frontend/api/modules/chatApi', () => ({
  chatApi: {
    editMessage: apiMocks.chatEditMessage,
    deleteMessage: apiMocks.chatDeleteMessage,
  },
}))

// 屏蔽 threadsApi 以避免 transport.ts 在 node 测试环境引用 window
vi.mock('@infos/frontend/api/modules/threadsApi', () => ({
  threadsApi: {
    list: vi.fn(),
    get: apiMocks.threadGet,
    getProjection: apiMocks.threadProjection,
    create: vi.fn(),
    getLatest: vi.fn(),
  },
}))

vi.mock('@infos/frontend/lib/logger', () => ({
  logger: {
    error: apiMocks.loggerError,
  },
}))

import { useAgentStore } from '@infos/frontend/stores/useAgentStore'
import { useConfigStore } from '@infos/frontend/stores/useConfigStore'
import { useNotificationStore } from '@infos/frontend/stores/useNotificationStore'
import { useThreadStore } from '@infos/frontend/stores/useThreadStore'

describe('useNotificationStore', () => {
  beforeEach(() => {
    localStorageMock.clear()
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-27T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('应当添加 toast 并在延迟后自动移除', () => {
    const store = useNotificationStore()

    store.toast('保存成功', { type: 'success', title: '完成', duration: 100 })

    expect(store.toasts).toHaveLength(1)
    expect(store.toasts[0]).toMatchObject({
      type: 'success',
      severity: 'toast',
      title: '完成',
      message: '保存成功',
      duration: 100,
    })

    vi.advanceTimersByTime(100)

    expect(store.toasts).toHaveLength(0)
  })

  it('远程通知重连补发时应按 notificationId 去重', () => {
    const store = useNotificationStore()
    store.toastRemote('notification-1', '重要通知', { type: 'warning', duration: 0 })
    store.toastRemote('notification-1', '重要通知', { type: 'warning', duration: 0 })
    store.toastRemote('notification-2', '另一条通知', { duration: 0 })

    expect(store.toasts.map((toast) => toast.message)).toEqual(['重要通知', '另一条通知'])
  })

  it('刷新后仍保留远程通知回执，避免重复展示', () => {
    useNotificationStore().toastRemote('seen-before-refresh', '历史失败', { duration: 0 })
    setActivePinia(createPinia())
    const restored = useNotificationStore()
    restored.toastRemote('seen-before-refresh', '历史失败', { duration: 0 })
    expect(restored.toasts).toHaveLength(0)
  })

  it('排队通知实际展示后才开始倒计时和确认回执', () => {
    const store = useNotificationStore()
    for (let i = 0; i < 3; i++) store.toast(`占位 ${i}`, { duration: 0 })
    const presented = vi.fn()
    store.toastRemote('queued-remote', '新失败', { duration: 100, onPresented: presented })
    vi.advanceTimersByTime(1000)
    expect(store.toasts).toHaveLength(3)
    expect(presented).not.toHaveBeenCalled()
    expect(store.wasRemotePresented('queued-remote')).toBe(false)
    store.removeToast(store.toasts[0]!.id)
    expect(presented).toHaveBeenCalledOnce()
    expect(store.wasRemotePresented('queued-remote')).toBe(true)
    expect(store.toasts.some((item) => item.message === '新失败')).toBe(true)
    vi.advanceTimersByTime(100)
    expect(store.toasts.some((item) => item.message === '新失败')).toBe(false)
  })

  it('应当显示和关闭模态通知', () => {
    const store = useNotificationStore()

    store.showModal('数据库异常', '系统错误', 'error')
    expect(store.modal).toMatchObject({
      type: 'error',
      severity: 'modal',
      title: '系统错误',
      message: '数据库异常',
      duration: 0,
    })

    store.closeModal()

    expect(store.modal).toBeNull()
  })

  it('已知和未知错误码均恰好产生一条可见通知，不锁定默认展示渠道', () => {
    const store = useNotificationStore()
    for (const code of ['UNAUTHORIZED', 'VALIDATION_ERROR', 'UNKNOWN_CODE']) {
      store.closeModal()
      store.toasts = []
      const message = '测试通知 ' + code
      store.notifyByCode(code, message)
      const visible = [...store.toasts, ...(store.modal ? [store.modal] : [])]
      expect(visible.map((item) => item.message)).toEqual([message])
    }
  })
})

describe('useConfigStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('应当优先返回缓存配置并支持强制刷新', async () => {
    const store = useConfigStore()
    store.cache.theme = 'dark'
    apiMocks.configGet.mockResolvedValue({ data: 'light' })

    await expect(store.getConfig('theme')).resolves.toBe('dark')
    await expect(store.getConfig('theme', true)).resolves.toBe('light')

    expect(apiMocks.configGet).toHaveBeenCalledTimes(1)
    expect(store.cache.theme).toBe('light')
  })

  it('应当在设置配置成功时更新缓存，失败时返回 false', async () => {
    const store = useConfigStore()
    apiMocks.configSet
      .mockResolvedValueOnce({ code: 'OK' })
      .mockRejectedValueOnce(new Error('失败'))

    await expect(store.setConfig('volume', 80)).resolves.toBe(true)
    await expect(store.setConfig('volume', 20)).resolves.toBe(false)

    expect(apiMocks.configSet).toHaveBeenCalledWith('volume', 80)
    expect(store.cache.volume).toBe(80)
  })

  it('应当批量加载配置并在结束后关闭加载状态', async () => {
    const store = useConfigStore()
    apiMocks.configBatch.mockResolvedValue({ data: { theme: 'dark', language: 'zh-CN' } })

    await store.loadBatch(['theme', 'language'])

    expect(store.isLoading).toBe(false)
    expect(store.cache).toMatchObject({ theme: 'dark', language: 'zh-CN' })

    store.clearCache()
    expect(store.cache).toEqual({})
  })
})

describe('useAgentStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // fetchAgents 会调用 agentApi.getActive 同步活跃角色，默认 mock 为 assistant
    apiMocks.agentActive.mockResolvedValue({ data: { id: 'assistant', name: 'Assistant' } })
  })

  it('应当拉取 Agent 列表并同步活跃 Agent', async () => {
    const store = useAgentStore()
    apiMocks.agentList.mockResolvedValue({
      data: [
        { id: 'pero', name: 'Pero', isEnabled: true, isActive: false },
        { id: 'assistant', name: 'Assistant', isEnabled: false, isActive: true },
      ],
    })

    await store.fetchAgents()

    expect(store.isLoading).toBe(false)
    expect(store.activeAgentId).toBe('assistant')
    expect(store.currentAgent?.id).toBe('assistant')
    expect(store.enabledAgents.map((agent) => agent.id)).toEqual(['pero'])
  })

  it('应当在拉取失败时记录错误并关闭加载状态', async () => {
    const store = useAgentStore()
    apiMocks.agentList.mockRejectedValue(new Error('网络异常'))

    await store.fetchAgents()

    expect(store.isLoading).toBe(false)
    expect(store.error).toBe('网络异常')
  })

  it('切换窗口绑定时保留已加载的角色列表', async () => {
    const store = useAgentStore()
    const agents = [
      { id: 'pero', name: 'Pero', isEnabled: true, isActive: true },
      { id: 'assistant', name: 'Assistant', isEnabled: true, isActive: false },
    ]
    apiMocks.runtimeSetWindowAgent.mockResolvedValue({ code: 'OK' })
    apiMocks.agentList.mockResolvedValue({ data: agents })
    apiMocks.agentActive.mockResolvedValue({ data: agents[0] })
    await store.fetchAgents()
    apiMocks.agentList.mockClear()

    await store.switchAgent('assistant')

    expect(apiMocks.runtimeSetWindowAgent).toHaveBeenCalledWith(expect.any(String), 'assistant')
    expect(store.activeAgentId).toBe('assistant')
    expect(store.agents).toEqual(agents)
    expect(apiMocks.agentList).not.toHaveBeenCalled()
  })
})

describe('useThreadStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('应当添加消息并完成流式生成', () => {
    const store = useThreadStore()

    store.addMessage({
      id: '1',
      role: 'assistant',
      content: '你好',
      timestamp: 'now',
      isStreaming: true,
    })
    store.generationState = 'generating'
    store.streamingMessageId = '1'
    store.finishStreaming()

    expect(store.messages[0]).toMatchObject({ content: '你好', isStreaming: false })
    expect(store.generationState).toBe('idle')
    expect(store.streamingMessageId).toBeNull()
  })

  it('切屏重载Projection时应保留运行中的流式消息Shell', async () => {
    const store = useThreadStore()
    apiMocks.threadGet.mockResolvedValue({
      data: { thread: { id: 'thread-1', agentId: 'pero', channel: 'desktop' } },
    })
    apiMocks.threadProjection.mockResolvedValue({
      data: {
        scopeId: 'conversation:thread-1',
        threadId: 'thread-1',
        principalId: 'pero',
        messages: [],
        surfaces: [],
      },
    })
    store.startThread('thread-1', 'desktop')
    store.addMessage({
      id: 'streaming-1',
      role: 'assistant',
      content: '',
      timestamp: 'now',
      isStreaming: true,
    })
    store.streamingMessageId = 'streaming-1'
    store.generationState = 'generating'

    await store.loadThreadMessages('thread-1', 'pero')

    expect(store.messages).toEqual([
      expect.objectContaining({ id: 'streaming-1', isStreaming: true }),
    ])
    expect(store.streamingMessageId).toBe('streaming-1')
    expect(store.generationState).toBe('generating')
  })

  it('应当在 threadId 就绪后编辑和删除消息并同步后端', async () => {
    const store = useThreadStore()
    apiMocks.chatEditMessage.mockImplementation(
      async (threadId: string, id: string, content: string, revision: number) => ({
        code: 'OK',
        data: {
          protocolVersion: 1,
          threadId,
          principalId: 'pero',
          revision: 2,
          generatedAt: 'now',
          messages: [
            {
              messageId: id,
              threadId,
              role: id === '12' ? 'user' : 'assistant',
              content,
              revision: revision + 1,
              timestamp: 'now',
              status: 'completed',
              imageTranscription: false,
              contentBlocks: [],
              toolCalls: [],
              attachments: [],
            },
          ],
          surfaces: [],
        },
      }),
    )
    apiMocks.chatDeleteMessage.mockResolvedValue({ code: 'OK' })

    store.startThread('thread-1', 'desktop', 'pero')
    store.addMessage({ id: '12', role: 'user', content: '旧内容', timestamp: 'now', revision: 1 })
    store.addMessage({
      id: '13',
      role: 'assistant',
      content: '草稿',
      timestamp: 'now',
      revision: 1,
    })

    await store.editMessage('12', '新内容')
    expect(store.messages[0]).toMatchObject({ id: '12', content: '新内容', revision: 2 })
    store.deleteMessage('12')
    await store.editMessage('13', '新草稿')

    expect(apiMocks.chatEditMessage).toHaveBeenCalledWith('thread-1', '12', '新内容', 1)
    expect(apiMocks.chatEditMessage).toHaveBeenCalledWith('thread-1', '13', '新草稿', 1)
    expect(apiMocks.chatDeleteMessage).toHaveBeenCalledWith('thread-1', '12')
    expect(store.messages).toEqual([
      expect.objectContaining({ id: '13', role: 'assistant', content: '新草稿', revision: 2 }),
    ])
  })

  it('应当重置 Thread 并维护生成状态 getter', () => {
    const store = useThreadStore()

    store.generationState = 'thinking'
    expect(store.isGenerating).toBe(true)

    store.startThread('thread-1', 'desktop')

    expect(store.threadId).toBe('thread-1')
    expect(store.channel).toBe('desktop')
    expect(store.messages).toEqual([])
    expect(store.isGenerating).toBe(false)
  })
})
