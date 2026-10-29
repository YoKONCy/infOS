import { AbstractSocialAdapter } from '@infos/social/adapters/ISocialAdapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SocialBridge } from '@infos/social/runtime/socialBridge'
import type { InboundMessage } from '@infos/social/runtime/types'
import { currentSocialRecovery, socialFailure } from '@infos/social/runtime/socialRecovery'
import { SocialLoopGuard, normalizeLoopPolicy } from '@infos/social/runtime/socialLoopGuard'
import type { SocialTurnRecord } from '@infos/shared'

class FakeAdapter extends AbstractSocialAdapter {
  accept(message: InboundMessage) {
    return this.deliverMessage(message)
  }
  platform = 'napcat'
  connect = vi.fn(() => Promise.resolve())
  disconnect = vi.fn(() => Promise.resolve())
  sendMessage = vi.fn(() => Promise.resolve())
  getStatus = vi.fn(() => Promise.resolve({ platform: 'napcat', connected: true, latencyMs: 0 }))
  getConnectedAccountIds = vi.fn((): string[] => [])
  getContacts = vi.fn(() => Promise.resolve([]))
  getGroups = vi.fn(() => Promise.resolve([]))
  getContactInfo = vi.fn(() =>
    Promise.resolve({ id: 'contact', name: '联系人', platform: 'napcat' }),
  )
  getGroupInfo = vi.fn(() => Promise.resolve({ id: 'contact', name: '联系人', platform: 'napcat' }))
  getGroupMembers = vi.fn(() => Promise.resolve([]))
  handleFriendRequest = vi.fn(() => Promise.resolve())
  removeFriend = vi.fn(() => Promise.resolve())
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'napcat',
    channelId: 'group-1',
    channelType: 'group',
    senderId: 'u1',
    senderName: '群友',
    content: '你好',
    agentId: 'pero',
    accountId:
      overrides.accountId ??
      String((overrides.rawEvent as Record<string, unknown> | undefined)?.self_id ?? '123456789'),
    messageId:
      overrides.messageId ??
      String((overrides.rawEvent as Record<string, unknown> | undefined)?.message_id ?? '123'),
    isMentioned:
      overrides.isMentioned ??
      (overrides.rawEvent as Record<string, unknown> | undefined)?._isMentioned === true,
    rawEvent: { message_id: 123 },
    ...overrides,
  }
}

