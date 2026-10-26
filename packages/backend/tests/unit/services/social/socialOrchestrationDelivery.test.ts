import { AbstractSocialAdapter } from '@infos/social/adapters/ISocialAdapter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocialBridge } from '@infos/social/runtime/socialBridge'
import { SocialOrchestration } from '@infos/social/runtime/socialOrchestration'
import { assertQQOutboundContent } from '@infos/social/adapters/napcat/napcatParser'
import { finishSocialTurn, runSocialRecovery } from '@infos/social/runtime/socialRecovery'
import type { SocialStoragePort, SocialTurnRecord } from '@infos/shared'
import type { OutboundMessage, SocialDeliveryReceipt } from '@infos/social/runtime/types'
import type { SocialSessionManager } from '@infos/social/runtime/socialSessionManager'

class DeliveryAdapter extends AbstractSocialAdapter {
  readonly platform = 'qq'
  override validateOutbound(message: OutboundMessage): void {
    assertQQOutboundContent(message.content)
  }
  async connect() {}
  async disconnect() {}
  async sendMessage(): Promise<SocialDeliveryReceipt> {
    return { sentAt: Date.now() }
  }
  async getStatus() {
    return { platform: this.platform, connected: true, latencyMs: 0 }
  }
}
function fixture() {
  const rows: Array<Parameters<SocialStoragePort['insert']>[0]> = []
  const records = new Map<string, SocialTurnRecord>()
  const insert = vi.fn<SocialStoragePort['insert']>().mockImplementation(async (message) => {
    if (!rows.some((row) => row.msgId === message.msgId)) rows.push(structuredClone(message))
  })
  const saveTurn = vi.fn<SocialStoragePort['saveTurn']>().mockImplementation(async (record) => {
    records.set(record.id, structuredClone(record))
  })
  const storage = {
    insert,
    saveTurn,
    getTurn: vi.fn(async (id: string) => records.get(id) ?? null),
    getDataVersion: vi.fn(async () => 0),
    getByMsgId: vi.fn(async () => null),
    getRecent: vi.fn(async () => []),
    listRecoverableTurns: vi.fn(async () =>
      [...records.values()].filter((record) =>
        ['running', 'retrying', 'waiting'].includes(record.status),
      ),
    ),
  } as unknown as SocialStoragePort
  const bridge = new SocialBridge({
    socialMessageRepo: storage,
    socialEvents: { publish: vi.fn(async () => undefined) },
    generateReply: vi.fn(async () => ({ type: 'pass' as const })),
  })
  const sendMessage = vi.fn<(message: OutboundMessage) => Promise<SocialDeliveryReceipt>>()
  sendMessage.mockImplementation(async () => ({
    messageId: `platform-${sendMessage.mock.calls.length}`,
    sentAt: Date.now(),
  }))
  const adapter = Object.assign(new DeliveryAdapter(), {
    platform: 'qq',
    sendMessage,
    getConnectedAccountIds: () => ['123456789'],
  })
  bridge.registerAdapter(adapter as never)
  const controller = new AbortController()
  const record: SocialTurnRecord = {
    id: 'delivery-turn',
    platform: 'qq',
    agentId: 'keromi',
    accountId: '123456789',
    channelType: 'group',
    channelId: '987654321',
    status: 'running',
    attempts: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 600000).toISOString(),
    checkpoint: {
      deliveryDataVersion: 0,
      inbound: [
        {
          platform: 'qq',
          accountId: '123456789',
          messageId: 'trigger',
          agentId: 'keromi',
          channelId: '987654321',
          channelType: 'group',
          senderId: '234567890',
          senderName: '群友',
          content: '你好',
          rawEvent: { self_id: '123456789', message_id: 'trigger' },
        },
      ],
    },
  }
  const run = (input: Record<string, unknown>, id = 'call') =>
    runSocialRecovery(
      {
        record,
        signal: controller.signal,
        save: () => saveTurn(record),
      },
      () =>
        new SocialOrchestration({
          accountId: record.accountId,
          channelId: record.channelId,
          channelType: record.channelType,
          triggerMessageId: 'trigger',
          triggerSenderId: '234567890',
          available: () => true,
          execute: async () => '{"success":true}',
          sendResource: async () => '{"success":true}',
          send: (message, key) => bridge.sendOrchestratedMessage(message, key),
        }).execute(input, id),
    )
  return { run, bridge, record, rows, storage, insert, saveTurn, sendMessage, controller }
}

afterEach(() => vi.useRealTimers())

