import { describe, expect, it } from 'vitest'
import { validateEventNoteNarrative } from '@infos/backend/services/memory/eventNoteNarrative'

describe('后台事件及历史草稿的记事视角', () => {
  it.each([
    'Pero 和主人约定每周复盘。',
    '用户向助手表达了稳定偏好。',
    '主人说：“我下周要搬家。”',
    '主人告诉我下周要搬家。',
    '“我会记住的。”这是助手的回复。',
    'It was agreed that the user would move next week.',
  ])('拒绝旁观叙述并返回重写说明：%s', (narrative) => {
    expect(() => validateEventNoteNarrative(narrative)).toThrow('请根据真实对话重写后重新调用工具')
  })

  it.each([
    '我和主人约定每周复盘。',
    '我得知小林下周要搬家。',
    '我听主人说，他不喜欢太甜的饮料。',
    'I learned that Lin is moving next week.',
    'I’m going to review the plan with my owner every week, as we agreed.',
  ])('保留合规正文及他人的事实归属：%s', (narrative) => {
    expect(validateEventNoteNarrative(`  ${narrative}\n`)).toBe(narrative)
  })

  it('视角纠正后可提交，空正文返回错误', () => {
    expect(() => validateEventNoteNarrative('  ')).toThrow('事件记叙不能为空')
    expect(() => validateEventNoteNarrative('用户喜欢红茶。')).toThrow('事件记叙视角不符合要求')
    expect(validateEventNoteNarrative('我记住了主人喜欢红茶。')).toBe('我记住了主人喜欢红茶。')
  })
})
