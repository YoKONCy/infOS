import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProactiveService } from '../../../src/services/companion/proactiveService'
import type { BackgroundTaskInfo } from '../../../src/services/task/backgroundTaskService'
import { readTaskLifecycle } from '../../../src/services/task/taskLifecycle'

function backgroundTask(overrides: Partial<BackgroundTaskInfo>): BackgroundTaskInfo {
  return {
    id: 'task',
    revision: 1,
    lifecycle: readTaskLifecycle(undefined, '等待任务完成'),
    agentId: 'pero',
    threadId: 'background-task',
    targetThreadId: null,
    parentTaskId: null,
    title: '测试任务',
    instruction: '等待任务完成',
    status: 'running',
    progress: null,
    currentStage: null,
    result: null,
    errorMessage: null,
    toolCallCount: 0,
    priority: 0,
    requestedBy: 'agent',
    completionAction: 'notify',
    category: 'agent_task',
    inputQuestion: null,
    inputContext: null,
    metadata: {},
    execution: null,
    checkpoint: null,
    createdAt: '2026-10-20T12:00:00Z',
    startedAt: '2026-10-20T12:00:00Z',
    completedAt: null,
    readAt: null,
    updatedAt: '2026-10-20T12:00:00Z',
    ...overrides,
  }
}

const services: ProactiveService[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown()
  vi.useRealTimers()
  vi.clearAllMocks()
})
type Target = {
  id: string
  agentId: string
  channel: string
  purpose: string
  status: string
  interactionMode: string
  generation?: number
}
function fixture(store = new Map<string, string>()) {
  const enabled = ['nana', 'pero']
  const tasks = new Map<string, BackgroundTaskInfo>()
  const threads = new Map<string, Target>(
    enabled.map((agentId) => [
      agentId,
      {
        id: `${agentId}-first`,
        agentId,
        channel: 'desktop',
        purpose: 'conversation',
        status: 'active',
        interactionMode: 'minimal',
        generation: 1,
      },
    ]),
  )
  const config = {
    getJson: async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : undefined),
    set: async (key: string, value: string) => {
      store.set(key, value)
    },
  }
  const deps = {
    listAgents: vi.fn(() => enabled),
    resolveThread: vi.fn(async (agentId: string) => {
      const thread = threads.get(agentId)
      if (!thread) throw new Error('本轮会话暂时无法取得')
      return thread
    }),
    isBusy: vi.fn((_agentId: string) => false),
    getThread: vi.fn(async (id: string) => [...threads.values()].find((thread) => thread.id === id) ?? null),
    groupMessages: vi.fn(async (_roomId: string, _afterId: number, _senderId?: string) => [] as Array<{ id: number; senderId: string }>),
    resumeGroupWait: vi.fn(async (_messageId: number, _agentId: string) => true),
    getTask: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    resumeTaskWait: vi.fn(async () => {}),
    currentRoom: vi.fn(async () => 'living'),
    activitySourceActive: vi.fn(async () => true),
    runStronghold: vi.fn(async (_agentId: string, _signal: AbortSignal) => '据点发言'),
    run: vi.fn(
      async (_input: {
        signal: AbortSignal
        content: string
        thread: {
          id: string
          agentId: string
          channel: string
          purpose?: string
          status?: string
          interactionMode?: string
        }
      }) => '主动回复',
    ),
    changed: vi.fn(async () => {}),
  }
  const service = new ProactiveService(config as never)
  services.push(service)
  return { service, deps, store, enabled, threads, tasks }
}

