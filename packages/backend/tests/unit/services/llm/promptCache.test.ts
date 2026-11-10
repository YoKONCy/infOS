import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../../../src/services/llm/types'
import {
  canonicalTools,
  appendPromptSnapshot,
  historyKey,
  invalidatePromptReplay,
  clearPromptReplay,
  promptReplayGeneration,
  preparePromptReplay,
  promptReplayHistoryStart,
  promptFingerprint,
  stableHistoryWindow,
  trimOldestPromptRound,
} from '../../../../src/services/llm/promptCache'
import { OpenAiProvider } from '../../../../src/services/llm/providers/openaiProvider'
import { desktopCheckpointMessages } from '../../../../src/services/agent/reactLoop'
import { bindDynamicContext, compileModelRequest } from '../../../../src/services/prompt/requestCompiler'

afterEach(() => {
  invalidatePromptReplay()
  vi.useRealTimers()
})

const system: ChatMessage = { role: 'system', content: '固定人格与协议' }
function current(content: string): ChatMessage {
  const message: ChatMessage = { role: 'user', content }
  message.cacheControl = { kind: 'current', currentKeys: [historyKey(message)] }
  return message
}
function history(message: ChatMessage): ChatMessage {
  return { ...message, cacheControl: { kind: 'history', key: historyKey(message) } }
}
function snapshot(content: string): ChatMessage {
  return { role: 'user', content }
}

function stored(id: number, role: 'user' | 'assistant', content = `正文${id}`): ChatMessage {
  return {
    role,
    content,
    cacheControl: { kind: 'history', key: `${id}:${content}`, historyMessageId: id },
  }
}

function persistedCurrent(id: number): ChatMessage {
  const key = `${id}:正文${id}`
  return {
    role: 'user',
    content: `正文${id}`,
    cacheControl: {
      kind: 'current',
      currentKeys: [key],
      replayAnchor: { key, messageId: id },
    },
  }
}

function wire(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(({ cacheControl: _cache, ...message }) => message)
}

