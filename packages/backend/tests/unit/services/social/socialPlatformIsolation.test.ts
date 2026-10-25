import { describe, expect, it, vi } from 'vitest'
import { AbstractSocialAdapter } from '@infos/social/adapters/ISocialAdapter'
import { createSocialAdapters } from '@infos/social/adapters/registry'
import { SocialSessionManager } from '@infos/social/runtime/socialSessionManager'
import {
  SocialOperations,
  type SocialOperationDependencies,
  type SocialOperationScope,
} from '@infos/social/runtime/socialOperations'
import { SocialCommonOperations } from '@infos/social/runtime/socialCommonOperations'
import { currentSocialScope } from '@infos/social/runtime/socialStorageScope'
import { SocialAppRuntime } from '@infos/social/runtime'
import { SocialLoopGuard, normalizeLoopPolicy } from '@infos/social/runtime/socialLoopGuard'
import type { InboundMessage } from '@infos/social/runtime/types'

/** 使用不带 QQ 协议字段、账号含非数字字符的平台验证通用契约。 */
class OtherAdapter extends AbstractSocialAdapter {
  readonly platform = 'other'
  getOwnerId() {
    return '@owner:example.org'
  }
  getConnectedAccountIds() {
    return ['account-A']
  }
  async connect() {}
  async disconnect() {}
  async sendMessage() {}
  async getStatus() {
    return { platform: this.platform, connected: true, latencyMs: 0 }
  }
}

const message = (platform = 'other'): InboundMessage => ({
  platform,
  accountId: 'account-A',
  messageId: 'same-id',
  agentId: 'pero',
  channelId: 'room:topic:1',
  channelType: 'group',
  senderId: '@user:example.org',
  senderName: '测试联系人',
  content: '你好',
})
const scope: SocialOperationScope = {
  ...message(),
  owner: false,
  callId: 'operation',
}

