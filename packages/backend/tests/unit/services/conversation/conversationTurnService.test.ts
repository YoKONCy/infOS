import { describe, expect, it, vi } from 'vitest'
import { ConversationTurnService } from '@infos/backend/services/conversation/conversationTurnService'
import type { CompiledRunParams } from '@infos/backend/services/agent/agentService'
import path from 'node:path'

describe('ConversationTurnService 初始提示词快照', () => {
  it.each([
    ['gemini', true, true],
    ['gemini', false, false],
    ['openai', true, false],
  ])('%s 手动音频开关为 %s 时，原音装配为 %s', async (provider, enabled, expected) => {
    const row = {
      id: 'audio-1',
      kind: 'audio',
      mimeType: 'audio/wav',
      originalName: '录音.wav',
      sizeBytes: 100,
      metadataJson: '{}',
    }
    const readContent = vi.fn().mockResolvedValue({ bytes: Buffer.from('audio') })
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
      },
      getThreadModelConfig: vi
        .fn()
        .mockResolvedValue({ provider, modelId: 'gemini', apiKey: '', enableAudioInput: enabled }),
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: '听音频' }],
          currentMessageIndex: 0,
          manifest: { disabledTools: [] },
        }),
      },
      attachmentService: {
        validateForBinding: vi.fn().mockResolvedValue([row]),
        toDto: vi.fn((value) => value),
        bind: vi.fn(),
        readContent,
      },
      imageUnderstandingService: { transcribe: vi.fn() },
    } as never)
    const prepared = await service.prepareTurn({
      threadId: 'thread',
      content: '听音频',
      attachmentIds: ['audio-1'],
    })
    const parts = prepared.messages[0]!.content as Array<{ type: string; text?: string }>
    expect(parts.some((part) => part.type === 'input_audio')).toBe(expected)
    expect(readContent).toHaveBeenCalledTimes(expected ? 1 : 0)
    expect(JSON.stringify(parts)).toContain('attachment:audio-1')
  })
  it('任务交付唤醒不伪造用户消息，保存原会话答复并标记 Agent 发起', async () => {
    const appendUserMessage = vi.fn()
    const appendAssistantMessage = vi.fn().mockResolvedValue({ id: 2, status: 'active' })
    const run = vi.fn().mockResolvedValue('已接收结果，继续原任务')
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'origin',
          agentId: 'pero',
          channel: 'desktop',
          interactionMode: 'work',
          disabledTools: [],
        }),
        appendUserMessage,
        appendAssistantMessage,
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [
            { role: 'system', content: '人格' },
            { role: 'user', content: '任务结果已到达', cacheControl: { kind: 'current' } },
          ],
          currentMessageIndex: 1,
          manifest: { disabledTools: [] },
        }),
      },
      agentService: { chatWithCompiledMessages: run },
      attachmentService: {
        validateForBinding: vi.fn().mockResolvedValue([]),
        bindOutgoing: vi.fn(),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
    } as never)
    await service.executeTurn({
      threadId: 'origin',
      content: '任务结果已到达',
      queueMessageId: 'task-result:delivery',
      achievementSubjectId: 'paired-device',
      inputPersistence: 'ephemeral',
      proactive: true,
    })
    expect(appendUserMessage).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: 'agent' }))
    expect(appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'origin', content: '已接收结果，继续原任务' }),
    )
    const metadata = JSON.parse(appendAssistantMessage.mock.calls[0]![0].metadataJson)
    expect(metadata.proactive).toBe(true)
    expect(metadata.workContext.inputKind).toBe('proactive')
    expect(appendAssistantMessage.mock.calls[0]![0].achievement).toBeUndefined()
  })
  it('保存实际发送的预填充和后续请求，快照与执行期间的数组修改隔离', async () => {
    const appendAssistantMessage = vi.fn().mockResolvedValue({ id: 2, status: 'active' })
    const prefix = { role: 'assistant', content: '我先', promptSegment: 'assistant_prefill' }
    const first = [{ role: 'user', content: '你好' }, prefix]
    const later = [
      { role: 'user', content: '你好' },
      { role: 'tool', content: '查询结果', toolCallId: 'query' },
      prefix,
    ]
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendAssistantMessage,
      },
      agentService: {
        chatWithCompiledMessages: vi.fn(async (params: CompiledRunParams) => {
          params.onRequestCompiled?.({ turn: 1, messages: first, tools: [] } as never)
          params.onRequestCompiled?.({ turn: 2, messages: later, tools: [] } as never)
          first.push({ role: 'assistant', content: '不应污染快照' } as never)
          return '我先确认了结果。'
        }),
      },
      attachmentService: { bindOutgoing: vi.fn() },
    } as never)
    await service.executeTurn({
      threadId: 'thread',
      content: '你好',
      resumeMessages: [{ role: 'user', content: '你好' }],
    })
    const metadata = JSON.parse(appendAssistantMessage.mock.calls[0]![0].metadataJson)
    expect(metadata.initialPromptMessages).toHaveLength(2)
    expect(metadata.initialPromptMessages.at(-1)).toEqual(prefix)
    expect(metadata.modelRequests).toHaveLength(2)
    expect(metadata.modelRequests[1].messages).toEqual(later)
  })

  it('未知文件只给本机服务端存储路径和附件引用，不注入完整内容', async () => {
    const serverPath = path.resolve('TEMP/attachment-upload/stored-original')
    const attachment = {
      id: 'file-1',
      kind: 'file',
      mimeType: 'application/octet-stream',
      originalName: '资料.custom',
      storageKey: 'ab/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      extractedText: '不应注入的长正文'.repeat(1000),
    }
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [
            { role: 'system', content: '系统' },
            { role: 'user', content: '读取文件' },
          ],
          currentMessageIndex: 1,
          manifest: { disabledTools: [] },
        }),
      },
      attachmentService: {
        validateForBinding: vi.fn().mockResolvedValue([attachment]),
        toDto: vi.fn().mockReturnValue(attachment),
        bind: vi.fn(),
        resolveStoragePath: vi.fn().mockReturnValue(serverPath),
      },
      imageUnderstandingService: { transcribe: vi.fn().mockResolvedValue(null) },
    } as never)
    const prepared = await service.prepareTurn({
      threadId: 'thread-1',
      content: '读取文件',
      attachmentIds: ['file-1'],
    })
    const text = (prepared.messages[1]!.content as Array<{ text?: string }>)
      .map((part) => part.text ?? '')
      .join('\n')
    expect(text).toContain('attachment:file-1')
    expect(text).toContain(JSON.stringify(serverPath))
    expect(text).not.toContain('不应注入的长正文')
    expect(prepared.messages[0]).toEqual({ role: 'system', content: '系统' })
  })
  it('预算编译与执行共用会话模型快照，密钥不进入回合返回值', async () => {
    const model = {
      provider: 'openai',
      modelId: 'thread-model',
      apiKey: '不可返回的密钥',
      reasoningEffort: 'high' as const,
      contextWindowTokens: 64000,
      maxTokens: 2048,
    }
    const getThreadModelConfig = vi.fn().mockResolvedValue(model)
    const run = vi.fn().mockResolvedValue('完成')
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
          interactionMode: 'chat',
        }),
      },
      getThreadModelConfig,
      agentService: { chatWithCompiledMessages: run },
    } as never)
    const result = await service.executeTurn({
      threadId: 'thread',
      content: '任务',
      outputPersistence: 'ephemeral',
      resumeMessages: [{ role: 'user', content: '任务' }],
    })
    expect(getThreadModelConfig).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toMatchObject({ modelConfig: model })
    expect(result.maxInputTokens).toBeGreaterThan(0)
    expect(result.maxInputTokens).toBeLessThan(64000)
    expect(JSON.stringify(result)).not.toContain('不可返回的密钥')
  })

  it.each(['chat', 'work'] as const)(
    '%s 模式都保存单轮执行原件，失败轮次同样保留',
    async (interactionMode) => {
      const trace = [
        {
          role: 'assistant' as const,
          content: null,
          reasoningContent: '完整推理',
          toolCalls: [
            {
              id: 'read',
              type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: 'tool' as const, content: '完整读取正文', toolCallId: 'read' },
      ]
      const appendAssistantMessage = vi.fn().mockResolvedValue({ id: 2, status: 'active' })
      let fail = false
      const service = new ConversationTurnService({
        threadService: {
          getThread: vi.fn().mockResolvedValue({
            id: 'thread',
            agentId: 'pero',
            channel: 'desktop',
            interactionMode,
            disabledTools: [],
          }),
          appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
          appendAssistantMessage,
        },
        contextCompiler: {
          compile: vi.fn().mockResolvedValue({
            messages: [{ role: 'user', content: '任务' }],
            manifest: { disabledTools: [] },
          }),
        },
        agentService: {
          chatWithCompiledMessages: async (params: CompiledRunParams) => {
            params.onExecutionMessages?.(trace)
            if (fail) throw new Error('上游最终失败')
            return '完成'
          },
        },
        attachmentService: {
          validateForBinding: vi.fn().mockResolvedValue([]),
          bindOutgoing: vi.fn(),
        },
        imageUnderstandingService: { transcribe: vi.fn() },
      } as never)
      await service.executeTurn({ threadId: 'thread', content: '任务' })
      expect(
        JSON.parse(appendAssistantMessage.mock.calls[0]![0].metadataJson).workContext.messages,
      ).toEqual(trace)
      fail = true
      await expect(service.executeTurn({ threadId: 'thread', content: '任务' })).rejects.toThrow(
        '上游最终失败',
      )
      const saved = appendAssistantMessage.mock.calls[1]![0]
      expect(saved.status).toBe('failed')
      expect(JSON.parse(saved.metadataJson).workContext.messages).toEqual(trace)
    },
  )
  it.each(['stream', 'single'])(
    '桌面暂停在 %s 链路持久化，消息保留供续接且不发完成通知',
    async (mode) => {
      const pause = {
        kind: 'desktop' as const,
        code: 'DESKTOP_WAITING',
        message: '用户已接管',
        toolName: 'open_application',
        callId: 'open',
        pausedAt: '2026-10-18T08:00:00Z',
      }
      const descriptor = { executionId: 'run', processId: 'process', principalId: 'pero' }
      const appendAssistantMessage = vi.fn().mockResolvedValue({ id: 2, status: 'active' })
      const complete = vi.fn()
      const suspend = vi.fn()
      const onReplyReady = vi.fn()
      const service = new ConversationTurnService({
        threadService: {
          getThread: vi.fn().mockResolvedValue({
            id: 'thread',
            agentId: 'pero',
            channel: 'desktop',
            disabledTools: [],
          }),
          appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
          appendAssistantMessage,
        },
        contextCompiler: {
          compile: vi.fn().mockResolvedValue({
            messages: [{ role: 'user', content: '任务' }],
            manifest: { disabledTools: [] },
          }),
        },
        agentService: {
          chatWithCompiledMessages: vi.fn(async (params: CompiledRunParams) => {
            params.onExecutionPause?.(pause)
            return '已有工作'
          }),
          chatStreamWithCompiledMessages: async function* (params: CompiledRunParams) {
            yield { event: 'narration_delta', data: { delta: '已有工作' } }
            params.onExecutionPause?.(pause)
          },
        },
        attachmentService: {
          validateForBinding: vi.fn().mockResolvedValue([]),
          bindOutgoing: vi.fn(),
        },
        imageUnderstandingService: { transcribe: vi.fn() },
        onReplyReady,
        executionRuntime: {
          create: vi.fn().mockResolvedValue(descriptor),
          start: vi.fn(),
          complete,
          suspend,
        },
      } as never)
      if (mode === 'stream') {
        const stream = service.streamTurn({ threadId: 'thread', content: '任务' })
        for await (const chunk of stream) {
          void chunk
        }
      } else await service.executeTurn({ threadId: 'thread', content: '任务' })
      expect(complete).not.toHaveBeenCalled()
      expect(suspend).toHaveBeenCalledWith(descriptor)
      expect(onReplyReady).not.toHaveBeenCalled()
      const saved = appendAssistantMessage.mock.calls[0]![0]
      expect(saved).toMatchObject({
        status: 'active',
        scorerStatus: 'skipped',
        content: '已有工作',
      })
      expect(JSON.parse(saved.metadataJson).executionPause).toEqual(pause)
    },
  )
  it('失败回合不提交酒馆变量，成功回合保存回复后提交，检查点保留待提交变化', async () => {
    const change = {
      id: '变量提交',
      scope: 'desktop:pero:thread',
      effects: { local: [], global: [] },
    }
    const order: string[] = []
    const commitPromptVariables = vi.fn().mockImplementation(async () => {
      order.push('变量')
    })
    const checkpoint = vi.fn()
    let fail = true
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
        appendAssistantMessage: vi.fn().mockImplementation(async () => {
          order.push('回复')
          return { id: 2, status: 'active' }
        }),
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: '问题' }],
          manifest: { disabledTools: [] },
          promptVariableCommit: change,
        }),
        commitPromptVariables,
      },
      agentService: {
        chatWithCompiledMessages: vi.fn().mockImplementation(async (params) => {
          await params.onCheckpoint?.({ messages: [], toolCalls: [], turn: 1 })
          if (fail) throw new Error('模拟模型失败')
          return '完成'
        }),
      },
      attachmentService: {
        validateForBinding: vi.fn().mockResolvedValue([]),
        bindOutgoing: vi.fn(),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
    } as never)
    await expect(
      service.executeTurn({ threadId: 'thread', content: '问题', onCheckpoint: checkpoint }),
    ).rejects.toThrow('模拟模型失败')
    expect(commitPromptVariables).not.toHaveBeenCalled()
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ promptVariables: change }))
    expect(order).toEqual(['回复'])
    order.length = 0
    fail = false
    await service.executeTurn({ threadId: 'thread', content: '问题' })
    expect(order).toEqual(['回复', '变量'])
    expect(commitPromptVariables).toHaveBeenCalledWith(change)
  })

  it('历史后指令不抢占当前用户的图片附件，临时输入也不会重复追加', async () => {
    const input = { role: 'user', content: '请看图片' }
    const post = { role: 'user', content: '【系统指令】\n后置要求' }
    const compile = vi.fn().mockResolvedValue({
      messages: [{ role: 'system', content: '自有框架' }, input, post],
      currentMessageIndex: 1,
      manifest: { disabledTools: [] },
    })
    const attachment = {
      id: 'image-1',
      kind: 'image',
      mimeType: 'image/png',
      originalName: '图片.png',
    }
    const deps = {
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
      },
      contextCompiler: { compile },
      attachmentService: {
        validateForBinding: vi.fn().mockResolvedValue([attachment]),
        toDto: vi.fn().mockReturnValue(attachment),
        bind: vi.fn(),
        readContent: vi.fn().mockResolvedValue({ bytes: Buffer.from('image') }),
      },
      imageUnderstandingService: { transcribe: vi.fn().mockResolvedValue(null) },
    }
    const service = new ConversationTurnService(deps as never)
    const prepared = await service.prepareTurn({
      threadId: 'thread-1',
      content: '请看图片',
      attachmentIds: ['image-1'],
      imageMode: 'native',
    })
    expect(prepared.messages[2]).toEqual(post)
    expect(prepared.messages[1]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]),
    )
    deps.attachmentService.validateForBinding.mockResolvedValue([])
    compile.mockResolvedValue({
      messages: [{ role: 'system', content: '自有框架' }, input, post],
      currentMessageIndex: 1,
      manifest: { disabledTools: [] },
    })
    const ephemeral = await service.prepareTurn({
      threadId: 'thread-1',
      content: '临时输入',
      inputPersistence: 'ephemeral',
    })
    expect(ephemeral.messages).toHaveLength(3)
    expect(compile.mock.calls.at(-1)?.[2]).toMatchObject({
      currentInput: { role: 'user', content: '临时输入' },
    })
  })

  it('在 assistant 元数据中保存进入 ReAct 前的完整消息，且不包含执行期工具消息', async () => {
    const appendAssistantMessage = vi.fn().mockResolvedValue({ id: 2, status: 'active' })
    const onReplyReady = vi.fn()
    const initialMessages = [
      { role: 'system' as const, content: '<system>完整系统提示词</system>' },
      { role: 'user' as const, content: '当前问题' },
    ]
    const expectedMessages = structuredClone(initialMessages)
    const deps = {
      onReplyReady,
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'nana',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
        appendAssistantMessage,
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: initialMessages,
          manifest: { disabledTools: [] },
        }),
      },
      agentService: {
        chatWithCompiledMessages: vi.fn().mockImplementation(async (params) => {
          params.onRawText?.('原始回复')
          params.onGenerationStats?.({
            outputTokens: 110,
            modelDurationMs: 2000,
            modelCalls: 2,
            estimated: false,
          })
          params.onSpokenReply?.('简短口语答复')
          params.onToolCalls?.([
            {
              name: 'update_flow_state',
              args: {},
              result: '成功',
              durationMs: 1,
              isError: false,
              callId: 'call-1',
            },
          ])
          // 模拟 ReAct 内部产生额外上下文，但不得污染持久化的初始快照。
          params.messages.push({ role: 'tool', content: '运行期工具结果' })
          return '可见回复'
        }),
      },
      attachmentService: {
        validateForBinding: vi.fn().mockResolvedValue([]),
        bind: vi.fn(),
        bindOutgoing: vi.fn().mockResolvedValue(undefined),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
    }
    const service = new ConversationTurnService(deps as never)

    await service.executeTurn({ threadId: 'thread-1', content: '当前问题' })

    const saved = appendAssistantMessage.mock.calls[0]![0]
    expect(JSON.parse(saved.metadataJson).spokenReply).toBe('简短口语答复')
    expect(JSON.parse(saved.metadataJson).generationStats).toEqual({
      outputTokens: 110,
      modelDurationMs: 2000,
      modelCalls: 2,
      estimated: false,
    })
    expect(JSON.parse(saved.metadataJson).tokenUsage.outputTokens).toBe(110)
    expect(onReplyReady).toHaveBeenCalledWith({
      completedSuccessfully: true,
      agentId: 'nana',
      threadId: 'thread-1',
      messageId: '2',
      spokenReply: '简短口语答复',
    })
    const metadata = JSON.parse(saved.metadataJson) as {
      initialPromptMessages: typeof initialMessages
      tokenUsage: { inputTokens: number; outputTokens: number }
    }
    expect(metadata.initialPromptMessages).toEqual(expectedMessages)
    expect(metadata.initialPromptMessages.some((message) => String(message.role) === 'tool')).toBe(
      false,
    )
    expect(metadata.tokenUsage.inputTokens).toBeGreaterThan(0)
    expect(metadata.tokenUsage.outputTokens).toBeGreaterThan(0)
  })

  it('应为每次 Turn 建立 Execution，并将同一因果身份传给 assistant 提交', async () => {
    const descriptor = {
      executionId: 'execution-1',
      processId: 'process-1',
      principalId: 'nana',
      threadId: 'thread-1',
      channel: 'desktop',
      class: 'interactive',
      priority: 5,
      budget: {},
    }
    const create = vi.fn().mockResolvedValue(descriptor)
    const start = vi.fn().mockResolvedValue(undefined)
    const complete = vi.fn().mockResolvedValue(undefined)
    const appendAssistantMessage = vi.fn().mockResolvedValue({ id: 2 })
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'nana',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
        appendAssistantMessage,
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: '执行任务' }],
          manifest: { disabledTools: [] },
        }),
      },
      agentService: { chatWithCompiledMessages: vi.fn().mockResolvedValue('完成') },
      attachmentService: {
        bindOutgoing: vi.fn().mockResolvedValue(undefined),
        validateForBinding: vi.fn().mockResolvedValue([]),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
      executionRuntime: { create, start, complete, fail: vi.fn() },
    } as never)

    const result = await service.executeTurn({ threadId: 'thread-1', content: '执行任务' })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: 'nana',
        threadId: 'thread-1',
        channel: 'desktop',
        class: 'interactive',
      }),
    )
    expect(start).toHaveBeenCalledWith(descriptor)
    expect(appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ execution: descriptor }),
    )
    expect(complete).toHaveBeenCalledWith(descriptor)
    expect(result.execution).toBe(descriptor)
  })

  it('Realm任务使用最小上下文且不写入主应用Thread', async () => {
    const appendUserMessage = vi.fn()
    const appendAssistantMessage = vi.fn()
    const compile = vi.fn().mockResolvedValue({
      messages: [{ role: 'system', content: '最小人格上下文' }],
      manifest: { disabledTools: [] },
    })
    const chatWithCompiledMessages = vi.fn().mockResolvedValue('Realm结果')
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'task-thread',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage,
        appendAssistantMessage,
      },
      contextCompiler: { compile },
      agentService: { chatWithCompiledMessages },
      attachmentService: {
        bindOutgoing: vi.fn().mockResolvedValue(undefined),
        validateForBinding: vi.fn().mockResolvedValue([]),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
    } as never)

    await service.executeTurn({
      threadId: 'task-thread',
      content: '编辑文档',
      realmId: 'infos.arca',
      inputPersistence: 'ephemeral',
      outputPersistence: 'ephemeral',
    })

    expect(compile).toHaveBeenCalledWith(
      'task-thread',
      'pero',
      expect.objectContaining({ realmExecution: true, appendThreadMessages: false }),
    )
    expect(chatWithCompiledMessages).toHaveBeenCalledWith(
      expect.objectContaining({ realmId: 'infos.arca' }),
    )
    expect(appendUserMessage).not.toHaveBeenCalled()
    expect(appendAssistantMessage).not.toHaveBeenCalled()
  })

  it('回复成功持久化后才提交事件记忆草稿', async () => {
    const order: string[] = []
    const commit = vi.fn().mockImplementation(async () => {
      order.push('commit')
    })
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'nana',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
        appendAssistantMessage: vi.fn().mockImplementation(async () => {
          order.push('persist')
          return { id: 2, timestamp: '2026-08-27T12:00:00.000Z' }
        }),
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: '记住这件事' }],
          manifest: { disabledTools: [] },
        }),
      },
      agentService: {
        chatWithCompiledMessages: vi.fn().mockImplementation(async (params) => {
          params.onToolCalls?.([
            {
              name: 'write_event_note',
              args: { narrative: '我记住了这件事' },
              result: '已接受',
              durationMs: 1,
              isError: false,
              callId: 'call-memory',
            },
          ])
          return '好的'
        }),
      },
      attachmentService: {
        bindOutgoing: vi.fn().mockResolvedValue(undefined),
        validateForBinding: vi.fn().mockResolvedValue([]),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
      eventNoteDraftCommitter: { commit },
    } as never)

    await service.executeTurn({ threadId: 'thread-1', content: '记住这件事' })

    expect(order).toEqual(['persist', 'commit'])
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ assistantMessageId: 2 }))
  })

  it('回复持久化失败或临时回合时不提交事件记忆草稿', async () => {
    const commit = vi.fn()
    const common = {
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'nana',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
        appendAssistantMessage: vi.fn().mockRejectedValue(new Error('写入失败')),
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: '内容' }],
          manifest: { disabledTools: [] },
        }),
      },
      agentService: { chatWithCompiledMessages: vi.fn().mockResolvedValue('回复') },
      attachmentService: {
        bindOutgoing: vi.fn().mockResolvedValue(undefined),
        validateForBinding: vi.fn().mockResolvedValue([]),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
      eventNoteDraftCommitter: { commit },
    }
    const failed = new ConversationTurnService(common as never)
    await expect(failed.executeTurn({ threadId: 'thread-1', content: '内容' })).rejects.toThrow(
      '写入失败',
    )
    expect(commit).not.toHaveBeenCalled()

    const ephemeral = new ConversationTurnService({
      ...common,
      threadService: { ...common.threadService, appendAssistantMessage: vi.fn() },
    } as never)
    await ephemeral.executeTurn({
      threadId: 'thread-1',
      content: '内容',
      inputPersistence: 'ephemeral',
      outputPersistence: 'ephemeral',
    })
    expect(commit).not.toHaveBeenCalled()
  })

  it('仅在持久化回复后按Pair提交反馈，且反馈失败不影响回复', async () => {
    const feedback = vi.fn().mockRejectedValue(new Error('反馈训练失败'))
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'nana',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
        appendAssistantMessage: vi.fn().mockResolvedValue({ id: 2 }),
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: '调用记忆' }],
          manifest: { disabledTools: [] },
        }),
      },
      agentService: { chatWithCompiledMessages: vi.fn().mockResolvedValue('已使用记忆') },
      attachmentService: {
        bindOutgoing: vi.fn().mockResolvedValue(undefined),
        validateForBinding: vi.fn().mockResolvedValue([]),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
      retrievalFeedback: { applyRetrievalFeedback: feedback },
    } as never)

    const result = await service.executeTurn({ threadId: 'thread-1', content: '调用记忆' })

    expect(result.reply).toBe('已使用记忆')
    expect(feedback).toHaveBeenCalledWith(result.pairId, '已使用记忆')
  })

  it('持久对话编译不再因窗口轮数同步触发后台补记', async () => {
    const ensureContextWindowCoverage = vi.fn().mockResolvedValue(undefined)
    const compile = vi.fn().mockResolvedValue({
      messages: [{ role: 'user', content: '第41轮' }],
      manifest: { disabledTools: [] },
    })
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
      },
      contextCompiler: {
        getMessageWindow: vi.fn().mockResolvedValue(40),
        compile,
      },
      eventMemoryFallback: { ensureContextWindowCoverage },
      attachmentService: {
        bindOutgoing: vi.fn().mockResolvedValue(undefined),
        validateForBinding: vi.fn().mockResolvedValue([]),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
      getAgentModelConfig: vi.fn().mockResolvedValue(null),
    } as never)

    await service.prepareTurn({ threadId: 'thread-1', content: '第41轮' })

    expect(ensureContextWindowCoverage).not.toHaveBeenCalled()
    expect(compile).toHaveBeenCalledOnce()
  })

  it('完整读取结果进入短期缓存，来源随对话保存且不再自动写入心流正文', async () => {
    const source = { callId: 'call-read', toolName: 'read_file_range', sourceRef: 'src/app.ts' }
    const capture = vi.fn().mockReturnValue(source)
    const output = JSON.stringify({
      content: '文件中的完整内容',
      hash: 'abc',
      lineStart: 10,
      lineEnd: 11,
    })
    const appendAssistantMessage = vi.fn().mockResolvedValue({ id: 2 })
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-1',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
        appendAssistantMessage,
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: '读取代码' }],
          manifest: { disabledTools: [] },
        }),
      },
      agentService: {
        chatWithCompiledMessages: vi.fn().mockImplementation(async (params) => {
          await params.onToolObserved?.({
            name: 'read_file_range',
            args: { path: 'src/app.ts', line_start: 10, line_end: 11 },
            output,
            isError: false,
            callId: 'call-read',
          })
          return '读取完成'
        }),
      },
      attachmentService: {
        bindOutgoing: vi.fn().mockResolvedValue(undefined),
        validateForBinding: vi.fn().mockResolvedValue([]),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
      toolContextService: {
        capture,
        deletePairs: vi.fn(),
        auditMessages: (messages: unknown[]) => messages,
      },
    } as never)

    const result = await service.executeTurn({ threadId: 'thread-1', content: '读取代码' })

    expect(capture).toHaveBeenCalledWith(
      { threadId: 'thread-1', agentId: 'pero', pairId: result.pairId, channel: 'desktop' },
      {
        name: 'read_file_range',
        args: { path: 'src/app.ts', line_start: 10, line_end: 11 },
        output,
        isError: false,
        callId: 'call-read',
      },
      0,
    )
    expect(result.toolSources).toEqual([source])
    const savedMetadata = JSON.parse(appendAssistantMessage.mock.calls[0]![0].metadataJson)
    expect(savedMetadata.toolSources).toEqual([source])
    expect(JSON.stringify(savedMetadata)).not.toContain('文件中的完整内容')
  })

  it('模型未配置上下文窗口时Token预算返回不可计算状态', async () => {
    const compile = vi.fn()
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-tsukinaga',
          agentId: 'tsukinaga',
          channel: 'desktop',
          disabledTools: [],
        }),
      },
      contextCompiler: { compile },
      getAgentModelConfig: vi.fn().mockResolvedValue({
        modelId: 'model-without-window',
        maxTokens: 8_192,
      }),
    } as never)

    await expect(
      service.previewTokenBudget({
        threadId: 'thread-tsukinaga',
        content: '待发送内容',
      }),
    ).resolves.toEqual({
      usedTokens: 0,
      contextWindowTokens: 0,
      maxInputTokens: 0,
      modelId: 'model-without-window',
    })
    expect(compile).not.toHaveBeenCalled()
  })

  it('普通会话的Token预算始终使用Thread所属Agent', async () => {
    const compile = vi.fn().mockResolvedValue({
      messages: [{ role: 'system', content: '系统提示词' }],
      manifest: { disabledTools: [] },
    })
    const getAgentModelConfig = vi.fn().mockResolvedValue({
      modelId: 'model-pero',
      contextWindowTokens: 262_144,
      maxTokens: 8_192,
    })
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-pero',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
      },
      contextCompiler: { compile },
      getAgentModelConfig,
    } as never)

    const result = await service.previewTokenBudget({
      threadId: 'thread-pero',
      agentId: 'nana',
      content: '待发送内容',
    })

    expect(getAgentModelConfig).toHaveBeenCalledWith('pero')
    expect(compile).toHaveBeenCalledWith(
      'thread-pero',
      'pero',
      expect.objectContaining({
        retrievalQuery: '待发送内容',
        disableMemoryRetrieval: true,
        disableContinuity: true,
      }),
    )
    expect(result.modelId).toBe('model-pero')
    expect(result.memoryRetrievalDeferred).toBe(true)
  })

  it('拒绝用其他Agent身份向普通Thread写入消息', async () => {
    const appendUserMessage = vi.fn()
    const service = new ConversationTurnService({
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread-pero',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
        }),
        appendUserMessage,
      },
    } as never)

    await expect(
      service.executeTurn({
        threadId: 'thread-pero',
        agentId: 'nana',
        content: '不应写入旧角色会话',
      }),
    ).rejects.toThrow(Error)
    expect(appendUserMessage).not.toHaveBeenCalled()
  })
})

