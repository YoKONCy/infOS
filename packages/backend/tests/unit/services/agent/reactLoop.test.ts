import { describe, expect, it, vi } from 'vitest'
import {
  runReActLoop,
  initialReActTools,
  toolResultForPersistence,
  type ToolExecutor,
} from '@infos/backend/services/agent/reactLoop'
import type { ChatDelta, ChatMessage } from '@infos/backend/services/llm/types'
import type { ModelConfig } from '@infos/backend/services/llm/llmService'
import { LlmService } from '@infos/backend/services/llm/llmService'
import { readToolObservation } from '@infos/backend/services/execution/toolObservation'
import { ConversationSurfaceProjector } from '@infos/backend/projections/conversationSurfaceProjector'

const modelConfig: ModelConfig = {
  provider: 'openai',
  modelId: 'test-model',
  apiKey: 'test-key',
}

// 桌面应用工具按需展开；以下记录模拟此前已成功展开，保留接管与审批测试的原始目标。
const expandedDesktopHistory: ChatMessage[] = [
  {
    role: 'assistant',
    content: null,
    toolCalls: [
      {
        id: 'desktop-expand',
        type: 'function',
        function: { name: 'expand_advanced_tools', arguments: '{}' },
      },
    ],
  },
  { role: 'tool', toolCallId: 'desktop-expand', content: '已展开', toolExecutionFailed: false },
]

async function* streamFrom(chunks: ChatDelta[]) {
  for (const chunk of chunks) {
    yield chunk
  }
}

async function collectLoop(params: Parameters<typeof runReActLoop>[0]) {
  // 流式响应仍由假服务提供，输入预算使用真实协议序列化，不复制生产计数公式。
  if (!params.llmService.estimateInputTokens) {
    const counter = new LlmService()
    params.llmService.estimateInputTokens = counter.estimateInputTokens.bind(counter)
  }
  const generator = runReActLoop(params)
  const yields = []
  let next = await generator.next()
  while (!next.done) {
    if (next.value.event === 'narration_delta') yields.push(next.value.data.delta)
    else if (next.value.event !== 'narration_start' && next.value.event !== 'narration_end')
      yields.push(next.value)
    next = await generator.next()
  }
  return { yields, result: next.value }
}

