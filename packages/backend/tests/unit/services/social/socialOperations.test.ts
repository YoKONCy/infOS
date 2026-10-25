import { SocialCommonOperations } from '@infos/social/runtime/socialCommonOperations'
import type { SocialOperationDependencies } from '@infos/social/runtime/socialOperations'
import { describe, expect, it, vi } from 'vitest'
import {
  NapcatOperations as SocialOperations,
  unwrapNapcatResponse,
  type SocialOperationScope,
} from '@infos/social/adapters/napcat/napcatOperations'
import type { NapcatAdapter } from '@infos/social/adapters/napcat'
import type { SocialStoragePort } from '@infos/shared'

const accountId = '123456789'
const scope: SocialOperationScope = {
  platform: 'qq',
  agentId: 'pero',
  accountId,
  channelId: '987654321',
  channelType: 'private',
  owner: true,
  callId: 'turn:call',
}
function fixture(
  overrides: Partial<
    ConstructorParameters<typeof SocialOperations>[0] & SocialOperationDependencies
  > = {},
) {
  const values = new Map<string, string>()
  const callApi = vi.fn(async (action: string) => ({
    status: 'ok',
    retcode: 0,
    data:
      action === 'get_version_info'
        ? { app_version: '4.18.38' }
        : action === 'send_qzone_msg'
          ? { tid: 'post123' }
          : null,
  }))
  const adapter = {
    getConnectedAccountIds: () => [accountId, '234567890'],
    callApi,
    sendMessage: vi.fn(),
  } as unknown as NapcatAdapter
  const storage = { getByMsgId: vi.fn(async () => null) } as unknown as SocialStoragePort
  const deps = {
    adapter: () => adapter,
    active: () => true,
    config: {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        values.set(key, value)
      },
    },
    storage,
    prepareImage: vi.fn(async () => 'base64://aW1hZ2U='),
    ...overrides,
  } satisfies ConstructorParameters<typeof SocialOperations>[0]
  const service = new SocialCommonOperations(
    deps as SocialOperationDependencies,
    () => adapter.getConnectedAccountIds(),
    new SocialOperations(deps),
  )
  return { service, callApi, values, storage }
}

