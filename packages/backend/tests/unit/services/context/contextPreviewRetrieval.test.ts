import { describe, expect, it, vi } from 'vitest'
import { ContextCompiler } from '@infos/backend/services/context/contextCompiler'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'
import { isToolAllowedInInteractionMode } from '@infos/backend/tools/interactionMode'
import { buildConversationTimeAnchors } from '@infos/backend/services/context/conversationTime'
import type { ThreadMessageInfo } from '@infos/backend/services/thread/threadService'
import {
  invalidatePromptReplay,
  preparePromptReplay,
} from '@infos/backend/services/llm/promptCache'

function fixture(
  channel: 'desktop' | 'group',
  mode: 'chat' | 'work' = 'chat',
  disabledTools: string[] = [],
) {
  const workingPairs = vi.fn().mockResolvedValue([])
  const activePairs = vi.fn().mockResolvedValue([
    {
      id: 1,
      pairId: 'pair-test',
      role: 'user',
      content: '历史问题',
      revision: 1,
      metadataJson: '{}',
    },
  ])
  const timeAnchors = vi.fn().mockResolvedValue(new Map())
  const automaticRag = vi.fn().mockResolvedValue([])
  const registry = new ToolRegistry()
  const renderSlots = vi.fn((_slots: unknown, _vars: Record<string, unknown>) => [
    { role: 'system', content: '本地提示词' },
  ])
  const planGet = vi.fn().mockReturnValue({ id: 'plan', revision: 1, title: '当前计划', steps: [] })
  const compiler = new ContextCompiler(
    {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread-test',
        agentId: 'test',
        channel,
        interactionMode: mode,
        disabledTools,
        contextPolicy: JSON.stringify({
          enableStateInjection: false,
          enableToolDescriptions: false,
          enableContinuity: false,
        }),
      }),
      getActiveMessagePairs: activePairs,
      getWorkingMessagePairs: workingPairs,
      getConversationTimeAnchors: timeAnchors,
    } as never,
    { getAgent: vi.fn().mockReturnValue(undefined) } as never,
    { get: vi.fn().mockResolvedValue(null) } as never,
    { buildDefaultSlots: () => [], renderSlots } as never,
    {
      resolve: () => ({
        allowedTools: new Set(['update_plan']),
        promptFragments: [],
        skillMenuText: '',
      }),
      isToolAllowedInMode: (name: string, interactionMode: 'chat' | 'work') =>
        isToolAllowedInInteractionMode(name, interactionMode, registry),
    } as never,
    { get: vi.fn().mockResolvedValue({ currentGoal: '', privateFacts: '' }) } as never,
  )
  compiler.setEventMemoryService({ automaticRag } as never)
  compiler.setTaskPlanService({ get: planGet } as never)
  return { compiler, automaticRag, renderSlots, planGet, workingPairs, activePairs, timeAnchors }
}

