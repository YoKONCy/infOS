import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SocialSessionManager,
  type SocialTurnOutcome,
} from '@infos/social/runtime/socialSessionManager'
import type { InboundMessage } from '@infos/social/runtime/types'

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelId: overrides.channelId ?? 'group-1',
    channelType: overrides.channelType ?? 'group',
    senderId: overrides.senderId ?? 'user-1',
    senderName: overrides.senderName ?? '群友',
    content: overrides.content ?? '你好',
    agentId: overrides.agentId ?? 'pero',
    platform: overrides.platform ?? 'qq',
    messageId:
      overrides.messageId ??
      String((overrides.rawEvent as Record<string, unknown> | undefined)?.message_id ?? ''),
    accountId:
      overrides.accountId ??
      String((overrides.rawEvent as Record<string, unknown> | undefined)?.self_id ?? ''),
    isMentioned:
      overrides.isMentioned ??
      (overrides.rawEvent as Record<string, unknown> | undefined)?._isMentioned === true,
    rawEvent: overrides.rawEvent ?? {},
  }
}

describe('SocialSessionManager 单 Agent 状态机', () => {
  afterEach(() => vi.useRealTimers())

  it('明确提及时收集消息并把 Agent 回复提交为 engaged', async () => {
    vi.useFakeTimers()
    const flush = vi.fn<() => Promise<SocialTurnOutcome>>().mockResolvedValue({
      type: 'reply',
      content: '你好呀',
    })
    const manager = new SocialSessionManager(flush as never, { groupCollectTimeout: 1 })

    await manager.handleInbound(message({ rawEvent: { _isMentioned: true } }))
    const session = manager.getActiveSessions('group')[0]!
    expect(session).toMatchObject({ participation: 'listening', phase: 'collecting' })

    await vi.advanceTimersByTimeAsync(1000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(session).toMatchObject({ participation: 'engaged', phase: 'cooldown' })
  })

  it('running 期间的新消息进入下一批而不污染 inFlight', async () => {
    vi.useFakeTimers()
    let resolve!: (value: SocialTurnOutcome) => void
    const flush = vi.fn(() => new Promise<SocialTurnOutcome>((done) => (resolve = done)))
    const manager = new SocialSessionManager(flush, { groupCollectTimeout: 1 })

    await manager.handleInbound(message({ content: '第一条', rawEvent: { _isMentioned: true } }))
    const session = manager.getActiveSessions('group')[0]!
    const running = vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(session.phase).toBe('running'))

    await manager.handleInbound(message({ content: '第二条' }))
    expect(session.inFlightMessages.map((item) => item.content)).toEqual(['第一条'])
    expect(session.pendingMessages.map((item) => item.content)).toEqual(['第二条'])

    resolve({ type: 'pass' })
    await running
    expect(session.pendingMessages.map((item) => item.content)).toEqual(['第二条'])
  })

  it('WAIT 保留当前批次并在等待后交给同一回调重审', async () => {
    vi.useFakeTimers()
    const flush = vi
      .fn<() => Promise<SocialTurnOutcome>>()
      .mockResolvedValueOnce({
        type: 'wait',
        wait: { reason: 'continuation_expected', duration: 'short' },
      })
      .mockResolvedValueOnce({ type: 'pass' })
    const manager = new SocialSessionManager(flush as never, {
      groupCollectTimeout: 1,
      maxCollectionDuration: 10,
    })

    await manager.handleInbound(message({ rawEvent: { _isMentioned: true } }))
    await vi.advanceTimersByTimeAsync(1000)
    const session = manager.getActiveSessions('group')[0]!
    expect(session.phase).toBe('collecting')
    expect(session.pendingMessages).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(4000)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(session.phase).toBe('ready')
    expect(session.pendingMessages).toHaveLength(0)
  })

  it('失败时恢复批次并进入 retrying', async () => {
    vi.useFakeTimers()
    const manager = new SocialSessionManager(
      vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('网络连接失败'), { code: 'NETWORK_ERROR' })),
      {
        groupCollectTimeout: 1,
      },
    )
    await manager.handleInbound(message({ rawEvent: { _isMentioned: true } }))
    await vi.advanceTimersByTimeAsync(1000)

    const session = manager.getActiveSessions('group')[0]!
    expect(session.phase).toBe('retrying')
    expect(session.retryMessages).toHaveLength(1)
    expect(session.pendingMessages).toHaveLength(0)
    expect(session.inFlightMessages).toHaveLength(0)
  })

  it('DEFER 只保存当前会话意图并在到期前不触发', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'))
    const flush = vi.fn<() => Promise<SocialTurnOutcome>>().mockResolvedValue({
      type: 'defer',
      intent: {
        intention: '稍后问问结果',
        timing: 'soon',
        expires: 'one_hour',
      },
    })
    const manager = new SocialSessionManager(flush as never, { privateCollectTimeout: 1 })
    await manager.handleInbound(message({ channelType: 'private', channelId: 'user-1' }))
    await vi.advanceTimersByTimeAsync(1000)

    const session = manager.getActiveSessions('private')[0]!
    expect(session.deferredIntent?.intention).toBe('稍后问问结果')
    expect(manager.dueDeferredIntent(session)).toBeUndefined()
    vi.setSystemTime(session.deferredIntent!.notBefore)
    expect(manager.dueDeferredIntent(session)?.intention).toBe('稍后问问结果')
  })
})
