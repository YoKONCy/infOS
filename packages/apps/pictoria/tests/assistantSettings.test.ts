import { describe, expect, it } from 'vitest'
import {
  assistantSettingsSchema,
  assistantRequestParameters,
  defaultAssistantSettings,
} from '../src/assistantSettings'

describe('助手生成参数', () => {
  it('默认不覆盖供应商参数，明确填写的零值仍发送', () => {
    expect(assistantRequestParameters(defaultAssistantSettings())).toEqual({})
    expect(
      assistantRequestParameters(
        {
          ...defaultAssistantSettings(),
          generation: { temperature: 0, topP: 0, maxTokens: 2048, reasoningEffort: 'off' },
        },
        'local-model',
      ),
    ).toEqual({ temperature: 0, top_p: 0, max_tokens: 2048, reasoning_effort: 'none' })
  })
  it('原生推理模型使用总输出额度字段，不同时发送两个长度参数', () => {
    expect(
      assistantRequestParameters(
        { ...defaultAssistantSettings(), generation: { maxTokens: 4096 } },
        'gpt-5',
      ),
    ).toEqual({ max_completion_tokens: 4096 })
  })
  it('拒绝非法数值和无法处理的上下文预算', () => {
    expect(assistantSettingsSchema.safeParse({ generation: { temperature: 2.1 } }).success).toBe(
      false,
    )
    expect(assistantSettingsSchema.safeParse({ generation: { topP: -0.1 } }).success).toBe(false)
    expect(assistantSettingsSchema.safeParse({ generation: { maxTokens: 0 } }).success).toBe(false)
    expect(
      assistantSettingsSchema.safeParse({ historyMessages: 0, contextCharacters: 64000 }).success,
    ).toBe(true)
    expect(assistantSettingsSchema.safeParse({ contextCharacters: 64001 }).success).toBe(false)
  })
})
