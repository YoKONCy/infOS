import { describe, expect, it } from 'vitest'
import {
  createWorldbookEntry,
  exportWorldbookFile,
  importSillyTavernWorldbook,
  normalizeWorldbookBinding,
  normalizeWorldbookEntries,
  normalizeWorldbookKeys,
  normalizeWorldbookSettings,
  type Worldbook,
} from '../src/worldbook'

describe('世界书结构归一化', () => {
  it('收敛非法字段，重复或空 ID 重新编号，关键词去重去空白', () => {
    const entries = normalizeWorldbookEntries([
      {
        id: 'a',
        light: 'unknown',
        position: 'top',
        probability: 150,
        keys: ' x, y ,x,',
      },
      { id: 'a', role: 'narrator', order: '12', channels: ['desktop', 'mars'] },
      { content: 42 },
      'bad',
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'entry-2', 'entry-3', 'entry-4'])
    expect(entries[0]).toMatchObject({ light: 'keyword', probability: 100, keys: ['x', 'y'] })
    // 旧版的插入位置字段不再保留。
    expect(entries[0]).not.toHaveProperty('position')
    expect(entries[1]).toMatchObject({ order: 12, channels: ['desktop'] })
    expect(entries[2]!.content).toBe('')
    expect(normalizeWorldbookKeys(['  ', 'a', 'a', 3])).toEqual(['a'])
  })

  it('设置与绑定只保留合法 ID，主要世界书不重复出现在附加列表', () => {
    expect(
      normalizeWorldbookSettings({ scanDepth: 'x', globalBooks: ['ok', '../bad', 'ok'] }),
    ).toEqual({
      scanDepth: 2,
      tokenBudget: 0,
      globalBooks: ['ok'],
    })
    expect(normalizeWorldbookBinding({ primary: 'a', additional: ['a', 'b', 'b', '/x'] })).toEqual({
      primary: 'a',
      additional: ['b'],
    })
    expect(normalizeWorldbookBinding({ primary: '' }).primary).toBeNull()
  })
})

describe('酒馆世界书导入导出', () => {
  it('转换独立世界书的蓝绿灯、顺序、概率与粘滞，位置统一并统计降级项', () => {
    const result = importSillyTavernWorldbook({
      entries: {
        '0': {
          key: ['剑'],
          comment: '武器',
          content: '一把剑',
          order: 5,
          position: 1,
          probability: 40,
          useProbability: true,
        },
        '1': { key: [], constant: true, content: '常驻', position: 0, disable: true },
        '2': {
          key: ['/龙.+/i'],
          keysecondary: ['火'],
          selective: true,
          content: '龙',
          position: 4,
          depth: 2,
          role: 2,
          sticky: 3,
        },
        '3': { key: ['作者注'], content: '注释位置', position: 2 },
      },
    })
    expect(result.entries).toMatchObject([
      {
        title: '武器',
        light: 'keyword',
        keys: ['剑'],
        order: 5,
        probability: 40,
        enabled: true,
      },
      { light: 'constant', enabled: false },
      // 酒馆粘滞 3 条消息折算为 2 轮。
      { sticky: 2 },
      { content: '注释位置' },
    ])
    expect(result.warnings).toEqual({
      secondary_keys_ignored: 1,
      regex_keys_literal: 1,
      position_unified: 3,
    })
  })

  it('读取角色卡内嵌的 character_book', () => {
    const result = importSillyTavernWorldbook({
      spec: 'chara_card_v2',
      data: {
        character_book: {
          name: '角色书',
          entries: [
            {
              keys: ['猫'],
              content: '喵',
              enabled: true,
              insertion_order: 7,
              position: 'before_char',
              extensions: { depth: 4, probability: 100 },
            },
          ],
        },
      },
    })
    expect(result.name).toBe('角色书')
    expect(result.entries[0]).toMatchObject({ keys: ['猫'], order: 7 })
    expect(result.warnings).toEqual({ position_unified: 1 })
  })

  it('导出为酒馆格式后再导入保持一致，非世界书 JSON 报错', () => {
    const book: Worldbook = {
      version: 1,
      id: 'wb-1',
      name: '往返',
      revision: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          ...createWorldbookEntry('a'),
          title: 'A',
          keys: ['k'],
          content: 'c',
          probability: 30,
          sticky: 2,
          channels: ['group'],
        },
        {
          ...createWorldbookEntry('b'),
          light: 'constant',
          enabled: false,
        },
      ],
    }
    const exported = exportWorldbookFile(book)
    const imported = importSillyTavernWorldbook(JSON.parse(JSON.stringify(exported)))
    expect(imported.name).toBe('往返')
    expect(imported.entries.map(({ id: _id, ...entry }) => entry)).toEqual(
      book.entries.map(({ id: _id, ...entry }) => entry),
    )
    // 本应用导出的文件带 infosChannels，再次导入时不计入位置警告。
    expect(imported.warnings).toEqual({})
    expect(exported.entries['0']).toMatchObject({ position: 4, depth: 1, role: 0 })
    expect(() => importSillyTavernWorldbook({ prompts: [] })).toThrow('WORLDBOOK_IMPORT_INVALID')
  })
})