describe('历史时间标记与当前输入隔离', () => {
  it('任务结果进入原生与模板历史，其他系统消息仍不进入模型', async () => {
    const { compiler, activePairs, renderSlots } = fixture('desktop')
    activePairs.mockResolvedValue([
      {
        id: 1,
        role: 'system',
        content: '任务产出',
        revision: 1,
        metadataJson: JSON.stringify({
          kind: 'background_task_result',
          taskId: 'task',
          deliveryId: 'delivery',
        }),
      },
      { id: 2, role: 'system', content: '不可注入的系统消息', revision: 1, metadataJson: '{}' },
      { id: 3, role: 'user', content: '结果是什么', revision: 1, metadataJson: '{}' },
    ])
    const result = await compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
    const event = result.messages.find((message) => message.cacheControl?.historyMessageId === 1)
    expect(event?.role).toBe('user')
    expect(event?.content).toContain('任务产出')
    expect(event?.content).toContain('不是用户的新指令')
    expect(JSON.stringify(result.messages)).not.toContain('不可注入的系统消息')
    expect(renderSlots.mock.calls[0]![1].conversation_history).toContain('<background_task_result>')
  })
  function message(id: number, role: 'user' | 'assistant', timestamp: string): ThreadMessageInfo {
    return {
      id,
      role,
      timestamp,
      threadId: 'thread-test',
      content: `正文-${id}`,
      pairId: `pair-${Math.ceil(id / 2)}`,
      agentId: role === 'assistant' ? 'test' : null,
      senderId: null,
      rawContent: null,
      revision: 1,
      metadataJson: '{}',
      status: 'active',
    }
  }
  const rows = [
    message(1, 'user', '2026-10-22 11:04:00'),
    message(2, 'assistant', '2026-10-22 11:05:00'),
    message(3, 'user', '2026-10-25 07:02:00'),
    message(4, 'assistant', '2026-10-25 07:03:00'),
    message(5, 'user', '2026-10-25 08:01:59'),
    message(6, 'assistant', '2026-10-25 08:02:00'),
    message(7, 'user', '2026-10-25 08:02:00'),
  ]
  const anchors = buildConversationTimeAnchors(rows.filter((row) => row.role === 'user'))

  it('只标历史用户消息，原生历史与模板历史一致，当前输入即使到点也不加标记', async () => {
    const { compiler, activePairs, timeAnchors, renderSlots } = fixture('desktop')
    activePairs.mockResolvedValue(rows)
    timeAnchors.mockResolvedValue(anchors)
    const before = JSON.stringify(rows)
    const compiled = await compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
    expect(timeAnchors).toHaveBeenCalledWith('thread-test', 6)
    const history = (id: number) =>
      compiled.messages.find((item) => item.cacheControl?.historyMessageId === id)
    expect(history(1)?.content).toBe('【对话记录时间：2026-10-22 11:04】\n正文-1')
    expect(history(3)?.content).toBe('【对话记录时间：2026-10-25 07:02】\n正文-3')
    expect(history(5)?.content).toBe('正文-5')
    expect(history(4)?.content).toBe('正文-4')
    expect(compiled.messages[compiled.currentMessageIndex!]?.content).toBe('正文-7')
    const vars = renderSlots.mock.calls[0]![1]
    expect(vars.conversation_history).toContain('【对话记录时间：2026-10-25 07:02】\n正文-3')
    expect(vars.current_message).toMatchObject({ role: 'user', content: '正文-7' })
    expect(JSON.stringify(rows)).toBe(before)
  })

  it('历史窗口移动后保留原标记及缓存身份，不把窗口首条消息重新当作起点', async () => {
    const { compiler, activePairs, timeAnchors } = fixture('desktop')
    timeAnchors.mockResolvedValue(anchors)
    activePairs.mockResolvedValue(rows)
    const first = await compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
    activePairs.mockResolvedValue(rows.slice(4))
    const next = await compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
    const oldUser = first.messages.find((item) => item.cacheControl?.historyMessageId === 5)
    const retained = next.messages.find((item) => item.cacheControl?.historyMessageId === 5)
    expect(retained?.content).toBe('正文-5')
    expect(retained?.cacheControl?.key).toBe(oldUser?.cacheControl?.key)
  })

  it('临时当前输入不加时间，禁用历史的预览不查询时间索引', async () => {
    const { compiler, activePairs, timeAnchors } = fixture('desktop')
    activePairs.mockResolvedValue(rows)
    timeAnchors.mockResolvedValue(anchors)
    const currentInput = { role: 'user' as const, content: '这次临时输入' }
    const compiled = await compiler.compile('thread-test', 'test', {
      currentInput,
      disableMemoryRetrieval: true,
    })
    expect(compiled.messages[compiled.currentMessageIndex!]?.content).toBe('这次临时输入')
    expect(
      compiled.messages.find((item) => item.cacheControl?.historyMessageId === 7)?.content,
    ).toBe('【对话记录时间：2026-10-25 08:02】\n正文-7')
    timeAnchors.mockClear()
    await compiler.compile('thread-test', 'test', {
      currentInput,
      appendThreadMessages: false,
      disableMemoryRetrieval: true,
    })
    expect(timeAnchors).not.toHaveBeenCalled()
  })

  it('新标记进入历史时退出旧热轨迹，之后未打标的连续对话仍能复用', async () => {
    const { compiler, activePairs, timeAnchors } = fixture('desktop')
    timeAnchors.mockResolvedValue(anchors)
    const scope = 'time-anchor-replay'
    try {
      activePairs.mockResolvedValue(rows.slice(0, 3))
      const first = await compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
      const start = preparePromptReplay(scope, first.messages, '测试模型')
      start.commit([...start.messages, { role: 'assistant', content: '正文-4' }], '正文-4')
      activePairs.mockResolvedValue(rows.slice(0, 5))
      const second = await compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
      const marked = preparePromptReplay(scope, second.messages, '测试模型')
      expect(marked.reused).toBe(false)
      expect(
        marked.messages.find((item) => item.cacheControl?.historyMessageId === 3)?.content,
      ).toBe('【对话记录时间：2026-10-25 07:02】\n正文-3')
      marked.commit([...marked.messages, { role: 'assistant', content: '正文-6' }], '正文-6')
      activePairs.mockResolvedValue(rows)
      const third = await compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
      const continued = preparePromptReplay(scope, third.messages, '测试模型')
      expect(continued.reused).toBe(true)
      expect(continued.messages.at(-1)?.content).toBe('正文-7')
    } finally {
      invalidatePromptReplay(scope)
    }
  })
})