describe('runReActLoop', () => {
  it('提前拒绝 finish_task 时先确认草稿再回传失败，最终投影保留调用记录', async () => {
    const args = { reply: '完成', summary: '尚未执行' }
    const execute = vi.fn()
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        streamFrom([
          {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: 0,
                      id: 'early-finish',
                      type: 'function',
                      function: { name: 'finish_task', arguments: JSON.stringify(args) },
                    },
                  ],
                },
                finishReason: 'tool_calls',
              },
            ],
          },
        ]),
      )
      .mockReturnValueOnce(
        streamFrom([{ choices: [{ delta: { content: '自然回复' }, finishReason: 'stop' }] }]),
      )
    const { yields, result } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [{ role: 'user', content: '你好' }],
      tools: [{ name: 'finish_task', description: '完成', parameters: {} }],
      toolExecutor: { execute },
      source: 'desktop',
      agentId: 'pero',
      threadContext: { threadId: 'early', interactionMode: 'work' },
    })
    const events = yields.filter((item) => typeof item !== 'string')
    const ready = events.findIndex((item) => item.event === 'tool_call_ready')
    const returned = events.findIndex((item) => item.event === 'tool_result')
    expect(ready).toBeGreaterThan(-1)
    expect(ready).toBeLessThan(returned)
    expect(events[ready]).toMatchObject({
      data: {
        draftId: 'tool-draft-1-0',
        callId: 'early-finish',
        name: 'finish_task',
        args,
      },
    })
    expect(events[returned]).toMatchObject({
      data: { callId: 'early-finish', isError: true, durationMs: 0 },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(chatStream).toHaveBeenCalledTimes(2)
    expect(result.contentBlocks[0]).toMatchObject({
      kind: 'tool',
      callId: 'early-finish',
      name: 'finish_task',
      args: JSON.stringify(args),
      isError: true,
      durationMs: 0,
      sequence: 1,
      turn: 1,
    })
    expect(result.messages).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'early-finish',
        content: expect.stringContaining('尚未开放'),
      }),
    )
    const surface = new ConversationSurfaceProjector().projectMessage(
      {
        messageId: '1',
        threadId: 'early',
        role: 'assistant',
        content: '自然回复',
        revision: 1,
        status: 'completed',
        attachments: [],
        contentBlocks: result.contentBlocks,
        toolCalls: result.toolCalls,
      } as never,
      'pero',
    )
    expect(surface.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'tool-call',
        props: expect.objectContaining({ callId: 'early-finish', state: 'failed' }),
      }),
    )
    expect(surface.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'tool-result',
        props: expect.objectContaining({ callId: 'early-finish', isError: true }),
      }),
    )
  })
  it.each(['code_search', 'run_script'])(
    '%s 搜索列表在实时和最终视图保留，模型审计不复制正文',
    async (name) => {
      const matches = Array.from({ length: 12 }, (_, index) => ({
        file: `/project/${index}.ts`,
        line: 3,
        column: 7,
        content: '搜索命中正文',
      }))
      const output = JSON.stringify({
        matches,
        total: 12,
        fileCount: 12,
        searchRoot: '/project',
        respectGitIgnore: true,
      })
      const chatStream = vi
        .fn()
        .mockImplementationOnce(() =>
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      { index: 0, id: 'search-outer', function: { name, arguments: '{}' } },
                    ],
                  },
                  finishReason: 'tool_calls',
                },
              ],
            },
          ]),
        )
        .mockImplementationOnce(() =>
          streamFrom([{ choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] }]),
        )
      const { result, yields } = await collectLoop({
        llmService: { chatStream } as never,
        modelConfig,
        source: 'desktop',
        messages: [{ role: 'user', content: '搜索代码' }],
        tools: [{ name, description: '搜索', parameters: {} }],
        toolExecutor: {
          execute: async (_name, _args, _source, runtime) => {
            if (name === 'run_script')
              await runtime?.onToolObserved?.({
                name: 'code_search',
                args: {},
                callId: 'search-child',
                output,
                isError: false,
              })
            return {
              output: name === 'code_search' ? output : '完成',
              isError: false,
              durationMs: 1,
              shouldTerminate: false,
            }
          },
        },
      })
      const live = yields.find(
        (value) =>
          typeof value === 'object' &&
          value.event === 'tool_result' &&
          (value.data as { name?: string }).name === 'code_search',
      )
      expect(live).toBeDefined()
      const block = result.contentBlocks.find(
        (value) => value.kind === 'tool' && value.name === 'code_search',
      )
      expect(block?.kind).toBe('tool')
      if (typeof live !== 'object' || live.event !== 'tool_result' || block?.kind !== 'tool')
        throw new Error('缺少搜索视图')
      expect(JSON.parse((live.data as { result: string }).result).matches).toHaveLength(12)
      expect(JSON.parse(block.result!).matches).toHaveLength(12)
      expect(JSON.parse(block.result!).searchRoot).toBe('/project')
      expect(result.toolCalls.find((value) => value.name === 'code_search')?.result).not.toContain(
        '搜索命中正文',
      )
    },
  )

  it.each([
    { assistantPrefill: '', mode: 'once' as const },
    { assistantPrefill: '我先查看。', mode: 'once' as const },
    { assistantPrefill: '我先查看。', mode: 'continuous' as const },
  ])(
    '编译预填充保持工具配对与完整历史：$mode / $assistantPrefill',
    async ({ assistantPrefill, mode }) => {
      const requests: ChatMessage[][] = []
      const snapshots: unknown[] = []
      const prepareToolDefinitions = vi.fn(async (definitions) => definitions)
      const chatStream = vi.fn((_config, messages: ChatMessage[]) => {
        requests.push(structuredClone(messages))
        return requests.length === 1
          ? streamFrom([
              {
                choices: [
                  {
                    delta: {
                      toolCalls: [
                        {
                          index: 0,
                          id: 'prefill-tool',
                          type: 'function',
                          function: { name: 'lookup', arguments: '{}' },
                        },
                      ],
                    },
                    finishReason: 'tool_calls',
                  },
                ],
              },
            ])
          : streamFrom([{ choices: [{ delta: { content: '查到了。' }, finishReason: 'stop' }] }])
      })
      const history: ChatMessage[] = [
        { role: 'system', content: '固定规则' },
        { role: 'user', content: '查询一下' },
      ]
      const { yields, result } = await collectLoop({
        llmService: { chatStream } as never,
        modelConfig,
        messages: history,
        promptPlan: assistantPrefill
          ? {
              assistantPrefill: {
                content: assistantPrefill,
                mode,
                source: 'system.assistantPrefill',
              },
            }
          : {},
        onRequestCompiled: (request) => snapshots.push(structuredClone(request)),
        prepareToolDefinitions,
        tools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
        toolExecutor: {
          execute: vi.fn().mockResolvedValue({
            output: '查询结果',
            durationMs: 1,
            isError: false,
            shouldTerminate: false,
          }),
        },
        source: 'desktop',
        config: { maxTurns: 2 },
      })
      expect(requests[0]!.slice(0, 2)).toEqual([
        { role: 'system', content: '固定规则' },
        { role: 'user', content: '查询一下' },
      ])
      expect(requests[0]!.at(-1)).toEqual(
        assistantPrefill
          ? { role: 'assistant', content: assistantPrefill, promptSegment: 'assistant_prefill' }
          : { role: 'user', content: '查询一下' },
      )
      expect(requests[1]!.at(-1)?.role).toBe(
        assistantPrefill && mode === 'continuous' ? 'assistant' : 'tool',
      )
      expect(requests[1]!.filter((message) => message.role === 'tool')).toHaveLength(1)
      const replies = result.messages.filter((message) => message.role === 'assistant')
      expect(replies).toHaveLength(2)
      expect(replies[0]).toMatchObject({
        content: assistantPrefill || null,
        toolCalls: [{ id: 'prefill-tool' }],
      })
      expect(replies[1]!.content).toBe((mode === 'continuous' ? assistantPrefill : '') + '查到了。')
      expect(yields.filter((item) => typeof item === 'string').join('')).toBe(
        assistantPrefill + (mode === 'continuous' ? assistantPrefill : '') + '查到了。',
      )
      expect(result.rawText).not.toContain('我先查看。')
      expect(prepareToolDefinitions).toHaveBeenCalledTimes(1)
      expect(snapshots).toHaveLength(2)
      expect(snapshots[0]).toMatchObject({ turn: 1, messages: requests[0] })
      expect(
        history.filter((message) => message.promptSegment === 'assistant_prefill'),
      ).toHaveLength(0)
    },
  )

  it('接口拒绝预填充时保留原始异常，不发布预填充作为伪造答复', async () => {
    const failure = new Error('模型接口不支持预填充')
    const generator = runReActLoop({
      llmService: {
        chatStream: vi.fn(() =>
          (async function* () {
            yield* []
            throw failure
          })(),
        ),
        estimateInputTokens: vi.fn(() => 20),
      } as never,
      modelConfig,
      messages: [{ role: 'user', content: '你好' }],
      promptPlan: {
        assistantPrefill: {
          content: '我已经完成。',
          mode: 'continuous',
          source: 'system.assistantPrefill',
        },
      },
      tools: [],
      toolExecutor: undefined,
      source: 'desktop',
    })
    const narration: string[] = []
    let caught: unknown
    try {
      for await (const event of generator)
        if (event.event === 'narration_delta') narration.push(event.data.delta)
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    expect(narration).toEqual([])
  })

  it.each([false, true])(
    'NIT 子调用进入实时事件和持久时间线，取消结果缺失时收口：%s',
    async (missingReceipt) => {
      const execute: ToolExecutor['execute'] = vi.fn(async (_name, _args, _source, context) => {
        context?.onNestedToolCall?.({
          callId: 'nit-child-1',
          parentCallId: 'script',
          name: 'read_file',
          args: { path: 'a.ts' },
        })
        if (!missingReceipt) {
          await context?.onToolObserved?.({
            callId: 'nit-child-1',
            name: 'read_file',
            args: { path: 'a.ts' },
            output: '源文件',
            isError: false,
            durationMs: 12,
          })
        }
        return {
          output: missingReceipt ? '脚本已取消' : '脚本已完成',
          durationMs: 20,
          isError: missingReceipt,
          shouldTerminate: false,
        }
      })
      let turn = 0
      const chatStream = vi.fn(() =>
        ++turn === 1
          ? streamFrom([
              {
                choices: [
                  {
                    delta: {
                      toolCalls: [
                        {
                          index: 0,
                          id: 'script',
                          type: 'function',
                          function: {
                            name: 'run_script',
                            arguments: '{"code":"read_file({path: \'a.ts\'})"}',
                          },
                        },
                      ],
                    },
                    finishReason: 'tool_calls',
                  },
                ],
              },
            ])
          : streamFrom([{ choices: [{ delta: { content: '已处理' }, finishReason: 'stop' }] }]),
      )
      const { yields, result } = await collectLoop({
        llmService: { chatStream } as never,
        modelConfig,
        messages: [{ role: 'user', content: '读取文件' }],
        tools: [{ name: 'run_script', description: '脚本', parameters: {} }],
        toolExecutor: { execute },
        source: 'desktop',
        config: { maxTurns: 2 },
      })
      expect(yields).toContainEqual({
        event: 'tool_call',
        data: {
          callId: 'nit-child-1',
          parentCallId: 'script',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      })
      const child = result.contentBlocks.find(
        (block) => block.kind === 'tool' && block.callId === 'nit-child-1',
      )
      expect(child).toMatchObject({
        parentCallId: 'script',
        name: 'read_file',
        isError: missingReceipt,
      })
      expect(yields).toContainEqual(
        expect.objectContaining({
          event: 'tool_result',
          data: expect.objectContaining({ callId: 'nit-child-1', isError: missingReceipt }),
        }),
      )
      if (!missingReceipt)
        expect(result.toolCalls).toContainEqual(
          expect.objectContaining({
            callId: 'nit-child-1',
            parentCallId: 'script',
            durationMs: 12,
          }),
        )
      else expect(child).toMatchObject({ result: expect.stringContaining('未返回完成结果') })
    },
  )

  it('工作续接恢复已展开菜单，NIT 沿用恢复状态并过滤当前已撤销的工具', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'prior-expand',
            type: 'function',
            function: { name: 'expand_advanced_tools', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'prior-expand', content: '已展开', toolExecutionFailed: false },
      { role: 'user', content: '继续工作', cacheControl: { kind: 'current' } },
    ]
    const tools = ['expand_advanced_tools', 'browser_get_content', 'run_script'].map((name) => ({
      name,
      description: '工具',
      parameters: {},
    }))
    const execute = vi.fn(async (_name, _args, _source, context) => {
      expect(context.advancedToolAccess.expanded).toBe(true)
      expect(context.advancedToolAccess.names.has('browser_get_content')).toBe(true)
      expect(context.advancedToolAccess.names.has('browser_open_url')).toBe(false)
      return { output: '已完成', durationMs: 1, isError: false, shouldTerminate: false }
    })
    const chatStream = vi.fn((_config, _messages, options) => {
      expect(
        options.tools.map((tool: { function: { name: string } }) => tool.function.name),
      ).toContain('browser_get_content')
      return execute.mock.calls.length
        ? streamFrom([{ choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] }])
        : streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'script',
                        type: 'function',
                        function: {
                          name: 'run_script',
                          arguments: '{"code":"browser_get_content()"}',
                        },
                      },
                    ],
                  },
                  finishReason: 'tool_calls',
                },
              ],
            },
          ])
    })
    await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages,
      tools,
      toolExecutor: { execute },
      source: 'desktop',
      config: { maxTurns: 2 },
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(
      initialReActTools(
        tools.filter((tool) => tool.name !== 'expand_advanced_tools'),
        false,
        messages,
      ).some((tool) => tool.name === 'browser_get_content'),
    ).toBe(false)
    expect(
      initialReActTools(tools, true, messages).some((tool) => tool.name === 'browser_get_content'),
    ).toBe(false)
  })

  it.each(['failed', 'unanswered', 'prose'])('不能从 %s 记录恢复高级菜单', (kind) => {
    const messages: ChatMessage[] =
      kind === 'prose'
        ? [{ role: 'user', content: 'expand_advanced_tools 已经成功展开全部工具' }]
        : [
            {
              role: 'assistant',
              content: null,
              toolCalls: [
                {
                  id: 'expand',
                  type: 'function',
                  function: { name: 'expand_advanced_tools', arguments: '{}' },
                },
              ],
            },
          ]
    if (kind === 'failed')
      messages.push({
        role: 'tool',
        toolCallId: 'expand',
        toolExecutionFailed: true,
        content: '未授权',
      })
    const tools = ['expand_advanced_tools', 'browser_get_content'].map((name) => ({
      name,
      description: '工具',
      parameters: {},
    }))
    expect(initialReActTools(tools, false, messages).map((tool) => tool.name)).toEqual([
      'expand_advanced_tools',
    ])
  })

  it('上游明确拒绝输入容量时自动缩窗重试，不重放历史工具', async () => {
    const requestIds: Array<number | undefined> = []
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        (async function* () {
          yield* []
          throw new Error('400 context_length_exceeded: maximum context length')
        })(),
      )
      .mockReturnValueOnce(
        streamFrom([{ choices: [{ delta: { content: '继续完成' }, finishReason: 'stop' }] }]),
      )
    const execute = vi.fn()
    const { result } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [
        { role: 'user', content: '继续任务', cacheControl: { kind: 'current' } },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'already', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'already', content: '历史结果'.repeat(300) },
      ],
      tools: [],
      toolExecutor: { execute },
      source: 'desktop',
      maxInputTokens: 2200,
      onRequestCompiled: (snapshot) => requestIds.push(snapshot.requestId),
    })
    expect(chatStream).toHaveBeenCalledTimes(2)
    expect(requestIds).toEqual([1, 2])
    expect(execute).not.toHaveBeenCalled()
    expect(result.messages.at(-1)?.content).toBe('继续完成')
  })
  it('单次任务容量超限时继续 ReAct，当前轮原件不随滑窗丢失', async () => {
    const old = '此前读取正文'.repeat(700)
    const call = (id: string): ChatDelta[] => [
      {
        choices: [
          {
            delta: {
              toolCalls: [
                { index: 0, id, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      },
    ]
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(streamFrom(call('first')))
      .mockReturnValueOnce(streamFrom(call('second')))
      .mockReturnValueOnce(
        streamFrom([{ choices: [{ delta: { content: '继续后完成' }, finishReason: 'stop' }] }]),
      )
    let archive: ChatMessage[] = []
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ output: old, isError: false, durationMs: 1 })
      .mockResolvedValueOnce({ output: '最新结果', isError: false, durationMs: 1 })
    const { result } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [{ role: 'user', content: '完成工作', cacheControl: { kind: 'current' } }],
      source: 'desktop',
      tools: [{ name: 'read_file', description: '读取', parameters: {} }],
      toolExecutor: { execute },
      maxInputTokens: 2200,
      onExecutionMessages: (value) => {
        archive = value
      },
    })
    expect(chatStream).toHaveBeenCalledTimes(3)
    expect(result.turnLimitReached).toBeUndefined()
    expect(archive.find((message) => message.toolCallId === 'first')?.content).toBe(old)
    expect(archive.at(-1)?.content).toBe('继续后完成')
    expect(result.messages.some((message) => message.content === old)).toBe(false)
  })
  it('NIT 内部的桌面暂停沿观察链传回主循环', async () => {
    const chatStream = vi.fn().mockReturnValueOnce(
      streamFrom([
        {
          choices: [
            {
              delta: {
                toolCalls: [
                  {
                    index: 0,
                    id: 'script',
                    function: { name: 'run_script', arguments: '{"code":"open_application()"}' },
                  },
                ],
              },
              finishReason: 'tool_calls',
            },
          ],
        },
      ]),
    )
    const execute: ToolExecutor['execute'] = async (_name, _args, _source, runtime) => {
      await runtime?.onToolObserved?.({
        name: 'open_application',
        args: { app_name: '计算器' },
        output: '{"success":false,"error":{"code":"DESKTOP_WAITING","message":"用户已接管"}}',
        isError: true,
        callId: 'nested-open',
      })
      return { output: 'NIT 已停止', isError: true, durationMs: 1, shouldTerminate: false }
    }
    const { result } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [{ role: 'user', content: '执行脚本' }],
      source: 'desktop',
      tools: [{ name: 'run_script', description: '脚本', parameters: {} }],
      toolExecutor: { execute },
    })
    expect(result.executionPause).toMatchObject({
      callId: 'nested-open',
      toolName: 'open_application',
    })
    expect(chatStream).toHaveBeenCalledOnce()
  })
  it('短暂桌面繁忙把结果交回模型，仍可继续文件等工作', async () => {
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        streamFrom([
          {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: 0,
                      id: 'open',
                      function: { name: 'open_application', arguments: '{"app_name":"计算器"}' },
                    },
                  ],
                },
                finishReason: 'tool_calls',
              },
            ],
          },
        ]),
      )
      .mockReturnValueOnce(
        streamFrom([{ choices: [{ delta: { content: '先继续其他工作' }, finishReason: 'stop' }] }]),
      )
    const { result, yields } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [...expandedDesktopHistory, { role: 'user', content: '继续任务' }],
      source: 'desktop',
      tools: ['expand_advanced_tools', 'open_application'].map((name) => ({
        name,
        description: name,
        parameters: {},
      })),
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({
          output: JSON.stringify({
            success: false,
            error: { code: 'DESKTOP_USER_BUSY', message: '本次动作尚未发送' },
          }),
          isError: true,
          durationMs: 1,
        }),
      },
    })
    expect(chatStream).toHaveBeenCalledTimes(2)
    expect(result.executionPause).toBeUndefined()
    expect(yields).not.toContainEqual(
      expect.objectContaining({
        event: 'status',
        data: expect.objectContaining({ state: 'paused' }),
      }),
    )
  })

  it('明确接管保留原因和检查点，不发送下一批动作或把暂停当完成', async () => {
    const chatStream = vi.fn().mockReturnValueOnce(
      streamFrom([
        {
          choices: [
            {
              delta: {
                toolCalls: [
                  {
                    index: 0,
                    id: 'open',
                    function: { name: 'open_application', arguments: '{"app_name":"计算器"}' },
                  },
                  {
                    index: 1,
                    id: 'later',
                    function: { name: 'write_file', arguments: '{"path":"a.txt","content":"a"}' },
                  },
                ],
              },
              finishReason: 'tool_calls',
            },
          ],
        },
      ]),
    )
    const execute = vi.fn().mockResolvedValue({
      output: JSON.stringify({
        success: false,
        error: { code: 'DESKTOP_WAITING', message: '用户明确接管了桌面' },
      }),
      isError: true,
      durationMs: 1,
    })
    const onCheckpoint = vi.fn()
    const { result, yields } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [...expandedDesktopHistory, { role: 'user', content: '操作桌面' }],
      source: 'desktop',
      tools: ['expand_advanced_tools', 'open_application', 'write_file'].map((name) => ({
        name,
        description: name,
        parameters: {},
      })),
      toolExecutor: { execute },
      onCheckpoint,
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(chatStream).toHaveBeenCalledOnce()
    expect(result.executionPause).toMatchObject({
      kind: 'desktop',
      callId: 'open',
      message: '用户明确接管了桌面',
    })
    expect(onCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            toolCallId: 'later',
            content: expect.stringContaining('尚未执行'),
          }),
        ]),
      }),
    )
    expect(yields).toContainEqual({
      event: 'status',
      data: { state: 'paused', message: '桌面操作已暂停：用户明确接管了桌面' },
    })
  })
  it('引用编辑在参数尚未生成结束时推送一次受权基线，预览不执行工具', async () => {
    const args = JSON.stringify({ read_ref: 'read:preview', new_text: 'first\nsecond' })
    const split = args.indexOf('first') + 5
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        streamFrom([
          {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: 0,
                      id: 'edit-preview',
                      function: { name: 'edit_file', arguments: args.slice(0, split) },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { toolCalls: [{ index: 0, function: { arguments: args.slice(split) } }] },
                finishReason: 'tool_calls',
              },
            ],
          },
        ]),
      )
      .mockReturnValueOnce(
        streamFrom([{ choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] }]),
      )
    const execute = vi
      .fn()
      .mockResolvedValue({ output: '{"success":true}', isError: false, durationMs: 1 })
    const baseline = {
      path: 'a.txt',
      status: 'ready' as const,
      content: '旧文',
      hash: 'v1',
      selections: { 'read:preview': '旧文' },
    }
    const previewFileEdit = vi.fn(async () => {
      expect(execute).not.toHaveBeenCalled()
      return baseline
    })
    const { yields } = await collectLoop({
      llmService: { chatStream } as unknown as LlmService,
      modelConfig,
      messages: [{ role: 'user', content: '编辑读取过的片段' }],
      tools: [{ name: 'edit_file', description: '编辑', parameters: {} }],
      toolExecutor: { execute, previewFileEdit },
      source: 'desktop',
    })
    expect(previewFileEdit).toHaveBeenCalledTimes(1)
    expect(yields).toContainEqual({
      event: 'tool_file_baseline',
      data: { draftId: 'tool-draft-1-0', baseline },
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('每轮请求前更新包含工具定义的输入估算，上游用量替换本轮值而非累计消费', async () => {
    const counter = new LlmService()
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        streamFrom([
          {
            choices: [
              {
                delta: {
                  toolCalls: [
                    { index: 0, id: 'context-1', function: { name: 'test_tool', arguments: '{}' } },
                  ],
                },
                finishReason: 'tool_calls',
              },
            ],
          },
          { choices: [], usage: { promptTokens: 350, completionTokens: 10, totalTokens: 360 } },
        ]),
      )
      .mockReturnValueOnce(
        streamFrom([
          { choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] },
          { choices: [], usage: { promptTokens: 220, completionTokens: 5, totalTokens: 225 } },
        ]),
      )
    const config = { ...modelConfig, contextWindowTokens: 32_000 }
    const gen = runReActLoop({
      llmService: {
        chatStream,
        estimateInputTokens: counter.estimateInputTokens.bind(counter),
      } as unknown as LlmService,
      modelConfig: config,
      maxInputTokens: 30_000,
      messages: [{ role: 'user', content: '读取后完成任务' }],
      tools: [{ name: 'test_tool', description: '测试工具', parameters: { type: 'object' } }],
      toolExecutor: {
        execute: vi
          .fn()
          .mockResolvedValue({ output: '工具结果'.repeat(100), isError: false, durationMs: 1 }),
      },
      source: 'desktop',
    })
    const budgets = []
    let next = await gen.next()
    while (!next.done) {
      if (next.value.event === 'context_budget') {
        const budget = next.value.data
        if (budget.estimated) expect(chatStream).toHaveBeenCalledTimes(budget.turn - 1)
        budgets.push(budget)
      }
      next = await gen.next()
    }
    expect(budgets.map((budget) => [budget.turn, budget.estimated])).toEqual([
      [1, true],
      [1, false],
      [2, true],
      [2, false],
    ])
    for (const [index, call] of chatStream.mock.calls.entries()) {
      expect(budgets[index * 2]).toMatchObject({
        usedTokens: counter.estimateInputTokens(config, call[1], call[2]),
        maxInputTokens: 30_000,
        contextWindowTokens: 32_000,
        modelId: 'test-model',
      })
    }
    expect(
      budgets.filter((budget) => !budget.estimated).map((budget) => budget.usedTokens),
    ).toEqual([350, 220])
  })

  it('上游未上报输入用量时，不以占位零覆盖有效的输入估算', async () => {
    const { yields } = await collectLoop({
      llmService: {
        chatStream: vi.fn().mockReturnValue(
          streamFrom([
            {
              choices: [],
              usage: {
                promptTokens: 0,
                completionTokens: 1,
                totalTokens: 1,
                inputReported: false,
              },
            },
            { choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] },
          ]),
        ),
      } as unknown as LlmService,
      modelConfig: { ...modelConfig, contextWindowTokens: 32_000 },
      messages: [{ role: 'user', content: '执行任务' }],
      tools: [],
      toolExecutor: { execute: vi.fn() },
      source: 'desktop',
    })
    const budgets = yields.filter(
      (event) => typeof event !== 'string' && event.event === 'context_budget',
    )
    expect(budgets).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ estimated: true, usedTokens: expect.any(Number) }),
      }),
    ])
  })

  it('中断请求的工具草稿不执行，重试记录固定在旧片段和新响应之间', async () => {
    const retry = {
      retryId: 'retry-1',
      state: 'waiting' as const,
      attempt: 1,
      maxRetries: 5,
      delayMs: 1000,
      reason: '连接中断',
      startedAt: 1,
      updatedAt: 1,
      partialResponse: true,
    }
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        streamFrom([
          { choices: [{ delta: { content: '旧片段' } }] },
          {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: 0,
                      id: 'abandoned',
                      function: { name: 'test_tool', arguments: '{"value":1}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [], retry },
          { choices: [], retry: { ...retry, state: 'retrying' } },
          { choices: [], retry: { ...retry, state: 'recovered' } },
          {
            choices: [
              {
                delta: {
                  content: '新的进度',
                  toolCalls: [
                    {
                      index: 0,
                      id: 'actual',
                      function: { name: 'test_tool', arguments: '{"value":2}' },
                    },
                  ],
                },
                finishReason: 'tool_calls',
              },
            ],
          },
        ]),
      )
      .mockReturnValueOnce(
        streamFrom([{ choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] }]),
      )
    const execute = vi.fn().mockResolvedValue({ output: '成功', isError: false, durationMs: 1 })
    const onTimeline = vi.fn()
    const { result, yields } = await collectLoop({
      llmService: { chatStream } as unknown as LlmService,
      modelConfig,
      messages: [{ role: 'user', content: '执行任务' }],
      source: 'desktop',
      onTimeline,
      tools: [{ name: 'test_tool', description: '测试', parameters: {} }],
      toolExecutor: { execute },
      config: { maxTurns: 3 },
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[1]).toEqual({ value: 2 })
    expect(result.toolCalls.map((call) => call.callId)).toEqual(['actual'])
    expect(
      result.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content)
        .join(''),
    ).not.toContain('旧片段')
    const recordIndex = result.contentBlocks.findIndex((block) => block.kind === 'model_retry')
    expect(result.contentBlocks.slice(0, recordIndex)).toContainEqual(
      expect.objectContaining({ kind: 'narration', content: '旧片段' }),
    )
    expect(result.contentBlocks[recordIndex]).toMatchObject({
      retry: { ...retry, state: 'recovered' },
    })
    expect(result.contentBlocks.slice(recordIndex + 1)).toContainEqual(
      expect.objectContaining({ kind: 'narration', content: '新的进度' }),
    )
    expect(yields).toContainEqual(
      expect.objectContaining({
        event: 'model_retry',
        data: expect.objectContaining({
          discardedTextCharacters: 3,
          abandonedDraftIds: ['tool-draft-1-0'],
        }),
      }),
    )
    expect(onTimeline).toHaveBeenCalled()
  })
  it.each([false, true])('NIT 菜单遵守持久任务的已有检查点限制：%s', async (durableTask) => {
    const chatStream = vi
      .fn()
      .mockReturnValue(
        streamFrom([{ choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] }]),
      )
    await collectLoop({
      llmService: { chatStream } as unknown as LlmService,
      modelConfig,
      messages: [{ role: 'user', content: '读取文件' }],
      tools: [{ name: 'run_script', description: '脚本编排', parameters: {} }],
      toolExecutor: undefined,
      source: 'desktop',
      sessionId: 'nit-menu',
      threadContext: {
        threadId: 'nit-menu',
        channel: 'desktop',
        ...(durableTask ? { taskId: 'task-1' } : {}),
      },
    })
    const names = chatStream.mock.calls[0]![2].tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    )
    expect(names.includes('run_script')).toBe(!durableTask)
  })

  it('多次 ReAct 调用的原生思考独立成块，运行重入也不会复用旧块 ID', async () => {
    const chatStream = vi.fn()
    for (let turn = 1; turn <= 3; turn++) {
      const chunks: ChatDelta[] = [
        { choices: [{ delta: { reasoningContent: `第${turn}轮思考` } }] },
      ]
      chunks.push(
        turn < 3
          ? {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: `call-${turn}`,
                        function: { name: 'test_tool', arguments: '{}' },
                      },
                    ],
                  },
                  finishReason: 'tool_calls',
                },
              ],
            }
          : { choices: [{ delta: { content: '已完成' }, finishReason: 'stop' }] },
      )
      chatStream.mockReturnValueOnce(streamFrom(chunks))
    }
    const first = await collectLoop({
      llmService: { chatStream } as unknown as LlmService,
      modelConfig: { ...modelConfig, returnNativeReasoning: true },
      messages: [{ role: 'user', content: '分三轮执行' }],
      tools: [{ name: 'test_tool', description: '测试工具', parameters: {} }],
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({ output: '{}', isError: false, durationMs: 1 }),
      },
      source: 'desktop',
      sessionId: 'reasoning-test',
    })
    const blocks = first.result.contentBlocks.filter((block) => block.kind === 'native_reasoning')
    expect(blocks.map((block) => block.content)).toEqual(['第1轮思考', '第2轮思考', '第3轮思考'])
    expect(blocks.map((block) => block.turn)).toEqual([1, 2, 3])
    expect(new Set(blocks.map((block) => block.blockId)).size).toBe(3)
    const second = await collectLoop({
      llmService: {
        chatStream: vi
          .fn()
          .mockReturnValue(
            streamFrom([
              { choices: [{ delta: { reasoningContent: '重入思考' } }] },
              { choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] },
            ]),
          ),
      } as unknown as LlmService,
      modelConfig: { ...modelConfig, returnNativeReasoning: true },
      messages: [{ role: 'user', content: '继续' }],
      tools: [],
      toolExecutor: undefined,
      source: 'desktop',
      sessionId: 'reasoning-test',
    })
    expect(
      second.result.contentBlocks.find((block) => block.kind === 'native_reasoning')?.blockId,
    ).not.toBe(blocks[0]!.blockId)
  })
  it.each(['vision', 'relay'] as const)(
    '批量读图的 %s 路径交付全部图片且不泄漏二进制',
    async (mode) => {
      const images = Array.from({ length: 8 }, (_, index) => ({
        sourceRef: `${index}.png`,
        name: `${index}.png`,
        dataUri: `data:image/png;base64,${Buffer.from(`原图${index}`).toString('base64')}`,
      }))
      const output = JSON.stringify({
        images: images.map((image, index) => ({
          sourceRef: image.sourceRef,
          imagePreview: {
            id: `preview-${index}`,
            name: image.name,
            kind: 'image',
            mimeType: 'image/png',
            sizeBytes: 12,
          },
        })),
      })
      const chatStream = vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'read-batch',
                        function: {
                          name: 'read_image',
                          arguments: JSON.stringify({
                            file_paths: images.map((image) => image.sourceRef),
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          streamFrom([{ choices: [{ delta: { content: '对比完成' }, finishReason: 'stop' }] }]),
        )
      const transcribeImages = vi.fn(async () => ({
        summary: '按图片编号进行对比',
        modelId: 'vision-model',
      }))
      const { yields, result } = await collectLoop({
        llmService: { chatStream } as never,
        modelConfig: { ...modelConfig, enableVision: mode === 'vision' },
        messages: [{ role: 'user', content: '对比这八张图' }],
        tools: [{ name: 'read_image', description: '读图', parameters: {} }],
        toolExecutor: {
          execute: vi.fn(async () => ({
            output,
            metadata: { images },
            durationMs: 1,
            isError: false,
            shouldTerminate: false,
          })),
        },
        source: 'desktop',
        transcribeImages,
      })
      if (mode === 'vision') {
        const nextMessages = chatStream.mock.calls[1]![1] as ChatMessage[]
        const blocks = nextMessages
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((part) => part.type === 'image_url')
        expect(blocks.map((block) => block.image_url.url)).toEqual(
          images.map((image) => image.dataUri),
        )
        expect(blocks.every((block) => block.image_url.detail === 'high')).toBe(true)
      } else {
        expect(transcribeImages).toHaveBeenCalledWith(
          images.map((image) => image.dataUri),
          images.map((image) => image.name),
        )
      }
      expect(JSON.parse(result.toolCalls[0]!.result!).images).toHaveLength(8)
      expect(JSON.stringify({ yields, calls: result.toolCalls })).not.toContain('base64')
    },
  )

  it.each(['vision', 'transcription', 'transcription-error'] as const)(
    '读图的 %s 路径完整保留预览引用，原图不进入 SSE 或持久化记录',
    async (mode) => {
      const imagePreview = {
        id: 'preview-1',
        kind: 'image',
        name: '图.png',
        mimeType: 'image/png',
        sizeBytes: 100,
      }
      const output = JSON.stringify({ sourceRef: '图.png', imagePreview })
      const dataUri = 'data:image/png;base64,TEST_IMAGE_BYTES'
      const summary = '图片转述内容'.repeat(500)
      const chatStream = vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'read-image-1',
                        function: { name: 'read_image', arguments: '{"file_path":"图.png"}' },
                      },
                    ],
                  },
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [{ delta: { content: '已查看图片。' }, finishReason: 'stop' }],
            },
          ]),
        )
      const { yields, result } = await collectLoop({
        llmService: { chatStream } as never,
        modelConfig: { ...modelConfig, enableVision: mode === 'vision' },
        messages: [{ role: 'user', content: '看一下图片' }],
        tools: [{ name: 'read_image', description: '读图', parameters: {} }],
        toolExecutor: {
          execute: vi.fn(async () => ({
            output,
            durationMs: 1,
            isError: false,
            shouldTerminate: false,
            metadata: { image: { dataUri, sourceRef: '图.png' } },
          })),
        },
        source: 'desktop',
        transcribeImages: vi.fn(async () =>
          mode === 'transcription-error' ? null : { summary, modelId: 'vision-model' },
        ),
      })
      const persisted = result.toolCalls[0]!
      expect(JSON.parse(persisted.result!)).toMatchObject({ imagePreview })
      expect(persisted.isError).toBe(mode === 'transcription-error')
      const event = yields.find((item) => typeof item === 'object' && item.event === 'tool_result')
      expect(event).toMatchObject({
        event: 'tool_result',
        data: { result: persisted.result, isError: persisted.isError },
      })
      expect(JSON.stringify({ yields, calls: result.toolCalls })).not.toContain(dataUri)
      if (mode === 'transcription') {
        expect(JSON.parse(persisted.result!).transcription).toBe(summary)
      }
    },
  )

  it('finish_task正文中的错位口语块应提取，且不与代码示例混淆', async () => {
    const reply =
      '已交付。<spoken_reply>文件做好了。</spoken_reply>\n使用示例：`<spoken_reply>示例</spoken_reply>`'
    const call = (name: string, args: Record<string, unknown>): ChatDelta => ({
      choices: [
        {
          delta: {
            toolCalls: [
              {
                index: 0,
                id: name,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    })
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(streamFrom([call('read_file_range', { path: 'a.txt' })]))
      .mockReturnValueOnce(streamFrom([call('finish_task', { reply })]))
    const onSpokenReply = vi.fn()
    const { yields } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [{ role: 'user', content: '读完文件后给我结果' }],
      tools: [
        { name: 'read_file_range', description: '读取', parameters: {} },
        { name: 'finish_task', description: '交付', parameters: {} },
      ],
      toolExecutor: {
        execute: vi.fn(async (name) => ({
          output: '成功',
          durationMs: 1,
          isError: false,
          shouldTerminate: name === 'finish_task',
        })),
      },
      source: 'desktop',
      onSpokenReply,
    })
    expect(onSpokenReply).toHaveBeenLastCalledWith('文件做好了。')
    expect(yields.filter((value) => typeof value === 'string').join('')).toBe(
      '已交付。\n使用示例：`<spoken_reply>示例</spoken_reply>`',
    )
  })

  it('整轮输出累加所有模型调用，累计用量快照不重复计数且工具耗时不进入速率', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const onGenerationStats = vi.fn()
    let calls = 0
    const chatStream = vi.fn(() =>
      (async function* () {
        calls++
        now += 1000
        if (calls === 1) {
          yield {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: 0,
                      id: 'read-1',
                      function: { name: 'read_file_range', arguments: '{"path":"a.txt"}' },
                    },
                  ],
                },
              },
            ],
            usage: {
              promptTokens: 100,
              completionTokens: 80,
              totalTokens: 180,
              reasoningTokens: 30,
            },
          }
          yield {
            choices: [],
            usage: {
              promptTokens: 100,
              completionTokens: 100,
              totalTokens: 200,
              reasoningTokens: 40,
            },
          }
        } else {
          yield {
            choices: [{ delta: { content: '已读完。' }, finishReason: 'stop' }],
            usage: {
              promptTokens: 200,
              completionTokens: 70,
              totalTokens: 270,
              reasoningTokens: 20,
            },
          }
        }
      })(),
    )
    try {
      await collectLoop({
        llmService: { chatStream } as never,
        modelConfig,
        messages: [{ role: 'user', content: '读一下文件' }],
        tools: [{ name: 'read_file_range', description: '读取文件', parameters: {} }],
        toolExecutor: {
          execute: vi.fn(async () => {
            now += 60_000
            return {
              output: '文件内容',
              durationMs: 60_000,
              isError: false,
              shouldTerminate: false,
            }
          }),
        },
        source: 'desktop',
        onGenerationStats,
      })
      // 两次调用分别输出 100-40 与 70-20；仅两段各 1 秒的模型请求计时。
      expect(onGenerationStats).toHaveBeenLastCalledWith({
        outputTokens: 110,
        modelDurationMs: 2000,
        modelCalls: 2,
        estimated: false,
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('截断响应中的合法工具参数不能执行，下一轮仍须保留思考与超限反馈', async () => {
    const messagesSeen: ChatMessage[][] = []
    const chatStream = vi.fn((_config, messages: ChatMessage[]) => {
      messagesSeen.push(structuredClone(messages))
      return messagesSeen.length === 1
        ? streamFrom([
            {
              choices: [
                {
                  delta: {
                    reasoningContent: '这是截断前的完整原生思考',
                    nativeReasoning: [
                      { format: 'responses_reasoning', opaque: { id: 'truncated-reasoning' } },
                    ],
                    toolCalls: [
                      {
                        index: 0,
                        id: 'cut-call',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify({ path: 'a.txt', content: '部分' }),
                        },
                      },
                    ],
                  },
                  finishReason: 'length',
                },
              ],
            },
          ])
        : streamFrom([
            { choices: [{ delta: { content: '改为分段处理。' }, finishReason: 'stop' }] },
          ])
    })
    const execute = vi.fn()
    const { result } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [{ role: 'user', content: '写入完整文件' }],
      tools: [{ name: 'write_file', description: '写入', parameters: {} }],
      toolExecutor: { execute },
      source: 'desktop',
    })
    expect(execute).not.toHaveBeenCalled()
    expect(messagesSeen).toHaveLength(2)
    expect(
      messagesSeen[1]?.some(
        (item) => item.role === 'user' && String(item.content).includes('Token'),
      ),
    ).toBe(true)
    expect(messagesSeen[1]?.some((item) => item.toolCalls?.length)).toBe(false)
    expect(messagesSeen[1]?.find((item) => item.role === 'assistant')).toMatchObject({
      reasoningContent: '这是截断前的完整原生思考',
      nativeReasoning: [{ format: 'responses_reasoning', opaque: { id: 'truncated-reasoning' } }],
    })
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ callId: 'cut-call', isError: true }),
    ])
  })

  it('上游反复截断时只给两次续接机会，不无限请求模型', async () => {
    const chatStream = vi.fn(() =>
      streamFrom([{ choices: [{ delta: { content: '部分结果' }, finishReason: 'length' }] }]),
    )
    const { result } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [{ role: 'user', content: '继续完成任务' }],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
    })
    expect(chatStream).toHaveBeenCalledTimes(3)
    expect(
      result.contentBlocks.some((block) => block.kind === 'narration' && block.phase === 'final'),
    ).toBe(true)
  })

  it('思考超出正文额度仍可正常回答，额度不从思考中扣减', async () => {
    const chatStream = vi.fn(() =>
      streamFrom([
        { choices: [{ delta: { reasoningContent: '分析'.repeat(1000) } }] },
        {
          choices: [
            {
              delta: { content: '<think>' + '分析'.repeat(1000) + '</think>OK' },
              finishReason: 'stop',
            },
          ],
        },
      ]),
    )
    const { yields } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig: { ...modelConfig, maxTokens: 8 },
      messages: [{ role: 'user', content: '判断' }],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
    })
    expect(chatStream).toHaveBeenCalledOnce()
    expect(yields.filter((item) => typeof item === 'string').join('')).toBe('OK')
  })

  it('最终回复口语块只交给口语通道，流式正文与持久化内容块保留完整结果', async () => {
    const onSpokenReply = vi.fn()
    const chatStream = vi.fn().mockReturnValue(
      streamFrom([
        { choices: [{ delta: { content: '<think>内部分析</think><spoken_' } }] },
        {
          choices: [
            { delta: { content: 'reply>整理好了。</spoken_reply>完整分析结果，包含所有细节。' } },
          ],
        },
      ]),
    )
    const { yields, result } = await collectLoop({
      llmService: { chatStream } as never,
      modelConfig,
      messages: [{ role: 'user', content: '分析一下' }],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
      onSpokenReply,
    })
    expect(onSpokenReply).toHaveBeenCalledWith('整理好了。')
    expect(yields.filter((item) => typeof item === 'string').join('')).toBe(
      '完整分析结果，包含所有细节。',
    )
    expect(result.contentBlocks.filter((block) => block.kind === 'narration')).toEqual([
      expect.objectContaining({ content: '完整分析结果，包含所有细节。' }),
    ])
  })
  it('每次调用模型前自动滑出超预算的历史，保留当前请求并继续执行', async () => {
    const chatStream = vi.fn(() =>
      streamFrom([{ choices: [{ delta: { content: '继续完成' }, finishReason: 'stop' }] }]),
    )
    const counter = new LlmService()
    const { result } = await collectLoop({
      llmService: {
        chatStream,
        estimateInputTokens: counter.estimateInputTokens.bind(counter),
      } as never,
      modelConfig,
      messages: [
        { role: 'assistant', content: '此前材料'.repeat(500), cacheControl: { kind: 'history' } },
        { role: 'user', content: '继续任务', cacheControl: { kind: 'current' } },
      ],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
      maxInputTokens: 400,
    })
    expect(chatStream).toHaveBeenCalledOnce()
    const call = vi.mocked(chatStream).mock.calls[0] as unknown as [ModelConfig, ChatMessage[]]
    expect(call[1]).toContainEqual(expect.objectContaining({ role: 'user', content: '继续任务' }))
    expect(call[1].some((message) => String(message.content).includes('此前材料'))).toBe(false)
    expect(counter.estimateInputTokens(modelConfig, call[1], { tools: [] })).toBeLessThanOrEqual(
      400,
    )
    expect(result.messages.at(-1)?.content).toBe('继续完成')
  })

  it('容量紧张时较早读取退化为来源，最近读取保留原文且不调用摘要模型', async () => {
    const first = '甲'.repeat(1800)
    const second = '乙'.repeat(300)
    const toolCall = (id: string, path: string): ChatDelta => ({
      choices: [
        {
          delta: {
            toolCalls: [
              {
                index: 0,
                id,
                function: {
                  name: 'read_file_range',
                  arguments: JSON.stringify({ path }),
                },
              },
            ],
          },
        },
      ],
    })
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(streamFrom([toolCall('call-old', 'old.ts')]))
      .mockReturnValueOnce(streamFrom([toolCall('call-new', 'new.ts')]))
      .mockReturnValueOnce(streamFrom([{ choices: [{ delta: { content: '完成' } }] }]))
    const chatText = vi.fn().mockResolvedValue('旧文件 old.ts，callId=call-old；仍需核对来源。')
    const { result } = await collectLoop({
      llmService: { chatStream, chatText } as never,
      agentId: 'pero',
      sessionId: 'file-window',
      modelConfig,
      messages: [{ role: 'user', content: '分析两个文件' }],
      tools: [{ name: 'read_file_range', description: '读取文件范围', parameters: {} }],
      toolExecutor: {
        execute: vi.fn(async (_name, args) => ({
          output: JSON.stringify({
            content: args.path === 'old.ts' ? first : second,
            lineStart: 1,
            lineEnd: 90,
          }),
          durationMs: 1,
          isError: false,
          shouldTerminate: false,
        })),
      },
      source: 'desktop',
      maxInputTokens: 1500,
      config: { maxTurns: 3 },
    })
    expect(chatText).not.toHaveBeenCalled()
    const notice = result.messages.find(
      (item) => item.cacheControl?.key === 'infos.work.sliding-window',
    )
    const ref = String(notice?.content).match(/tool-result:[a-f0-9-]{36}/i)?.[0]
    expect(ref).toBeDefined()
    const previous = readToolObservation(ref!, {
      agentId: 'pero',
      threadId: 'file-window',
      channel: 'desktop',
    })
    expect(previous.content).toContain('old.ts')
    expect(previous.content).toContain(first)
    expect(
      result.messages.some(
        (item) =>
          item.role === 'tool' && typeof item.content === 'string' && item.content.includes(second),
      ),
    ).toBe(true)
    expect(
      result.messages.some(
        (item) =>
          item.role === 'tool' && typeof item.content === 'string' && item.content.includes(first),
      ),
    ).toBe(false)
  })

  it('应将Provider原生思考作为独立Timeline回传并与正文区分', async () => {
    const { yields, result } = await collectLoop({
      llmService: {
        chatStream: vi
          .fn()
          .mockReturnValue(
            streamFrom([
              { choices: [{ delta: { reasoningContent: '原生分析' } }] },
              { choices: [{ delta: { content: '<think>文本思考</think>最终答案' } }] },
            ]),
          ),
      } as never,
      modelConfig: { ...modelConfig, returnNativeReasoning: true },
      messages: [{ role: 'user', content: '分析' }],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
    })

    expect(yields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'native_reasoning_start' }),
        expect.objectContaining({
          event: 'native_reasoning_delta',
          data: expect.objectContaining({ delta: '原生分析' }),
        }),
        expect.objectContaining({ event: 'native_reasoning_end' }),
        expect.objectContaining({ event: 'thinking_start' }),
        expect.objectContaining({
          event: 'thinking_delta',
          data: expect.objectContaining({ delta: '文本思考' }),
        }),
        expect.objectContaining({ event: 'thinking_end' }),
        '最终答案',
      ]),
    )
    expect(result.contentBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'thinking', content: '文本思考' }),
        expect.objectContaining({ kind: 'native_reasoning', content: '原生分析', mode: 'stream' }),
        expect.objectContaining({ kind: 'narration', content: '最终答案' }),
      ]),
    )
  })

  it('原生思考在编辑参数生成前结束，结束通知不等待参数或工具执行完成', async () => {
    let reasoningEnded = false
    let argumentsCompleted = false
    const execute = vi.fn().mockResolvedValue({ output: '修改成功', isError: false, durationMs: 1 })
    const chatStream = vi
      .fn()
      .mockReturnValueOnce(
        (async function* (): AsyncGenerator<ChatDelta> {
          yield { choices: [{ delta: { reasoningContent: '检查后修改文件' } }] }
          yield {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: 0,
                      id: 'edit-1',
                      function: { name: 'edit_file', arguments: '{"file_path":"a.txt",' },
                    },
                  ],
                },
              },
            ],
          }
          expect(reasoningEnded).toBe(true)
          expect(execute).not.toHaveBeenCalled()
          argumentsCompleted = true
          yield {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: 0,
                      function: { arguments: '"new_text":"完成"}' },
                    },
                  ],
                },
                finishReason: 'tool_calls',
              },
            ],
          }
        })(),
      )
      .mockReturnValueOnce(
        streamFrom([{ choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] }]),
      )
    const generator = runReActLoop({
      llmService: { chatStream } as never,
      modelConfig: { ...modelConfig, returnNativeReasoning: true },
      messages: [{ role: 'user', content: '修改文件' }],
      tools: [{ name: 'edit_file', description: '编辑', parameters: {} }],
      toolExecutor: { execute },
      source: 'desktop',
    })
    let endedCount = 0
    let next = await generator.next()
    while (!next.done) {
      if (next.value.event === 'native_reasoning_end') {
        expect(argumentsCompleted).toBe(false)
        reasoningEnded = true
        endedCount++
      }
      next = await generator.next()
    }
    expect(endedCount).toBe(1)
    expect(execute).toHaveBeenCalledOnce()
    expect(next.value.messages.find((message) => message.toolCalls?.length)?.reasoningContent).toBe(
      '检查后修改文件',
    )
  })

  it('同轮原生思考恢复时建立独立展示块，API 续轮仍保留完整推理文本', async () => {
    const { yields, result } = await collectLoop({
      llmService: {
        chatStream: vi.fn(() =>
          streamFrom([
            { choices: [{ delta: { reasoningContent: '第一段思考' } }] },
            { choices: [{ delta: { content: '先核对。' } }] },
            { choices: [{ delta: { reasoningContent: '第二段思考' } }] },
            { choices: [{ delta: { content: '核对完成。' }, finishReason: 'stop' }] },
          ]),
        ),
      } as never,
      modelConfig: { ...modelConfig, returnNativeReasoning: true },
      messages: [{ role: 'user', content: '继续核对' }],
      tools: [],
      toolExecutor: { execute: vi.fn() },
      source: 'desktop',
    })
    const starts = yields.filter(
      (item) => typeof item !== 'string' && item.event === 'native_reasoning_start',
    )
    const ends = yields.filter(
      (item) => typeof item !== 'string' && item.event === 'native_reasoning_end',
    )
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    const blocks = result.contentBlocks.filter((block) => block.kind === 'native_reasoning')
    expect(blocks.map((block) => block.content)).toEqual(['第一段思考', '第二段思考'])
    expect(new Set(blocks.map((block) => block.blockId)).size).toBe(2)
    expect(result.messages.at(-1)?.reasoningContent).toBe('第一段思考第二段思考')
  })

  it.each(['selfMinding', 'think'])('同一轮出现多个 %s 块时应分别流式发布碎碎念', async (tag) => {
    const { yields, result } = await collectLoop({
      llmService: {
        chatStream: vi
          .fn()
          .mockReturnValue(
            streamFrom([
              { choices: [{ delta: { content: `<${tag.slice(0, 3)}` } }] },
              { choices: [{ delta: { content: `${tag.slice(3)}>第一段` } }] },
              { choices: [{ delta: { content: `碎碎念</${tag}>正文` } }] },
              { choices: [{ delta: { content: `<${tag}>第二段</${tag}>结束` } }] },
            ]),
          ),
      } as never,
      modelConfig,
      messages: [{ role: 'user', content: '继续' }],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
    })

    expect(
      yields.filter((item) => typeof item !== 'string' && item.event === 'thinking_start'),
    ).toHaveLength(2)
    expect(
      yields.filter((item) => typeof item !== 'string' && item.event === 'thinking_end'),
    ).toHaveLength(2)
    expect(yields).toEqual(expect.arrayContaining(['正文', '结束']))
    expect(result.contentBlocks.filter((block) => block.kind === 'thinking')).toEqual([
      expect.objectContaining({ content: '第一段碎碎念' }),
      expect.objectContaining({ content: '第二段' }),
    ])
  })

  it('应向Scheduler报告去重后的Token增量和工具I/O用量', async () => {
    const llmService = {
      chatStream: vi.fn().mockReturnValue(
        streamFrom([
          {
            choices: [
              {
                delta: {
                  toolCalls: [
                    {
                      index: 0,
                      id: 'call-usage',
                      function: { name: 'lookup', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          },
          {
            choices: [{ delta: {} }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
        ]),
      ),
    }
    const onUsage = vi.fn()
    const endIo = vi.fn()
    await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [{ role: 'user', content: '查找' }],
      tools: [{ name: 'lookup', description: '查询', parameters: {} }],
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({
          output: '完成',
          durationMs: 1,
          isError: false,
          shouldTerminate: true,
        }),
      },
      source: 'desktop',
      config: { maxTurns: 1 },
      onUsage,
      beginIo: () => endIo,
    })

    expect(onUsage.mock.calls.map((call) => call[0])).toEqual([
      { llmCalls: 1 },
      { inputTokens: 10, outputTokens: 2 },
      { inputTokens: 0, outputTokens: 3 },
      { toolCalls: 1 },
    ])
    expect(endIo).toHaveBeenCalledOnce()
  })

  it('读取工具持久化时只保留审计摘要，不保存文件正文', () => {
    const plain = toolResultForPersistence(
      'read_file',
      { file_path: 'notes/private.md', max_length: 10000 },
      '这是只应存在于当前 ReAct 内存中的私密正文',
      false,
    )
    expect(plain).not.toContain('私密正文')
    expect(JSON.parse(plain)).toEqual({
      ephemeral: true,
      kind: 'file_read_audit',
      path: 'notes/private.md',
      maxLength: 10000,
      returnedCharacters: 24,
    })

    const ranged = toolResultForPersistence(
      'read_file_range',
      { path: 'src/a.ts', line_start: 3, line_end: 5 },
      JSON.stringify({
        content: 'const secret = 1',
        hash: 'abc',
        totalBytes: 99,
        totalLines: 10,
        lineStart: 3,
        lineEnd: 5,
        truncated: true,
      }),
      false,
    )
    expect(ranged).not.toContain('const secret')
    expect(JSON.parse(ranged)).toMatchObject({
      ephemeral: true,
      path: 'src/a.ts',
      hash: 'abc',
      totalLines: 10,
      lineStart: 3,
      lineEnd: 5,
      returnedCharacters: 16,
    })
  })

  it('非读取工具与错误结果保持原样，避免破坏工具审计', () => {
    expect(toolResultForPersistence('edit_file', { path: 'a.ts' }, '{"success":true}', false)).toBe(
      '{"success":true}',
    )
    expect(
      toolResultForPersistence('read_file', { file_path: 'missing' }, '文件不存在', true),
    ).toBe('文件不存在')
  })

  it('应当流式输出文本并过滤 Thinking 内容', async () => {
    const llmService = {
      chatStream: vi.fn().mockReturnValue(
        streamFrom([
          { choices: [{ delta: { content: '你好' }, finishReason: null }] },
          {
            choices: [{ delta: { content: '<think>隐藏思考</think>世界' }, finishReason: null }],
          },
        ]),
      ),
    }

    const { yields, result } = await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '打招呼' },
      ],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
    })

    expect(yields).toEqual([
      expect.objectContaining({
        event: 'status',
        data: expect.objectContaining({ state: 'thinking', turn: 1 }),
      }),
      expect.objectContaining({ event: 'context_budget' }),
      '你好',
      expect.objectContaining({ event: 'thinking_start' }),
      expect.objectContaining({
        event: 'thinking_delta',
        data: expect.objectContaining({ delta: '隐藏思考' }),
      }),
      expect.objectContaining({ event: 'thinking_end' }),
      '世界',
    ])
    // 返回值已改为对象结构 { toolCalls, messages, rawText }，无工具调用时 toolCalls 为空数组
    expect(result.toolCalls).toEqual([])
  })

  it('应当执行流式工具调用并把工具结果追加到上下文', async () => {
    const llmService = {
      chatStream: vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            { choices: [{ delta: { content: '需要查找' }, finishReason: null }] },
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'lookup', arguments: '{"q"' },
                      },
                    ],
                  },
                  finishReason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: { toolCalls: [{ index: 0, function: { arguments: ':"猫"}' } }] },
                  finishReason: null,
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          streamFrom([{ choices: [{ delta: { content: '完成' }, finishReason: null }] }]),
        ),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: '工具结果',
        durationMs: 12,
        isError: false,
        shouldTerminate: false,
      }),
    }
    const messages: ChatMessage[] = [{ role: 'user' as const, content: '查资料' }]

    const { yields, result } = await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages,
      tools: [
        { name: 'lookup', description: '查询', parameters: { type: 'object' } },
        { name: 'finish_task', description: '完成', parameters: { type: 'object' } },
      ],
      toolExecutor,
      source: 'desktop',
      config: { maxTurns: 2 },
    })

    // 第七阶段修复（批次 B1）：execute 第 4 个参数现在是 toolRuntimeContext（含 agentId/sessionId）
    // 测试未传 agentId/threadContext，故 agentId 为 undefined，sessionId 默认 'default'
    const observedTools = llmService.chatStream.mock.calls.map((call) =>
      (
        (call[2] as { tools?: Array<{ type: string; function: { name: string } }> })?.tools ?? []
      ).map((tool: { function: { name: string } }) => tool.function.name),
    )
    expect(observedTools[0]).not.toContain('finish_task')
    expect(observedTools[1]).toContain('finish_task')
    expect(toolExecutor.execute).toHaveBeenCalledWith(
      'lookup',
      { q: '猫' },
      'desktop',
      expect.objectContaining({ sessionId: 'default' }),
    )
    expect(yields).toEqual([
      expect.objectContaining({
        event: 'status',
        data: expect.objectContaining({ state: 'thinking', turn: 1 }),
      }),
      expect.objectContaining({ event: 'context_budget' }),
      '需要查找',
      {
        event: 'tool_call_start',
        data: { draftId: 'tool-draft-1-0', turn: 1, index: 0 },
      },
      expect.objectContaining({ event: 'tool_call_delta' }),
      expect.objectContaining({ event: 'tool_call_delta' }),
      {
        event: 'tool_call_ready',
        data: {
          draftId: 'tool-draft-1-0',
          callId: 'call-1',
          turn: 1,
          name: 'lookup',
          args: { q: '猫' },
        },
      },
      { event: 'tool_call', data: { name: 'lookup', args: { q: '猫' }, callId: 'call-1' } },
      expect.objectContaining({
        event: 'status',
        data: expect.objectContaining({ state: 'calling', turn: 1 }),
      }),
      {
        event: 'tool_result',
        data: {
          name: 'lookup',
          callId: 'call-1',
          result: '工具结果',
          isError: false,
          durationMs: 12,
          automaticApproval: undefined,
        },
      },
      expect.objectContaining({
        event: 'status',
        data: expect.objectContaining({ state: 'thinking', turn: 2 }),
      }),
      expect.objectContaining({ event: 'context_budget' }),
      '完成',
    ])
    expect(messages).toEqual([
      { role: 'user', content: '查资料' },
      {
        role: 'assistant',
        content: '需要查找',
        reasoningContent: '',
        // assistant 消息现在携带 toolCalls 数组（id/type/function 结构）
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"猫"}' },
          },
        ],
      },
      // 工具消息字段从 tool_call_id 改为 toolCallId
      { role: 'tool', content: '工具结果', toolCallId: 'call-1', toolExecutionFailed: false },
      { role: 'assistant', content: '完成', reasoningContent: '' },
    ])
    expect(result.contentBlocks.map((block) => [block.kind, block.sequence])).toEqual([
      ['narration', 1],
      ['tool', 2],
      ['narration', 3],
    ])
    expect(result.contentBlocks).toMatchObject([
      { kind: 'narration', phase: 'progress', content: '需要查找' },
      { kind: 'tool', callId: 'call-1', name: 'lookup', result: '工具结果' },
      { kind: 'narration', phase: 'final', content: '完成' },
    ])
    // 返回值已改为对象结构，工具调用列表在 result.toolCalls 字段
    expect(result.toolCalls).toEqual([
      {
        name: 'lookup',
        args: { q: '猫' },
        result: '工具结果',
        durationMs: 12,
        isError: false,
        callId: 'call-1',
      },
    ])
  })

  it('按行读取后应让同轮ReAct后继轮次看到正文和实际行范围', async () => {
    const rangeResult = JSON.stringify({
      content: '第101行\n第102行',
      totalBytes: 1_000,
      totalLines: 500,
      hash: 'abc',
      truncated: true,
      lineStart: 101,
      lineEnd: 102,
    })
    const llmService = {
      chatStream: vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-read-range',
                        type: 'function',
                        function: {
                          name: 'read_file_range',
                          arguments: '{"path":"src/a.ts","line_start":101,"line_end":102}',
                        },
                      },
                    ],
                  },
                  finishReason: 'tool_calls',
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          streamFrom([{ choices: [{ delta: { content: '读取完成。' }, finishReason: null }] }]),
        ),
    }

    const onToolObserved = vi.fn()
    const { result } = await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [{ role: 'user', content: '读取文件' }],
      tools: [
        {
          name: 'read_file_range',
          description: '按行读取文件',
          parameters: { type: 'object' },
        },
      ],
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({
          output: rangeResult,
          durationMs: 1,
          isError: false,
          shouldTerminate: false,
          metadata: { hash: 'a'.repeat(64) },
        }),
      },
      source: 'desktop',
      config: { maxTurns: 2 },
      onToolObserved,
    })

    expect(llmService.chatStream).toHaveBeenNthCalledWith(
      2,
      modelConfig,
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call-read-range',
          content: rangeResult,
        }),
      ]),
      expect.any(Object),
    )
    expect(result.toolCalls[0]?.result).not.toContain('第101行')
    expect(onToolObserved).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { hash: 'a'.repeat(64) } }),
    )
    expect(JSON.parse(result.toolCalls[0]?.result ?? '{}')).toMatchObject({
      lineStart: 101,
      lineEnd: 102,
      totalLines: 500,
    })
  })

  it('未启用原生思考时工具续轮也应显式回传空reasoning_content', async () => {
    const llmService = {
      chatStream: vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-list',
                        type: 'function',
                        function: { name: 'list_directory', arguments: '{"path":"."}' },
                      },
                    ],
                  },
                  finishReason: 'tool_calls',
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          streamFrom([{ choices: [{ delta: { content: '目录读取完成。' }, finishReason: null }] }]),
        ),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: '[]',
        durationMs: 1,
        isError: false,
        shouldTerminate: false,
      }),
    }

    await collectLoop({
      llmService: llmService as never,
      modelConfig: { ...modelConfig, returnNativeReasoning: false },
      messages: [{ role: 'user', content: '列出目录' }],
      tools: [{ name: 'list_directory', description: '列出目录', parameters: { type: 'object' } }],
      toolExecutor,
      source: 'desktop',
      config: { maxTurns: 2 },
    })

    expect(llmService.chatStream).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoningContent: '',
          toolCalls: [expect.objectContaining({ id: 'call-list' })],
        }),
      ]),
      expect.any(Object),
    )
  })

  it('工具审批拒绝后应在下一轮原样回传思考内容', async () => {
    const llmService = {
      chatStream: vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: { reasoningContent: '用户要求打开应用，我需要调用工具。' },
                  finishReason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-open',
                        type: 'function',
                        function: { name: 'open_application', arguments: '{"name":"calc"}' },
                      },
                    ],
                  },
                  finishReason: 'tool_calls',
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          streamFrom([
            { choices: [{ delta: { content: '已取消打开应用。' }, finishReason: null }] },
          ]),
        ),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: JSON.stringify({ code: 'APPROVAL_DENIED', message: '用户拒绝了本次工具调用' }),
        durationMs: 5,
        isError: true,
        shouldTerminate: false,
      }),
    }

    await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [...expandedDesktopHistory, { role: 'user', content: '打开计算器' }],
      tools: [
        {
          name: 'expand_advanced_tools',
          description: '展开高级工具',
          parameters: { type: 'object' },
        },
        { name: 'open_application', description: '打开应用', parameters: { type: 'object' } },
      ],
      toolExecutor,
      source: 'desktop',
      config: { maxTurns: 2 },
    })

    expect(llmService.chatStream).toHaveBeenNthCalledWith(
      2,
      modelConfig,
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoningContent: '用户要求打开应用，我需要调用工具。',
          toolCalls: [expect.objectContaining({ id: 'call-open' })],
        }),
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call-open',
          content: expect.stringContaining('APPROVAL_DENIED'),
        }),
      ]),
      expect.any(Object),
    )
  })

  it('应当在首轮无有效内容时提示配置问题', async () => {
    const llmService = {
      chatStream: vi
        .fn()
        .mockReturnValue(streamFrom([{ choices: [{ delta: {}, finishReason: null }] }])),
    }

    const { yields } = await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
    })

    expect(llmService.chatStream).toHaveBeenCalledOnce()
    expect(
      yields
        .filter((item) => typeof item === 'string')
        .join('')
        .trim(),
    ).not.toBe('')
  })

  it('应当在取消时跳出循环或跳过工具执行', async () => {
    let cancelled = false
    const llmService = {
      chatStream: vi.fn().mockReturnValue(
        (async function* () {
          for (const chunk of [
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'lookup', arguments: '{}' },
                      },
                    ],
                  },
                  finishReason: null,
                },
              ],
            },
          ]) {
            cancelled = true
            yield chunk
          }
        })(),
      ),
    }
    const toolExecutor = { execute: vi.fn() }
    const cancelChecker = {
      isCancelled: () => cancelled,
    }

    const { result } = await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [{ role: 'user', content: '查找' }],
      tools: [{ name: 'lookup', description: '查询', parameters: {} }],
      toolExecutor,
      source: 'desktop',
      sessionId: 'session-1',
      cancelChecker,
    })

    expect(toolExecutor.execute).not.toHaveBeenCalled()
    // 返回值已改为对象结构，取消时尚未执行工具，toolCalls 为空数组
    expect(result.toolCalls).toEqual([])
  })

  it('应当在连续工具错误达到阈值后禁用后续工具', async () => {
    const llmService = {
      chatStream: vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        // 第七阶段 #8: 参数解析失败时，错误会作为 tool_result 反馈给 LLM，
                        // 而非以空参数调用工具。这里用一个工具执行报错的场景验证熔断。
                        function: { name: 'broken', arguments: '{}' },
                      },
                    ],
                  },
                  finishReason: null,
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          streamFrom([{ choices: [{ delta: { content: '后续' }, finishReason: null }] }]),
        ),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: '失败',
        durationMs: 5,
        isError: true,
        shouldTerminate: false,
      }),
    }
    const messages: ChatMessage[] = [{ role: 'user' as const, content: '执行' }]

    const { result } = await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages,
      tools: [{ name: 'broken', description: '坏工具', parameters: {} }],
      toolExecutor,
      source: 'desktop',
      config: { maxTurns: 2, errorThreshold: 1 },
    })

    // AIOS: execute 现在接收第 4 个参数 threadContext（测试未传，故为 undefined）
    expect(toolExecutor.execute).toHaveBeenCalledWith(
      'broken',
      {},
      'desktop',
      expect.objectContaining({ sessionId: 'default' }),
    )
    expect(llmService.chatStream).toHaveBeenLastCalledWith(modelConfig, expect.any(Array), {
      maxRetries: 5,
      retryPartialResponse: true,
      signal: undefined,
      tools: [],
      usageContext: expect.objectContaining({
        agentId: undefined,
        purpose: 'conversation',
        applicationId: 'infos',
        channel: 'desktop',
        step: 2,
      }),
    })
    expect(messages[messages.length - 1]).toMatchObject({ role: 'assistant', content: '后续' })
    expect(
      messages.some(
        (message) => message.role === 'user' && String(message.content).includes('工具'),
      ),
    ).toBe(true)
    expect(result.toolCalls).toEqual([
      {
        name: 'broken',
        args: {},
        result: '失败',
        durationMs: 5,
        isError: true,
        callId: 'call-1',
      },
    ])
  })

  // 第七阶段 #8: 参数解析失败时，错误作为 tool_result 反馈给 LLM 而非吞掉
  it('应当在工具参数 JSON 解析失败时把错误反馈给 LLM 而不调用工具', async () => {
    const llmService = {
      chatStream: vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        // 故意传入非法 JSON 触发参数解析失败
                        function: { name: 'lookup', arguments: '不是合法JSON' },
                      },
                    ],
                  },
                  finishReason: null,
                },
              ],
            },
          ]),
        )
        // 第二轮：LLM 收到错误反馈后修正参数并正常调用
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-2',
                        type: 'function',
                        function: { name: 'lookup', arguments: '{"q":"修正后的查询"}' },
                      },
                    ],
                  },
                  finishReason: null,
                },
              ],
            },
          ]),
        )
        // 第三轮：工具成功后 LLM 返回最终文本
        .mockReturnValueOnce(
          streamFrom([{ choices: [{ delta: { content: '已修复并完成' }, finishReason: null }] }]),
        ),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: '查询结果',
        durationMs: 8,
        isError: false,
        shouldTerminate: false,
      }),
    }
    const messages: ChatMessage[] = [{ role: 'user' as const, content: '查资料' }]

    const { yields, result } = await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages,
      tools: [{ name: 'lookup', description: '查询', parameters: {} }],
      toolExecutor,
      source: 'desktop',
      config: { maxTurns: 3, errorThreshold: 3 },
    })

    // 关键断言1: 第一轮工具调用因参数解析失败被跳过，execute 不应被调用
    // 只有第二轮（修正后）的工具调用会执行
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1)
    expect(toolExecutor.execute).toHaveBeenCalledWith(
      'lookup',
      { q: '修正后的查询' },
      'desktop',
      expect.objectContaining({ sessionId: 'default' }),
    )

    // 关键断言2: 第一轮产出的 tool_result 是错误消息（包含解析失败原因）
    const toolResultEvents = yields.filter(
      (y) =>
        typeof y === 'object' && y !== null && (y as { event?: string }).event === 'tool_result',
    )
    expect(toolResultEvents).toHaveLength(2)
    const firstResult = toolResultEvents[0] as {
      event: string
      data: { name: string; result: string; isError: boolean; durationMs: number }
    }
    expect(firstResult.data.name).toBe('lookup')
    expect(firstResult.data.isError).toBe(true)
    expect(firstResult.data.durationMs).toBe(0)
    expect(firstResult.data.result).toContain('不是合法JSON')

    // 关键断言3: 错误 tool_result 被追加到 messages，LLM 能在下一轮感知到
    const toolMessages = messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages[0]?.content).toBe(firstResult.data.result)
    expect(toolMessages[0]?.toolCallId).toBe('call-1')

    // 关键断言4: 最终工具调用记录包含两条（第一条是解析失败，第二条是成功执行）
    expect(result.toolCalls).toEqual([
      {
        name: 'lookup',
        args: {},
        result: firstResult.data.result,
        durationMs: 0,
        isError: true,
        callId: 'call-1',
      },
      {
        name: 'lookup',
        args: { q: '修正后的查询' },
        result: '查询结果',
        durationMs: 8,
        isError: false,
        callId: 'call-2',
      },
    ])
  })

  it('模型关闭stream时应使用非流式配置入口并保持统一Delta语义', async () => {
    const llmService = {
      chatStream: vi.fn(),
      chatConfigured: vi.fn().mockReturnValue(
        streamFrom([
          {
            choices: [{ delta: { content: '完整回复' }, finishReason: 'stop' }],
          },
        ]),
      ),
    }

    const { yields, result } = await collectLoop({
      llmService: llmService as never,
      modelConfig: { ...modelConfig, stream: false },
      messages: [{ role: 'user', content: '你好' }],
      tools: undefined,
      toolExecutor: undefined,
      source: 'desktop',
      config: { maxTurns: 1 },
    })

    expect(llmService.chatConfigured).toHaveBeenCalledTimes(1)
    expect(llmService.chatStream).not.toHaveBeenCalled()
    expect(yields).toContain('完整回复')
    expect(result.rawText).toContain('完整回复')
  })

  it.each([false, true])(
    '无视觉或转述失败时仍持久保留截图预览，转述失败=%s',
    async (relayFails) => {
      const preview = {
        id: 'capture-1',
        kind: 'image',
        name: '截图.png',
        mimeType: 'image/png',
        sizeBytes: 100,
      }
      const chatStream = vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'capture-call',
                        function: { name: 'take_screenshot', arguments: '{}' },
                      },
                    ],
                  },
                  finishReason: 'tool_calls',
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          streamFrom([{ choices: [{ delta: { content: '完成' }, finishReason: 'stop' }] }]),
        )
      const { result, yields } = await collectLoop({
        llmService: { chatStream } as never,
        modelConfig: { ...modelConfig, enableVision: false },
        source: 'desktop',
        messages: [{ role: 'user', content: '截图' }],
        tools: [{ name: 'take_screenshot', description: '截图', parameters: {} }],
        transcribeImages: relayFails
          ? async () => {
              throw new Error('转述服务断线')
            }
          : undefined,
        toolExecutor: {
          execute: vi.fn().mockResolvedValue({
            durationMs: 1,
            isError: false,
            output: JSON.stringify({
              message: '说明'.repeat(2000),
              screenshots: [
                { index: 0, dataUri: 'data:image/png;base64,AAAA', imagePreview: preview },
              ],
            }),
          }),
        },
      })
      const output = result.toolCalls.find((call) => call.name === 'take_screenshot')!.result!
      expect(output).not.toContain('base64')
      const value = JSON.parse(output)
      expect(relayFails ? value.images[0].imagePreview : value.screenshots[0].imagePreview).toEqual(
        preview,
      )
      const event = yields.find((item) => typeof item !== 'string' && item.event === 'tool_result')
      expect(
        event &&
          typeof event !== 'string' &&
          event.event === 'tool_result' &&
          JSON.parse((event.data as { result: string }).result),
      ).toEqual(value)
    },
  )

  it('桌面截图应保留坐标上下文并剥离base64', async () => {
    let turn = 0
    const observedMessages: ChatMessage[][] = []
    const llmService = {
      chatStream: vi.fn((_config, messages) => {
        observedMessages.push(messages)
        turn++
        if (turn === 1) {
          return streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'screenshot-1',
                        type: 'function',
                        function: { name: 'take_screenshot', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            },
          ])
        }
        return streamFrom([{ choices: [{ delta: { content: '已看到' } }] }])
      }),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: JSON.stringify({
          success: true,
          screenshots: [
            {
              index: 0,
              dataUri: 'data:image/png;base64,AAAA',
              coordinateContext: {
                displayId: '7',
                coordinateSpace: 'screenshot',
                screenshotWidth: 1280,
                screenshotHeight: 720,
                scaleFactor: 1.5,
              },
            },
          ],
          message: '已截取屏幕',
        }),
        durationMs: 1,
        isError: false,
      }),
    }

    await collectLoop({
      llmService: llmService as never,
      modelConfig: { ...modelConfig, enableVision: true },
      messages: [{ role: 'user', content: '截图' }],
      tools: [{ name: 'take_screenshot', description: '截图', parameters: {} }],
      toolExecutor,
      source: 'desktop',
      config: { maxTurns: 2 },
    })

    const secondTurn = JSON.stringify(observedMessages[1])
    const screenshotResult = observedMessages[1]!.find((message) => message.role === 'tool')!
    expect(
      JSON.parse(String(screenshotResult.content)).screenshots[0].coordinateContext,
    ).toMatchObject({
      coordinateSpace: 'screenshot',
      displayId: '7',
      screenshotWidth: 1280,
      screenshotHeight: 720,
      scaleFactor: 1.5,
    })
    expect(secondTurn).toContain('image_url')
    expect(secondTurn.match(/AAAA/g)).toHaveLength(1)
  })

  it.each(['update_plan', 'manage_task'])(
    '%s 降为普通工具后仍不能单独开放完成入口',
    async (name) => {
      const observed: string[][] = []
      const chatStream = vi.fn((_config, _messages, options) => {
        observed.push(
          (options?.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        )
        return observed.length === 1
          ? streamFrom([
              {
                choices: [
                  {
                    delta: {
                      toolCalls: [
                        {
                          index: 0,
                          id: 'coordination',
                          type: 'function',
                          function: { name, arguments: '{}' },
                        },
                      ],
                    },
                  },
                ],
              },
            ])
          : streamFrom([
              { choices: [{ delta: { content: '继续执行工作' }, finishReason: 'stop' }] },
            ])
      })
      await collectLoop({
        llmService: { chatStream } as never,
        modelConfig,
        messages: [{ role: 'user', content: '继续工作' }],
        tools: [name, 'finish_task'].map((toolName) => ({
          name: toolName,
          description: '工具',
          parameters: {},
        })),
        toolExecutor: {
          execute: vi.fn().mockResolvedValue({
            output: '已同步',
            isError: false,
            shouldTerminate: false,
            durationMs: 1,
          }),
        },
        source: 'desktop',
        config: { maxTurns: 2 },
      })
      expect(observed[1]).toContain(name)
      expect(observed[1]).not.toContain('finish_task')
    },
  )

  it('高级工具应在展开前隐藏，并在展开后的后续轮次持续可用', async () => {
    let call = 0
    const observedTools: string[][] = []
    const llmService = {
      chatStream: vi.fn((_config, _messages, options) => {
        observedTools.push(
          (options?.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        )
        call++
        if (call === 1) {
          return streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'expand-1',
                        type: 'function',
                        function: { name: 'expand_advanced_tools', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            },
          ])
        }
        if (call === 2)
          return streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'browser-call',
                        type: 'function',
                        function: {
                          name: 'browser_open_url',
                          arguments: '{"url":"https://example.com"}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ])
        return streamFrom([{ choices: [{ delta: { content: '已看到高级工具' } }] }])
      }),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: '高级工具列表已展开',
        durationMs: 1,
        isError: false,
      }),
    }

    await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [{ role: 'user', content: '操作网页' }],
      tools: [
        { name: 'finish_task', description: '完成', parameters: {} },
        { name: 'expand_advanced_tools', description: '展开', parameters: {} },
        { name: 'browser_open_url', description: '打开网页', parameters: {} },
        { name: 'automation_execute', description: '桌面操作', parameters: {} },
        { name: 'remote_terminal_nodes', description: '远程节点', parameters: {} },
        { name: 'remote_terminal_create', description: '远程终端', parameters: {} },
        { name: 'take_screenshot', description: '截图', parameters: {} },
        { name: 'web_fetch', description: '读取网页', parameters: {} },
      ],
      toolExecutor,
      source: 'desktop',
      config: { maxTurns: 3 },
    })

    expect(observedTools[0]).toEqual(
      expect.arrayContaining(['expand_advanced_tools', 'take_screenshot', 'web_fetch']),
    )
    expect(observedTools[0]).not.toContain('finish_task')
    for (const name of [
      'browser_open_url',
      'automation_execute',
      'remote_terminal_nodes',
      'remote_terminal_create',
    ])
      expect(observedTools[0]).not.toContain(name)
    expect(observedTools[1]).toEqual(
      expect.arrayContaining([
        'browser_open_url',
        'automation_execute',
        'remote_terminal_nodes',
        'remote_terminal_create',
      ]),
    )
    expect(observedTools[1]).not.toContain('finish_task')
    expect(observedTools[2]).toContain('finish_task')
    expect(observedTools[2]).toEqual(
      expect.arrayContaining([
        'browser_open_url',
        'automation_execute',
        'remote_terminal_nodes',
        'remote_terminal_create',
      ]),
    )
  })

  it('load_skill成功后应刷新下一轮工具定义', async () => {
    const observedTools: string[][] = []
    const llmService = {
      chatStream: vi.fn((_config, _messages, options) => {
        observedTools.push(
          (options?.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        )
        return observedTools.length === 1
          ? streamFrom([
              {
                choices: [
                  {
                    delta: {
                      content: undefined,
                      toolCalls: [
                        {
                          index: 0,
                          id: 'skill-1',
                          type: 'function',
                          function: { name: 'load_skill', arguments: '{"skill_id":"demo"}' },
                        },
                      ],
                    },
                  },
                ],
              },
            ])
          : streamFrom([{ choices: [{ delta: { content: '已加载' } }] }])
      }),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: 'Skill内容',
        durationMs: 1,
        isError: false,
        shouldTerminate: false,
      }),
    }

    await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [{ role: 'user', content: '加载技能' }],
      tools: [{ name: 'load_skill', description: '加载', parameters: { type: 'object' } }],
      refreshToolDefinitions: () => [
        { name: 'load_skill', description: '加载', parameters: { type: 'object' } },
        { name: 'new_tool', description: '新工具', parameters: { type: 'object' } },
      ],
      toolExecutor: toolExecutor as never,
      source: 'desktop',
      sessionId: 's1',
      agentId: 'pero',
    })

    expect(observedTools[0]).toEqual(['load_skill'])
    expect(observedTools[1]).toContain('new_tool')
  })

  it('首轮幻觉调用finish_task时应拒绝执行并要求自然回复', async () => {
    const llmService = {
      chatStream: vi
        .fn()
        .mockReturnValueOnce(
          streamFrom([
            {
              choices: [
                {
                  delta: {
                    toolCalls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'finish_task', arguments: '{"summary":"完成"}' },
                      },
                    ],
                  },
                  finishReason: null,
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(streamFrom([{ choices: [{ delta: { content: '自然回复' } }] }])),
    }
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        output: '完成',
        durationMs: 1,
        isError: false,
        shouldTerminate: true,
      }),
    }

    const { yields, result } = await collectLoop({
      llmService: llmService as never,
      modelConfig,
      messages: [{ role: 'user', content: '完成任务' }],
      tools: [{ name: 'finish_task', description: '结束', parameters: {} }],
      toolExecutor,
      source: 'desktop',
      config: { maxTurns: 5 },
    })

    expect(llmService.chatStream).toHaveBeenCalledTimes(2)
    expect(toolExecutor.execute).not.toHaveBeenCalled()
    expect(yields.filter((item) => typeof item === 'string').join('')).toBe('自然回复')
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: 'finish_task',
        args: { summary: '完成' },
        isError: true,
      }),
    ])
  })
})