describe('角色主动行为与全局继承', () => {
  it('主动模式关闭时重启恢复条件等待，投递失败保留现场并沿真实来源重试', async () => {
    const original = fixture()
    await original.service.initialize(original.deps)
    original.deps.groupMessages.mockResolvedValue([{ id: 10, senderId: 'pero' }])
    await original.service.recordNextActivity({ kind: 'wait_message', senderId: 'user' }, {
      source: 'group', channel: 'group', agentId: 'pero', threadId: 'pero-first', sessionId: 'pero-first',
      generation: 1, pairId: 'question', sceneRoomId: 'living',
    })
    const restored = fixture(new Map(original.store))
    restored.deps.groupMessages.mockResolvedValue([{ id: 11, senderId: 'user' }])
    restored.deps.resumeGroupWait.mockRejectedValueOnce(new Error('暂时无法投递'))

    await restored.service.initialize(restored.deps)
    expect(restored.service.getState().settings.mode).toBe('off')
    expect(restored.service.hasPendingActivities()).toBe(true)
    await restored.service.recoverPendingActivities()
    expect(restored.deps.resumeGroupWait.mock.calls).toEqual([
      [11, 'pero', expect.objectContaining({ sourcePairId: 'question', afterMessageId: 10, generation: 1 })],
      [11, 'pero', expect.objectContaining({ sourcePairId: 'question', afterMessageId: 10, generation: 1 })],
    ])
    expect(restored.service.hasPendingActivities()).toBe(false)
    expect(JSON.parse(restored.store.get('proactive.state')!).agents.pero.waiting).toBeUndefined()
    await restored.service.recoverPendingActivities()
    expect(restored.deps.resumeGroupWait).toHaveBeenCalledTimes(2)
    expect(restored.deps.run).not.toHaveBeenCalled()
    expect(restored.deps.runStronghold).not.toHaveBeenCalled()
  })

  it.each(['generation', 'source', 'location', 'disabled'] as const)(
    '等待恢复时按 %s 变化淘汰旧现场', async (change) => {
      const f = fixture()
      await f.service.initialize(f.deps)
      await f.service.recordNextActivity({ kind: 'wait_message', senderId: 'user' }, {
        source: 'group', channel: 'group', agentId: 'pero', threadId: 'pero-first', sessionId: 'pero-first',
        generation: 1, pairId: 'old-source', sceneRoomId: 'living',
      })
      f.deps.groupMessages.mockResolvedValue([{ id: 11, senderId: 'user' }])
      if (change === 'generation') f.threads.get('pero')!.generation = 2
      if (change === 'source') f.deps.activitySourceActive.mockResolvedValue(false)
      if (change === 'location') f.deps.currentRoom.mockResolvedValue('study')
      if (change === 'disabled') f.enabled.splice(f.enabled.indexOf('pero'), 1)

      await f.service.recoverPendingActivities()

      expect(f.service.hasPendingActivities()).toBe(false)
      expect(f.deps.resumeGroupWait).not.toHaveBeenCalled()
      expect(JSON.parse(f.store.get('proactive.state')!).agents.pero.waiting).toBeUndefined()
    },
  )

  it.each([
    { scene: 'desktop', target: 'pero-first', status: 'completed', deliveries: 0 },
    { scene: 'desktop', target: 'pero-first', status: 'failed', deliveries: 0 },
    { scene: 'desktop', target: 'pero-first', status: 'cancelled', deliveries: 1 },
    { scene: 'desktop', target: 'side-thread', status: 'completed', deliveries: 1 },
    { scene: 'group', target: 'pero-first', status: 'completed', deliveries: 1 },
  ] as const)('$scene 等待 $status 任务时按目标 $target 复用正式回填', async ({ scene, target, status, deliveries }) => {
    const f = fixture()
    const task = backgroundTask({ completionAction: 'send_to_chat',
      targetThreadId: target, metadata: { targetThreadGeneration: 1 } })
    f.tasks.set(task.id, task)
    await f.service.initialize(f.deps)
    await f.service.recordNextActivity({ kind: 'wait_task', taskId: task.id }, {
      source: scene, channel: scene, agentId: 'pero', threadId: 'pero-first', sessionId: 'pero-first',
      generation: 1, pairId: 'waiting-task', ...(scene === 'group' ? { sceneRoomId: 'living' } : {}),
    })

    task.status = status
    await f.service.notifyTask(task)
    await f.service.notifyTask(task)

    expect(f.deps.resumeTaskWait).toHaveBeenCalledTimes(deliveries)
    expect(f.service.hasPendingActivities()).toBe(false)
    expect(JSON.parse(f.store.get('proactive.state')!).agents.pero.waiting).toBeUndefined()
  })

  it('关闭主动模式时任务接续暂时失败，维护恢复仍可完成投递', async () => {
    const f = fixture()
    const task = backgroundTask({})
    f.tasks.set(task.id, task)
    await f.service.initialize(f.deps)
    await f.service.recordNextActivity({ kind: 'wait_task', taskId: task.id }, {
      source: 'desktop', channel: 'desktop', agentId: 'pero', threadId: 'pero-first', sessionId: 'pero-first',
      generation: 1, pairId: 'waiting-task',
    })
    task.status = 'completed'
    f.deps.resumeTaskWait.mockRejectedValueOnce(new Error('队列暂时不可用'))
    await expect(f.service.notifyTask(task)).rejects.toThrow('队列暂时不可用')
    expect(f.service.hasPendingActivities()).toBe(true)

    await f.service.recoverPendingActivities()

    expect(f.service.hasPendingActivities()).toBe(false)
    expect(f.deps.resumeTaskWait).toHaveBeenCalledTimes(2)
    expect(f.deps.run).not.toHaveBeenCalled()
  })

  it('两项设置独立继承，移除角色覆盖后实时采用全局默认', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    expect(f.service.getAgentSettings('pero')).toEqual({ mode: 'off', strongholdActivity: false })
    await f.service.configureAgent('pero', { mode: 'autonomous', strongholdActivity: false })
    await f.service.configure({ mode: 'companion', strongholdActivity: true })
    expect(f.service.getAgentSettings('pero')).toEqual({ mode: 'autonomous', strongholdActivity: false })
    expect(f.service.getAgentSettings('nana')).toEqual({ mode: 'companion', strongholdActivity: true })
    await f.service.configureAgent('pero', { mode: null })
    expect(f.service.getAgentSettings('pero')).toEqual({ mode: 'companion', strongholdActivity: false })
    await f.service.configureAgent('pero', { strongholdActivity: null })
    expect(f.service.getAgentSettings('pero')).toEqual({ mode: 'companion', strongholdActivity: true })
    expect(f.service.getState().settings.agents?.pero).toBeUndefined()
  })

  it('并发保存不同角色时保留双方覆盖', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    await Promise.all([
      f.service.configureAgent('pero', { mode: 'autonomous' }),
      f.service.configureAgent('nana', { strongholdActivity: true }),
    ])
    expect(f.service.getState().settings.agents).toEqual({ pero: { mode: 'autonomous' }, nana: { strongholdActivity: true } })
  })

  it('全局关闭时仍按角色选择的陪伴间隔安排唤醒', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    await f.service.configure({ companionIntervalMinutes: 1 })
    await f.service.configureAgent('pero', { mode: 'companion' })
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.deps.run.mock.calls.map(([input]) => input.thread.agentId)).toEqual(['pero'])
    expect(f.service.getState().settings.mode).toBe('off')
  })

  it('静默后延长空闲等待，减少没有新情况时的推理', async () => {
    const f = fixture()
    f.enabled.splice(1)
    f.deps.run.mockResolvedValue('')
    await f.service.initialize(f.deps)
    await f.service.configure({ mode: 'autonomous', autonomousIntervalMinutes: 1 })
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.deps.run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deps.run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deps.run).toHaveBeenCalledTimes(2)
  })

  it('据点自由活动独立启用，使用事件与空闲调度，不占私聊主动回合计数', async () => {
    const f = fixture()
    f.enabled.splice(0, 1)
    await f.service.initialize(f.deps)
    await f.service.configure({ strongholdActivity: true, autonomousIntervalMinutes: 1, maxDailyRuns: 1 })
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 100)
    expect(f.deps.runStronghold.mock.calls.map(([id]) => id)).toEqual(['pero', 'pero'])
    expect(f.deps.run).not.toHaveBeenCalled()
    expect(f.service.getState().dailyRuns).toBe(0)
  })

  it('条件等待阻止空闲唤醒，只在对应房间的新回答到达后派发一次', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    await f.service.configure({ mode: 'autonomous', autonomousIntervalMinutes: 1 })
    await f.service.configureAgent('nana', { strongholdActivity: true })
    f.deps.groupMessages.mockResolvedValue([{ id: 10, senderId: 'pero' }])
    const context = {
      source: 'group', channel: 'group', agentId: 'pero', threadId: 'pero-first', sessionId: 'pero-first',
      generation: 1, pairId: 'question-1', sceneRoomId: 'living',
    }
    await expect(f.service.recordNextActivity({ kind: 'wait_message', senderId: 'nana' }, context, false)).rejects.toThrow('ACTIVITY_MESSAGE_REQUIRED')
    expect(f.service.getState().activities?.pero).toBeUndefined()
    await f.service.recordNextActivity({ kind: 'wait_message', senderId: 'nana' }, context)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(f.deps.run.mock.calls.map(([input]) => input.thread.agentId)).toEqual(['nana'])
    expect(f.deps.runStronghold.mock.calls.map(([id]) => id)).toEqual(['nana', 'nana'])
    await f.service.notifyGroupMessage('bedroom', 11, 'nana')
    expect(f.service.getState().activities?.pero).toBe('wait_message')
    await f.service.notifyGroupMessage('living', 11, 'nana')
    expect(f.deps.resumeGroupWait).toHaveBeenCalledWith(11, 'pero', expect.objectContaining({ threadId: 'pero-first', generation: 1 }))
    expect(f.service.getState().activities?.pero).toBe('rest')
    await f.service.notifyGroupMessage('living', 11, 'nana')
    expect(f.deps.resumeGroupWait).toHaveBeenCalledTimes(1)
  })
  it('默认关闭；无需选择角色或会话，开启后轮转所有已启用角色', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(f.deps.run).not.toHaveBeenCalled()
    await f.service.configure({ mode: 'autonomous', autonomousIntervalMinutes: 1 })
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 100)
    expect(f.deps.run.mock.calls.map(([input]) => input.thread.agentId)).toEqual(['nana', 'pero'])
    expect(f.deps.run.mock.calls[0]![0].content).toContain('通过现有工具取得资料与回执')
    expect(f.service.getState().settings.mode).toBe('autonomous')
    expect(f.service.getState().agentId).toBeNull()
  })

  it('旧版会话与信息源设置在恢复时清除，不依赖旧会话是否存在', async () => {
    const store = new Map([
      [
        'proactive.settings',
        JSON.stringify({
          mode: 'autonomous',
          autonomousIntervalMinutes: 1,
          threadId: 'deleted',
          watchUrls: ['https://unused.test/'],
        }),
      ],
      [
        'proactive.state',
        JSON.stringify({
          watches: [{ url: 'https://unused.test/', hash: 'old' }],
          agentId: 'deleted-role',
        }),
      ],
    ])
    const f = fixture(store)
    await f.service.initialize(f.deps)
    expect(f.service.getState().settings.mode).toBe('autonomous')
    expect(store.get('proactive.settings')).not.toContain('threadId')
    expect(store.get('proactive.settings')).not.toContain('watchUrls')
    expect(store.get('proactive.state')).not.toContain('watches')
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.deps.run).toHaveBeenCalledOnce()
    await f.service.shutdown()
    const restarted = fixture(store)
    await restarted.service.initialize(restarted.deps)
    await vi.advanceTimersByTimeAsync(60_100)
    expect(restarted.deps.run).toHaveBeenCalledOnce()
    expect(restarted.deps.run.mock.calls[0]![0].thread.agentId).toBe('pero')
  })

  it('每次自动取得执行会话，不固定到旧 Thread，也不改变会话工具模式', async () => {
    const f = fixture()
    f.enabled.splice(1)
    await f.service.initialize(f.deps)
    await f.service.configure({ mode: 'autonomous', autonomousIntervalMinutes: 1 })
    await vi.advanceTimersByTimeAsync(60_100)
    f.threads.set('nana', { ...f.threads.get('nana')!, id: 'nana-new', interactionMode: 'work' })
    await vi.advanceTimersByTimeAsync(60_100)
    expect(
      f.deps.run.mock.calls.map(([input]) => [input.thread.id, input.thread.interactionMode]),
    ).toEqual([
      ['nana-first', 'minimal'],
      ['nana-new', 'work'],
    ])
    f.threads.delete('nana')
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.service.getState().settings.mode).toBe('autonomous')
    f.threads.set('nana', {
      id: 'nana-recreated',
      agentId: 'nana',
      channel: 'desktop',
      purpose: 'conversation',
      status: 'active',
      interactionMode: 'chat',
    })
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.deps.run.mock.lastCall?.[0].thread.id).toBe('nana-recreated')
  })

  it('策略切换取消旧回合，角色 API 只覆盖指定角色', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    f.deps.run.mockImplementationOnce(
      ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    await f.service.configure({ companionIntervalMinutes: 1, autonomousIntervalMinutes: 1 })
    await f.service.start('nana')
    expect(f.service.listStates(['nana', 'pero'])).toEqual([
      { agentId: 'nana', enabled: true },
      { agentId: 'pero', enabled: false },
    ])
    await vi.advanceTimersByTimeAsync(60_100)
    await f.service.configureAgent('nana', { mode: 'autonomous' })
    expect(f.deps.run.mock.calls[0]![0].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.deps.run).toHaveBeenCalledTimes(2)
    await f.service.configure({ mode: 'autonomous' })
    await f.service.stop('pero')
    expect(f.service.getAgentSettings('pero').mode).toBe('off')
    expect(f.service.getState().settings.mode).toBe('autonomous')
    await f.service.configure({ mode: 'off' })
    await f.service.configureAgent('nana', { mode: null })
    expect(f.service.getState().settings.mode).toBe('off')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.deps.run).toHaveBeenCalledTimes(2)
  })

  it('忙碌角色不抢占，启用角色集合变化无需重新保存全局模式', async () => {
    const f = fixture()
    f.deps.isBusy.mockImplementation((id) => id === 'nana')
    await f.service.initialize(f.deps)
    await f.service.configure({ mode: 'autonomous', autonomousIntervalMinutes: 1 })
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.deps.run.mock.lastCall?.[0].thread.agentId).toBe('pero')
    f.enabled.splice(0)
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.service.getState().settings.mode).toBe('autonomous')
    expect(f.deps.run).toHaveBeenCalledOnce()
    f.enabled.push('nana')
    f.deps.isBusy.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(60_100)
    expect(f.deps.run.mock.lastCall?.[0].thread.agentId).toBe('nana')
  })

  it('用户在同一角色的另一会话发言，也会等主动回合退出再继续', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    f.deps.run.mockImplementationOnce(
      ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    await f.service.configure({ mode: 'autonomous', autonomousIntervalMinutes: 1 })
    await vi.advanceTimersByTimeAsync(60_100)
    await f.service.notifyActivity('nana', 'another-thread')
    expect(f.deps.run.mock.calls[0]![0].signal.aborted).toBe(true)
    expect(f.service.getState().phase).toBe('waiting')
  })

  it('解析执行会话期间也可取消，不会留下随后启动的幽灵回合', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    await f.service.configure({ mode: 'companion', companionIntervalMinutes: 1 })
    let resolve!: (thread: Target) => void
    f.deps.resolveThread.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    await vi.advanceTimersByTimeAsync(60_100)
    let finished = false
    const activity = f.service.notifyActivity('nana', 'another').then(() => {
      finished = true
    })
    expect(finished).toBe(false)
    resolve(f.threads.get('nana')!)
    await activity
    expect(f.deps.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.deps.run).not.toHaveBeenCalled()
  })

  it('全局预算跨角色合计，立即唤醒不能绕过，第二天自动恢复', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    await f.service.configure({
      mode: 'autonomous',
      autonomousIntervalMinutes: 1,
      maxDailyRuns: 2,
      timeZone: 'UTC',
    })
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 100)
    await f.service.checkNow()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.deps.run).toHaveBeenCalledTimes(2)
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    await f.service.checkNow()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.deps.run).toHaveBeenCalledTimes(3)
    expect(f.service.getState().dailyRuns).toBe(1)
  })

  it('单个角色失败不关闭全局模式，其他角色仍轮转；陪伴超过五次仍渐进冷却', async () => {
    const f = fixture()
    await f.service.initialize(f.deps)
    f.deps.run.mockRejectedValueOnce(new Error('上游连接失败'))
    await f.service.configure({ mode: 'autonomous', autonomousIntervalMinutes: 1 })
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 100)
    expect(f.deps.run.mock.lastCall?.[0].thread.agentId).toBe('pero')
    expect(f.service.getState().recent[0]?.error).toBe('上游连接失败')
    const companion = fixture()
    companion.enabled.splice(1)
    await companion.service.initialize(companion.deps)
    await companion.service.configure({
      mode: 'companion',
      companionIntervalMinutes: 1,
      timeZone: 'UTC',
    })
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(companion.deps.run.mock.calls.length).toBeGreaterThan(5)
  })
})
