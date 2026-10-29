import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocialSessionManager } from '@infos/social/runtime/socialSessionManager'
import type { InboundMessage } from '@infos/social/runtime/types'
import {
  StickerService,
  splitStickerSegments,
  type AccountSticker,
} from '@infos/social/runtime/stickerService'
import { setSocialDiaryReaderProvider, socialReadDiaryTool } from '@infos/social/tools'
import { NapcatStickers } from '@infos/social/adapters/napcat/napcatStickers'
import { executeSocialSticker } from '@infos/social/tools/sticker'
import type { SocialStoragePort } from '@infos/shared'
import { SocialTurnEndedError, socialFailure } from '@infos/social/runtime/socialRecovery'

function createMessage(partial: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'napcat',
    channelId: partial.channelId ?? 'group-1',
    channelType: partial.channelType ?? 'group',
    senderId: partial.senderId ?? 'u1',
    senderName: partial.senderName ?? '主人',
    content: partial.content ?? '你好',
    agentId: partial.agentId ?? 'pero',
    accountId:
      partial.accountId ??
      String((partial.rawEvent as Record<string, unknown> | undefined)?.self_id ?? ''),
    messageId:
      partial.messageId ??
      String((partial.rawEvent as Record<string, unknown> | undefined)?.message_id ?? ''),
    isMentioned:
      partial.isMentioned ??
      (partial.rawEvent as Record<string, unknown> | undefined)?._isMentioned === true,
    rawEvent: partial.rawEvent ?? {},
    attachments: partial.attachments,
  }
}