describe('工作窗口跨轮续接', () => {
  it('阶段清理阻止当前会话的旧缓存提交，持久执行的隐私代次独立计数', () => {
    const scope = 'desktop:pero:clear-context'
    const generation = promptReplayGeneration()
    const input = [system, current('第一条输入')]
    const first = preparePromptReplay(scope, input, { model: '模型' })
    clearPromptReplay(scope)
    first.commit([...first.messages, { role: 'assistant', content: '旧执行回复' }], '旧执行回复')
    expect(promptReplayGeneration()).toBe(generation)
    const next = preparePromptReplay(scope, [system, history(input[1]!),
      history({ role: 'assistant', content: '旧执行回复' }), current('新输入')], { model: '模型' })
    expect(next.reused).toBe(false)
    expect(next.messages.map((message) => message.content)).toEqual(['固定人格与协议', '第一条输入', '旧执行回复', '新输入'])
  })

  it('前移动态资料时继续复用规范轨迹，已发送的更早前缀保持一致', () => {
    const scope = 'desktop:pero:dynamic-depth-replay'
    const fixed: ChatMessage = { ...system, promptPlan: { dynamicContextDepth: 1 } }
    const dynamic = (content: string): ChatMessage => ({
      role: 'user', content,
      cacheControl: { kind: 'snapshot', key: 'prompt-slot:turn_context' },
    })
    const firstInput = [fixed, stored(1, 'user'), stored(2, 'assistant'), dynamic('状态一'), persistedCurrent(3)]
    bindDynamicContext(firstInput, 1, '1:正文1')
    const first = preparePromptReplay(scope, firstInput, { model: '模型', depth: 1 })
    const trace: ChatMessage[] = [...first.messages, { role: 'assistant', content: '正文4' }]
    const firstWire = compileModelRequest(trace, 0).messages
    first.commit(trace, '正文4')
    const nextInput = [
      fixed, stored(1, 'user'), stored(2, 'assistant'), stored(3, 'user'),
      stored(4, 'assistant'), dynamic('状态二'), persistedCurrent(5),
    ]
    bindDynamicContext(nextInput, 1, '3:正文3')
    const next = preparePromptReplay(scope, nextInput, { model: '模型', depth: 1 })
    expect(next.reused).toBe(true)
    const nextWire = compileModelRequest(next.messages, 0).messages
    expect(wire(nextWire.slice(0, 4))).toEqual(wire(firstWire.slice(0, 4)))
    expect(nextWire[4]?.content).toContain('状态二')
    expect(nextWire[5]?.content).toBe('正文3')
    expect(nextWire[6]?.content).toBe('正文4')
    expect(nextWire.at(-1)?.content).toBe('正文5')
    expect(next.messages.slice(0, trace.length).map((message) => message.content)).toEqual(
      trace.map((message) => message.content),
    )
  })

  it('裁剪后固定起点，连续追加保持已发送前缀，再次裁剪才前移且不补回旧材料', () => {
    const scope = 'desktop:pero:stable-work-window'
    const rows = Array.from({ length: 10 }, (_, index) =>
      stored(index + 1, index % 2 === 0 ? 'user' : 'assistant'),
    )
    const first = preparePromptReplay(
      scope,
      [system, ...rows.slice(0, 4), snapshot('旧执行状态'), persistedCurrent(5)],
      '模型',
    )
    // 模拟逐请求滑窗已移除第一个完整对话对，提交实际保留的投影。
    const trimmed: ChatMessage[] = [
      system,
      ...first.messages.slice(3),
      { role: 'assistant', content: '正文6' },
    ]
    first.commit(trimmed, '正文6')
    expect(promptReplayHistoryStart(scope)).toBe(3)

    const second = preparePromptReplay(
      scope,
      [system, ...rows.slice(0, 6), persistedCurrent(7)],
      '模型',
    )
    expect(second.reused).toBe(true)
    expect(wire(second.messages.slice(0, trimmed.length))).toEqual(wire(trimmed))
    expect(second.messages.some((message) => message.content === '正文1')).toBe(false)
    second.commit([...second.messages, { role: 'assistant', content: '正文8' }], '正文8')
    expect(promptReplayHistoryStart(scope)).toBe(3)

    const third = preparePromptReplay(
      scope,
      [system, ...rows.slice(2, 8), persistedCurrent(9)],
      '模型',
    )
    expect(third.reused).toBe(true)
    const moved = third.messages.filter(
      (message) => !['3:正文3', '4:正文4'].includes(message.cacheControl?.replayAnchor?.key ?? ''),
    )
    third.commit([...moved, { role: 'assistant', content: '正文10' }], '正文10')
    expect(promptReplayHistoryStart(scope)).toBe(5)
    const fourth = preparePromptReplay(scope, [system, ...rows.slice(2), persistedCurrent(11)], '模型')
    expect(fourth.reused).toBe(true)
    expect(wire(fourth.messages.slice(0, moved.length))).toEqual(wire(moved))
    expect(fourth.messages.some((message) => message.content === '正文3')).toBe(false)
  })

  it('输入滑出后仍校验保留回复的来源', () => {
    const scope = 'desktop:pero:reply-anchor'
    const first = preparePromptReplay(scope, [system, persistedCurrent(1)], '模型')
    first.commit([...first.messages, { role: 'assistant', content: '正文2' }], '正文2')
    const second = preparePromptReplay(
      scope,
      [system, stored(1, 'user'), stored(2, 'assistant'), persistedCurrent(3)],
      '模型',
    )
    expect(second.reused).toBe(true)
    second.commit(
      [
        ...second.messages.filter((message) => message.content !== '正文1'),
        { role: 'assistant', content: '正文4' },
      ],
      '正文4',
    )
    expect(promptReplayHistoryStart(scope)).toBe(1)
    const next = preparePromptReplay(
      scope,
      [
        system,
        stored(1, 'user', '编辑后的输入'),
        stored(2, 'assistant'),
        stored(3, 'user'),
        stored(4, 'assistant'),
        persistedCurrent(5),
      ],
      '模型',
    )
    expect(next.reused).toBe(false)
    expect(next.messages.some((message) => message.content === '编辑后的输入')).toBe(true)
  })

  it.each(['编辑', '撤回', '模型', '权限', '失效'])('固定窗口遇到%s时重新编译', (change) => {
    const scope = 'desktop:pero:changed-window'
    const rows = [stored(1, 'user'), stored(2, 'assistant'), stored(3, 'user'), stored(4, 'assistant')]
    const identity = { model: '一', tools: ['read_file'] }
    const first = preparePromptReplay(
      scope,
      [system, ...rows, snapshot('旧执行细节'), persistedCurrent(5)],
      identity,
    )
    first.commit([system, ...first.messages.slice(3), { role: 'assistant', content: '正文6' }], '正文6')
    if (change === '失效') {
      invalidatePromptReplay('changed-window')
      expect(promptReplayHistoryStart(scope)).toBeUndefined()
    }
    const retained = [
      stored(3, 'user'),
      stored(4, 'assistant'),
      stored(5, 'user'),
      stored(6, 'assistant'),
    ]
    if (change === '编辑') retained[0] = stored(3, 'user', '修改后的正文')
    if (change === '撤回') retained.splice(1, 1)
    const next = preparePromptReplay(scope, [system, ...retained, persistedCurrent(7)], {
      model: change === '模型' ? '二' : '一',
      tools: change === '权限' ? [] : ['read_file'],
    })
    expect(next.reused).toBe(false)
    expect(next.messages.some((message) => message.content === '旧执行细节')).toBe(false)
  })

  it('读取起点不消费缓存，过期后恢复冷窗口', () => {
    vi.useFakeTimers()
    const scope = 'desktop:pero:window-expiry'
    const replay = preparePromptReplay(scope, [system, persistedCurrent(42)], '模型')
    replay.commit([...replay.messages, { role: 'assistant', content: '完成' }], '完成')
    expect(promptReplayHistoryStart(scope)).toBe(42)
    expect(promptReplayHistoryStart(scope)).toBe(42)
    vi.advanceTimersByTime(31 * 60_000)
    expect(promptReplayHistoryStart(scope)).toBeUndefined()
  })
})

