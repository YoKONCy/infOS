import { describe, expect, it, vi } from 'vitest'
import type { SocialMessageRecord, SocialTurnRecord } from '@infos/shared'
import type { Attachment, InboundMessage } from '@infos/social/runtime/types'
import { createSocialImageReader } from '@infos/social/runtime/socialImageReader'
import { runSocialRecovery } from '@infos/social/runtime/socialRecovery'

function fixture(attachments: Attachment[]) {
  const message: InboundMessage = {
    platform: 'qq',
    agentId: 'pero',
    accountId: '10000',
    channelId: '20000',
    channelType: 'group',
    messageId: 'source',
    senderId: '30000',
    senderName: '群友',
    content: '[图片]',
    attachments,
  }
  const row = {
    platform: 'qq',
    agentId: 'pero',
    accountId: '10000',
    channelId: '20000',
    channelType: 'group',
    msgId: 'source',
  } as SocialMessageRecord
  const storage = { getByMsgId: vi.fn(async () => row as SocialMessageRecord | null) }
  const cache = {
    download: vi.fn(async (url: string) => url),
    readAsDataUrl: vi.fn((path: string) => `data:image/png;base64,${path}`),
  }
  const fetchMessage = vi.fn(async () => message as InboundMessage | null)
  const reader = createSocialImageReader(storage, () => message, cache, fetchMessage)
  const record: SocialTurnRecord = {
    id: 'read-images',
    platform: 'qq',
    agentId: 'pero',
    accountId: '10000',
    channelId: '20000',
    channelType: 'group',
    status: 'running',
    attempts: 1,
    checkpoint: {},
    startedAt: '',
    updatedAt: '',
    deadline: '',
  }
  const controller = new AbortController()
  const read = () =>
    runSocialRecovery(
      {
        record,
        signal: controller.signal,
        save: async () => {},
      },
      () => reader.readImages('pero', ['source'], 3),
    )
  return { read, cache, storage, fetchMessage, message, controller }
}

describe('社交按需读图', () => {
  it('一条消息中的多张图片最多读取三张，并返回对应来源', async () => {
    const f = fixture(['YQ==', 'Yg==', 'Yw==', 'ZA=='].map((url) => ({ type: 'image', url })))
    const result = await f.read()
    expect(result.images).toEqual([
      'data:image/png;base64,YQ==',
      'data:image/png;base64,Yg==',
      'data:image/png;base64,Yw==',
    ])
    expect(result.sources).toEqual([
      { message_id: 'source', image_index: 1 },
      { message_id: 'source', image_index: 2 },
      { message_id: 'source', image_index: 3 },
    ])
  })

  it('只有原生表情编号时明确报告没有像素，不编造图片地址', async () => {
    const f = fixture([{ type: 'native_emoji', nativeEmoji: { kind: 'face', faceId: '289' } }])
    expect(await f.read()).toEqual({
      images: [],
      sources: [],
      unavailable: [{ message_id: 'source', reason: 'native_emoji_no_pixels' }],
    })
    expect(f.cache.download).not.toHaveBeenCalled()
  })

  it('未入库的引用从平台按当前范围读取；其他会话的返回不能进入模型', async () => {
    const f = fixture([{ type: 'image', url: 'YQ==' }])
    f.storage.getByMsgId.mockResolvedValue(null)
    expect((await f.read()).images).toEqual(['data:image/png;base64,YQ=='])
    f.cache.download.mockClear()
    f.fetchMessage.mockResolvedValue({ ...f.message, channelId: 'other-group' })
    expect((await f.read()).unavailable).toEqual([{ message_id: 'source', reason: 'not_found' }])
    expect(f.cache.download).not.toHaveBeenCalled()
  })

  it('读图取消直接传播，不会误报图片不存在', async () => {
    const f = fixture([{ type: 'image', url: 'YQ==' }])
    const cancelled = new Error('回合已取消')
    f.cache.download.mockImplementation(async () => {
      f.controller.abort(cancelled)
      return 'YQ=='
    })
    await expect(f.read()).rejects.toBe(cancelled)
    expect(f.cache.readAsDataUrl).not.toHaveBeenCalled()
  })
})