describe('首次有效对话成就', () => {
  it.each([
    {
      name: '普通正式回复',
      reply: '你好，很高兴见到你。',
      paused: false,
      handoff: false,
      eligible: true,
    },
    { name: '仅内部过程', reply: '   ', paused: false, handoff: false, eligible: false },
    {
      name: '桌面接管暂停',
      reply: '请先完成桌面操作。',
      paused: true,
      handoff: false,
      eligible: false,
    },
    {
      name: '用户新输入导致交接',
      reply: '我先查一下。',
      paused: false,
      handoff: true,
      eligible: false,
    },
  ])('$name', async ({ reply, paused, handoff, eligible }) => {
    const appendAssistantMessage = vi.fn().mockResolvedValue({ id: 2, status: 'active' })
    const service = new ConversationTurnService({
      isHandoffRequested: () => handoff,
      threadService: {
        getThread: vi.fn().mockResolvedValue({
          id: 'thread',
          agentId: 'pero',
          channel: 'desktop',
          disabledTools: [],
          interactionMode: 'chat',
        }),
        appendUserMessage: vi.fn().mockResolvedValue({ id: 1 }),
        appendAssistantMessage,
      },
      contextCompiler: {
        compile: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: '你好' }],
          currentMessageIndex: 0,
          manifest: { disabledTools: [] },
        }),
      },
      agentService: {
        chatWithCompiledMessages: vi.fn(async (params: CompiledRunParams) => {
          if (paused)
            params.onExecutionPause?.({
              kind: 'desktop',
              code: 'DESKTOP_PAUSED',
              message: '等待用户完成操作',
              toolName: 'desktop_click',
              callId: 'click',
              pausedAt: '2026-10-27T00:00:00.000Z',
            })
          return reply
        }),
      },
      attachmentService: {
        validateForBinding: vi.fn().mockResolvedValue([]),
        bindOutgoing: vi.fn(),
      },
      imageUnderstandingService: { transcribe: vi.fn() },
    } as never)
    await service.executeTurn({
      threadId: 'thread',
      content: '你好',
      achievementSubjectId: 'paired-device',
    })
    expect(appendAssistantMessage.mock.calls[0]![0].achievement).toEqual(
      eligible ? { subjectId: 'paired-device', id: 'fresh_start' } : undefined,
    )
  })
})
