import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiscordAdapter } from '@infos/social/adapters/discord/discordAdapter'
import { PlatformStore } from '@infos/social/adapters/platformStore'
import type { InboundMessage } from '@infos/social/runtime/types'

const fixtures = vi.hoisted(() => ({
  clients: [] as Array<{ emit(name: string, value?: unknown): boolean; destroyed: boolean }>,
  send: vi.fn(async () => ({ id: 'server-message' })),
  fetchMessages: vi.fn(async () => new Map()),
}))
vi.mock('@infos/social/node_modules/discord.js', async () => {
  const actual = await vi.importActual<typeof import('@infos/social/node_modules/discord.js')>(
    '@infos/social/node_modules/discord.js',
  )
  const { EventEmitter } = await import('node:events')
  class FakeClient extends EventEmitter {
    destroyed = false
    ready = false
    user = { id: 'bot-1' }
    channels = {
      cache: new Map(),
      fetch: vi.fn(async () => ({
        id: 'channel-1',
        isSendable: () => true,
        isTextBased: () => true,
        send: fixtures.send,
        messages: { fetch: fixtures.fetchMessages },
      })),
    }
    constructor() {
      super()
      fixtures.clients.push(this)
    }
    async login() {
      this.ready = true
      queueMicrotask(() => this.emit(actual.Events.ClientReady, this))
      return '测试令牌'
    }
    isReady() {
      return this.ready && !this.destroyed
    }
    async destroy() {
      this.destroyed = true
      this.ready = false
    }
  }
  class FakeRest {
    setToken() {
      return this
    }
    async get() {
      return { id: 'bot-1', username: '测试机器人', bot: true }
    }
  }
  return { ...actual, Client: FakeClient, REST: FakeRest }
})
const directories: string[] = []
const running: DiscordAdapter[] = []
afterEach(async () => {
  for (const adapter of running.splice(0)) await adapter.disconnect()
  fixtures.clients.length = 0
  vi.clearAllMocks()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function setup(fullGroupMessages = true) {
  const directory = await mkdtemp(join(process.env.INFOS_TEST_TEMP_ROOT!, 'discord-adapter-'))
  directories.push(directory)
  const adapter = new DiscordAdapter({ id: 'discord' }, 'pero', { privateRoot: directory })
  running.push(adapter)
  await adapter.manage('account_add', { token: 'DISCORD_PRIVATE_TOKEN', fullGroupMessages })
  await adapter.connect()
  await vi.waitFor(() => expect(adapter.getConnectedAccountIds()).toEqual(['bot-1']))
  return { adapter, client: fixtures.clients[0]!, directory }
}
function message(id = 'message-1', channelId = 'thread-1') {
  return {
    id,
    channelId,
    createdTimestamp: Date.now(),
    author: { id: 'user-1', username: '群友', bot: true },
    inGuild: () => true,
    content: '你好',
    attachments: new Map(),
    mentions: { users: new Map([['bot-1', {}]]) },
  }
}
describe('Discord Gateway 适配器', () => {
  it('帖子线程独立映射，并在确认接收前保留私有收件箱', async () => {
    const { adapter, client, directory } = await setup()
    let accept!: () => void
    const receive = vi.fn(
      (_message: InboundMessage) =>
        new Promise<void>((resolve) => {
          accept = resolve
        }),
    )
    adapter.bindInboundReceiver(receive)
    client.emit('messageCreate', message())
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(receive.mock.calls[0]![0]).toMatchObject({
      platform: 'discord',
      accountId: 'bot-1',
      channelId: 'thread-1',
      senderKind: 'bot',
      isMentioned: true,
    })
    const store = new PlatformStore(directory, JSON.stringify(['discord', 'discord']))
    expect(
      (await store.read<{ pending: Record<string, unknown[]> }>({ pending: {} })).pending['bot-1'],
    ).toHaveLength(1)
    accept()
    await vi.waitFor(async () =>
      expect(
        (await store.read<{ pending: Record<string, unknown[]> }>({ pending: {} })).pending[
          'bot-1'
        ],
      ).toHaveLength(0),
    )
    expect(JSON.stringify(await adapter.managementSnapshot())).not.toContain(
      'DISCORD_PRIVATE_TOKEN',
    )
  })
  it('只有明确的结构化用户提及会进入 allowed_mentions，退出时销毁 Gateway', async () => {
    const { adapter, client } = await setup(false)
    expect(adapter.canObserveGroup('bot-1', 'channel-1')).toBe(false)
    await adapter.sendMessage({
      accountId: 'bot-1',
      channelId: 'channel-1',
      channelType: 'group',
      content: '@everyone 普通正文',
      mentions: ['123456'],
    })
    expect(fixtures.send).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: { parse: [], users: ['123456'], repliedUser: false },
      }),
    )
    await adapter.disconnect()
    expect(client.destroyed).toBe(true)
    expect(adapter.getConnectedAccountIds()).toEqual([])
  })
  it('退出取消尚未确认的入站等待，重启后可恢复私有收件箱', async () => {
    const { adapter, client, directory } = await setup()
    const receive = vi.fn(() => new Promise<void>(() => {}))
    adapter.bindInboundReceiver(receive)
    client.emit('messageCreate', message())
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    await adapter.disconnect()
    const saved = await new PlatformStore(directory, JSON.stringify(['discord', 'discord'])).read<{
      pending: Record<string, InboundMessage[]>
    }>({ pending: {} })
    expect(saved.pending['bot-1']).toHaveLength(1)
    const recovered: InboundMessage[] = []
    adapter.bindInboundReceiver(async (message) => {
      recovered.push(message)
    })
    await adapter.connect()
    await vi.waitFor(() => expect(recovered).toHaveLength(1))
    expect(recovered[0]!.messageId).toBe('message-1')
  })
})
