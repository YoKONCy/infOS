import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SocialTurnRecord } from '@infos/shared'
import type { InboundMessage } from '@infos/social/runtime/types'
import {
  SocialLoopGuard,
  normalizeLoopPolicy,
  type LoopPolicy,
} from '@infos/social/runtime/socialLoopGuard'

vi.mock('@infos/backend/applicationHostAbi', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
  safeModelDiagnostic: (value: unknown) => String(value),
  retryableLlmError: () => false,
}))
afterEach(() => vi.useRealTimers())

function fixture(patch: Partial<LoopPolicy> = {}) {
  const data = new Map<string, string>()
  const config = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: string) => {
      data.set(key, value)
    },
  }
  let policy = normalizeLoopPolicy(patch)
  const create = () =>
    new SocialLoopGuard(
      config,
      () => policy,
      () => ['123456', '234567'],
      () => '345678',
      async (change) => {
        const next = change(policy)
        await config.set('social', JSON.stringify({ mode: { loopGuard: next } }))
        policy = next
        return next
      },
      () => 'qq',
    )
  const message = (id: string, senderId = '234567'): InboundMessage => ({
    platform: 'qq',
    agentId: 'keromi',
    channelType: 'group',
    channelId: '456789',
    senderId,
    senderName: '主人',
    content: '你好',
    accountId: '123456',
    messageId: id,
    rawEvent: { self_id: '123456', message_id: id },
  })
  const turn = (id: string, inbound = message(id)): SocialTurnRecord => ({
    id,
    platform: 'qq',
    agentId: 'keromi',
    accountId: '123456',
    channelType: 'group',
    channelId: '456789',
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 21600000).toISOString(),
    attempts: 1,
    checkpoint: { inbound: [inbound] },
  })
  return { create, message, turn, data, policy: () => policy }
}

