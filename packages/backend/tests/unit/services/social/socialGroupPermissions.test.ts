import { NAPCAT_ACTIONS as SOCIAL_ACTIONS } from '@infos/social/adapters/napcat/napcatActions'
import { describe, expect, it, vi } from 'vitest'
import type { SocialStoragePort } from '@infos/shared'
import {
  NapcatOperations as SocialOperations,
  type SocialOperationScope,
} from '@infos/social/adapters/napcat/napcatOperations'
import type { NapcatAdapter } from '@infos/social/adapters/napcat'

type Role = 'member' | 'admin' | 'owner'
const accountId = '123456789'
const secondAccount = '234567890'
const groupId = '987654321'
const otherGroup = '876543210'
const targetId = '345678901'
const scope: SocialOperationScope = {
  agentId: 'pero',
  accountId,
  channelType: 'private',
  channelId: '456789012',
  owner: true,
  callId: '权限测试',
}
const wholeBan = { action: 'whole_ban', input: { group_id: groupId, enable: true } }

function fixture(role: Role = 'member') {
  const roles = new Map<string, Role>([[`${accountId}:${groupId}:${accountId}`, role]])
  const values = new Map<string, string>()
  const replies = new Map<string, unknown>()
  const callApi = vi.fn(
    async (
      action: string,
      input: Record<string, unknown>,
      _timeout?: number,
      selected = accountId,
    ): Promise<unknown> => {
      if (replies.has(action)) return replies.get(action)
      let data: unknown = null
      if (action === 'get_version_info') data = { app_version: '4.18.38' }
      if (action === 'get_group_list') data = [{ group_id: groupId }, { group_id: otherGroup }]
      if (action === 'get_group_member_info')
        data = {
          group_id: input.group_id,
          user_id: input.user_id,
          role: roles.get(`${selected}:${input.group_id}:${input.user_id}`) ?? 'member',
        }
      return { status: 'ok', retcode: 0, data }
    },
  )
  const getByMsgId = vi.fn(async (): Promise<unknown> => null)
  const service = new SocialOperations({
    adapter: () =>
      ({
        getConnectedAccountIds: () => [accountId, secondAccount],
        callApi,
      }) as unknown as NapcatAdapter,
    active: () => true,
    config: {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        values.set(key, value)
      },
    },
    storage: { getByMsgId } as unknown as SocialStoragePort,
    prepareImage: vi.fn(async () => 'base64://aW1hZ2U='),
  })
  const execute = async (args: Record<string, unknown>, current = scope) =>
    JSON.parse(await service.execute('social_group', args, current)) as Record<string, unknown>
  const definition = async (current = scope) =>
    (await service.definitions(current)).find((tool) => tool.function.name === 'social_group')!
      .function
  return { service, roles, values, replies, callApi, getByMsgId, execute, definition }
}

function actions(definition: Awaited<ReturnType<ReturnType<typeof fixture>['definition']>>) {
  return (definition.parameters.properties as Record<string, { enum?: string[] }>).action!.enum!
}