describe('跨轮提示词前缀', () => {
  it('多条已送达文字与表情作为完整消息组续接，不与第一条回复错误比较', () => {
    const user = current('发三条')
    const first = preparePromptReplay('social:multi-delivery', [system, user], '模型')
    const trace: ChatMessage[] = [
      ...first.messages,
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'act',
            type: 'function',
            function: { name: 'social_act', arguments: '{"reply":"第一条"}' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'act', content: '{"status":"completed"}' },
    ]
    const replies: ChatMessage[] = ['第一条', '[native_emoji:12:1]', '第三条'].map((content) => ({
      role: 'assistant',
      content,
    }))
    first.commit(
      trace,
      replies.map((reply) => reply.content).join('\n'),
      replies.map((reply) => ({
        key: historyKey(reply),
        reply: String(reply.content),
      })),
    )
    const next = preparePromptReplay(
      'social:multi-delivery',
      [system, history(user), ...replies.map(history), current('继续')],
      '模型',
    )
    expect(next.reused).toBe(true)
    expect(next.messages.slice(0, trace.length)).toEqual(trace)
    expect(next.messages.at(-1)?.content).toBe('继续')
  })

  it('消息组部分删除或改写后退出热轨迹，不补回已删除内容', () => {
    const user = current('发两条')
    const first = preparePromptReplay('social:changed-delivery', [system, user], '模型')
    const a: ChatMessage = { role: 'assistant', content: '第一条' }
    const b: ChatMessage = { role: 'assistant', content: '第二条' }
    first.commit(
      [...first.messages, a, b],
      '第一条\n第二条',
      [a, b].map((reply) => ({
        key: historyKey(reply),
        reply: String(reply.content),
      })),
    )
    const next = preparePromptReplay(
      'social:changed-delivery',
      [system, history(user), history(a), current('继续')],
      '模型',
    )
    expect(next.reused).toBe(false)
    expect(next.reason).toContain('消息组')
    expect(next.messages.some((message) => message.content === '第二条')).toBe(false)
  })

  it('动态状态相同不重复注入，变化时只在尾部追加', () => {
    const messages: ChatMessage[] = [system, current('处理任务')]
    expect(appendPromptSnapshot(messages, 'infos.work.execution-state', '终端一')).toBe(true)
    const prefix = structuredClone(messages)
    expect(appendPromptSnapshot(messages, 'infos.work.execution-state', '终端一')).toBe(false)
    expect(messages).toEqual(prefix)
    expect(appendPromptSnapshot(messages, 'infos.work.execution-state', '终端二')).toBe(true)
    expect(messages.slice(0, prefix.length)).toEqual(prefix)
    expect(messages.at(-1)?.content).toBe('终端二')
  })

  it('落盘轨迹展开成多条工具消息后仍按来源续接真实前缀及媒体', () => {
    const user = current('读取文件')
    const first = preparePromptReplay('desktop:pero:expanded', [system, user], '模型')
    const image: ChatMessage = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }
    const trace: ChatMessage[] = [...first.messages, image, { role: 'assistant', content: '完成' }]
    first.commit(trace, '完成')
    const key = historyKey({ role: 'assistant', content: '完成' })
    const source = (index: number): ChatMessage['cacheControl'] => ({
      kind: 'history',
      historySourceKey: key,
      key: `${key}:work:${index}`,
    })
    const next = preparePromptReplay(
      'desktop:pero:expanded',
      [
        system,
        {
          ...history(user),
          cacheControl: {
            kind: 'history',
            historySourceKey: historyKey(user),
            key: `${historyKey(user)}:work:input`,
          },
        },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'old', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
          cacheControl: source(0),
        },
        { role: 'tool', toolCallId: 'old', content: '已保存正文', cacheControl: source(1) },
        { role: 'assistant', content: '完成', cacheControl: source(2) },
        snapshot('新状态'),
        current('继续'),
      ],
      '模型',
    )
    expect(next.reused).toBe(true)
    expect(next.messages.slice(0, trace.length)).toEqual(trace)
    expect(next.messages.at(-1)?.content).toBe('继续')
    expect(next.messages.filter((message) => message.toolCallId === 'old')).toHaveLength(0)
    expect(JSON.stringify(next.messages)).toContain('base64,AAAA')
  })

  it('追加快照时保留真实工具调用、结果和原生思考，并校验原始历史', () => {
    const user = current('读取文件')
    const first = preparePromptReplay(
      'desktop:pero:t1',
      [system, snapshot('时间一'), user],
      '模型一',
    )
    const trace: ChatMessage[] = [
      ...first.messages,
      {
        role: 'assistant',
        content: null,
        reasoningContent: '读取所需片段',
        nativeReasoning: [{ format: 'reasoning_details', opaque: { signature: '签名' } }],
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'call-1', content: '运行期读取正文' },
      { role: 'assistant', content: '已读取' },
    ]
    first.commit(trace, '已读取')
    const second = preparePromptReplay(
      'desktop:pero:t1',
      [
        system,
        history(user),
        history({ role: 'assistant', content: '已读取' }),
        snapshot('时间二'),
        current('继续'),
      ],
      '模型一',
    )
    expect(second.reused).toBe(true)
    expect(second.messages.slice(0, trace.length)).toEqual(trace)
    expect(second.messages.at(-1)?.content).toBe('继续')
    expect(second.messages.filter((message) => message.content === '时间二')).toHaveLength(1)
    expect(second.messages.find((message) => message.toolCalls)?.nativeReasoning).toEqual(
      trace[3]?.nativeReasoning,
    )
  })

  it.each(['编辑', '模型', '权限', '删除', '过期'])('%s 后重新编译', (change) => {
    vi.useFakeTimers()
    const user = current('原消息')
    const first = preparePromptReplay('desktop:pero:t2', [system, snapshot('旧快照'), user], {
      model: '一',
      tools: ['read'],
    })
    first.commit([...first.messages, { role: 'assistant', content: '完成' }], '完成')
    if (change === '删除') invalidatePromptReplay('t2')
    if (change === '过期') vi.advanceTimersByTime(31 * 60_000)
    const next = preparePromptReplay(
      'desktop:pero:t2',
      [
        system,
        history(change === '编辑' ? { role: 'user', content: '新消息' } : user),
        history({ role: 'assistant', content: '完成' }),
        snapshot('新快照'),
        current('下一轮'),
      ],
      {
        model: change === '模型' ? '二' : '一',
        tools: change === '权限' ? [] : ['read'],
      },
    )
    expect(next.reused).toBe(false)
    expect(next.messages.some((message) => message.content === '旧快照')).toBe(false)
  })

  it('永久删除后，在飞的旧运行也不能重新提交热轨迹', () => {
    const user = current('原消息')
    const first = preparePromptReplay('desktop:pero:t3', [system, user], '一')
    invalidatePromptReplay()
    first.commit([...first.messages, { role: 'assistant', content: '完成' }], '完成')
    expect(
      preparePromptReplay(
        'desktop:pero:t3',
        [system, history(user), history({ role: 'assistant', content: '完成' }), current('继续')],
        '一',
      ).reused,
    ).toBe(false)
  })

  it('账号和应用作用域不共享轨迹，本地标记不会发往 Provider', () => {
    const user = current('读取')
    const first = preparePromptReplay('social:账号甲:群', [system, user], '一')
    first.commit([...first.messages, { role: 'assistant', content: '完成' }], '完成')
    const input = [
      system,
      history(user),
      history({ role: 'assistant', content: '完成' }),
      current('继续'),
    ]
    expect(preparePromptReplay('social:账号乙:群', input, '一').reused).toBe(false)
    const provider = new OpenAiProvider({
      apiKey: '',
      apiBase: 'https://example.invalid',
      modelId: 'test',
    })
    expect(JSON.stringify(provider.getInputTokenPayload(input, {}))).not.toContain('cacheControl')
  })
})