function createBridge(overrides: Record<string, unknown> = {}) {
  const deps = {
    generateReply: vi.fn(() => Promise.resolve({ type: 'reply' as const, content: '好的' })),
    socialEvents: { publish: vi.fn(() => Promise.resolve()) },
    socialMessageRepo: {
      insert: vi.fn(() => Promise.resolve()),
      getRecentChannels: vi.fn(() => Promise.resolve([])),
      getRecentChannelsForPlatform: vi.fn(() => Promise.resolve([])),
      getByMsgId: vi.fn().mockResolvedValue(null),
      getRecent: vi.fn().mockResolvedValue([]),
      memoryAvailable: vi.fn().mockResolvedValue(true),
      getTurn: vi.fn().mockResolvedValue(null),
      saveTurn: vi.fn(async (_record: SocialTurnRecord) => {}),
      getDataVersion: vi.fn().mockResolvedValue(0),
      completeQueuedMessages: vi.fn().mockResolvedValue(undefined),
      queuedMessages: vi.fn().mockResolvedValue([]),
      listRecoverableTurns: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  }
  return { bridge: new SocialBridge(deps as never), deps }
}

function executeTurn(
  bridge: SocialBridge,
  messages: InboundMessage[],
  signal = new AbortController().signal,
) {
  const first = messages[0]!
  return (
    bridge as unknown as {
      executeReply(
        session: unknown,
        messages: InboundMessage[],
        reason: 'proactive_review',
        signal: AbortSignal,
      ): Promise<unknown>
    }
  ).executeReply(
    {
      platform: first.platform,
      accountId: first.accountId,
      channelId: first.channelId,
      channelType: first.channelType,
      agentId: first.agentId,
      participation: 'idle',
      phase: 'running',
    },
    messages,
    'proactive_review',
    signal,
  )
}

describe('SocialBridge 单 Agent 社交链路', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('启动先恢复低活跃，普通消息与时间不会唤醒，只有所属账号可手动恢复', async () => {
    const values = new Map([
      [
        'social.groupActivity',
        JSON.stringify({
          '["napcat","pero","123456789","group-1"]': {
            mode: 'mention_only',
            passCount: 4,
            reviewNotBefore: 0,
          },
        }),
      ],
    ])
    const { bridge, deps } = createBridge({
      activityConfig: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: string) => {
          values.set(key, value)
        },
      },
      getAgentId: () => 'pero',
    })
    const adapter = new FakeAdapter()
    adapter.getConnectedAccountIds.mockReturnValue(['123456789'])
    vi.spyOn(adapter, 'resolveAgentId').mockReturnValue('pero')
    bridge.registerAdapter(adapter)
    bridge.updateSchedulerConfig({ nightSilenceEnabled: false })
    await bridge.start()
    try {
      for (let index = 0; index < 3; index++) {
        await adapter.accept(inbound({ messageId: `ordinary-${index}` }))
        await vi.advanceTimersByTimeAsync(1)
      }
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(deps.generateReply).not.toHaveBeenCalled()
      expect(bridge.getGroupState('pero', '123456789', 'group-1', 'napcat')).toMatchObject({
        activityMode: 'mention_only',
        consecutivePasses: 4,
        nextReviewAt: null,
        gate: 'mention_only',
      })
      await expect(
        bridge.resumeGroupObservation('pero', 'napcat', 'other-account', 'group-1'),
      ).rejects.toThrow('SOCIAL_ACCOUNT_FORBIDDEN')
      await bridge.resumeGroupObservation('pero', 'napcat', '123456789', 'group-1')
      // 正常观察至少等待 180 秒，到期后最多再等一轮 10 秒扫描。
      await vi.advanceTimersByTimeAsync(179_999)
      expect(deps.generateReply).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_001)
      expect(
        deps.generateReply,
        JSON.stringify(bridge.getGroupState('pero', '123456789', 'group-1', 'napcat')),
      ).toHaveBeenCalledTimes(1)
      expect(bridge.getGroupState('pero', '123456789', 'group-1', 'napcat')).toMatchObject({
        activityMode: 'normal',
        consecutivePasses: 0,
      })
    } finally {
      await bridge.stop()
    }
  })

  it('参与状态读取失败时不连接适配器，避免用默认模式启动群观察', async () => {
    const { bridge } = createBridge({
      activityConfig: {
        get: async () => '{invalid-json',
        set: async () => undefined,
      },
    })
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter)
    await expect(bridge.start()).rejects.toThrow()
    expect(adapter.connect).not.toHaveBeenCalled()
    await bridge.stop()
  })

  it('接收确认等待持久化成功，但不等待后续会话处理', async () => {
    const { bridge, deps } = createBridge()
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter)
    await bridge.start()
    let persist!: () => void
    deps.socialMessageRepo.insert.mockReturnValue(
      new Promise<void>((resolve) => {
        persist = resolve
      }),
    )
    let continueProcessing!: () => void
    vi.spyOn(
      bridge as unknown as { handleOrchestrationInbound(): Promise<boolean> },
      'handleOrchestrationInbound',
    ).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          continueProcessing = () => resolve(false)
        }),
    )
    let accepted = false
    const accepting = adapter.accept(inbound()).then(() => {
      accepted = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(accepted).toBe(false)
    persist()
    await accepting
    expect(accepted).toBe(true)
    expect(deps.generateReply).not.toHaveBeenCalled()
    continueProcessing()
    await bridge.stop()
  })

  it('持久化失败不签发接收确认，停止时也不确认新消息', async () => {
    const { bridge, deps } = createBridge()
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter)
    await bridge.start()
    deps.socialMessageRepo.insert.mockRejectedValue(new Error('测试写入失败'))
    await expect(adapter.accept(inbound())).rejects.toThrow('测试写入失败')
    await bridge.stop()
    await expect(adapter.accept(inbound())).rejects.toThrow('SOCIAL_INBOUND_UNAVAILABLE')
  })

  it('普通群聊短时限流保留原批次，窗口恢复后自动调用模型并发送', async () => {
    const values = new Map<string, string>()
    const loopGuard = new SocialLoopGuard(
      {
        get: async (key) => values.get(key),
        set: async (key, value) => {
          values.set(key, value)
        },
      },
      () => normalizeLoopPolicy({ maxTurnsPerWindow: 1, windowSeconds: 10 }),
      () => [],
      () => undefined,
    )
    const { bridge, deps } = createBridge({ loopGuard })
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter as never)
    const snapshots: Array<{ error?: string; status: string }> = []
    deps.socialMessageRepo.saveTurn.mockImplementation(async (record) => {
      snapshots.push(structuredClone(record))
    })
    await executeTurn(bridge, [inbound({ rawEvent: { self_id: '111111', message_id: 1 } })])
    const pending = executeTurn(bridge, [
      inbound({ rawEvent: { self_id: '111111', message_id: 2 } }),
    ])
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.generateReply).toHaveBeenCalledTimes(1)
    expect(deps.socialMessageRepo.completeQueuedMessages).toHaveBeenCalledTimes(1)
    expect(
      snapshots.some(
        (record) => record.status === 'running' && record.error?.includes('消息已保留'),
      ),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(10000)
    await expect(pending).resolves.toMatchObject({ type: 'reply' })
    expect(deps.generateReply).toHaveBeenCalledTimes(2)
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2)
    expect(deps.socialMessageRepo.completeQueuedMessages).toHaveBeenCalledTimes(2)
    expect(snapshots.at(-1)).toMatchObject({ status: 'completed', error: undefined })
  })

  it('限流等待遵守父任务停止，不在窗口到期后产生幽灵回复', async () => {
    const values = new Map<string, string>()
    const loopGuard = new SocialLoopGuard(
      {
        get: async (key) => values.get(key),
        set: async (key, value) => {
          values.set(key, value)
        },
      },
      () => normalizeLoopPolicy({ maxTurnsPerWindow: 1, windowSeconds: 10 }),
      () => [],
      () => undefined,
    )
    const { bridge, deps } = createBridge({ loopGuard })
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter as never)
    await executeTurn(bridge, [inbound({ rawEvent: { self_id: '111111', message_id: 1 } })])
    const controller = new AbortController()
    const pending = executeTurn(
      bridge,
      [inbound({ rawEvent: { self_id: '111111', message_id: 2 } })],
      controller.signal,
    )
    const rejection = expect(pending).rejects.toThrow('用户停止')
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error('用户停止'))
    await rejection
    await vi.advanceTimersByTimeAsync(10000)
    expect(deps.generateReply).toHaveBeenCalledTimes(1)
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('模型重试预算耗尽后关闭批次，不把 fetch failed 重新交给外层恢复', async () => {
    const failure = Object.assign(new Error('OpenAI 网络错误: fetch failed'), {
      data: { retryable: true },
    })
    const generateReply = vi.fn(async () => {
      currentSocialRecovery()!.record.checkpoint.generation = { retries: 2, toolStarted: false }
      throw failure
    })
    const { bridge, deps } = createBridge({ generateReply })
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter as never)
    const error = await executeTurn(bridge, [inbound()]).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'SOCIAL_TURN_ENDED', data: { retryable: false } })
    expect(socialFailure(error).retryable).toBe(false)
    expect(generateReply).toHaveBeenCalledOnce()
    expect(deps.socialMessageRepo.saveTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed' }),
    )
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it.each(['failed', 'cancelled'] as const)(
    '恢复 %s 的持久任务时不调用模型，也不重新开启重试',
    async (status) => {
      const { bridge, deps } = createBridge()
      deps.socialMessageRepo.getTurn.mockResolvedValue({ status, error: '该任务已经结束' } as never)
      const error = await executeTurn(bridge, [inbound()]).catch((value: unknown) => value)
      expect(socialFailure(error).retryable).toBe(false)
      expect(deps.generateReply).not.toHaveBeenCalled()
    },
  )

  it('群友提及前的主人发言不会改变本轮对话对象，完整回复只发送一次', async () => {
    const reply = '你现在方便吗？我已经准备好了！\n这是完整的一条消息。'
    const { bridge, deps } = createBridge({
      getOwnerId: () => '654321',
      generateReply: vi.fn().mockResolvedValue({ type: 'reply', content: reply }),
    })
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter as never)
    await executeTurn(bridge, [
      inbound({ senderId: '654321', isOwner: true, rawEvent: { message_id: 1 } }),
      inbound({
        senderId: '123456',
        senderName: '主人',
        rawEvent: { message_id: 2, _isMentioned: true },
      }),
    ])
    expect(deps.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        isOwner: false,
        triggerSenderId: '123456',
        combinedMessage: expect.stringContaining('平台账号:123456 身份:普通联系人'),
      }),
    )
    expect(adapter.sendMessage).toHaveBeenCalledOnce()
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: reply, replyTo: '2' }),
      expect.any(AbortSignal),
    )
  })

  it.each(['private', 'group'] as const)(
    '%s 只提供可选图片来源，不在 Agent 决定前附带图片像素',
    async (channelType) => {
      const imageCache = {
        download: vi.fn(async () => 'cached-image'),
        readAsDataUrl: vi.fn(() => 'data:image/png;base64,aW1hZ2U='),
      }
      const { bridge, deps } = createBridge({ imageCacheManager: imageCache })
      bridge.registerAdapter(new FakeAdapter() as never)
      await executeTurn(bridge, [
        inbound({
          channelType,
          attachments: [{ type: 'image', url: 'https://example.test/image' }],
          rawEvent: { self_id: '111111', message_id: 22, _isMentioned: channelType === 'group' },
        }),
      ])
      expect(deps.generateReply).toHaveBeenCalledWith(
        expect.objectContaining({
          images: [],
          imageSources: [expect.stringContaining('消息 22')],
          combinedMessage: expect.stringContaining('消息 22'),
        }),
      )
      expect(imageCache.readAsDataUrl).not.toHaveBeenCalled()
    },
  )

  it('引用图片保留账号和会话来源，未主动读取时不误报图片损坏', async () => {
    const { bridge, deps } = createBridge({
      imageCacheManager: { download: vi.fn(async () => null), readAsDataUrl: vi.fn() },
    })
    bridge.registerAdapter(new FakeAdapter() as never)
    deps.socialMessageRepo.getByMsgId.mockResolvedValue({
      platform: 'napcat',
      agentId: 'pero',
      accountId: '111111',
      channelId: 'group-1',
      channelType: 'group',
      msgId: '21',
      senderId: 'u2',
      senderName: '被引用者',
      content: '[图片]',
      rawEventJson: JSON.stringify({
        _infosInbound: { attachments: [{ type: 'image', url: 'https://example.test/image' }] },
      }),
    })
    await executeTurn(bridge, [
      inbound({
        replyTo: '21',
        rawEvent: { self_id: '111111', message_id: 22, _isMentioned: true },
      }),
    ])
    expect(deps.socialMessageRepo.getByMsgId).toHaveBeenCalledWith(
      'pero',
      '21',
      '111111',
      expect.objectContaining({ platform: 'napcat', accountId: '111111', channelId: 'group-1' }),
    )
    expect(deps.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [],
        combinedMessage: expect.stringContaining('以上图片尚未查看'),
      }),
    )
  })

  it('注册、替换、启动和停止适配器', async () => {
    const { bridge } = createBridge()
    const first = new FakeAdapter()
    const second = new FakeAdapter()
    bridge.registerAdapter(first as never)
    expect(() => bridge.registerAdapter(second as never)).toThrow('SOCIAL_PLATFORM_DUPLICATE')
    bridge.unregisterAdapter(first.platform)
    bridge.registerAdapter(second as never)
    await bridge.start()
    await bridge.stop()
    expect(bridge.getAdapter('napcat')).toBe(second)
    expect(first.listenerCount('message')).toBe(0)
    expect(second.connect).toHaveBeenCalled()
    expect(second.disconnect).toHaveBeenCalled()
  })

  it('入站消息先持久化，再进入状态机并发布事件', async () => {
    let persist!: () => void
    const writing = new Promise<void>((resolve) => {
      persist = resolve
    })
    const { bridge, deps } = createBridge()
    deps.socialMessageRepo.insert.mockReturnValue(writing)
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter as never)
    await bridge.start()
    adapter.emit('message', inbound())
    await vi.waitFor(() => expect(deps.socialMessageRepo.insert).toHaveBeenCalledOnce())
    expect(deps.socialEvents.publish).not.toHaveBeenCalled()
    expect(deps.generateReply).not.toHaveBeenCalled()
    persist()
    await vi.waitFor(() => expect(deps.socialEvents.publish).toHaveBeenCalled())
    await bridge.stop()
    expect(deps.socialMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ msgId: '123', content: '你好' }),
    )
    expect(deps.socialEvents.publish).toHaveBeenCalledWith(
      'social_message',
      expect.objectContaining({ direction: 'inbound' }),
    )
  })

  it('唯一角色 Agent 的 reply 结果会发送并持久化', async () => {
    const { bridge, deps } = createBridge()
    const adapter = new FakeAdapter()
    bridge.registerAdapter(adapter as never)
    const session = {
      channelId: 'group-1',
      channelType: 'group',
      agentId: 'pero',
      participation: 'idle',
      phase: 'running',
    }
    const outcome = await (
      bridge as unknown as {
        executeReply: (
          session: unknown,
          messages: InboundMessage[],
          reason: 'proactive_review',
          signal: AbortSignal,
        ) => Promise<unknown>
      }
    ).executeReply(session, [inbound()], 'proactive_review', new AbortController().signal)

    expect(outcome).toEqual({ type: 'reply', content: '好的' })
    expect(deps.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'proactive_review',
        participation: 'idle',
        deferredIntent: undefined,
      }),
    )
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      {
        accountId: '123456789',
        channelId: 'group-1',
        channelType: 'group',
        content: '好的',
        replyTo: undefined,
        deliveryId: expect.stringMatching(/^[a-f0-9]{24}$/),
      },
      expect.any(AbortSignal),
    )
    expect(deps.socialMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: 'self', content: '好的' }),
    )
    expect(deps.socialMessageRepo.saveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'conversation', outcome: 'reply' }),
    )
  })

  it('明确的主 Agent 委派进入任务分类，普通发送不改变分类规则', async () => {
    const { bridge, deps } = createBridge()
    const adapter = new FakeAdapter()
    adapter.platform = 'qq'
    adapter.getConnectedAccountIds.mockReturnValue(['123456789'] as never)
    Object.assign(adapter, { resolveAgentId: () => 'pero' })
    bridge.registerAdapter(adapter as never)
    await bridge.start()
    try {
      await bridge.runCommand('delegated-task', 'pero', '987654321', '委派内容', '234567890')
      expect(deps.socialMessageRepo.saveTurn).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'task', outcome: 'reply' }),
      )
    } finally {
      await bridge.stop()
    }
  })

  it('PASS、WAIT、DEFER 不产生平台发送', async () => {
    for (const outcome of [
      { type: 'pass' as const },
      {
        type: 'wait' as const,
        wait: { reason: 'continuation_expected' as const, duration: 'short' as const },
      },
      {
        type: 'defer' as const,
        intent: { intention: '稍后再问', timing: 'soon' as const, expires: 'today' as const },
      },
    ]) {
      const { bridge } = createBridge({ generateReply: vi.fn().mockResolvedValue(outcome) })
      const adapter = new FakeAdapter()
      bridge.registerAdapter(adapter as never)
      const result = await (
        bridge as unknown as {
          executeReply: (
            session: unknown,
            messages: InboundMessage[],
            reason: 'proactive_review',
            signal: AbortSignal,
          ) => Promise<unknown>
        }
      ).executeReply(
        {
          channelId: 'group-1',
          channelType: 'group',
          agentId: 'pero',
          participation: 'idle',
        },
        [inbound()],
        'proactive_review',
        new AbortController().signal,
      )
      expect(result).toEqual(outcome)
      expect(adapter.sendMessage).not.toHaveBeenCalled()
    }
  })

  it('适配器缺失会抛错，让批次进入可靠重试路径', async () => {
    const { bridge } = createBridge()
    await expect(
      bridge.sendReply('missing', { channelId: 'g1', channelType: 'group', content: '消息' }),
    ).rejects.toThrow(Error)
  })
})
