import { describe, expect, it } from 'vitest'
import {
  completePrefilledContent,
  PrefillContinuationGate,
  unclosedThinkingTag,
} from '@infos/backend/services/prompt/prefillContinuation'

describe('预填充续写判定', () => {
  it('只识别末尾仍未闭合的思考标签', () => {
    expect(unclosedThinkingTag('<selfMinding>')).toBe('selfminding')
    expect(unclosedThinkingTag('<think>\n我')).toBe('think')
    expect(unclosedThinkingTag('<think>想过</think>答：')).toBeUndefined()
    expect(unclosedThinkingTag('我先查看。')).toBeUndefined()
  })

  it('关闭标签跨片段出现时确认续写，并只拼回一次预填充', () => {
    const gate = new PrefillContinuationGate('<selfMinding>')
    // 判定前暂存，不能先把思考文字当正文发出去。
    expect(gate.push('想')).toBe('')
    expect(gate.push('法</selfM')).toBe('')
    expect(gate.push('inding>答')).toBe('<selfMinding>想法</selfMinding>答')
    expect(gate.push('案')).toBe('案')
    expect(gate.finish()).toBe('')
    expect(gate.outcome).toBe('continued')
  })

  it('整段完整答案没有关闭标签：不拼回开标签，原样作为正文', () => {
    const gate = new PrefillContinuationGate('<selfMinding>')
    expect(gate.push('今天天气很好，')).toBe('')
    expect(gate.push('适合出门。')).toBe('')
    expect(gate.finish()).toBe('今天天气很好，适合出门。')
    expect(gate.outcome).toBe('ignored')
  })

  it('上游自己从思考开标签重新开头：不重复拼回', () => {
    expect(completePrefilledContent('<selfMinding>', '<selfMinding>想</selfMinding>答')).toBe(
      '<selfMinding>想</selfMinding>答',
    )
  })

  it('普通文本预填充保持直接拼回；没有正文时不拼回', () => {
    expect(completePrefilledContent('我先查看。', '好了。')).toBe('我先查看。好了。')
    expect(completePrefilledContent('<selfMinding>', '')).toBe('')
    expect(completePrefilledContent('', '答')).toBe('答')
  })

  it('纯工具调用沿用原行为拼回预填充；已有暂存正文时按未续写发布', () => {
    expect(completePrefilledContent('<selfMinding>', '', true)).toBe('<selfMinding>')
    expect(completePrefilledContent('<selfMinding>', '先查一下', true)).toBe('先查一下')
    const gate = new PrefillContinuationGate('<selfMinding>')
    expect(gate.startToolCall()).toBe('<selfMinding>')
    expect(gate.push('后续')).toBe('后续')
  })
})