describe('预算预览与远程记忆检索隔离', () => {
  it('资料召回开关与记忆 RAG 独立，预算预览和 Realm 不执行资料召回', async () => {
    const { compiler, automaticRag, renderSlots } = fixture('desktop')
    const recall = vi.fn().mockResolvedValue({
      knowledge: '<document>资料摘要</document>',
      facts: '<fact>有效事实</fact>',
      documentHits: 1,
      factHits: 1,
    })
    compiler.setKnowledgeRecallService({ recall } as never)
    await compiler.compile('thread-test', 'test', {
      disableMemoryRetrieval: true,
      retrievalQuery: '实际输入',
    })
    expect(recall).toHaveBeenCalledWith('实际输入', expect.any(Set), undefined)
    expect(automaticRag).not.toHaveBeenCalled()
    expect(renderSlots.mock.calls[0]![1]).toMatchObject({
      memory_context: '',
      knowledge_context: '<document>资料摘要</document>',
      facts_context: '<fact>有效事实</fact>',
    })
    recall.mockClear()
    await compiler.compile('thread-test', 'test', { disableReferenceRetrieval: true })
    await compiler.compile('thread-test', 'test', { realmExecution: true })
    expect(recall).not.toHaveBeenCalled()
  })
  it('请求策略随编译结果传递，不改变动态资料与用户输入的角色', async () => {
    const { compiler } = fixture('desktop')
    const requestPlan = {
      assistantPrefill: { content: '我', mode: 'continuous', source: 'system.assistantPrefill' },
    }
    compiler.setPromptWorkspace({
      snapshot: () => ({ id: 'compiled-prefill' }),
      prepare: vi.fn().mockResolvedValue({
        messages: [
          { role: 'system', content: '固定规则' },
          { role: 'user', content: '<turn_context>当前状态</turn_context>' },
        ],
        preview: { requestPlan, segments: [] },
      }),
    } as never)
    const compiled = await compiler.compile('thread-test', 'test', {
      currentInput: { role: 'user', content: '你好' },
    })
    expect(compiled.messages[0]?.promptPlan).toEqual(requestPlan)
    expect(
      compiled.messages.find((message) => String(message.content).includes('<turn_context>'))?.role,
    ).toBe('user')
    expect(
      compiled.messages.find((message) => message.promptSegment === 'assistant_prefill'),
    ).toBeUndefined()
  })

  it('仅桌面工作模式加载按预算分页的工作历史，聊天与 Realm 保持隔离', async () => {
    const work = fixture('desktop', 'work')
    await work.compiler.compile('thread-test', 'test', {
      disableMemoryRetrieval: true,
      maxInputTokens: 12_000,
    })
    expect(work.workingPairs).toHaveBeenCalledWith('thread-test', 12_000)
    const chat = fixture('desktop', 'chat')
    await chat.compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
    expect(chat.workingPairs).not.toHaveBeenCalled()
    const realm = fixture('desktop', 'work')
    await realm.compiler.compile('thread-test', 'test', { realmExecution: true })
    expect(realm.workingPairs).not.toHaveBeenCalled()
  })
  it.each([
    { mode: 'chat' as const, disabled: [], enabled: false },
    { mode: 'work' as const, disabled: ['update_plan'], enabled: false },
    { mode: 'work' as const, disabled: [], enabled: true },
  ])('计划提示词遵守模式与用户开关：$mode / $enabled', async ({ mode, disabled, enabled }) => {
    const { compiler, renderSlots, planGet } = fixture('desktop', mode, disabled)
    await compiler.compile('thread-test', 'test', { disableMemoryRetrieval: true })
    expect(renderSlots.mock.calls[0]?.[1].task_plan_enabled).toBe(enabled)
    if (enabled) {
      expect(planGet).toHaveBeenCalledOnce()
      expect(renderSlots.mock.calls[0]?.[1].task_plan).toMatchObject({ id: 'plan' })
    } else {
      expect(planGet).not.toHaveBeenCalled()
      expect(renderSlots.mock.calls[0]?.[1].task_plan).toBeNull()
    }
  })

  it.each(['desktop', 'group'] as const)(
    '%s 的草稿和空草稿预览都不检索，正常对话仍检索',
    async (channel) => {
      const { compiler, automaticRag } = fixture(channel)
      for (const retrievalQuery of ['待发送草稿', '']) {
        const preview = await compiler.compile('thread-test', 'test', {
          retrievalQuery,
          appendThreadMessages: false,
          disableContinuity: true,
          disableMemoryRetrieval: true,
        })
        expect(preview.messages).toEqual([{ role: 'system', content: '本地提示词' }])
        expect(preview.manifest.hasMemoryRetrieval).toBe(false)
      }
      expect(automaticRag).not.toHaveBeenCalled()

      const normal = await compiler.compile('thread-test', 'test', { retrievalQuery: '正常发送' })
      expect(automaticRag).toHaveBeenCalledTimes(1)
      expect(automaticRag).toHaveBeenCalledWith(
        'test',
        '正常发送',
        expect.any(Number),
        channel,
        undefined,
        undefined,
      )
      expect(normal.manifest.hasMemoryRetrieval).toBe(true)
      expect(normal.messages.at(-1)).toMatchObject({ role: 'user', content: '历史问题' })
    },
  )
})