describe('群身份与主人授权分别校验', () => {
  it.each(['member', 'admin', 'owner'] as const)('%s 身份只展示对应管理操作', async (role) => {
    const f = fixture(role)
    const visible = actions(await f.definition())
    for (const action of SOCIAL_ACTIONS.filter((item) => item.groupRole)) {
      const allowed = role === 'owner' || (role === 'admin' && action.groupRole === 'admin')
      expect(visible.includes(action.action)).toBe(allowed)
    }
    expect(visible).toContain('info')
    expect(visible).toContain('card_set')
    expect(visible).toContain('leave')
  })

  it('非主人即使机器人为群主，也看不到或执行不了管理操作', async () => {
    const f = fixture('owner')
    const visitor = { ...scope, owner: false, channelType: 'group' as const, channelId: groupId }
    expect(actions(await f.definition(visitor))).not.toContain('ban')
    f.callApi.mockClear()
    expect(await f.execute(wholeBan, visitor)).toMatchObject({
      success: false,
      error: '此操作仅对主人开放',
    })
    expect(f.callApi).not.toHaveBeenCalled()
  })

  it('当前群没有权限时，不借用其他群的群主权限展示操作', async () => {
    const f = fixture()
    f.roles.set(`${accountId}:${otherGroup}:${accountId}`, 'owner')
    const visible = actions(
      await f.definition({ ...scope, channelType: 'group', channelId: groupId }),
    )
    expect(visible).not.toContain('ban')
    expect(f.callApi.mock.calls.some((call) => call[0] === 'get_group_list')).toBe(false)
  })

  it('主应用按账号列出管理范围，执行不借用另一个账号的权限', async () => {
    const f = fixture()
    f.roles.set(`${secondAccount}:${otherGroup}:${secondAccount}`, 'admin')
    const definition = await f.definition({ ...scope, accountId: undefined, host: true })
    expect(actions(definition)).toContain('ban')
    expect(actions(definition)).not.toContain('admin_set')
    expect(definition.description).toContain(`QQ ${secondAccount}：群 ${otherGroup}`)
    expect(await f.execute(wholeBan)).toMatchObject({
      success: false,
      code: 'GROUP_PERMISSION_DENIED',
    })
    expect(f.callApi.mock.calls.some((call) => call[0] === 'set_group_whole_ban')).toBe(false)
    expect(
      await f.execute({
        action: 'whole_ban',
        account_id: secondAccount,
        input: { group_id: otherGroup, enable: true },
      }),
    ).toMatchObject({ success: true })
  })

  it('管理操作的群号枚举仅包含有权限的群', async () => {
    const f = fixture('admin')
    const definition = await f.definition()
    const branches = (
      definition.parameters.properties as Record<
        string,
        {
          anyOf: Array<{
            description: string
            properties: { group_id: { enum?: string[] } }
          }>
        }
      >
    ).input!.anyOf
    expect(
      branches.find((branch) => branch.description === 'ban')!.properties.group_id.enum,
    ).toEqual([groupId])
  })

  it('权限查询失败隐藏管理操作，调用时明确告知未执行', async () => {
    const f = fixture('owner')
    f.replies.set('get_group_member_info', { status: 'failed', retcode: 1200, message: '查询超时' })
    expect(actions(await f.definition())).not.toContain('ban')
    expect(await f.execute(wholeBan)).toMatchObject({
      success: false,
      code: 'GROUP_PERMISSION_UNAVAILABLE',
    })
    expect(f.callApi.mock.calls.some((call) => call[0] === 'set_group_whole_ban')).toBe(false)
  })

  it('不接受其他群或其他账号的成员身份响应', async () => {
    const f = fixture('owner')
    f.replies.set('get_group_member_info', {
      status: 'ok',
      retcode: 0,
      data: { group_id: otherGroup, user_id: secondAccount, role: 'owner' },
    })
    expect(await f.execute(wholeBan)).toMatchObject({
      success: false,
      code: 'GROUP_PERMISSION_UNAVAILABLE',
    })
  })

  it('展示时为管理员，执行前降为成员时必须重新查询并拒绝', async () => {
    const f = fixture('admin')
    expect(actions(await f.definition())).toContain('whole_ban')
    f.roles.set(`${accountId}:${groupId}:${accountId}`, 'member')
    expect(await f.execute(wholeBan)).toMatchObject({
      success: false,
      code: 'GROUP_PERMISSION_DENIED',
    })
    expect(actions(await f.definition())).not.toContain('whole_ban')
    expect(f.callApi.mock.calls.some((call) => call[0] === 'set_group_whole_ban')).toBe(false)
  })

  it.each(['ban', 'kick'] as const)('管理员不能 %s 同级管理员或群主', async (action) => {
    for (const role of ['admin', 'owner'] as const) {
      const f = fixture('admin')
      f.roles.set(`${accountId}:${groupId}:${targetId}`, role)
      expect(
        await f.execute({
          action,
          input: {
            group_id: groupId,
            user_id: targetId,
            ...(action === 'ban' ? { duration: 60 } : {}),
          },
        }),
      ).toMatchObject({
        success: false,
        error: '不能管理同级或更高身份的群成员',
      })
      expect(
        f.callApi.mock.calls.some((call) => ['set_group_ban', 'set_group_kick'].includes(call[0])),
      ).toBe(false)
    }
  })

  it('群主可以禁言管理员；普通管理员不能设置管理员或专属头衔', async () => {
    const f = fixture('owner')
    f.roles.set(`${accountId}:${groupId}:${targetId}`, 'admin')
    expect(
      await f.execute({
        action: 'ban',
        input: { group_id: groupId, user_id: targetId, duration: 60 },
      }),
    ).toMatchObject({ success: true })
    f.roles.set(`${accountId}:${groupId}:${accountId}`, 'admin')
    expect(
      await f.execute({
        action: 'admin_set',
        input: { group_id: groupId, user_id: targetId, enable: true },
      }),
    ).toMatchObject({ success: false, code: 'GROUP_PERMISSION_DENIED' })
    expect(
      await f.execute({
        action: 'title_set',
        input: { group_id: groupId, user_id: targetId, special_title: '朋友' },
      }),
    ).toMatchObject({ success: false, code: 'GROUP_PERMISSION_DENIED' })
  })

  it('普通成员可以改自己的群名片和退群，但不能改他人名片或解散群', async () => {
    const f = fixture()
    expect(
      await f.execute({ action: 'card_set', input: { group_id: groupId, card: '新名片' } }),
    ).toMatchObject({ success: true })
    expect(
      await f.execute({
        action: 'card_set',
        input: { group_id: groupId, user_id: targetId, card: '新名片' },
      }),
    ).toMatchObject({ success: false, code: 'GROUP_PERMISSION_DENIED' })
    expect(
      await f.execute({ action: 'leave', input: { group_id: groupId, is_dismiss: true } }),
    ).toMatchObject({ success: false, code: 'GROUP_PERMISSION_DENIED' })
    expect(await f.execute({ action: 'leave', input: { group_id: groupId } })).toMatchObject({
      success: true,
    })
  })

  it('撤回自己的群消息不需管理权限，撤回他人消息需按群身份校验', async () => {
    const f = fixture()
    const row = {
      platform: 'qq',
      accountId,
      channelId: groupId,
      channelType: 'group',
      senderId: accountId,
    }
    f.getByMsgId.mockResolvedValue(row)
    expect(
      JSON.parse(
        await f.service.execute(
          'social',
          { action: 'message_recall', input: { message_id: '1' } },
          scope,
        ),
      ),
    ).toMatchObject({ success: true })
    f.getByMsgId.mockResolvedValue({ ...row, senderId: targetId })
    expect(
      JSON.parse(
        await f.service.execute(
          'social',
          { action: 'message_recall', input: { message_id: '2' } },
          scope,
        ),
      ),
    ).toMatchObject({ success: false, code: 'GROUP_PERMISSION_DENIED' })
    expect(f.callApi.mock.calls.filter((call) => call[0] === 'delete_msg')).toHaveLength(1)
  })

  it.each(['ERR_NOT_GROUP_ADMIN', '权限不足，无法操作', 'permission denied'])(
    '平台权限拒绝 %s 保留原因而不标记结果不明',
    async (message) => {
      const f = fixture('admin')
      f.replies.set('set_group_whole_ban', { status: 'failed', retcode: 1200, message })
      const result = await f.execute(wholeBan)
      expect(result).toMatchObject({ success: false, code: 'GROUP_PERMISSION_DENIED' })
      expect(result.error).toContain(message)
      expect(result.uncertain).toBeUndefined()
      const records = JSON.parse(f.values.get(`social.operations.${accountId}`)!)
      expect(records[0].status).toBe('failed')
    },
  )

  it('真实超时仍保持结果不明，避免重复群操作', async () => {
    const f = fixture('admin')
    const original = f.callApi.getMockImplementation()!
    f.callApi.mockImplementation(async (...args) => {
      if (args[0] === 'set_group_whole_ban') throw new Error('请求超时')
      return original(...args)
    })
    expect(await f.execute(wholeBan)).toMatchObject({ success: false, uncertain: true })
    expect(await f.execute(wholeBan, { ...scope, callId: '再次调用' })).toMatchObject({
      success: false,
      uncertain: true,
    })
    expect(f.callApi.mock.calls.filter((call) => call[0] === 'set_group_whole_ban')).toHaveLength(1)
  })

  it('排队等待期间权限被撤销时，必须在真正执行前重新判断', async () => {
    const f = fixture('admin')
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const original = f.callApi.getMockImplementation()!
    f.callApi.mockImplementation(async (...args) => {
      if (args[0] === 'set_group_whole_ban') {
        started()
        await waiting
      }
      return original(...args)
    })
    const first = f.execute(wholeBan)
    await entered
    const second = f.execute({ action: 'kick', input: { group_id: groupId, user_id: targetId } })
    f.roles.set(`${accountId}:${groupId}:${accountId}`, 'member')
    release()
    expect(await first).toMatchObject({ success: true })
    expect(await second).toMatchObject({ success: false, code: 'GROUP_PERMISSION_DENIED' })
    expect(f.callApi.mock.calls.some((call) => call[0] === 'set_group_kick')).toBe(false)
  })

  it('群申请列表只返回指定群，不能拿其他群的 flag 执行', async () => {
    const f = fixture('admin')
    f.replies.set('get_group_system_msg', {
      status: 'ok',
      retcode: 0,
      data: {
        join_requests: [
          { group_id: groupId, request_id: 123, checked: false },
          { group_id: otherGroup, request_id: 456, checked: false },
        ],
        invited_requests: [],
        InvitedRequest: [],
      },
    })
    const listing = await f.execute({ action: 'requests', input: { group_id: groupId } })
    expect(listing.data).toMatchObject({ join_requests: [{ group_id: groupId, request_id: 123 }] })
    expect(
      await f.execute({
        action: 'request_handle',
        input: { group_id: groupId, flag: '456', approve: true },
      }),
    ).toMatchObject({ success: false })
    expect(f.callApi.mock.calls.some((call) => call[0] === 'set_group_add_request')).toBe(false)
    expect(
      await f.execute({
        action: 'request_handle',
        input: { group_id: groupId, flag: '123', approve: true },
      }),
    ).toMatchObject({ success: true })
    expect(f.callApi).toHaveBeenCalledWith(
      'set_group_add_request',
      { flag: '123', approve: true },
      15000,
      accountId,
      undefined,
    )
  })
})
