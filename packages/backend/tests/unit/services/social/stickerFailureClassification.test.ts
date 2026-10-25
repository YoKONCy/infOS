import { describe, expect, it, vi } from 'vitest'
import type { SocialStoragePort } from '@infos/shared'
import type { StickerService } from '@infos/social/runtime/stickerService'
import { executeSocialSticker } from '@infos/social/tools/sticker'
import { NapcatStickers } from '@infos/social/adapters/napcat/napcatStickers'

const scope = {
  agentId: 'keromi',
  accountId: '123456',
  channelId: '234567',
  channelType: 'private' as const,
}

describe('收藏表情失败与核验语义', () => {
  it('无图片的来源属于前置拒绝，不会变成写入结果未知', async () => {
    const collect = vi.fn()
    const service = { collect } as unknown as StickerService
    const storage = {
      getByMsgId: vi.fn(async () => ({
        platform: 'qq',
        accountId: scope.accountId,
        channelId: scope.channelId,
        channelType: scope.channelType,
        rawEventJson: JSON.stringify({ message: [{ type: 'face', data: { id: 14 } }] }),
      })),
    } as unknown as SocialStoragePort
    const result = JSON.parse(
      await executeSocialSticker(service, storage, scope, { action: 'collect', message_id: '11' }),
    )
    expect(result).toMatchObject({
      success: false,
      rejected: true,
      uncertain: false,
      stage: 'preflight',
    })
    expect(result.error).toContain('当前平台提供的表情能力')
    expect(collect).not.toHaveBeenCalled()
  })
  it('核验列表显式刷新，不沿用缓存', async () => {
    const list = vi.fn(async () => ({ stickers: [], total: 0 }))
    const service = { list } as unknown as StickerService
    await executeSocialSticker(service, {} as SocialStoragePort, scope, {
      action: 'list',
      refresh: true,
    })
    expect(list).toHaveBeenCalledWith('123456', '', 0, 20, true)
  })
  it('下载失败明确未收藏；平台拒绝与提交后断线分开处理', async () => {
    const md5 = 'a'.repeat(32)
    const api = vi.fn(async (action: string) => {
      if (action === 'download_file')
        return { status: 'ok', retcode: 0, data: { file: `C:/temp/${md5}.gif` } }
      if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: [] }
      return { status: 'failed', retcode: 1400, message: 'QQ 拒绝收藏' }
    })
    const provider = new NapcatStickers(api)
    await expect(provider.collect('123456', 'https://example.test/a.gif')).rejects.toMatchObject({
      rejected: true,
      stage: 'add_custom_face',
    })
    api.mockImplementation(async (action) => {
      if (action === 'download_file')
        return { status: 'ok', retcode: 0, data: { file: `C:/temp/${md5}` } }
      if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: [] }
      throw new Error('连接中断')
    })
    await expect(provider.collect('123456', 'https://example.test/a.gif')).rejects.toMatchObject({
      uncertain: true,
      rejected: false,
      stage: 'add_custom_face',
    })
    api.mockRejectedValue(new Error('下载失败'))
    await expect(provider.collect('123456', 'https://example.test/a.gif')).rejects.toMatchObject({
      rejected: true,
      uncertain: false,
      stage: 'download_file',
    })
  })
})
