import { describe, expect, it, vi } from 'vitest'
import type { SocialMessageRecord, SocialStoragePort } from '@infos/shared'
import { NativeEmojiService } from '@infos/social/adapters/napcat/nativeEmoji'
import {
  cleanCQCodes,
  extractAttachments,
  segmentsToCQString,
  toOneBotSegments,
} from '@infos/social/adapters/napcat/napcatParser'
import { splitStickerSegments } from '@infos/social/runtime/stickerService'

describe('QQ 原生与收藏表情边界', () => {
  it('收藏表情使用下划线子类型，原生系统与商城表情分别发送', () => {
    expect(
      toOneBotSegments('', [{ type: 'sticker', url: 'https://example.test/a.gif' }])[0]?.data,
    ).toEqual({ file: 'https://example.test/a.gif', sub_type: 1, summary: '[表情]' })
    const attachments = extractAttachments([
      { type: 'face', data: { id: '14' } },
      {
        type: 'image',
        data: {
          emoji_id: 'a'.repeat(32),
          emoji_package_id: 1234,
          key: 'private-key',
          summary: '学习',
        },
      },
    ])
    expect(cleanCQCodes('[CQ:face,id=14]')).toBe('[QQ表情:14]')
    const native = attachments.map((item) => ({ ...item, type: 'native_emoji' as const }))
    expect(toOneBotSegments('', native).map((item) => item.type)).toEqual(['face', 'mface'])
    expect(splitStickerSegments('你好[native_emoji:123:2]再见')).toEqual([
      { type: 'text', content: '你好' },
      { type: 'native_emoji', reference: '123:2' },
      { type: 'text', content: '再见' },
    ])
  })
  it('模型目录不包含平台密钥，原始来源删除后记住的引用自动失效', async () => {
    const scope = {
      agentId: 'keromi',
      accountId: '123456',
      channelId: '234567',
      channelType: 'private' as const,
    }
    let row: SocialMessageRecord | null = {
      ...scope,
      platform: 'qq',
      msgId: '12',
      rawEventJson: JSON.stringify({
        message: [
          {
            type: 'mface',
            data: {
              emoji_id: 'b'.repeat(32),
              emoji_package_id: 2345,
              key: 'private-key',
              summary: '招手',
            },
          },
        ],
      }),
    } as SocialMessageRecord
    const storage = {
      getByMsgId: vi.fn(async () => row),
      getRecent: vi.fn(async () => (row ? [row] : [])),
    } as unknown as SocialStoragePort
    const data = new Map<string, string>()
    const service = new NativeEmojiService(storage, {
      get: async (key) => data.get(key),
      set: async (key, value) => {
        data.set(key, value)
      },
    })
    const another = { ...scope, channelId: '345678', channelType: 'group' as const }
    await expect(service.resolve(another, '12:1')).rejects.toMatchObject({ rejected: true })
    await service.remember(scope, '12:1', '打招呼')
    expect((await service.resolve(another, '12:1')).type).toBe('native_emoji')
    expect(JSON.stringify(await service.list(scope))).not.toContain('private-key')
    expect([...data.values()].join('')).not.toContain('private-key')
    expect((await service.resolve(scope, '12:1')).nativeEmoji?.key).toBe('private-key')
    row = null
    expect((await service.list(scope)).emojis).toEqual([])
    await expect(service.resolve(scope, '12:1')).rejects.toMatchObject({ rejected: true })
  })
  it('带方括号的商城表情摘要不会截断 CQ 清洗并泄露后续密钥', () => {
    const text = cleanCQCodes(
      segmentsToCQString([
        {
          type: 'image',
          data: {
            summary: '[学习]',
            file: 'a.gif',
            key: 'private-key',
            emoji_id: 'a'.repeat(32),
            emoji_package_id: 1234,
          },
        },
      ]),
    )
    expect(text).toBe('[学习]')
    expect(text).not.toContain('private-key')
    expect(
      cleanCQCodes(
        segmentsToCQString([
          {
            type: 'mface',
            data: {
              summary: '[招手]',
              key: 'private-key',
              emoji_id: 'a'.repeat(32),
              emoji_package_id: 1234,
            },
          },
        ]),
      ),
    ).toBe('[QQ商城表情]')
  })
})
