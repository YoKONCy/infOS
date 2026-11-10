import { describe, expect, it } from 'vitest'
import { ASSISTANT_PREFILL_KEY, parseAssistantPrefillConfig, parseDynamicContextDepth } from '@infos/shared'
import {
  auditModelRequestMessages,
  compileModelRequest,
  compilePromptPlan,
  bindDynamicContext,
} from '@infos/backend/services/prompt/requestCompiler'
import type { ChatMessage } from '@infos/backend/services/llm/types'

describe('模型请求编译策略', () => {
  function dynamicInput(): ChatMessage[] {
    return [
      { role: 'system', content: '固定规则', promptPlan: { dynamicContextDepth: 1 } },
      { role: 'user', content: '上轮输入', cacheControl: { kind: 'history', key: 'user-one' } },
      {
        role: 'assistant', content: null, reasoningContent: '原始思考',
        toolCalls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        cacheControl: { kind: 'history', key: 'reply-one:work:0', historySourceKey: 'reply-one' },
      },
      { role: 'tool', toolCallId: 'read', content: '工具结果' },
      { role: 'assistant', content: '上轮回复' },
      { role: 'user', content: '本轮状态', cacheControl: { kind: 'snapshot', key: 'prompt-slot:turn_context' } },
      { role: 'user', content: '插件资料', cacheControl: { kind: 'snapshot', key: 'context-region:plugin' } },
      {
        role: 'user',
        content: [{ type: 'text', text: '本轮输入' }, { type: 'image_url', image_url: { url: 'attachment:image' } }],
        cacheControl: { kind: 'current', currentKeys: ['user-two'] },
      },
      { role: 'user', content: '运行中状态', cacheControl: { kind: 'snapshot', key: 'infos.work.execution-state' } },
    ]
  }

  it('按用户来源前移最新资料，完整工具组、附件和运行中状态保持原位', () => {
    const messages = dynamicInput()
    messages[5]!.cacheControl = {
      kind: 'snapshot', key: 'prompt-slot:renamed-dynamic', dynamicContext: true,
    }
    bindDynamicContext(messages, 1, 'user-one')
    const before = structuredClone(messages)
    const request = compileModelRequest(messages, 0).messages
    expect(request[1]?.content).toContain('本轮状态')
    expect(request[2]?.content).toContain('插件资料')
    expect(request[3]).toEqual(messages[1])
    expect(request.slice(4, 7)).toEqual(messages.slice(2, 5))
    expect(request.slice(7)).toEqual(messages.slice(7))
    expect(messages).toEqual(before)
    expect(compileModelRequest(request, 1).messages).toEqual(request)
  })

  it('默认深度和缺失的上一轮锚点均保留本轮位置', () => {
    expect(parseDynamicContextDepth()).toBe(0)
    expect(parseDynamicContextDepth('1')).toBe(1)
    expect(parseDynamicContextDepth('2')).toBe(0)
    const messages = dynamicInput()
    bindDynamicContext(messages, 0, 'user-one')
    expect(compileModelRequest(messages, 0, {}).messages).toEqual(messages)
    bindDynamicContext(messages, 1)
    expect(compileModelRequest(messages, 0).messages).toEqual(messages)
    bindDynamicContext(messages, 1, '已经滑出的来源')
    expect(compileModelRequest(messages, 0).messages).toEqual(messages)
  })

  it('深度和预填充独立编译，整轮请求沿用同一份策略', () => {
    const plan = compilePromptPlan({ enabled: true, content: '我先', mode: 'continuous' }, 1)
    const messages = dynamicInput()
    bindDynamicContext(messages, 1, 'user-one')
    const first = compileModelRequest(messages, 0, plan)
    const next = compileModelRequest(messages, 2, plan)
    expect(first.messages).toEqual(next.messages)
    expect(first.messages[1]?.content).toContain('本轮状态')
    expect(first.messages.at(-1)?.content).toBe('我先')
    expect(plan.dynamicContextDepth).toBe(1)
  })

  it('调试剥离内联媒体字节，保留远程引用且不修改模型输入', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
          { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
          { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } },
        ],
      },
    ]
    const snapshot = auditModelRequestMessages(messages)
    expect(JSON.stringify(snapshot)).not.toContain('aGVsbG8=')
    expect(JSON.stringify(snapshot)).toContain('https://example.test/image.png')
    expect(JSON.stringify(messages)).toContain('aGVsbG8=')
  })

  it('旧配置迁移为单次，无效配置不启用，模式必须在枚举内', () => {
    expect(parseAssistantPrefillConfig('{"enabled":true,"content":"我"}')).toEqual({
      enabled: true,
      content: '我',
      mode: 'once',
    })
    expect(
      compilePromptPlan(
        parseAssistantPrefillConfig('{"enabled":true,"content":"我","mode":"invalid"}'),
      ),
    ).toEqual({})
    expect(compilePromptPlan({ enabled: false, content: '我', mode: 'continuous' })).toEqual({})
  })

  it.each(['once', 'continuous'] as const)(
    '编译计划保留空白、来源和策略，历史不写入残缺 assistant：%s',
    (mode) => {
      const plan = compilePromptPlan({ enabled: true, content: '<think>\n我', mode })
      expect(plan.assistantPrefill?.source).toBe(ASSISTANT_PREFILL_KEY)
      const messages: ChatMessage[] = [
        { role: 'system', content: '规则', promptPlan: plan },
        { role: 'user', content: '你好' },
      ]
      const before = structuredClone(messages)
      expect(compileModelRequest(messages, 0).messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: '<think>\n我',
        promptSegment: 'assistant_prefill',
      })
      expect(compileModelRequest(messages, 2).prefill).toBe(
        mode === 'continuous' ? '<think>\n我' : '',
      )
      expect(
        compileModelRequest(messages, 0).messages.filter((item) => item.promptSegment),
      ).toHaveLength(1)
      expect(messages).toEqual(before)
    },
  )
})