describe('三个社交工具的账号与副作用边界', () => {
  it('群策略工具只修改当前群并返回运行时状态，不向 QQ 发送配置请求', async () => {
    const state = { policy: { reviewIntervalSeconds: 60 }, nextReviewAt: 1234, gate: 'busy' }
    const groupState = vi.fn(() => state)
    const configureGroupState = vi.fn(async () => state)
    const { service, callApi } = fixture({ groupState, configureGroupState })
    const current = { ...scope, owner: false, channelType: 'group' as const }
    const definitions = await service.definitions(current)
    const groupTools = definitions.find((tool) => tool.function.name === 'social_group')!
    expect(JSON.stringify(groupTools)).toContain('state_get')
    expect(JSON.stringify(groupTools)).toContain('state_configure')
    callApi.mockClear()
    const configured = JSON.parse(
      await service.execute(
        'social_group',
        {
          action: 'state_configure',
          input: { group_id: current.channelId, policy: { reviewIntervalSeconds: 60 } },
        },
        current,
      ),
    )
    expect(configured).toMatchObject({ success: true, data: state })
    expect(configureGroupState).toHaveBeenCalledWith(
      current,
      current.channelId,
      { reviewIntervalSeconds: 60 },
      false,
    )
    const queried = JSON.parse(
      await service.execute(
        'social_group',
        {
          action: 'state_get',
          input: { group_id: current.channelId },
        },
        current,
      ),
    )
    expect(queried.data).toEqual(state)
    expect(callApi).not.toHaveBeenCalled()
    const foreign = JSON.parse(
      await service.execute(
        'social_group',
        {
          action: 'state_configure',
          input: { group_id: '111111111', reset: true },
        },
        current,
      ),
    )
    expect(foreign.success).toBe(false)
    expect(configureGroupState).toHaveBeenCalledTimes(1)
  })

  it('拒绝空策略、未知字段及越界值，恢复默认也必须返回实际状态', async () => {
    const configureGroupState = vi.fn(async () => ({
      override: {},
      policy: { minMessagesForReview: 3 },
    }))
    const { service } = fixture({ groupState: vi.fn(), configureGroupState })
    const current = { ...scope, channelType: 'group' as const }
    for (const policy of [
      {},
      { unknown: true },
      { minMessagesForReview: 21 },
      { reviewIntervalSeconds: 1 },
    ]) {
      const result = JSON.parse(
        await service.execute(
          'social_group',
          {
            action: 'state_configure',
            input: { group_id: current.channelId, policy },
          },
          current,
        ),
      )
      expect(result.success).toBe(false)
    }
    expect(configureGroupState).not.toHaveBeenCalled()
    const result = JSON.parse(
      await service.execute(
        'social_group',
        {
          action: 'state_configure',
          input: { group_id: current.channelId, reset: true },
        },
        current,
      ),
    )
    expect(result).toMatchObject({
      success: true,
      data: { override: {}, policy: { minMessagesForReview: 3 } },
    })
  })
  it('未开启视觉时不展示读图操作，伪造调用也不会进入图片执行器', async () => {
    const { service } = fixture()
    const textOnly = { ...scope, enableVision: false }
    const definitions = await service.definitions(textOnly)
    expect(JSON.stringify(definitions)).not.toContain('image_read')
    const legacy = vi.fn()
    const result = JSON.parse(
      await service.execute(
        'social',
        {
          action: 'image_read',
          input: { message_ids: ['22'] },
        },
        textOnly,
        legacy,
      ),
    )
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('未开启视觉能力'),
    })
    expect(legacy).not.toHaveBeenCalled()
  })

  it('普通群友看不到账号写操作，也不能通过伪造参数执行', async () => {
    const { service, callApi } = fixture()
    const visitor = { ...scope, owner: false, channelType: 'group' as const }
    const definitions = await service.definitions(visitor)
    const account = definitions.find((tool) => tool.function.name === 'social_account')!
    expect(JSON.stringify(account)).not.toContain('qzone_publish')
    const result = JSON.parse(
      await service.execute(
        'social_account',
        { action: 'qzone_publish', input: { content: '测试', visibility: 'private' } },
        visitor,
      ),
    )
    expect(result.success).toBe(false)
    expect(callApi.mock.calls.some((call) => call[0] === 'send_qzone_msg')).toBe(false)
  })

  it('明确绑定所选账号，不借用默认连接', async () => {
    const { service, callApi } = fixture()
    await service.execute(
      'social',
      { action: 'contacts_list', account_id: '234567890', input: {} },
      scope,
    )
    expect(callApi).toHaveBeenCalledWith('get_friend_list', {}, 15000, '234567890', undefined)
  })

  it('拒绝未知字段和其他会话操作，不发送请求', async () => {
    const { service, callApi } = fixture()
    const visitor = { ...scope, owner: false, channelType: 'group' as const }
    expect(
      JSON.parse(
        await service.execute(
          'social_group',
          { action: 'info', input: { group_id: '111111111' } },
          visitor,
        ),
      ).success,
    ).toBe(false)
    expect(
      JSON.parse(
        await service.execute(
          'social_account',
          { action: 'profile_update', input: { nickname: '测试', arbitrary: true } },
          scope,
        ),
      ).success,
    ).toBe(false)
    expect(callApi).not.toHaveBeenCalled()
  })

  it('业务错误不能被正常的 OneBot 信封掩盖', () => {
    expect(() =>
      unwrapNapcatResponse({ status: 'ok', retcode: 0, data: { result: 7, errMsg: '没有权限' } }),
    ).toThrow('没有权限')
    expect(() =>
      unwrapNapcatResponse({
        status: 'ok',
        retcode: 0,
        data: { valid: false, message: '不是好友' },
      }),
    ).toThrow('不是好友')
    expect(() => unwrapNapcatResponse({ status: 'failed', retcode: 1400, data: null })).toThrow()
  })

  it('发布保存 tid 与可见范围，相同调用恢复时不会再发布', async () => {
    const { service, callApi } = fixture()
    const args = {
      action: 'qzone_publish',
      input: { content: '今天的创作', visibility: 'friends' },
    }
    const first = JSON.parse(await service.execute('social_account', args, scope))
    const again = JSON.parse(await service.execute('social_account', args, scope))
    expect(first).toMatchObject({ success: true, data: { tid: 'post123' } })
    expect(again.success).toBe(true)
    expect(callApi.mock.calls.filter((call) => call[0] === 'send_qzone_msg')).toHaveLength(1)
    expect(callApi).toHaveBeenCalledWith(
      'send_qzone_msg',
      { content: '今天的创作', images: [], ugc_right: 4 },
      120000,
      accountId,
      undefined,
    )
    const records = JSON.parse(
      await service.execute('social_account', { action: 'qzone_records', input: {} }, scope),
    )
    expect(records.data.posts[0]).toMatchObject({ tid: 'post123', visibility: 'friends' })
  })

  it('结果不明时阻止新调用重复提交，核验未发送后才允许再试', async () => {
    const { service, callApi } = fixture()
    callApi.mockImplementation(async (action) => {
      if (action === 'set_friend_remark') throw new Error('请求超时')
      return { status: 'ok', retcode: 0, data: null }
    })
    const args = { action: 'contact_remark', input: { user_id: '333333333', remark: '朋友' } }
    const first = JSON.parse(await service.execute('social', args, scope))
    const retry = JSON.parse(
      await service.execute('social', args, { ...scope, callId: 'another-call' }),
    )
    expect(first).toMatchObject({ success: false, uncertain: true })
    expect(retry.operation_id).toBe(first.operation_id)
    expect(callApi.mock.calls.filter((call) => call[0] === 'set_friend_remark')).toHaveLength(1)
    await service.execute(
      'social_account',
      {
        action: 'operation_resolve',
        input: { operation_id: first.operation_id, decision: 'not_sent' },
      },
      scope,
    )
    await service.execute('social', args, { ...scope, callId: 'confirmed-retry' })
    expect(callApi.mock.calls.filter((call) => call[0] === 'set_friend_remark')).toHaveLength(2)
  })

  it('关闭应用后拒绝继续操作', async () => {
    const { service, callApi } = fixture()
    service.close()
    expect(
      JSON.parse(await service.execute('social', { action: 'contacts_list', input: {} }, scope))
        .success,
    ).toBe(false)
    expect(callApi).not.toHaveBeenCalled()
  })
})