describe('社交编排逐条送达与消息落盘', () => {
  it('完整正文含入站占位时先拒绝，不先发送前面的文字或媒体段', async () => {
    const f = fixture()
    const result = await f.run({ reply: '前段[native_emoji:123:1]后段[QQ表情:289]' })
    expect(result.observations[0]).toMatchObject({
      status: 'failed',
      error: { code: 'DELIVERY_NOT_SENT' },
    })
    expect(f.sendMessage).not.toHaveBeenCalled()
    expect(f.rows).toEqual([])
  })
  it('已确认的发送回执可在通道离线后恢复，不重复发送或消耗新预算', async () => {
    const f = fixture()
    const context = {
      record: f.record,
      signal: f.controller.signal,
      save: () => f.saveTurn(f.record),
    }
    const message: OutboundMessage = {
      accountId: f.record.accountId,
      channelId: f.record.channelId,
      channelType: 'group',
      content: '已发送内容',
    }
    const first = await runSocialRecovery(context, () =>
      f.bridge.sendReply('qq', message, undefined, 'saved-stage'),
    )
    const readiness = vi
      .spyOn(f.bridge.getAdapter('qq')!, 'getSendReadiness')
      .mockResolvedValue({ ready: false, reason: 'SOCIAL_ACCOUNT_NOT_CONNECTED' })
    const second = await runSocialRecovery(context, () =>
      f.bridge.sendReply('qq', message, undefined, 'saved-stage'),
    )
    expect(second).toEqual(first)
    expect(readiness).not.toHaveBeenCalled()
    expect(f.sendMessage).toHaveBeenCalledOnce()
  })
  it('调度器到期领取原回合，复用原始消息及调用现场，领取时不直接重发', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const outcome = await f.run({
      messages: [{ content: '已发' }, { content: '待发', delay_ms: 1200 }],
    })
    f.record.status = 'waiting'
    f.record.checkpoint.outcome = {
      type: 'orchestration',
      wakeAt: outcome.wake_at,
      expiresAt: outcome.expires_at,
    }
    await f.saveTurn(f.record)
    const internal = f.bridge as unknown as {
      running: boolean
      sessionManager: SocialSessionManager
      resumeOrchestrations(agentId: string): Promise<void>
    }
    internal.running = true
    const retry = vi.spyOn(internal.sessionManager, 'retry').mockResolvedValue(undefined)
    vi.setSystemTime(outcome.wake_at!)
    await internal.resumeOrchestrations('keromi')
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry.mock.calls[0]?.[0]).toMatchObject({ turnId: f.record.id, phase: 'retrying' })
    const claimed = await f.storage.getTurn(f.record.id)
    expect(claimed?.status).toBe('retrying')
    expect(claimed?.checkpoint.outcome).toBeUndefined()
    expect(claimed?.checkpoint.orchestration).toBeDefined()
    expect(f.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('第二段失败仍保留第一段真实消息 ID，并将部分送达情况交回模型', async () => {
    const f = fixture()
    f.sendMessage
      .mockResolvedValueOnce({ messageId: 'qq-first', sentAt: Date.now() })
      .mockRejectedValueOnce(Object.assign(new Error('平台拒绝'), { code: 'DELIVERY_REJECTED' }))
    const result = await f.run({ messages: [{ content: '第一段' }, { content: '第二段' }] })
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({
      msgId: 'qq-first',
      content: '第一段',
      accountId: '123456789',
      senderId: 'self',
      agentId: 'keromi',
    })
    expect(result.status).toBe('continue')
    expect(result.delivered_messages).toEqual([
      expect.objectContaining({ content: '第一段', messageId: 'qq-first' }),
    ])
    expect(f.record.orchestrationSummary?.sends).toBe(1)
  })

  it('未知发送结果不会在后续入口调用中被换一个调用 ID 重发', async () => {
    const f = fixture()
    f.sendMessage.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const first = await f.run({ reply: '发送状态未知' }, 'first')
    const second = await f.run({ reply: '发送状态未知' }, 'second')
    expect(first.observations[0]?.status).toBe('uncertain')
    expect(second.observations[0]?.status).toBe('uncertain')
    expect(f.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.rows).toHaveLength(0)
  })

  it('发送成功但历史暂存失败时保留补存队列，恢复只补历史，不再次发送', async () => {
    const f = fixture()
    f.insert.mockRejectedValueOnce(new Error('数据库暂忙'))
    const result = await f.run({ reply: '已经送达' })
    expect(result.observations[0]?.status).toBe('uncertain')
    expect(result.delivered_messages).toEqual([expect.objectContaining({ content: '已经送达' })])
    await finishSocialTurn(f.storage, f.record, 'completed')
    expect(f.record.checkpoint.pendingHistory).toBeDefined()
    await (
      f.bridge as unknown as { repairDeliveryHistory(record: SocialTurnRecord): Promise<void> }
    ).repairDeliveryHistory(f.record)
    expect(f.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({
      msgId: 'platform-1',
      content: '已经送达',
      confirmedDeliveryKey: expect.any(String),
    })
  })

  it('显式取消后不会执行尚未发送的分段', async () => {
    const f = fixture()
    f.sendMessage.mockImplementationOnce(async () => {
      f.controller.abort(new Error('用户停止'))
      return { messageId: 'sent-before-stop', sentAt: Date.now() }
    })
    await expect(
      f.run({ messages: [{ content: '第一段' }, { content: '不能继续' }] }),
    ).rejects.toThrow('用户停止')
    expect(f.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.rows).toEqual([
      expect.objectContaining({ msgId: 'sent-before-stop', content: '第一段' }),
    ])
  })
})
