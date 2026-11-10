import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from '@infos/backend/services/agent/agentService'
import type { AgentServiceDeps } from '@infos/backend/services/agent/agentService'
import type { ChatDelta, ChatMessage } from '@infos/backend/services/llm/types'

const modelConfig = { provider: 'openai', modelId: 'test-model', apiKey: 'test-key' }

async function* streamFrom(chunks: ChatDelta[]) {
  for (const chunk of chunks) yield chunk
}

function createDeps(overrides: Partial<AgentServiceDeps> = {}): AgentServiceDeps {
  const deps: AgentServiceDeps = {
    llmService: {
      chatStream: vi
        .fn()
        .mockReturnValue(streamFrom([{ choices: [{ delta: { content: '回复' } }] }])),
    } as never,
    configRepo: {
      get: vi.fn().mockResolvedValue('default'),
    } as never,
    agentManager: {} as never,
    imageUnderstandingService: {
      getConfig: vi.fn().mockResolvedValue({ available: true }),
      transcribe: vi.fn().mockResolvedValue(null),
    } as never,
    isDesktopOperationAvailable: vi.fn().mockReturnValue(true),
    toolExecutor: undefined,
    getToolDefinitions: vi
      .fn()
      .mockReturnValue([{ name: 'finish_task', description: '结束', parameters: {} }]),
    cancelChecker: undefined,
    getModelConfig: vi.fn().mockResolvedValue(modelConfig),
  }
  return { ...deps, ...overrides }
}