describe('社交跨回合互聊保护', () => {
  it('无消息 ID 也能持久化账号标记，在其他群聊、私聊与角色中统一识别', async () => {
    const f = fixture()
    const result = await f.create().markBot(f.turn('owner-request'), {
      userId: '567890',
      reason: '主人明确指认这是另一个 Agent 的 QQ',
    })
    expect(result).toMatchObject({ added: true, user_id: '567890' })
    const saved = JSON.parse(f.data.get('social')!).mode.loopGuard
    expect(normalizeLoopPolicy(saved).botMarks).toHaveLength(1)
    expect(saved.botMarks[0].messageId).toBeUndefined()
    const guard = f.create()
    expect(
      guard.classify({ ...f.message('b', '567890'), channelType: 'private', channelId: '567890' }),
    ).toBe('bot')
    expect(
      guard.classify({ ...f.message('c', '567890'), agentId: 'pero', channelId: '678901' }),
    ).toBe('bot')
  })
  it('添加机器人标记保存来源与依据，重复调用不覆盖首次依据', async () => {
    const f = fixture()
    const guard = f.create()
    const scope = f.turn('a')
    const input = {
      userId: '567890',
      messageId: '11',
      reason: '多次以相同格式自动回应并给出机器人控制信息',
    }
    expect(await guard.markBot(scope, input)).toMatchObject({ added: true, user_id: '567890' })
    expect(await guard.markBot(scope, { ...input, reason: '第二次判断' })).toMatchObject({
      added: false,
    })
    const saved = JSON.parse(f.data.get('social')!).mode.loopGuard
    expect(saved.knownBotIds).toEqual(['qq:567890'])
    expect(saved.botMarks).toEqual([
      expect.objectContaining({
        ...input,
        userId: input.userId,
        agentId: 'keromi',
        accountId: '123456',
        channelId: '456789',
      }),
    ])
    expect(f.create().classify(f.message('b', '567890'))).toBe('bot')
  })
  it('主人与用户登记的真人不能被模型标记，本机机器人不重复添加', async () => {
    const f = fixture({ trustedHumanIds: ['567890'] })
    const guard = f.create()
    const mark = (userId: string) =>
      guard.markBot(f.turn('a'), { userId, messageId: '11', reason: '判断依据' })
    await expect(mark('345678')).rejects.toThrow('可信真人')
    await expect(mark('567890')).rejects.toThrow('可信真人')
    expect(await mark('234567')).toMatchObject({ added: false })
    expect(f.policy().knownBotIds).toEqual([])
    expect(guard.classify(f.message('owner', '345678'))).toBe('human')
  })
  it('回合中添加标记补计机器人预算；重复检查、恢复与标记不会重置发送预算', async () => {
    vi.useFakeTimers()
    const f = fixture({ maxBotTurns: 1, maxSends: 1, windowSeconds: 10 })
    const guard = f.create()
    const record = f.turn('a', f.message('a', '567890'))
    await guard.admit(record)
    await guard.consume(record, 'sends', 'one')
    record.checkpoint.deliveries = { one: 'sent' }
    await guard.markBot(record, { userId: '567890', messageId: 'a', reason: '明确的自动回复行为' })
    await guard.check(record)
    await guard.check(record)
    await f.create().admit(record)
    const onWait = vi.fn(async () => {})
    const pending = guard.consume(record, 'sends', 'two', { onWait })
    await vi.advanceTimersByTimeAsync(1)
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sends' }))
    await vi.advanceTimersByTimeAsync(10000)
    await expect(pending).resolves.toBeUndefined()
  })
  it('新标记从当前回合生效，后续机器人回合受限', async () => {
    const f = fixture({ maxBotTurns: 1 })
    const guard = f.create()
    const record = f.turn('a', f.message('a', '567890'))
    await guard.admit(record)
    await guard.markBot(record, { userId: '567890', messageId: 'a', reason: '明确的自动回复行为' })
    await guard.consume(record, 'sends', 'one')
    await expect(f.create().admit(f.turn('b', f.message('b', '567890')))).rejects.toThrow(
      '机器人互聊',
    )
  })
  it('手动移除标记会清理依据，可信真人优先且中止后不再写入', async () => {
    const f = fixture()
    const guard = f.create()
    await guard.markBot(f.turn('a'), { userId: '567890', messageId: 'a', reason: '判断依据' })
    expect(normalizeLoopPolicy({ ...f.policy(), knownBotIds: [] }).botMarks).toEqual([])
    const corrected = normalizeLoopPolicy({ ...f.policy(), trustedHumanIds: ['qq:567890'] })
    expect(corrected.knownBotIds).toEqual([])
    expect(corrected.botMarks).toEqual([])
    const controller = new AbortController()
    controller.abort(new Error('任务已停止'))
    await expect(
      guard.markBot(
        { ...f.turn('a'), signal: controller.signal },
        {
          userId: '678901',
          messageId: 'b',
          reason: '判断依据',
        },
      ),
    ).rejects.toThrow('任务已停止')
    expect(f.policy().knownBotIds).toEqual(['qq:567890'])
  })
  it('机器人预算跨实例恢复，昵称不能伪装真人', async () => {
    const f = fixture({ maxBotTurns: 2 })
    const guard = f.create()
    for (const id of ['a', 'b']) {
      const inbound = f.message(id)
      await guard.observe(inbound)
      expect(inbound.senderKind).toBe('bot')
      const record = f.turn(id, inbound)
      await guard.admit(record)
      await guard.consume(record, 'sends', 'reply')
    }
    await expect(f.create().admit(f.turn('c'))).rejects.toMatchObject({
      code: 'SOCIAL_LOOP_BLOCKED',
    })
  })
  it('普通群友无需真人白名单；窗口流过后多轮交流不会累计熔断', async () => {
    vi.useFakeTimers()
    const f = fixture({ maxTurnsPerWindow: 1, windowSeconds: 10 })
    const guard = f.create()
    for (let index = 0; index < 12; index++) {
      const message = f.message(String(index), '567890')
      await guard.observe(message)
      expect(message.senderKind).toBe('unknown')
      await expect(f.create().admit(f.turn(String(index), message))).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(10001)
    }
  })
  it('普通真人补充不取消已运行任务，手动重新授权不复活旧计划', async () => {
    const f = fixture()
    const guard = f.create()
    const record = f.turn('a')
    await guard.admit(record)
    await guard.observe(f.message('owner', '345678'))
    await guard.consume(record, 'sends', 'one')
    await expect(guard.check(record)).resolves.toBeUndefined()
    await guard.allow(record)
    await expect(guard.admit(record)).rejects.toThrow('旧社交计划')
    await expect(guard.admit(f.turn('new'))).resolves.toBeUndefined()
  })
  it('恢复同一回合与投递标识不重复计数，冷却后旧延迟计划仍失效', async () => {
    vi.useFakeTimers()
    const f = fixture({ maxBotTurns: 1, maxSends: 1, cooldownSeconds: 30 })
    const guard = f.create()
    const record = f.turn('a')
    await guard.admit(record)
    await guard.admit(record)
    await guard.consume(record, 'sends', 'same')
    await guard.consume(record, 'sends', 'same')
    await expect(guard.admit(f.turn('b'))).rejects.toThrow('互聊')
    vi.advanceTimersByTime(31000)
    await expect(f.create().admit(record)).rejects.toThrow('旧社交计划')
    await expect(f.create().admit(f.turn('c'))).resolves.toBeUndefined()
  })
  it('机器人 PASS 不消耗回复额度，一个机器人熔断不影响其他群友或机器人', async () => {
    const f = fixture({ maxBotTurns: 1, knownBotIds: ['678901'] })
    const guard = f.create()
    for (let index = 0; index < 10; index++) {
      const record = f.turn(`pass:${index}`)
      await guard.admit(record)
      await guard.consume(record, 'requests', 'judge')
    }
    const replied = f.turn('reply')
    await guard.admit(replied)
    await guard.consume(replied, 'sends', 'one')
    await expect(guard.admit(f.turn('bot-again'))).rejects.toThrow('机器人互聊')
    const normal = f.turn('normal', { ...f.message('normal', '567890'), isMentioned: true })
    // 同批旁听内容包含被熔断机器人，也不能把正常群友的 @ 一起拦住。
    normal.checkpoint.inbound = [
      f.message('background'),
      ...(normal.checkpoint.inbound as InboundMessage[]),
    ]
    await expect(guard.admit(normal)).resolves.toBeUndefined()
    await guard.consume(normal, 'sends', 'normal')
    const another = f.turn('other-bot', f.message('other-bot', '678901'))
    await expect(guard.admit(another)).resolves.toBeUndefined()
    await guard.consume(another, 'sends', 'other')
  })
  it('处理批次达到滑动窗口限额会等待，而不是丢弃请求或永久熔断', async () => {
    vi.useFakeTimers()
    const f = fixture({ maxTurnsPerWindow: 1, windowSeconds: 10 })
    const guard = f.create()
    await guard.admit(f.turn('one', f.message('one', '567890')))
    const onWait = vi.fn(async () => {})
    const pending = guard.admit(f.turn('two', f.message('two', '567890')), { onWait })
    await vi.advanceTimersByTimeAsync(1)
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turns' }))
    await vi.advanceTimersByTimeAsync(10000)
    await expect(pending).resolves.toBeUndefined()
    expect(onWait).toHaveBeenLastCalledWith()
  })
  it('主人发言不能绕过窗口内的模型请求频率上限，等待可取消', async () => {
    vi.useFakeTimers()
    const f = fixture({ maxModelRequests: 1, windowSeconds: 10 })
    const guard = f.create()
    const record = f.turn('one', f.message('one', '567890'))
    await guard.admit(record)
    await guard.consume(record, 'requests', 'one')
    await guard.observe(f.message('owner', '345678'))
    const controller = new AbortController()
    const onWait = vi.fn(async () => {})
    const pending = guard.consume(record, 'requests', 'two', { signal: controller.signal, onWait })
    const rejection = expect(pending).rejects.toThrow('用户已停止')
    await vi.advanceTimersByTimeAsync(1)
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ kind: 'requests' }))
    controller.abort(new Error('用户已停止'))
    await rejection
    await vi.advanceTimersByTimeAsync(10000)
    await expect(guard.consume(record, 'requests', 'three')).resolves.toBeUndefined()
  })
  it('旧版无人介入熔断自动迁移，保留在途任务身份并允许新请求', async () => {
    const f = fixture()
    const record = f.turn('active', f.message('active', '567890'))
    await f.create().admit(record)
    const key = [...f.data.keys()].find((key) => key.startsWith('social.loopGuard.'))!
    f.data.set(
      key,
      JSON.stringify({
        epoch: record.checkpoint.loopGuardEpoch,
        turns: ['active'],
        admitted: ['active'],
        requests: [],
        sends: [],
        botTurns: {},
        seen: [],
        blockedUntil: Date.now() + 600000,
        reason: '连续无人介入回合已达到上限',
      }),
    )
    const guard = f.create()
    await expect(guard.check(record)).resolves.toBeUndefined()
    await expect(guard.admit(f.turn('new', f.message('new', '567890')))).resolves.toBeUndefined()
    expect(JSON.parse(f.data.get(key)!)).toMatchObject({ version: 2 })
    expect(JSON.parse(f.data.get(key)!).blockedUntil).toBeUndefined()
  })
  it('平台明确拒绝发送会退还预约，结果未知的发送仍保留计数', async () => {
    const f = fixture({ maxBotTurns: 1 })
    const guard = f.create()
    const record = f.turn('rejected')
    await guard.admit(record)
    await guard.consume(record, 'sends', 'attempt')
    await guard.releaseSend(record, 'attempt')
    const next = f.turn('next')
    await expect(guard.admit(next)).resolves.toBeUndefined()
    await guard.consume(next, 'sends', 'attempt')
    next.checkpoint.deliveries = { attempt: 'sending' }
    await guard.releaseSend(next, 'attempt')
    await expect(guard.admit(f.turn('another'))).rejects.toThrow('机器人互聊')
  })
})
