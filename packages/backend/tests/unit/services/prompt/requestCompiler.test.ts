import { describe, expect, it } from 'vitest'
import { ASSISTANT_PREFILL_KEY, parseAssistantPrefillConfig } from '@infos/shared'
import {
  auditModelRequestMessages,
  compileModelRequest,
  compilePromptPlan,
} from '@infos/backend/services/prompt/requestCompiler'
import type { ChatMessage } from '@infos/backend/services/llm/types'

describe('模型请求编译策略', () => {
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