describe('AgentService', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('据点执行共用角色身份时，每次请求只使用当前场景输入', async () => {
    const requests: ChatMessage[][] = []
    const deps = createDeps({ llmService: {
      chatStream: vi.fn((_config, messages) => {
        requests.push(structuredClone(messages))
        return streamFrom([{ choices: [{ delta: { content: '场景回复' } }] }])
      }),
    } as never })
    const service = new AgentService(deps)
    for (const room of ['客厅', '书房']) await service.chatWithCompiledMessages({
      agentId: 'pero', threadId: 'shared-main-scene', channel: 'group', interactionMode: 'work',
      messages: [
        { role: 'system', content: '据点规则' },
        { role: 'user', content: `${room}当前输入`, cacheControl: { kind: 'current', currentKeys: [room] } },
      ],
    })
    expect(requests[0]?.filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['客厅当前输入'])
    expect(requests[1]?.filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['书房当前输入'])
    expect(requests[1]?.filter((message) => message.role === 'assistant')).toEqual([])
  })

  it('运行时补充视觉状态前保留编译计划，空系统框架的动态深度仍生效', async () => {
    const deps = createDeps({
      imageUnderstandingService: { getConfig: async () => ({ available: false }) } as never,
    })
    const service = new AgentService(deps)
    await service.chatWithCompiledMessages({
      agentId: 'pero', threadId: 'dynamic-without-system', interactionMode: 'work',
      messages: [
        {
          role: 'user', content: '上轮输入', promptPlan: { dynamicContextDepth: 1 },
          cacheControl: { kind: 'history', key: 'old-input' },
        },
        { role: 'assistant', content: '上轮回复', cacheControl: { kind: 'history', key: 'old-reply' } },
        {
          role: 'user', content: '本轮最新状态',
          cacheControl: { kind: 'snapshot', key: 'prompt-slot:turn_context', dynamicContextBefore: 'old-input' },
        },
        { role: 'user', content: '本轮输入', cacheControl: { kind: 'current', currentKeys: ['new-input'] } },
      ],
    })
    const sent = vi.mocked(deps.llmService.chatStream).mock.calls[0]![1]
    expect(sent[0]?.role).toBe('system')
    expect(sent[1]?.content).toContain('本轮最新状态')
    expect(sent[2]?.content).toBe('上轮输入')
    expect(sent[3]?.content).toBe('上轮回复')
    expect(sent.find((message) => message.cacheControl?.kind === 'current')?.content).toBe('本轮输入')
  })

  it('工作历史展开后仍续接原请求，不因落盘媒体占位破坏热前缀', async () => {
    const observed: ChatMessage[][] = []
    const chatStream = vi.fn((_config, messages) => {
      observed.push(structuredClone(messages))
      return streamFrom([{ choices: [{ delta: { content: '回复' } }] }])
    })
    const service = new AgentService(createDeps({ llmService: { chatStream } as never }))
    const system = { role: 'system' as const, content: '固定系统规则' }
    await service.chatWithCompiledMessages({
      agentId: 'pero',
      threadId: 'expanded-replay-integration',
      interactionMode: 'work',
      messages: [
        system,
        {
          role: 'user',
          content: '首轮真实输入',
          cacheControl: { kind: 'current', currentKeys: ['user-1'] },
        },
      ],
    })
    await service.chatWithCompiledMessages({
      agentId: 'pero',
      threadId: 'expanded-replay-integration',
      interactionMode: 'work',
      messages: [
        system,
        {
          role: 'user',
          content: '落盘恢复占位',
          cacheControl: {
            kind: 'history',
            key: 'user-1:work:input',
            historySourceKey: 'user-1',
          },
        },
        {
          role: 'assistant',
          content: '回复',
          cacheControl: {
            kind: 'history',
            key: 'reply-1:work:0',
            historySourceKey: 'reply-1',
          },
        },
        {
          role: 'user',
          content: '继续',
          cacheControl: { kind: 'current', currentKeys: ['user-2'] },
        },
      ],
    })
    expect(observed[1]?.slice(0, observed[0]!.length)).toEqual(observed[0])
    expect(JSON.stringify(observed[1])).not.toContain('落盘恢复占位')
    expect(observed[1]?.some((message) => message.content === '继续')).toBe(true)
  })

  it('应当完成非流式 ReAct 编排并返回回复', async () => {
    const deps = createDeps()
    const service = new AgentService(deps)

    const reply = await service.chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 's1',
      messages: [
        { role: 'system', content: '系统' },
        { role: 'user', content: '你好' },
      ],
    })

    expect(reply).toBe('回复')
    // 正式入口直接把 ContextCompiler 已编译的 messages 转交 ReAct Loop
    expect(deps.llmService.chatStream).toHaveBeenCalledWith(
      modelConfig,
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: '系统' }),
        expect.objectContaining({ role: 'user', content: '你好' }),
      ]),
      expect.objectContaining({ tools: [{ type: 'function', function: { name: 'finish_task', description: '结束', parameters: {} } }] }),
    )
  })

  it('应优先使用当前角色指派的模型', async () => {
    const nanaModel = { ...modelConfig, modelId: 'nana-model' }
    const getAgentModelConfig = vi.fn().mockResolvedValue(nanaModel)
    const deps = createDeps({ getAgentModelConfig })

    await new AgentService(deps).chatWithCompiledMessages({
      agentId: 'nana',
      threadId: 'nana-thread',
      messages: [{ role: 'user', content: '你好' }],
    })

    expect(getAgentModelConfig).toHaveBeenCalledWith('nana')
    expect(deps.llmService.chatStream).toHaveBeenCalledWith(
      nanaModel,
      expect.any(Array),
      expect.any(Object),
    )
  })

  it('Realm显式模型应覆盖角色指派', async () => {
    const realmModel = { ...modelConfig, modelId: 'realm-model' }
    const getAgentModelConfig = vi.fn().mockResolvedValue({ ...modelConfig, modelId: 'nana-model' })
    const getModelConfigById = vi.fn().mockResolvedValue(realmModel)
    const deps = createDeps({ getAgentModelConfig, getModelConfigById })

    await new AgentService(deps).chatWithCompiledMessages({
      agentId: 'nana',
      threadId: 'realm-thread',
      modelConfigId: 7,
      messages: [{ role: 'user', content: '你好' }],
    })

    expect(getModelConfigById).toHaveBeenCalledWith(7)
    expect(getAgentModelConfig).not.toHaveBeenCalled()
    expect(deps.llmService.chatStream).toHaveBeenCalledWith(
      realmModel,
      expect.any(Array),
      expect.any(Object),
    )
  })

  it('工具定义解析收到当前会话明确选用的 Skills', async () => {
    const getToolDefinitions = vi.fn(() => [])
    const service = new AgentService(createDeps({
      getToolDefinitions,
      threadService: { getThread: vi.fn(async () => ({ interactionMode: 'work', enabledSkills: ['writing'] })) } as never,
    }))

    for await (const event of service.chatStreamWithCompiledMessages({
      agentId: 'pero',
      threadId: 'thread-1',
      executionId: 'execution-1' as never,
      messages: [{ role: 'user', content: '你好' }],
    })) {
      expect(event).toBeDefined()
    }

    expect(getToolDefinitions).toHaveBeenCalledWith(
      'pero', 'desktop', expect.any(Array), undefined, undefined, 'execution-1', 'work', ['writing'],
    )
  })

  it('主模型和转述模型都无视觉时应禁用全部截图与自动化工具', async () => {
    const mainVision = false
    const relay = false
    const client = true
    const getToolDefinitions = vi
      .fn()
      .mockImplementation((_agentId, _channel, disabledTools: string[]) =>
        [
          { name: 'take_screenshot', description: '桌面截图', parameters: {} },
          { name: 'browser_screenshot', description: '浏览器截图', parameters: {} },
          { name: 'browser_page_image', description: '网页图片截图', parameters: {} },
          { name: 'automation_execute', description: '桌面自动化', parameters: {} },
          { name: 'get_mouse_position', description: '鼠标位置', parameters: {} },
          { name: 'finish_task', description: '结束', parameters: {} },
        ].filter((tool) => !disabledTools.includes(tool.name)),
      )
    const deps = createDeps({
      getModelConfig: vi.fn().mockResolvedValue({ ...modelConfig, enableVision: mainVision }),
      imageUnderstandingService: {
        getConfig: vi.fn().mockResolvedValue({ available: relay }),
      } as never,
      isDesktopOperationAvailable: vi.fn().mockReturnValue(client),
      getToolDefinitions,
    })

    await new AgentService(deps).chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 'vision-gate',
      messages: [{ role: 'user', content: '看看屏幕' }],
    })

    expect(getToolDefinitions).toHaveBeenCalledWith(
      'pero',
      'desktop',
      expect.arrayContaining([
        'take_screenshot',
        'browser_screenshot',
        'browser_page_image',
        'automation_execute',
        'get_mouse_position',
      ]),
      undefined,
      undefined,
      'vision-gate',
      'work',
      [],
    )
    expect(deps.llmService.chatStream).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      expect.objectContaining({ tools: [{ type: 'function', function: { name: 'finish_task', description: '结束', parameters: {} } }] }),
    )
  })

  it('客户端无桌面截图能力但有视觉转述时只禁用桌面截图', async () => {
    const getToolDefinitions = vi.fn().mockReturnValue([])
    const deps = createDeps({
      getModelConfig: vi.fn().mockResolvedValue({ ...modelConfig, enableVision: false }),
      imageUnderstandingService: {
        getConfig: vi.fn().mockResolvedValue({ available: true }),
      } as never,
      isDesktopOperationAvailable: vi
        .fn()
        .mockImplementation((operation) => operation !== 'screenCapture'),
      getToolDefinitions,
    })

    await new AgentService(deps).chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 'browser-vision-gate',
      messages: [{ role: 'user', content: '看看网页' }],
    })

    const disabled = getToolDefinitions.mock.calls[0]![2] as string[]
    expect(disabled).toContain('take_screenshot')
    expect(disabled).toContain('automation_execute')
    expect(disabled).toContain('get_mouse_position')
    expect(disabled).not.toContain('browser_screenshot')
    expect(disabled).not.toContain('browser_page_image')
  })

  it('桌面鼠标或键盘能力离线时应禁用自动化工具', async () => {
    const getToolDefinitions = vi.fn().mockReturnValue([])
    const deps = createDeps({
      getModelConfig: vi.fn().mockResolvedValue({ ...modelConfig, enableVision: true }),
      imageUnderstandingService: undefined,
      isDesktopOperationAvailable: vi
        .fn()
        .mockImplementation((operation) => operation !== 'keyboardAction'),
      getToolDefinitions,
    })

    await new AgentService(deps).chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 'automation-offline',
      messages: [{ role: 'user', content: '操作桌面' }],
    })

    const disabled = getToolDefinitions.mock.calls[0]![2] as string[]
    expect(disabled).toContain('automation_execute')
    expect(disabled).not.toContain('take_screenshot')
    expect(disabled).not.toContain('get_mouse_position')
  })

  it('鼠标位置能力离线时应禁用鼠标位置工具且刷新定义不能绕过', async () => {
    const getToolDefinitions = vi.fn().mockReturnValue([])
    const deps = createDeps({
      getModelConfig: vi.fn().mockResolvedValue({ ...modelConfig, enableVision: true }),
      imageUnderstandingService: undefined,
      isDesktopOperationAvailable: vi
        .fn()
        .mockImplementation((operation) => operation !== 'mousePosition'),
      getToolDefinitions,
    })

    await new AgentService(deps).chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 'mouse-position-offline',
      messages: [{ role: 'user', content: '鼠标在哪' }],
    })

    expect(getToolDefinitions).toHaveBeenCalled()
    for (const call of getToolDefinitions.mock.calls) {
      expect(call[2]).toContain('get_mouse_position')
    }
  })

  it('应用启动能力离线时应禁用open_application', async () => {
    const getToolDefinitions = vi.fn().mockReturnValue([])
    const deps = createDeps({
      getModelConfig: vi.fn().mockResolvedValue({ ...modelConfig, enableVision: true }),
      isDesktopOperationAvailable: vi
        .fn()
        .mockImplementation((operation) => operation !== 'applicationLaunch'),
      getToolDefinitions,
    })

    await new AgentService(deps).chatWithCompiledMessages({
      agentId: 'pero',
      threadId: 'application-launch-offline',
      messages: [{ role: 'user', content: '打开Edge' }],
    })

    const disabled = getToolDefinitions.mock.calls[0]![2] as string[]
    expect(disabled).toContain('open_application')
  })

  it('主模型支持视觉且客户端可截图时应保留截图工具', async () => {
    const getToolDefinitions = vi
      .fn()
      .mockReturnValue([{ name: 'take_screenshot', description: '桌面截图', parameters: {} }])
    const deps = createDeps({
      getModelConfig: vi.fn().mockResolvedValue({ ...modelConfig, enableVision: true }),
      imageUnderstandingService: undefined,
      isDesktopOperationAvailable: vi.fn().mockReturnValue(true),
      getToolDefinitions,
    })

    await new AgentService(deps).chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 'native-vision',
      messages: [{ role: 'user', content: '看看屏幕' }],
    })

    expect(getToolDefinitions).toHaveBeenCalledWith(
      'pero',
      'desktop',
      [],
      undefined,
      undefined,
      'native-vision',
      'work',
      [],
    )
    expect(deps.llmService.chatStream).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            function: expect.objectContaining({ name: 'take_screenshot' }),
          }),
        ],
      }),
    )
  })

  it('应当按当前 Agent 和通道解析工具定义', async () => {
    const deps = createDeps()
    const service = new AgentService(deps)

    await service.chatWithCompiledMessages({
      agentId: 'nana',
      threadId: 'stronghold_room_nana',
      channel: 'group',
      messages: [{ role: 'user', content: '你好' }],
    })

    expect(deps.getToolDefinitions).toHaveBeenCalledWith(
      'nana',
      'group',
      ['automation_execute', 'get_mouse_position'],
      undefined,
      undefined,
      'stronghold_room_nana',
      'work',
      [],
    )
  })

  it('Realm任务可使用Arca指定模型且不改变Desktop主模型', async () => {
    const arcaModel = { provider: 'anthropic', modelId: 'arca-writer', apiKey: 'realm-key' }
    const getModelConfig = vi.fn().mockResolvedValue(modelConfig)
    const getModelConfigById = vi.fn().mockResolvedValue(arcaModel)
    const deps = createDeps({ getModelConfig, getModelConfigById })
    const service = new AgentService(deps)

    await service.chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 'arca-task',
      realmId: 'infos.arca',
      modelConfigId: 7,
      messages: [{ role: 'user', content: '编辑星页' }],
    })
    expect(deps.llmService.chatStream).toHaveBeenLastCalledWith(
      arcaModel,
      expect.any(Array),
      expect.any(Object),
    )
    expect(getModelConfigById).toHaveBeenCalledWith(7)
    expect(getModelConfig).not.toHaveBeenCalled()

    await service.chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 'desktop-thread',
      messages: [{ role: 'user', content: '普通对话' }],
    })
    expect(deps.llmService.chatStream).toHaveBeenLastCalledWith(
      modelConfig,
      expect.any(Array),
      expect.any(Object),
    )
  })

  it('流式与非流式必须使用完全一致的运行参数', async () => {
    const makeDeps = () => {
      const toolExecutor = {
        execute: vi.fn().mockResolvedValue({
          output: '心流已更新',
          durationMs: 1,
          isError: false,
          shouldTerminate: false,
        }),
      }
      let requestCount = 0
      return createDeps({
        llmService: {
          chatStream: vi.fn().mockImplementation(() => {
            requestCount++
            return requestCount === 1
              ? streamFrom([
                  {
                    choices: [
                      {
                        delta: {
                          toolCalls: [
                            {
                              index: 0,
                              id: 'flow-call',
                              type: 'function',
                              function: {
                                name: 'update_flow_state',
                                arguments: '{"current_goal":"测试"}',
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ])
              : streamFrom([{ choices: [{ delta: { content: '完成' } }] }])
          }),
        } as never,
        toolExecutor,
        getToolDefinitions: vi
          .fn()
          .mockReturnValue([
            { name: 'update_flow_state', description: '更新心流', parameters: {} },
          ]),
      })
    }
    const params = {
      agentId: 'nana',
      threadId: 'thread-1',
      channel: 'desktop',
      taskId: 'task-1',
      pairId: 'pair-1',
      disabledTools: ['write_file'],
      messages: [{ role: 'user' as const, content: '开始' }],
    }
    const nonStreamDeps = makeDeps()
    const streamDeps = makeDeps()

    await new AgentService(nonStreamDeps).chatWithCompiledMessages(params)
    for await (const event of new AgentService(streamDeps).chatStreamWithCompiledMessages(params)) {
      expect(event).toBeDefined()
    }

    expect(nonStreamDeps.getToolDefinitions).toHaveBeenCalledWith(
      'nana',
      'desktop',
      ['write_file', 'automation_execute', 'get_mouse_position'],
      undefined,
      undefined,
      'thread-1',
      'work',
      [],
    )
    expect(streamDeps.getToolDefinitions).toHaveBeenCalledWith(
      'nana',
      'desktop',
      ['write_file', 'automation_execute', 'get_mouse_position'],
      undefined,
      undefined,
      'thread-1',
      'work',
      [],
    )
    expect(nonStreamDeps.llmService.chatStream).toHaveBeenCalledWith(
      modelConfig,
      expect.any(Array),
      expect.objectContaining({ tools: expect.any(Array) }),
    )
    expect(streamDeps.llmService.chatStream).toHaveBeenCalledWith(
      modelConfig,
      expect.any(Array),
      expect.objectContaining({ tools: expect.any(Array) }),
    )
    const nonStreamCall = vi.mocked(nonStreamDeps.llmService.chatStream).mock.calls[0]
    const streamCall = vi.mocked(streamDeps.llmService.chatStream).mock.calls[0]
    expect(streamCall).toEqual(nonStreamCall)

    const nonStreamExecution = vi.mocked(nonStreamDeps.toolExecutor!.execute).mock.calls[0]
    const streamExecution = vi.mocked(streamDeps.toolExecutor!.execute).mock.calls[0]
    expect(streamExecution?.slice(0, 3)).toEqual(nonStreamExecution?.slice(0, 3))
    const {
      onExecutionStatus: streamStatus,
      onToolObserved: streamObserved,
      onNestedToolCall: streamNested,
      loopGuard: streamLoopGuard,
      ...streamContext
    } = streamExecution![3]!
    const {
      onExecutionStatus: nonStreamStatus,
      onToolObserved: nonStreamObserved,
      onNestedToolCall: nonStreamNested,
      loopGuard: nonStreamLoopGuard,
      ...nonStreamContext
    } = nonStreamExecution![3]!
    expect(streamContext).toEqual(nonStreamContext)
    expect(streamNested).toEqual(expect.any(Function))
    expect(nonStreamNested).toEqual(expect.any(Function))
    expect(streamLoopGuard).not.toBe(nonStreamLoopGuard)
    expect(streamLoopGuard?.signal.aborted).toBe(false)
    expect(nonStreamLoopGuard?.signal.aborted).toBe(false)
    expect(streamStatus).toEqual(expect.any(Function))
    expect(nonStreamStatus).toEqual(expect.any(Function))
    expect(streamObserved).toEqual(expect.any(Function))
    expect(nonStreamObserved).toEqual(expect.any(Function))
    expect(nonStreamExecution?.[3]).toMatchObject({
      agentId: 'nana',
      threadId: 'thread-1',
      channel: 'desktop',
      taskId: 'task-1',
      pairId: 'pair-1',
      disabledTools: ['write_file', 'automation_execute', 'get_mouse_position'],
      toolCallId: 'flow-call',
    })
  })

  it('应当在没有模型配置时使用环境变量兜底或抛出配置错误', async () => {
    const envDeps = createDeps({ getModelConfig: vi.fn().mockResolvedValue(null) })
    vi.stubEnv('PERO_LLM_API_KEY', 'env-key')
    vi.stubEnv('PERO_LLM_MODEL', 'env-model')
    vi.stubEnv('PERO_LLM_PROVIDER', 'gemini')
    vi.stubEnv('PERO_LLM_API_BASE', 'https://example.test')
    const envService = new AgentService(envDeps)

    await envService.chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 's1',
      messages: [{ role: 'user', content: '你好' }],
    })

    expect(envDeps.llmService.chatStream).toHaveBeenCalledWith(
      {
        provider: 'gemini',
        modelId: 'env-model',
        apiKey: 'env-key',
        apiBase: 'https://example.test',
      },
      expect.any(Array),
      expect.any(Object),
    )

    vi.stubEnv('PERO_LLM_API_KEY', undefined)
    await envService.chatWithCompiledMessages({
      agentId: 'pero',
      channel: 'desktop',
      threadId: 's1',
      messages: [{ role: 'user', content: '免密连接' }],
    })
    expect(envDeps.llmService.chatStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: 'env-model', apiKey: '' }),
      expect.any(Array),
      expect.any(Object),
    )
    vi.stubEnv('PERO_LLM_MODEL', undefined)
    const errorDeps = createDeps({ getModelConfig: vi.fn().mockResolvedValue(null) })
    const errorService = new AgentService(errorDeps)

    await expect(
      errorService.chatWithCompiledMessages({
        agentId: 'pero',
        channel: 'desktop',
        threadId: 's1',
        messages: [{ role: 'user', content: '你好' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
  })
  it('应将模型流式文本作为正文增量传给调用方', async () => {
    const deps = createDeps({
      llmService: {
        chatStream: vi
          .fn()
          .mockReturnValue(
            streamFrom([
              { choices: [{ delta: { content: '前半' } }] },
              { choices: [{ delta: { content: '后半' } }] },
            ]),
          ),
      } as never,
    })
    const chunks = []
    for await (const chunk of new AgentService(deps).chatStreamWithCompiledMessages({
      agentId: 'pero',
      threadId: 's1',
      messages: [{ role: 'user', content: '开始' }],
    }))
      chunks.push(chunk)
    expect(
      chunks
        .flatMap((chunk) => (chunk.event === 'narration_delta' ? [chunk.data.delta] : []))
        .join(''),
    ).toBe('前半后半')
  })
})