describe('社交日记读取工具', () => {
  afterEach(() => {
    setSocialDiaryReaderProvider(null)
  })

  it('应按当前角色列出日记，并限制数量上限', async () => {
    const list = vi.fn().mockResolvedValue([{ date: '2026-08-27', parts: 2 }])
    setSocialDiaryReaderProvider({ list, read: vi.fn() })

    const output = await socialReadDiaryTool.execute(
      { action: 'list', limit: 999 },
      {
        agentId: 'nana',
        sessionId: 'social-realm',
        source: 'application',
        threadId: 'social-realm',
        channel: 'application',
      },
    )

    expect(list).toHaveBeenCalledWith('nana', 60)
    expect(JSON.parse(String(output))).toEqual({
      success: true,
      entries: [{ date: '2026-08-27', parts: 2 }],
      total: 1,
    })
  })

  it('应读取指定日期并拒绝非法日期', async () => {
    const read = vi.fn().mockResolvedValue({
      date: '2026-08-27',
      parts: 2,
      content: '# 2026-08-27\n\n日记正文',
      truncated: false,
    })
    setSocialDiaryReaderProvider({ list: vi.fn(), read })
    const context = {
      agentId: 'pero',
      sessionId: 'social-realm',
      source: 'application',
      threadId: 'social-realm',
      channel: 'application',
    }

    const output = await socialReadDiaryTool.execute(
      { action: 'read', date: '2026-08-27' },
      context,
    )
    const invalid = await socialReadDiaryTool.execute(
      { action: 'read', date: '../secret' },
      context,
    )

    expect(read).toHaveBeenCalledWith('pero', '2026-08-27')
    expect(JSON.parse(String(output))).toMatchObject({ success: true, parts: 2 })
    expect(JSON.parse(String(invalid)).error).toEqual(expect.any(String))
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('SocialSessionManager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('已结束的网络失败不再外层重试，新私聊可以立即进入下一批', async () => {
    vi.useFakeTimers()
    const failure = new SocialTurnEndedError('OpenAI 网络错误: fetch failed；自动恢复已结束')
    expect(socialFailure(failure).retryable).toBe(false)
    const callback = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ type: 'pass' })
    const manager = new SocialSessionManager(callback, { privateCollectTimeout: 1 })
    await manager.handleInbound(
      createMessage({ channelType: 'private', channelId: 'dm-ended', rawEvent: { message_id: 1 } }),
    )
    await vi.advanceTimersByTimeAsync(1000)
    const session = manager.getActiveSessions('private')[0]!
    expect(session.phase).toBe('failed')
    expect(session.retryMessages).toBeUndefined()
    await manager.handleInbound(
      createMessage({ channelType: 'private', channelId: 'dm-ended', rawEvent: { message_id: 2 } }),
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(session.phase).toBe('ready')
    manager.stop()
  })

  it('应当创建会话并按最近消息时间排序返回活跃会话', async () => {
    vi.useFakeTimers()
    const callback = vi.fn().mockResolvedValue({ type: 'pass' })
    const manager = new SocialSessionManager(callback)

    await manager.handleInbound(createMessage({ channelId: 'old' }))
    vi.advanceTimersByTime(10)
    await manager.handleInbound(createMessage({ channelId: 'new' }))

    const sessions = manager.getActiveSessions('group', 2)

    expect(sessions.map((session) => session.channelId)).toEqual(['new', 'old'])
    expect(manager.getOrCreate(createMessage({ channelId: 'new' }))).toBe(sessions[0])
  })

  it('群聊被提及时进入 listening/collecting，并在收集结束后处理批次', async () => {
    vi.useFakeTimers()
    const callback = vi.fn().mockResolvedValue({ type: 'pass' })
    const manager = new SocialSessionManager(callback, { groupCollectTimeout: 2 })

    await manager.handleInbound(
      createMessage({ rawEvent: { _isMentioned: true }, content: '@pero 第一条' }),
    )
    await manager.handleInbound(createMessage({ content: '第二条' }))
    const session = manager.getActiveSessions('group')[0]!

    expect(session).toMatchObject({ participation: 'listening', phase: 'collecting' })
    expect(session.pendingMessages).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(2000)

    expect(callback).toHaveBeenCalledWith(
      session,
      expect.arrayContaining([expect.objectContaining({ content: '@pero 第一条' })]),
      'direct_timeout',
      expect.any(AbortSignal),
    )
    expect(session.pendingMessages).toEqual([])
  })

  it('私聊始终直接触发，并使用私聊收集时长', async () => {
    vi.useFakeTimers()
    const callback = vi.fn().mockResolvedValue({ type: 'pass' })
    const manager = new SocialSessionManager(callback, { privateCollectTimeout: 1 })

    await manager.handleInbound(createMessage({ channelType: 'private', channelId: 'dm-1' }))
    const session = manager.getActiveSessions('private')[0]!

    expect(session).toMatchObject({ participation: 'listening', phase: 'collecting' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledWith(
      session,
      expect.any(Array),
      'direct_timeout',
      expect.any(AbortSignal),
    )
  })

  it('普通群消息只进入观察窗口，不会按超时或消息数直接唤醒 Agent', async () => {
    vi.useFakeTimers()
    const callback = vi.fn().mockResolvedValue({ type: 'pass' })
    const manager = new SocialSessionManager(callback, { bufferTimeout: 1, maxBufferSize: 2 })

    await manager.handleInbound(createMessage({ channelId: 'g1', content: '一' }))
    await manager.handleInbound(createMessage({ channelId: 'g1', content: '二' }))
    await manager.handleInbound(createMessage({ channelId: 'g1', content: '三' }))
    await vi.advanceTimersByTimeAsync(2000)

    const session = manager.getActiveSessions('group')[0]!
    expect(callback).not.toHaveBeenCalled()
    expect(session.phase).toBe('ready')
    // 观察窗口至少保留默认评估门槛的三条消息，避免容量小于触发门槛。
    expect(session.pendingMessages.map((item) => item.content)).toEqual(['一', '二', '三'])
  })

  it('回复后进入 engaged/cooldown，并在过期后回到 idle/ready', () => {
    vi.useFakeTimers()
    const manager = new SocialSessionManager(vi.fn(), { engagedDuration: 1 })
    const session = manager.getOrCreate(createMessage())

    manager.markReplied(session)
    expect(session).toMatchObject({ participation: 'engaged', phase: 'cooldown' })
    vi.advanceTimersByTime(1001)
    manager.checkActiveExpiry(session)

    expect(session).toMatchObject({ participation: 'idle', phase: 'ready' })
  })

  it('普通群聊续聊在入站前自动过期，旧排队标记不能再次直接唤醒', async () => {
    vi.useFakeTimers()
    const callback = vi.fn().mockResolvedValue({ type: 'pass' })
    const manager = new SocialSessionManager(callback, { engagedDuration: 1 })
    manager.markReplied(manager.getOrCreate(createMessage()))
    vi.advanceTimersByTime(1001)
    await manager.handleInbound(
      createMessage({
        rawEvent: { message_id: 'old', _infosQueuedForReply: true, _infosContinuation: true },
      }),
    )
    await vi.advanceTimersByTimeAsync(25000)
    expect(callback).not.toHaveBeenCalled()
    expect(manager.getActiveSessions('group')[0]?.participation).toBe('idle')
    await manager.handleInbound(
      createMessage({ rawEvent: { message_id: 'at', _isMentioned: true } }),
    )
    await vi.advanceTimersByTimeAsync(6001)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('flush 回调失败时保留批次并进入 retrying', async () => {
    vi.useFakeTimers()
    const callback = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('网络连接失败'), { code: 'NETWORK_ERROR' }))
    const manager = new SocialSessionManager(callback, { maxBufferSize: 1 })

    await manager.handleInbound(
      createMessage({ channelId: 'g3', rawEvent: { _isMentioned: true } }),
    )
    await vi.advanceTimersByTimeAsync(0)
    const session = manager.getActiveSessions('group')[0]!

    expect(callback).toHaveBeenCalled()
    expect(session.phase).toBe('retrying')
    expect(session.retryMessages).toHaveLength(1)
    expect(session.pendingMessages).toHaveLength(0)
  })
})

describe('StickerService', () => {
  const sticker: AccountSticker = {
    id: `s_${'a'.repeat(24)}`,
    description: '猫猫探头 围观',
    url: 'https://example.com/face.gif',
    resourceId: 'res-1',
    md5: 'a'.repeat(32),
    emojiId: '0',
  }
  const provider = () => ({
    list: vi.fn(async (accountId: string) => ({
      stickers: accountId === '1001' ? [{ ...sticker }] : [],
      truncated: false,
    })),
    collect: vi.fn(async () => ({ md5: sticker.md5 })),
    describe: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  })

  it('按账号隔离查询与发送，不能借用其他账号的表情 ID', async () => {
    const service = new StickerService(provider())
    expect((await service.list('1001', '探头 围观')).total).toBe(1)
    expect((await service.list('1002')).total).toBe(0)
    await expect(service.resolve('1002', sticker.id)).rejects.toThrow('不在当前账号收藏')
    expect(await service.resolve('1001', sticker.id)).toMatchObject({
      type: 'sticker',
      url: sticker.url,
    })
  })

  it('保持文字和表情顺序，过滤旧关键词与无效标记', () => {
    expect(splitStickerSegments(`好的 [sticker:${sticker.id}] 再见 [sticker:开心]`)).toEqual([
      { type: 'text', content: '好的' },
      { type: 'sticker', stickerId: sticker.id },
      { type: 'text', content: '再见' },
    ])
    expect(splitStickerSegments('[sticker:不存在]')).toEqual([])
  })

  it('删除后重新同步，不能把未实际删除当作成功', async () => {
    const adapter = provider()
    const service = new StickerService(adapter)
    await expect(service.remove('1001', sticker.id)).rejects.toThrow('尚未确认删除')
    expect(adapter.remove).toHaveBeenCalledWith('1001', sticker)
  })

  it('收藏成功但描述失败时保留成功结果与警告', async () => {
    const adapter = provider()
    adapter.describe.mockRejectedValueOnce(new Error('描述更新失败'))
    const result = await new StickerService(adapter).collect('1001', sticker.url, '探头')
    expect(result.sticker.id).toBe(sticker.id)
    expect(result).toHaveProperty('warning', '已收藏，描述未保存：描述更新失败')
  })

  it('收藏消息必须属于当前账号与当前会话', async () => {
    const adapter = provider()
    const storage = {
      getByMsgId: vi.fn(async () => ({
        platform: 'qq',
        channelId: 'friend-1',
        channelType: 'private',
        accountId: '1002',
        rawEventJson: JSON.stringify({
          self_id: '1002',
          message: [{ type: 'image', data: { url: sticker.url } }],
        }),
      })),
    } as unknown as SocialStoragePort
    const result = JSON.parse(
      await executeSocialSticker(
        new StickerService(adapter),
        storage,
        {
          agentId: 'pero',
          accountId: '1001',
          channelId: 'friend-1',
          channelType: 'private',
        },
        { action: 'collect', message_id: 'msg-1' },
      ),
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe('SOCIAL_MESSAGE_SOURCE_INVALID')
    expect(adapter.collect).not.toHaveBeenCalled()
  })

  it('远程 NapCat 收藏使用远端下载路径和内容 MD5', async () => {
    const md5 = 'b'.repeat(32)
    const file = `Z:\\NapCat\\temp\\${md5}`
    const callApi = vi.fn(async (action: string) => ({
      status: 'ok',
      retcode: 0,
      data:
        action === 'download_file'
          ? { file }
          : action === 'fetch_custom_face_detail'
            ? []
            : { result: 0 },
    }))
    expect(await new NapcatStickers(callApi).collect('1001', sticker.url)).toEqual({ md5 })
    expect(callApi).toHaveBeenCalledWith('add_custom_face', { file, md5 }, 60_000, '1001')
  })

  it('接口外层成功但 QQ 原生操作失败时仍报告错误', async () => {
    const callApi = vi.fn(async () => ({
      status: 'ok',
      retcode: 0,
      data: { result: 1, errMsg: 'QQ 拒绝删除' },
    }))
    await expect(new NapcatStickers(callApi).remove('1001', sticker)).rejects.toThrow('QQ 拒绝删除')
  })

  it('新版收藏详情保留原生资源标识，描述和删除发给同一 QQ 账号', async () => {
    const callApi = vi.fn(async (action: string) => ({
      status: 'ok',
      retcode: 0,
      data:
        action === 'fetch_custom_face_detail'
          ? [
              {
                resId: 'native-resource',
                url: sticker.url,
                md5: sticker.md5,
                emoId: '42',
                desc: '探头',
              },
            ]
          : { result: 0 },
    }))
    const adapter = new NapcatStickers(callApi)
    const result = await adapter.list('1001')
    const item = result.stickers[0]!
    expect(item).toMatchObject({
      resourceId: 'native-resource',
      emojiId: '42',
      description: '探头',
    })
    await adapter.describe('1001', item, '围观')
    await adapter.remove('1001', item)
    expect(callApi).toHaveBeenCalledWith(
      'set_custom_face_desc',
      {
        emoji_id: '42',
        res_id: 'native-resource',
        md5: sticker.md5,
        desc: '围观',
      },
      15_000,
      '1001',
    )
    expect(callApi).toHaveBeenCalledWith(
      'delete_custom_face',
      { res_id: 'native-resource' },
      15_000,
      '1001',
    )
  })

  it('外部表情接口明确拒绝时保留可重试判定与具体原因', async () => {
    const callApi = vi.fn(async () => ({
      status: 'failed',
      retcode: 1404,
      message: '接口暂不可用',
    }))
    await expect(new NapcatStickers(callApi).list('1001')).rejects.toMatchObject({
      code: 'STICKER_PLATFORM_REJECTED',
      rejected: true,
      message: '接口暂不可用',
    })
  })
})