describe('确定性菜单与整轮裁剪', () => {
  it('检查点保留工具关联及完整正文，原图仍由附件引用恢复', () => {
    const messages: ChatMessage[] = [
      system,
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: '读取',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: 'tool', toolCallId: '读取', content: '需要跨轮保留的正文' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '来源 a.png' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,RAW_PIXELS' } },
        ],
      },
    ]
    const saved = desktopCheckpointMessages(messages)
    expect(JSON.stringify(saved)).toContain('需要跨轮保留的正文')
    expect(JSON.stringify(saved)).not.toContain('RAW_PIXELS')
    expect(saved[2]?.toolCallId).toBe('读取')
    expect(JSON.stringify(saved)).toContain('a.txt')
    expect(messages[2]?.content).toBe('需要跨轮保留的正文')
  })
  it('工具注册顺序和参数对象键序不改变序列化，数组与调用参数不被重排', () => {
    const a: ToolDefinition = {
      type: 'function',
      function: {
        name: 'a',
        description: '甲',
        parameters: {
          type: 'object',
          properties: { z: { type: 'string' }, a: { type: 'string' } },
        },
      },
    }
    const b: ToolDefinition = {
      type: 'function',
      function: { name: 'b', description: '乙', parameters: {} },
    }
    const reordered: ToolDefinition = {
      ...a,
      function: {
        ...a.function,
        parameters: {
          properties: { a: { type: 'string' }, z: { type: 'string' } },
          type: 'object',
        },
      },
    }
    expect(JSON.stringify(canonicalTools([b, a]))).toBe(
      JSON.stringify(canonicalTools([reordered, b])),
    )
    expect(promptFingerprint([1, 2])).not.toBe(promptFingerprint([2, 1]))
  })

  it('窗口批量释放空间，之后的几轮保持起点不变', () => {
    expect(stableHistoryWindow('窗口', ['1', '2', '3', '4', '5'], 4, String)).toEqual([
      '3',
      '4',
      '5',
    ])
    expect(stableHistoryWindow('窗口', ['2', '3', '4', '5', '6'], 4, String)).toEqual([
      '3',
      '4',
      '5',
      '6',
    ])
    expect(stableHistoryWindow('窗口', ['3', '4', '5', '6', '7'], 4, String)).toEqual([
      '5',
      '6',
      '7',
    ])
  })

  it('超限移除完整工具链，保留当前快照和请求', () => {
    const messages: ChatMessage[] = [
      system,
      { ...snapshot('旧快照'), cacheControl: { kind: 'snapshot', turnStart: true } },
      current('旧请求'),
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: '旧调用', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', toolCallId: '旧调用', content: '旧正文' },
      { role: 'assistant', content: '旧回复' },
      { ...snapshot('新快照'), cacheControl: { kind: 'snapshot', turnStart: true } },
      current('新请求'),
    ]
    expect(trimOldestPromptRound(messages)).toBe(true)
    expect(messages.map((message) => message.content)).toEqual([
      '固定人格与协议',
      '新快照',
      '新请求',
    ])
    expect(trimOldestPromptRound(messages)).toBe(false)
  })
})
