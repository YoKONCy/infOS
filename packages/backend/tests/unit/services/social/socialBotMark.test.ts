import { SocialCommonOperations } from '@infos/social/runtime/socialCommonOperations'
import { describe, expect, it, vi } from 'vitest'
import type { SocialMessageRecord, SocialStoragePort } from '@infos/shared'
import type { NapcatAdapter } from '@infos/social/adapters/napcat'
import {
  type SocialOperationDependencies,
  type SocialOperationScope,
} from '@infos/social/runtime/socialOperations'

const scope: SocialOperationScope = {
  platform: 'qq',
  agentId: 'keromi',
  accountId: '123456',
  channelId: '456789',
  channelType: 'group',
  owner: false,
  callId: 'turn:mark',
}
const args = {
  action: 'contact_mark_bot',
  input: {
    user_id: '567890',
    message_id: '11',
    reason: '连续互动中出现明确的机器人控制信息',
  },
}

function fixture(patch: Partial<SocialMessageRecord> = {}) {
  const data = new Map<string, string>()
  const row: SocialMessageRecord = {
    id: 1,
    agentId: 'keromi',
    platform: 'qq',
    accountId: '123456',
    channelId: '456789',
    channelType: 'group',
    msgId: '11',
    senderId: '567890',
    senderName: '测试联系人',
    content: '测试消息',
    rawEventJson: '{}',
    isSummarized: false,
    timestamp: new Date().toISOString(),
    ...patch,
  }
  const getByMsgId = vi.fn(async () => row as SocialMessageRecord | null)
  const callApi = vi.fn(async () => ({
    status: 'ok',
    retcode: 0,
    data: { app_version: '4.18.38' },
  }))
  const markBot = vi.fn(async () => ({ added: true, user_id: '567890', kind: 'bot' }))
  const adapter = {
    getConnectedAccountIds: () => ['123456', '234567'],
    callApi,
  } as unknown as NapcatAdapter
  const service = new SocialCommonOperations(
    {
      active: () => true,
      config: {
        get: async (key) => data.get(key),
        set: async (key, value) => {
          data.set(key, value)
        },
      },
      storage: { getByMsgId } as unknown as SocialStoragePort,
      prepareImage: vi.fn(),
      send: vi.fn(),
      groupState: vi.fn(),
      configureGroupState: vi.fn(),
      markBot,
    } as SocialOperationDependencies,
    () => adapter.getConnectedAccountIds(),
  )
  return { service, markBot, getByMsgId, callApi }
}

describe('社交机器人标记的来源边界', () => {
  it('只有账号和依据即可标记，没有当前会话发言也不查询来源消息', async () => {
    const f = fixture()
    const result = JSON.parse(
      await f.service.execute(
        'social',
        {
          action: 'contact_mark_bot',
          input: { user_id: '678901', reason: '主人明确指认这是另一个 Agent 的 QQ' },
        },
        scope,
      ),
    )
    expect(result.success).toBe(true)
    expect(f.getByMsgId).not.toHaveBeenCalled()
    expect(f.markBot).toHaveBeenCalledWith(scope, {
      userId: '678901',
      messageId: undefined,
      reason: '主人明确指认这是另一个 Agent 的 QQ',
    })
  })
  it('当前群聊实际发送者可被标记，恢复同一工具调用不重复写入，也不修改 QQ 资料', async () => {
    const f = fixture()
    const result = JSON.parse(await f.service.execute('social', args, scope))
    expect(result).toMatchObject({ success: true, data: { added: true, user_id: '567890' } })
    await f.service.execute('social', args, scope)
    expect(f.markBot).toHaveBeenCalledTimes(1)
    expect(f.markBot).toHaveBeenCalledWith(scope, {
      userId: '567890',
      messageId: '11',
      reason: args.input.reason,
    })
    expect(f.getByMsgId).toHaveBeenCalledWith(
      'keromi',
      '11',
      '123456',
      expect.objectContaining({ platform: 'qq', accountId: '123456' }),
    )
    expect(f.callApi).not.toHaveBeenCalled()
  })
  it.each([
    { agentId: 'pero' },
    { platform: 'other' },
    { senderId: '678901' },
    { msgId: '22' },
    { channelType: 'other' },
  ])('提供佐证时不能伪造角色、平台、发送者或消息来源：%j', async (patch) => {
    const f = fixture(patch)
    // 主人身份也不能让伪造消息通过核验。
    const result = JSON.parse(await f.service.execute('social', args, { ...scope, owner: true }))
    expect(result).toMatchObject({ success: false, rejected: true })
    expect(f.markBot).not.toHaveBeenCalled()
  })
  it.each([
    { channelId: '678901' },
    { channelType: 'private' },
    { accountId: '234567', channelId: '678901', channelType: 'private' },
  ])('允许跨群聊、私聊与接入账号的真实佐证，保存实际出处：%j', async (patch) => {
    const f = fixture(patch)
    const result = JSON.parse(await f.service.execute('social', args, scope))
    expect(result.success).toBe(true)
    expect(f.markBot).toHaveBeenCalledWith(
      { ...scope, ...patch },
      {
        userId: '567890',
        messageId: '11',
        reason: args.input.reason,
      },
    )
  })
  it('优先查当前账号，未找到时可使用其他账号收到的消息作为佐证', async () => {
    const f = fixture({ accountId: '234567', channelType: 'private', channelId: '678901' })
    f.getByMsgId.mockResolvedValueOnce(null)
    expect(JSON.parse(await f.service.execute('social', args, scope)).success).toBe(true)
    expect(f.getByMsgId).toHaveBeenCalledWith(
      'keromi',
      '11',
      undefined,
      expect.objectContaining({ platform: 'qq', accountId: undefined }),
    )
    expect(f.markBot).toHaveBeenCalledWith(
      { ...scope, accountId: '234567', channelType: 'private', channelId: '678901' },
      { userId: '567890', messageId: '11', reason: args.input.reason },
    )
  })
  it('已提供但不存在的佐证、空白依据均在写入前拒绝', async () => {
    const f = fixture()
    f.getByMsgId.mockResolvedValue(null)
    expect(JSON.parse(await f.service.execute('social', args, scope)).success).toBe(false)
    expect(
      JSON.parse(
        await f.service.execute(
          'social',
          {
            ...args,
            input: { ...args.input, reason: '  ' },
          },
          scope,
        ),
      ).success,
    ).toBe(false)
    expect(f.markBot).not.toHaveBeenCalled()
  })
  it('主应用目录不展示标记工具，伪造主应用调用拒绝', async () => {
    const f = fixture()
    const host = { ...scope, host: true }
    expect(JSON.stringify(await f.service.definitions(scope))).toContain('contact_mark_bot')
    expect(JSON.stringify(await f.service.definitions(host))).not.toContain('contact_mark_bot')
    expect(JSON.parse(await f.service.execute('social', args, host)).success).toBe(false)
    expect(f.markBot).not.toHaveBeenCalled()
  })
})
