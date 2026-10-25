import { describe, expect, it } from 'vitest'
import { createWorldbookEntry, type WorldbookEntry } from '@infos/shared'
import {
  activateWorldbook,
  worldbookChannelOf,
  type WorldbookActivationInput,
} from '@infos/backend/services/worldbook/worldbookEngine'

const entry = (id: string, patch: Partial<WorldbookEntry> = {}): WorldbookEntry => ({
  ...createWorldbookEntry(id),
  content: `${id} 内容`,
  ...patch,
})
const input = (texts: string[], patch: Partial<WorldbookActivationInput> = {}) => ({
  messages: texts.map((content, index) => ({
    role: index % 2 === texts.length % 2 ? 'assistant' : 'user',
    content,
  })),
  channel: 'desktop' as const,
  charName: 'Pero',
  userName: '小明',
  seed: 'seed',
  ...patch,
})
const settings = { scanDepth: 2, tokenBudget: 0 }
const run = (
  entries: WorldbookEntry[],
  texts: string[],
  patch: Partial<WorldbookActivationInput> = {},
) => activateWorldbook([{ bookId: 'b', entries }], settings, input(texts, patch))

describe('世界书激活引擎', () => {
  it('蓝灯常驻，绿灯按关键词忽略大小写命中，关闭的条目不生效', () => {
    const result = run(
      [
        entry('blue', { light: 'constant' }),
        entry('green', { keys: ['Magic'] }),
        entry('miss', { keys: ['龙'] }),
        entry('off', { light: 'constant', enabled: false }),
      ],
      ['我想学 magic'],
    )
    expect(result.hits.map((hit) => [hit.entryId, hit.reason, hit.keyword])).toEqual([
      ['blue', 'constant', undefined],
      ['green', 'keyword', 'Magic'],
    ])
    expect(result.content).toBe('blue 内容\n\ngreen 内容')
  })

  it('只扫描最近 N 条消息，关键词不跨消息拼接', () => {
    const entries = [entry('old', { keys: ['旧事'] }), entry('split', { keys: ['ab'] })]
    expect(run(entries, ['旧事', '回答', '新问题']).hits).toEqual([])
    expect(run(entries, ['a', 'b']).hits).toEqual([])
    expect(run(entries, ['回答旧事', '新问题']).hits.map((hit) => hit.entryId)).toEqual(['old'])
  })

  it('持续轮数向前多扫描对应轮次，并标记为粘滞', () => {
    const sticky = entry('sticky', { keys: ['城堡'], sticky: 1 })
    const texts = ['去城堡', '好的', '然后呢', '继续']
    expect(run([sticky], texts).hits[0]).toMatchObject({ reason: 'sticky', keyword: '城堡' })
    expect(run([{ ...sticky, sticky: 0 }], texts).hits).toEqual([])
    expect(run([sticky], ['去城堡', '好的', '然后呢', '继续', '再来', '好']).hits).toEqual([])
  })

  it('按生效场景过滤，未选择场景时全部生效', () => {
    const entries = [
      entry('all', { light: 'constant' }),
      entry('group', { light: 'constant', channels: ['social_group'] }),
    ]
    expect(run(entries, ['x']).hits.map((hit) => hit.entryId)).toEqual(['all'])
    expect(run(entries, ['x'], { channel: 'social_group' }).hits.map((hit) => hit.entryId)).toEqual(
      ['all', 'group'],
    )
  })

  it('替换名字宏，所有条目按顺序数合并为一段', () => {
    const result = run(
      [
        entry('late', { light: 'constant', order: 20, content: '{{char}} 认识 {{ USER }}' }),
        entry('early', { light: 'constant', order: 10 }),
      ],
      ['x'],
    )
    expect(result.content).toBe('early 内容\n\nPero 认识 小明')
    expect(result.hits.map((hit) => hit.entryId)).toEqual(['early', 'late'])
  })

  it('Token 预算与酒馆一致：蓝灯优先，其次顺序数大者优先，用尽后其余全部舍弃', () => {
    const long = '很长的内容'.repeat(40)
    const run = (budget: number) =>
      activateWorldbook(
        [
          {
            bookId: 'b',
            entries: [
              entry('green-low', { keys: ['x'], order: 10 }),
              entry('blue', { light: 'constant', order: 50 }),
              entry('green-high', { keys: ['x'], order: 90 }),
              entry('green-long', { keys: ['x'], order: 70, content: long }),
            ],
          },
        ],
        { scanDepth: 2, tokenBudget: budget },
        input(['x']),
      )
    const limited = run(20)
    expect(limited.hits.map((hit) => hit.entryId)).toEqual(['blue', 'green-high'])
    expect(limited.dropped).toEqual(['b/green-long', 'b/green-low'])
    expect(limited.tokens).toBeLessThanOrEqual(20)
    // 不限预算时全部注入，并按顺序数从小到大排列。
    expect(run(0).hits.map((hit) => hit.entryId)).toEqual([
      'green-low',
      'blue',
      'green-long',
      'green-high',
    ])
  })

  it('绿灯概率按触发消息判定：扫描与粘滞期间结果一致，未通过的不会在粘滞期补上', () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry(`p${index}`, { keys: ['城堡'], sticky: 1, probability: 50 }),
    )
    const ids = (texts: string[], seed: string) =>
      run(entries, texts, { seed }).hits.map((hit) => hit.entryId)
    const triggered = ids(['去城堡'], 'turn-1')
    expect(triggered.length).toBeGreaterThan(0)
    expect(triggered.length).toBeLessThan(40)
    // 同一条触发消息：下一轮仍在扫描范围内、再下一轮进入粘滞，命中集合都不变。
    expect(ids(['去城堡', '好的'], 'turn-2')).toEqual(triggered)
    expect(ids(['去城堡', '好的', '然后呢', '继续'], 'turn-3')).toEqual(triggered)
    const never = run(
      [entry('never', { keys: ['城堡'], sticky: 1, probability: 0 })],
      ['去城堡', '好的', '然后呢'],
    )
    expect(never.hits).toEqual([])
  })

  it('触发概率由种子决定：同一种子稳定，0 永不触发，100 总是触发', () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry(`p${index}`, { light: 'constant', probability: 50 }),
    )
    const first = run(entries, ['x'], { seed: 'turn-1' })
    expect(run(entries, ['x'], { seed: 'turn-1' })).toEqual(first)
    expect(first.hits.length).toBeGreaterThan(0)
    expect(first.skipped.length).toBeGreaterThan(0)
    expect(first.hits.length + first.skipped.length).toBe(40)
    const never = run([entry('never', { light: 'constant', probability: 0 })], ['x'])
    expect(never.hits).toEqual([])
    expect(never.skipped).toEqual(['b/never'])
  })

  it('多本书合并时保持书的先后，相同顺序数不互相覆盖', () => {
    const result = activateWorldbook(
      [
        { bookId: 'global', entries: [entry('same', { light: 'constant' })] },
        { bookId: 'role', entries: [entry('same', { light: 'constant', content: '角色' })] },
      ],
      settings,
      input(['x']),
    )
    expect(result.hits.map((hit) => `${hit.bookId}/${hit.entryId}`)).toEqual([
      'global/same',
      'role/same',
    ])
    expect(result.content).toBe('same 内容\n\n角色')
  })

  it('只读取文本内容，并把频道映射为世界书场景', () => {
    const result = run([entry('img', { keys: ['猫'] })], [], {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:猫' } },
            { type: 'text', text: '一只猫' },
          ],
        },
      ],
    })
    expect(result.hits).toHaveLength(1)
    expect(worldbookChannelOf('desktop', false)).toBe('desktop')
    expect(worldbookChannelOf('group', false)).toBe('group')
    expect(worldbookChannelOf('social', true)).toBe('social_group')
    expect(worldbookChannelOf('social', false)).toBe('social_private')
    expect(worldbookChannelOf('task', false)).toBeUndefined()
  })
})
