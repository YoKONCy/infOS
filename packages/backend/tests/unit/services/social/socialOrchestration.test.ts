import { NAPCAT_ACTIONS } from '@infos/social/adapters/napcat/napcatActions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SocialOrchestration,
  notifyOrchestrationInbound,
  orchestrationWait,
  type SocialOrchestrationDeps,
} from '@infos/social/runtime/socialOrchestration'
import { finishSocialTurn, runSocialRecovery } from '@infos/social/runtime/socialRecovery'
import type { SocialStoragePort, SocialTurnRecord } from '@infos/shared'
import type { InboundMessage } from '@infos/social/runtime/types'

function fixture() {
  const inbound: InboundMessage = {
    agentId: 'keromi',
    platform: 'qq',
    channelType: 'group',
    channelId: '987654321',
    senderId: '234567890',
    senderName: '群友',
    content: '看看这张图',
    rawEvent: { self_id: '123456789', message_id: 'trigger' },
  }
  let record: SocialTurnRecord = {
    id: 'turn-act',
    agentId: 'keromi',
    accountId: '123456789',
    channelType: 'group',
    channelId: '987654321',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 21600000).toISOString(),
    attempts: 1,
    status: 'running',
    checkpoint: { inbound: [inbound] },
    sourceMessageIds: ['trigger'],
  }
  const controller = new AbortController()
  const execute = vi
    .fn<SocialOrchestrationDeps['execute']>()
    .mockResolvedValue(JSON.stringify({ success: true, title: '已读取' }))
  const send = vi
    .fn<SocialOrchestrationDeps['send']>()
    .mockResolvedValue({ messageId: 'sent', sentAt: Date.now() })
  const sendResource = vi
    .fn<SocialOrchestrationDeps['sendResource']>()
    .mockResolvedValue(JSON.stringify({ success: true }))
  const available = vi.fn(() => true)
  const assertAllowed = vi.fn(async () => undefined)
  const save = vi.fn(async () => undefined)
  const run = (input: Record<string, unknown>, id = 'call-1', closing = false) =>
    runSocialRecovery({ record, signal: controller.signal, save }, () =>
      new SocialOrchestration({
        assertAllowed,
        accountId: record.accountId,
        channelId: record.channelId,
        channelType: record.channelType,
        triggerMessageId: 'trigger',
        triggerSenderId: inbound.senderId,
        execute,
        isReadOnly: (name, args) =>
          NAPCAT_ACTIONS.some(
            (item) => item.tool === name && item.action === args.action && !item.mutation,
          ),
        send,
        sendResource,
        available,
      }).execute(input, id, closing),
    )
  return {
    run,
    execute,
    send,
    sendResource,
    available,
    assertAllowed,
    controller,
    inbound,
    save,
    get record() {
      return record
    },
    restart() {
      record = structuredClone(record)
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('统一社交入口与持久化编排', () => {
  it('角色可主动选择低活跃，回复后进入的决定随计划恢复并保留到终态', async () => {
    const silent = fixture()
    expect(await silent.run({ low_activity: true })).toMatchObject({
      status: 'completed',
      low_activity: true,
    })
    expect(silent.send).not.toHaveBeenCalled()
    const reply = fixture()
    const input = { reply: '先安静看大家聊，需要我时 @ 我就好', low_activity: true }
    expect(await reply.run(input)).toMatchObject({ status: 'completed', low_activity: true })
    reply.restart()
    expect(await reply.run(input)).toMatchObject({ status: 'completed', low_activity: true })
    expect(reply.send).toHaveBeenCalledTimes(1)
    reply.record.checkpoint.outcome = { type: 'reply', lowActivity: true }
    const saveTurn = vi.fn(async () => undefined)
    await finishSocialTurn({ saveTurn } as unknown as SocialStoragePort, reply.record, 'completed')
    expect(reply.record.checkpoint).toEqual({ participation: { lowActivity: true } })
  })

  it('低活跃决定不能与等待或继续判断混用，私聊也不能设置群聊模式', async () => {
    for (const input of [
      { action: 'observe', low_activity: true },
      { action: 'defer', low_activity: true },
      { action: 'continue', low_activity: true },
      { low_activity: true, next: 'continue' },
      { low_activity: 'true' },
    ]) {
      await expect(fixture().run(input)).rejects.toThrow()
    }
    const privateChat = fixture()
    privateChat.record.channelType = 'private'
    await expect(privateChat.run({ low_activity: true })).rejects.toThrow('低活跃仅适用于群聊')
    const delegated = fixture()
    delegated.record.kind = 'task'
    await expect(delegated.run({ low_activity: true })).rejects.toThrow(
      '委派任务不能修改群聊参与模式',
    )
  })

  it('可单独退出或回复后退出，并在恢复同一计划时保留退出决定', async () => {
    const silent = fixture()
    expect(await silent.run({ end_participation: true })).toMatchObject({
      status: 'completed',
      end_participation: true,
    })
    expect(silent.send).not.toHaveBeenCalled()
    const reply = fixture()
    const input = { reply: '先聊到这里', end_participation: true }
    expect(await reply.run(input)).toMatchObject({ status: 'completed', end_participation: true })
    reply.restart()
    expect(await reply.run(input)).toMatchObject({ status: 'completed', end_participation: true })
    expect(reply.send).toHaveBeenCalledTimes(1)
  })

  it('互聊保护阻止发送时仍可纯 PASS，但不能借 PASS 执行步骤或解除保护', async () => {
    const f = fixture()
    const blocked = new Error('SOCIAL_LOOP_BLOCKED')
    f.assertAllowed.mockRejectedValue(blocked)
    expect(await f.run({ action: 'pass', end_participation: true })).toMatchObject({
      status: 'completed',
    })
    expect(f.assertAllowed).not.toHaveBeenCalled()
    await expect(f.run({ reply: '不能发送' }, 'send')).rejects.toBe(blocked)
    await expect(f.run({ action: 'pass', reply: '不能夹带发送' }, 'invalid')).rejects.toThrow()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('退出决定不绕过取消，也不能与等待或返回模型继续编排混用', async () => {
    const f = fixture()
    await expect(f.run({ action: 'wait', end_participation: true })).rejects.toThrow()
    await expect(f.run({ end_participation: 'true' })).rejects.toThrow()
    await expect(f.run({ end_participation: true, next: 'continue' })).rejects.toThrow()
    const cancelled = new Error('回合已取消')
    f.controller.abort(cancelled)
    await expect(f.run({ end_participation: true }, 'cancelled')).rejects.toBe(cancelled)
  })
  it('普通回复入口即结束，并使用可信会话、引用与结构化提及', async () => {
    const f = fixture()
    const result = await f.run({ reply: '第一行\r\n \r\n第二行', mentions: ['234567890'] })
    expect(result.status).toBe('completed')
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: '123456789',
        channelId: '987654321',
        channelType: 'group',
        content: '第一行\n第二行',
        replyTo: 'trigger',
        mentions: ['234567890'],
      }),
      expect.any(String),
    )
    expect(f.execute).not.toHaveBeenCalled()
    f.restart()
    expect((await f.run({ reply: '第一行\r\n \r\n第二行', mentions: ['234567890'] })).status).toBe(
      'completed',
    )
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('查询结果回到当前模型，缺省的会话范围自动补全，图片保持多模态', async () => {
    const f = fixture()
    f.execute.mockResolvedValueOnce(
      JSON.stringify({ success: true, images: ['data:image/png;base64,aA=='] }),
    )
    const result = await f.run({
      steps: [
        { id: 'recent', op: 'call', tool: 'social', action: 'history_get', input: { count: 20 } },
      ],
    })
    expect(result.status).toBe('continue')
    expect(f.execute).toHaveBeenCalledWith(
      'social',
      {
        action: 'history_get',
        input: {
          count: 20,
          channel_id: '987654321',
          channel_type: 'group',
        },
      },
      'call-1:recent',
    )
    expect(result.images).toEqual(['data:image/png;base64,aA=='])
    expect(JSON.stringify(result.observations)).not.toContain('base64')
  })

  it('单个读取抛错不会中断独立步骤，依赖失败的发送自动跳过', async () => {
    const f = fixture()
    f.execute.mockRejectedValueOnce(new Error('读取失败'))
    const result = await f.run({
      steps: [
        { id: 'bad', op: 'call', tool: 'social', action: 'history_get', input: {}, retries: 0 },
        { id: 'dependent', op: 'send', content: '不应发送', depends_on: ['bad'] },
        { id: 'good', op: 'call', tool: 'social_group', action: 'info', input: {} },
      ],
    })
    expect(result.status).toBe('continue')
    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step_id: 'bad', status: 'failed' }),
        expect.objectContaining({ step_id: 'dependent', status: 'skipped' }),
        expect.objectContaining({ step_id: 'good', status: 'completed' }),
      ]),
    )
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('同一入口编排多个读图步骤时，多模态返回总计最多三张且正文不含 base64', async () => {
    const f = fixture()
    f.execute
      .mockResolvedValueOnce(
        JSON.stringify({
          success: true,
          images: ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          success: true,
          images: ['data:image/png;base64,Yw==', 'data:image/png;base64,ZA=='],
        }),
      )
    const result = await f.run({
      steps: [
        {
          id: 'first',
          op: 'call',
          tool: 'social',
          action: 'image_read',
          input: { message_ids: ['one'] },
        },
        {
          id: 'second',
          op: 'call',
          tool: 'social',
          action: 'image_read',
          input: { message_ids: ['two'] },
        },
        { op: 'yield' },
      ],
    })
    expect(result.images).toEqual([
      'data:image/png;base64,YQ==',
      'data:image/png;base64,Yg==',
      'data:image/png;base64,Yw==',
    ])
    expect(result.images_omitted).toBe(1)
    expect(JSON.stringify(result.observations)).not.toContain('base64')
    expect(result.status).toBe('continue')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('只读网络故障有限重试，权限错误不重试，写操作未知后交回模型', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.execute.mockRejectedValueOnce(new Error('ECONNRESET'))
    const read = f.run({
      steps: [{ op: 'call', tool: 'social', action: 'history_get', input: {} }],
    })
    await vi.runAllTimersAsync()
    expect((await read).observations[0]?.status).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(2)
    f.execute.mockResolvedValueOnce(JSON.stringify({ success: false, error: '权限不足' }))
    await f.run(
      { steps: [{ op: 'call', tool: 'social', action: 'history_get', input: {}, retries: 2 }] },
      'permission',
    )
    expect(f.execute).toHaveBeenCalledTimes(3)
    f.execute.mockRejectedValueOnce(new Error('网络连接断开'))
    const write = await f.run(
      {
        steps: [
          {
            op: 'call',
            tool: 'social',
            action: 'poke',
            input: { user_id: '234567890' },
            retries: 2,
          },
          { op: 'send', content: '不能冒充成功' },
        ],
      },
      'write',
    )
    expect(write.status).toBe('continue')
    expect(write.observations[0]?.status).toBe('uncertain')
    expect(f.execute).toHaveBeenCalledTimes(4)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('支持 fallback、条件分支及受限结果引用，不执行动态表达式', async () => {
    const f = fixture()
    f.execute.mockResolvedValueOnce(JSON.stringify({ success: false, error: '暂不可用' }))
    const result = await f.run({
      steps: [
        {
          id: 'primary',
          op: 'call',
          tool: 'social_group',
          action: 'info',
          input: {},
          on_error: 'fallback',
          fallback: [
            {
              id: 'backup',
              op: 'call',
              tool: 'social',
              action: 'contact_get',
              input: { user_id: '234567890' },
            },
          ],
        },
        {
          op: 'if',
          condition: { ref: 'backup.data.title', test: 'eq', value: '已读取' },
          then: [{ op: 'send', content: { $ref: 'backup.data.title' } }],
          else: [{ op: 'send', content: '不应选择此分支' }],
        },
      ],
      next: 'end',
    })
    expect(result.status).toBe('completed')
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '已读取' }),
      expect.any(String),
    )
    expect(f.send).toHaveBeenCalledTimes(1)
    const unsafe = await f.run(
      { steps: [{ op: 'send', content: { $ref: 'backup.__proto__.constructor' } }] },
      'unsafe',
    )
    expect(unsafe.observations[0]?.status).toBe('failed')
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('只读并发最大为三，拒绝在并发步骤中夹带写操作', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let active = 0
    let maximum = 0
    f.execute.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return '{"success":true}'
    })
    const reading = f.run({
      steps: [
        {
          op: 'parallel',
          steps: Array.from({ length: 7 }, (_, index) => ({
            id: `read${index}`,
            op: 'call',
            tool: 'social_group',
            action: 'info',
            input: {},
          })),
        },
      ],
    })
    await vi.runAllTimersAsync()
    await reading
    expect(maximum).toBe(3)
    expect(f.execute).toHaveBeenCalledTimes(7)
    await expect(
      f.run(
        {
          steps: [
            { op: 'parallel', steps: [{ op: 'call', tool: 'social', action: 'poke', input: {} }] },
          ],
        },
        'badparallel',
      ),
    ).rejects.toThrow('只读')
  })

  it('分段延迟被托管，进程恢复不重发第一段，计时从前一段完成后开始', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const request = { messages: [{ content: '第一段' }, { content: '第二段', delay_ms: 1200 }] }
    expect((await f.run(request)).status).toBe('waiting')
    expect(f.send).toHaveBeenCalledTimes(1)
    const pending = orchestrationWait(f.record.checkpoint)!
    f.restart()
    vi.setSystemTime(pending.until)
    expect((await f.run(request)).status).toBe('completed')
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[0]).toMatchObject({ content: '第二段' })
  })

  it('长时间离线后不补发已经过期的延迟内容，而是交回模型重新判断', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const request = { messages: [{ content: '第一段' }, { content: '过期第二段', delay_ms: 1200 }] }
    await f.run(request)
    const pending = orchestrationWait(f.record.checkpoint)!
    f.restart()
    vi.setSystemTime(pending.expiresAt + 1)
    const result = await f.run(request)
    expect(result.status).toBe('continue')
    expect(result.observations.some((item) => item.status === 'skipped')).toBe(true)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it.each(['reconsider', 'cancel'] as const)(
    '延迟遇相关消息时执行 %s，无关群友不会打断',
    async (decision) => {
      const f = fixture()
      const request = {
        messages: [{ content: '已发' }, { content: '待发', delay_ms: 5000 }],
        on_new_message: decision,
      }
      await f.run(request)
      expect(
        notifyOrchestrationInbound(f.record.checkpoint, {
          ...f.inbound,
          senderId: '345678901',
          content: '路过',
        }),
      ).toBe(false)
      expect(
        notifyOrchestrationInbound(f.record.checkpoint, {
          ...f.inbound,
          content: '已经解决，不需要了',
        }),
      ).toBe(true)
      f.restart()
      const result = await f.run(request)
      expect(result.status).toBe(decision === 'cancel' ? 'completed' : 'continue')
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(result.observations)).toContain('已经解决')
    },
  )

  it('观察按发送者及图片事件唤醒，等待记录不会被终态清理逻辑截断', async () => {
    const f = fixture()
    const request = {
      action: 'observe',
      watch: { senders: ['234567890'], events: ['image'], expires_in_seconds: 180 },
    }
    const first = await f.run(request)
    await finishSocialTurn(
      { saveTurn: f.save } as unknown as SocialStoragePort,
      f.record,
      'waiting',
    )
    expect(orchestrationWait(f.record.checkpoint)).toBeDefined()
    expect(notifyOrchestrationInbound(f.record.checkpoint, f.inbound)).toBe(false)
    expect(
      notifyOrchestrationInbound(f.record.checkpoint, {
        ...f.inbound,
        attachments: [{ type: 'image', url: 'https://example.test/image.png' }],
      }),
    ).toBe(true)
    expect((await f.run(request)).status).toBe('continue')
    expect(first.status).toBe('waiting')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('发送超时只返回结果未知，显式取消会中断执行且不执行后续步骤', async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const result = await f.run({ messages: [{ content: '可能送达' }, { content: '不能再发' }] })
    expect(result.observations[0]?.status).toBe('uncertain')
    expect(f.send).toHaveBeenCalledTimes(1)
    f.controller.abort(new Error('用户停止'))
    await expect(f.run({ reply: '不应发送' }, 'cancelled')).rejects.toThrow('用户停止')
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('收尾只限制业务步骤，入口仍能回复或 PASS，未开放的能力不会执行', async () => {
    const f = fixture()
    const blocked = await f.run(
      { steps: [{ op: 'call', tool: 'social_group', action: 'info', input: {} }] },
      'closingread',
      true,
    )
    expect(blocked.observations[0]?.status).toBe('failed')
    expect(f.execute).not.toHaveBeenCalled()
    expect((await f.run({ reply: '查询尚未完成' }, 'closingreply', true)).status).toBe('completed')
    expect((await f.run({ action: 'pass' }, 'closingpass', true)).status).toBe('completed')
    f.available.mockReturnValue(false)
    await f.run(
      { steps: [{ op: 'call', tool: 'social_account', action: 'qzone_publish', input: {} }] },
      'permission',
    )
    expect(f.execute).not.toHaveBeenCalled()
  })
})