describe('平台无关的社交边界', () => {
  it('从旧配置启用微信保留 QQ 主人和好友策略，不在配置中写入凭据', async () => {
    let config: Record<string, unknown> = { ownerQq: '123456', autoAcceptFriend: false }
    const runtime = new SocialAppRuntime()
    Object.assign(runtime, {
      ctx: {
        instanceId: 'enable-platform',
        configRepo: {
          get: async () => JSON.stringify(config),
          set: async (_key: string, value: string) => {
            config = JSON.parse(value)
          },
        },
      },
      adapters: createSocialAdapters(config, 'pero'),
      socialBridge: {
        registerAdapter: vi.fn(),
        closeSessionsExcept: vi.fn(),
        createMessagingProvider: () => null,
      },
    })
    await (runtime as unknown as { enablePlatform(type: string): Promise<void> }).enablePlatform(
      'weixin-ilink',
    )
    expect(config.connections).toMatchObject([
      { adapter: 'napcat', ownerId: '123456', autoAcceptFriend: false },
      { adapter: 'weixin-ilink', enabled: true },
    ])
    expect(JSON.stringify(config)).not.toMatch(/token|credential/i)
    expect(runtime.getAdapters().map((adapter) => adapter.platform)).toEqual(['qq', 'weixin'])
  })
  it('装配可注入非 QQ 适配器，规范身份与私聊会话号不要求等于用户号', () => {
    const adapters = createSocialAdapters(
      { connections: [{ adapter: 'other', id: 'other' }] },
      'pero',
      [{ type: 'other', platform: 'other', create: () => new OtherAdapter() }],
    )
    const normalized = adapters[0]!.normalizeInbound({
      ...message(),
      channelType: 'private',
      channelId: 'dm-channel-9',
      senderId: '@owner:example.org',
    })
    expect(normalized).toMatchObject({
      isOwner: true,
      accountId: 'account-A',
      messageId: 'same-id',
      channelId: 'dm-channel-9',
    })
  })

  it('相同账号、群号和消息号在不同平台创建独立状态机', () => {
    const manager = new SocialSessionManager(vi.fn(async () => ({ type: 'pass' as const })))
    const first = manager.getOrCreate(message('first'))
    const second = manager.getOrCreate(message('second'))
    first.phase = 'running'
    first.pendingMessages.push(message('first'))
    expect(second).toMatchObject({ phase: 'ready', pendingMessages: [] })
    expect(second).not.toBe(first)
    expect(manager.closeSession('pero', first.channelId)).toBe(false)
    expect(
      manager.closeSession('pero', first.channelId, {
        platform: 'first',
        accountId: 'account-A',
        channelType: 'group',
      }),
    ).toBe(true)
    expect(manager.listSessions()).toEqual([second])
    manager.stop()
  })

  it('无需实现 QQ 业务即可使用群策略工具，且无法修改其他群', async () => {
    const configure = vi.fn(async () => ({
      platform: currentSocialScope()?.platform,
      applied: true,
    }))
    const deps = {
      active: () => true,
      groupState: vi.fn(),
      configureGroupState: configure,
      markBot: vi.fn(),
      storage: {},
      config: { get: vi.fn(), set: vi.fn() },
      send: vi.fn(),
      prepareImage: vi.fn(),
    } as unknown as SocialOperationDependencies
    const operations = new SocialOperations()
    operations.register('other', new SocialCommonOperations(deps, () => ['account-A']))
    const definitions = await operations.definitions(scope)
    expect(JSON.stringify(definitions)).toContain('state_configure')
    expect(JSON.stringify(definitions)).not.toMatch(/qzone|QQ|poke/)
    const result = JSON.parse(
      await operations.execute(
        'social_group',
        {
          action: 'state_configure',
          input: { group_id: scope.channelId, policy: { reviewIntervalSeconds: 60 } },
        },
        scope,
      ),
    )
    expect(result).toMatchObject({ success: true, data: { platform: 'other', applied: true } })
    const rejected = JSON.parse(
      await operations.execute(
        'social_group',
        { action: 'state_configure', input: { group_id: 'another-room', reset: true } },
        scope,
      ),
    )
    expect(rejected.success).toBe(false)
    expect(configure).toHaveBeenCalledTimes(1)
    operations.register('second', new SocialCommonOperations(deps, () => ['account-A']))
    expect(() => operations.execute('social_group', {}, { ...scope, platform: undefined })).toThrow(
      'SOCIAL_PLATFORM_REQUIRED',
    )
    operations.close()
  })

  it('机器人名单限定平台，同名用户在其他平台仍是未知身份', () => {
    const guard = new SocialLoopGuard(
      { get: vi.fn(), set: vi.fn() },
      () => normalizeLoopPolicy({ knownBotIds: ['other:@user:example.org'] }),
      () => [],
      () => undefined,
    )
    expect(guard.classify(message())).toBe('bot')
    expect(guard.classify(message('second'))).toBe('unknown')
  })

  it('停止时先取消正在等待的连接更新，避免退出卡在握手阶段', async () => {
    const runtime = new SocialAppRuntime()
    const controller = new AbortController()
    const stop = vi.fn(async () => {})
    Object.assign(runtime, {
      lifetime: controller,
      adapterUpdates: new Promise<void>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
      socialBridge: { stop },
    })
    await runtime.onStop()
    expect(controller.signal.aborted).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('主人配置只取消所属平台的会话，禁用连接会注销并断开对应适配器', async () => {
    const make = (platform: string, owner: string) =>
      Object.assign(new OtherAdapter(), {
        platform,
        getOwnerId: () => owner,
        configure: (config: Record<string, unknown>) => {
          owner = String(config.ownerId ?? '')
        },
        disconnect: vi.fn(async () => {}),
      })
    const factories = ['first', 'second'].map((platform) => ({
      type: platform,
      platform,
      create: (config: Record<string, unknown>) => make(platform, String(config.ownerId ?? '')),
    }))
    let config = {
      connections: ['first', 'second'].map((id) => ({ id, adapter: id, ownerId: 'old-owner' })),
    }
    const adapters = createSocialAdapters(config, 'pero', factories)
    const bridge = {
      closeSessionsExcept: vi.fn(),
      unregisterAdapter: vi.fn(),
      createMessagingProvider: () => null,
    }
    const runtime = new SocialAppRuntime(factories)
    Object.assign(runtime, {
      adapters,
      socialBridge: bridge,
      ctx: {
        instanceId: 'scope-test',
        configRepo: { get: async () => JSON.stringify(config) },
        logger: { warn: vi.fn() },
      },
    })
    config.connections[0]!.ownerId = 'new-owner'
    await runtime.onConfigChanged(['social'])
    const allow = bridge.closeSessionsExcept.mock.calls[0]![0]
    expect(allow({ platform: 'first' })).toBe(false)
    expect(allow({ platform: 'second' })).toBe(true)
    config = { connections: config.connections.filter((item) => item.id === 'second') }
    await runtime.onConfigChanged(['social'])
    expect(adapters[0]!.disconnect).toHaveBeenCalledOnce()
    expect(bridge.unregisterAdapter).toHaveBeenCalledWith('first')
    expect(runtime.getAdapters().map((item) => item.platform)).toEqual(['second'])
  })
})
