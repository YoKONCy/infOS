import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createCipheriv } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformStore } from '@infos/social/adapters/platformStore'
import { WeixinAdapter, parseWeixinJson } from '@infos/social/adapters/weixin/weixinAdapter'
import {
  TelegramAdapter,
  telegramAddress,
  parseTelegramAddress,
  telegramMention,
} from '@infos/social/adapters/telegram/telegramAdapter'
import type { InboundMessage } from '@infos/social/runtime/types'

const directories: string[] = []
const adapters: Array<{ disconnect(): Promise<void> }> = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.disconnect()
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function directory() {
  const folder = await mkdtemp(join(process.env.INFOS_TEST_TEMP_ROOT!, 'platform-adapters-'))
  directories.push(folder)
  return folder
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
function waitForAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
async function weixin(
  onRequest?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined,
) {
  const folder = await directory()
  const calls: Array<{ url: URL; body: Record<string, unknown> }> = []
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    calls.push({ url, body })
    const custom = onRequest?.(url, init)
    if (custom) return custom
    if (url.pathname.endsWith('get_bot_qrcode'))
      return json({ qrcode: 'qr-session', qrcode_img_content: 'https://weixin.qq.com/login/test' })
    if (url.pathname.endsWith('get_qrcode_status'))
      return json({
        status: 'confirmed',
        bot_token: 'WX_PRIVATE_TOKEN',
        ilink_bot_id: 'bot@im.bot',
        ilink_user_id: 'owner@im.wechat',
        baseurl: 'https://ilinkai.weixin.qq.com',
      })
    if (url.pathname.endsWith('getupdates')) return waitForAbort(init.signal!)
    if (url.pathname.endsWith('sendmessage')) return json({ ret: 0 })
    if (url.pathname.endsWith('notifystart') || url.pathname.endsWith('notifystop'))
      return json({ ret: 0 })
    throw new Error('测试夹具收到未知请求')
  })
  vi.stubGlobal('fetch', fetch)
  const adapter = new WeixinAdapter({ id: 'weixin' }, 'pero', { privateRoot: folder })
  adapters.push(adapter)
  const start = await adapter.manage('login_start', {})
  await adapter.manage('login_poll', { loginId: (start.login as { id: string }).id })
  return { adapter, calls, folder, fetch }
}

describe('平台私有存储与微信协议', () => {
  it('不同平台并发初始化共用有效密钥，同一连接的并发更新不丢数据，文件不含明文凭据', async () => {
    const folder = await directory()
    const first = new PlatformStore(folder, 'first')
    const second = new PlatformStore(folder, 'second')
    await Promise.all([
      first.update<Record<string, string>>({}, (value) => {
        value.token = 'SECRET_TOKEN'
      }),
      second.update<Record<string, string>>({}, (value) => {
        value.token = 'SECOND_TOKEN'
      }),
    ])
    const reopened = new PlatformStore(folder, 'first')
    await Promise.all([
      first.update<Record<string, string>>({}, (value) => {
        value.one = '1'
      }),
      reopened.update<Record<string, string>>({}, (value) => {
        value.two = '2'
      }),
    ])
    expect(await reopened.read({})).toEqual({ token: 'SECRET_TOKEN', one: '1', two: '2' })
    for (const file of (await readdir(folder)).filter((name) => name.endsWith('.vault'))) {
      expect((await readFile(join(folder, file))).toString()).not.toContain('TOKEN')
    }
  })
  it('微信 uint64 消息标识保持精确，不改写正文里的伪造 JSON 片段', () => {
    const source = String.raw`{"message_id":18446744073709551615,"text":"\"message_id\":123"}`
    expect(parseWeixinJson(source)).toEqual({
      message_id: '18446744073709551615',
      text: '"message_id":123',
    })
  })
  it('扫码确认后管理快照不暴露令牌，主人来自已确认扫码身份', async () => {
    const { adapter } = await weixin()
    expect(adapter.getOwnerId()).toBe('owner@im.wechat')
    const snapshot = await adapter.managementSnapshot()
    expect(JSON.stringify(snapshot)).not.toContain('WX_PRIVATE_TOKEN')
    expect(snapshot.accounts).toMatchObject([{ id: 'bot@im.bot', connected: false }])
  })
  it('消息持久接收前不推进微信游标，发送不伪造服务端消息号', async () => {
    let polls = 0
    let accept!: () => void
    const { adapter, folder, calls } = await weixin((url, init) => {
      if (!url.pathname.endsWith('getupdates')) return
      if (++polls > 1) return waitForAbort(init.signal!)
      return json({
        ret: 0,
        get_updates_buf: 'cursor-next',
        msgs: [
          {
            message_id: '123',
            message_type: 1,
            from_user_id: 'owner@im.wechat',
            context_token: 'PRIVATE_CONTEXT',
            item_list: [{ type: 1, text_item: { text: '你好' } }],
          },
        ],
      })
    })
    const received = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        }),
    )
    adapter.bindInboundReceiver(received)
    await adapter.connect()
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce())
    const store = new PlatformStore(folder, JSON.stringify(['weixin', 'weixin']))
    const before = await store.read<{ accounts: Record<string, { cursor?: string }> }>({
      accounts: {},
    })
    expect(before.accounts['bot@im.bot']?.cursor).toBeUndefined()
    expect(polls).toBe(1)
    expect(JSON.stringify(received.mock.calls[0])).not.toContain('PRIVATE_CONTEXT')
    accept()
    await vi.waitFor(() => expect(polls).toBe(2))
    const receipt = await adapter.sendMessage({
      accountId: 'bot@im.bot',
      channelId: 'owner@im.wechat',
      channelType: 'private',
      content: '收到',
    })
    expect(receipt).toMatchObject({ acknowledgement: 'accepted', platformMessageIds: [] })
    expect(receipt.messageId).toBeUndefined()
    expect(
      (
        calls.find((call) => call.url.pathname.endsWith('sendmessage'))!.body.msg as Record<
          string,
          unknown
        >
      ).context_token,
    ).toBe('PRIVATE_CONTEXT')
  })
  it('微信缺少会话上下文时发送前拒绝，不调用发送接口', async () => {
    const { adapter, calls } = await weixin((url) =>
      url.pathname.endsWith('getupdates') ? json({ ret: 0, msgs: [] }) : undefined,
    )
    await adapter.connect()
    await vi.waitFor(() => expect(adapter.getConnectedAccountIds()).toContain('bot@im.bot'))
    await expect(
      adapter.sendMessage({
        accountId: 'bot@im.bot',
        channelId: 'unknown',
        channelType: 'private',
        content: '你好',
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_SENT' })
    expect(calls.some((call) => call.url.pathname.endsWith('sendmessage'))).toBe(false)
  })
  it('接收失败保留微信游标，断开立即取消退避等待', async () => {
    const { adapter, folder } = await weixin((url) =>
      url.pathname.endsWith('getupdates')
        ? json({
            ret: 0,
            get_updates_buf: 'must-not-commit',
            msgs: [
              {
                message_id: '1',
                from_user_id: 'owner',
                item_list: [{ text_item: { text: '你好' } }],
              },
            ],
          })
        : undefined,
    )
    const receive = vi.fn(async () => {
      throw new Error('测试持久化失败')
    })
    adapter.bindInboundReceiver(receive)
    await adapter.connect()
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    const state = await new PlatformStore(folder, JSON.stringify(['weixin', 'weixin'])).read<{
      accounts: Record<string, { cursor?: string }>
    }>({ accounts: {} })
    expect(state.accounts['bot@im.bot']?.cursor).toBeUndefined()
    await adapter.disconnect()
  })
  it('微信图片在私有边界完成解密，通用消息不携带密钥和 CDN 参数', async () => {
    const key = Buffer.alloc(16, 7)
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
    let polled = false
    const { adapter } = await weixin((url, init) => {
      if (url.hostname === 'novac2c.cdn.weixin.qq.com')
        return Promise.resolve(new Response(encrypted))
      if (!url.pathname.endsWith('getupdates')) return
      if (polled) return waitForAbort(init.signal!)
      polled = true
      return json({
        ret: 0,
        get_updates_buf: 'after-image',
        msgs: [
          {
            message_id: 'image-1',
            from_user_id: 'owner',
            item_list: [
              {
                type: 2,
                image_item: {
                  aeskey: key.toString('hex'),
                  media: { encrypt_query_param: 'SECRET_CDN_PARAM' },
                },
              },
            ],
          },
        ],
      })
    })
    const received: InboundMessage[] = []
    adapter.bindInboundReceiver(async (message) => {
      received.push(message)
    })
    await adapter.connect()
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(JSON.stringify(received)).not.toContain('SECRET_CDN_PARAM')
    expect(await readFile(received[0]!.attachments![0]!.localPath!)).toEqual(bytes)
  })
})

describe('Telegram 规范消息与接收确认', () => {
  it('主题标识独立编码，账号中的分隔符不造成地址歧义', () => {
    expect(telegramAddress('-1001', 7)).not.toBe(telegramAddress('-1001', 8))
    expect(parseTelegramAddress(telegramAddress('-1001', 7))).toEqual({
      chat_id: '-1001',
      message_thread_id: 7,
    })
    expect(() => parseTelegramAddress('["1",-1]')).toThrow('SOCIAL_CHANNEL_INVALID')
  })
  it('UTF-16 实体偏移正确识别提及，不把正文中的普通昵称当作提及', () => {
    const message = {
      message_id: 1,
      date: 1,
      chat: { id: -1, type: 'supergroup' },
      text: '😺 @TestBot',
      entities: [{ type: 'mention', offset: 3, length: 8 }],
    }
    expect(telegramMention(message, '42', 'testbot')).toBe(true)
    expect(telegramMention({ ...message, entities: [] }, '42', 'testbot')).toBe(false)
  })
  it('Webhook 冲突时不删除远端配置、不保存 Token', async () => {
    const folder = await directory()
    const fetch = vi.fn(async (input: string | URL) =>
      json({
        ok: true,
        result: String(input).endsWith('getMe')
          ? { id: 42, is_bot: true, first_name: '测试', username: 'TestBot' }
          : { url: 'https://existing.example/webhook' },
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const adapter = new TelegramAdapter({ id: 'telegram' }, 'pero', { privateRoot: folder })
    adapters.push(adapter)
    await expect(
      adapter.manage('account_add', { token: '42:ABCDEFGHIJKLMNOPQRSTUVWXYZ' }),
    ).rejects.toThrow('SOCIAL_WEBHOOK_CONFLICT')
    expect((await adapter.managementSnapshot()).accounts).toEqual([])
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('deleteWebhook'))).toBe(false)
  })
  it('Telegram 等待持久确认后才发送下一个 offset，消息中不泄露 Token', async () => {
    const folder = await directory()
    let polls = 0
    let accept!: () => void
    const offsets: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init: RequestInit) => {
        const method = String(input).split('/').at(-1)
        if (method === 'getMe')
          return json({
            ok: true,
            result: { id: 42, is_bot: true, first_name: '测试', username: 'TestBot' },
          })
        if (method === 'getWebhookInfo') return json({ ok: true, result: { url: '' } })
        if (method === 'getUpdates') {
          offsets.push(JSON.parse(String(init.body)).offset)
          if (++polls > 1) return waitForAbort(init.signal!)
          return json({
            ok: true,
            result: [
              {
                update_id: 9,
                message: {
                  message_id: 3,
                  date: 1,
                  from: { id: 7, is_bot: false, first_name: '用户' },
                  chat: { id: 7, type: 'private' },
                  text: '你好',
                },
              },
            ],
          })
        }
        throw new Error('测试夹具收到未知请求')
      }),
    )
    const adapter = new TelegramAdapter({ id: 'telegram' }, 'pero', { privateRoot: folder })
    adapters.push(adapter)
    await adapter.manage('account_add', { token: '42:ABCDEFGHIJKLMNOPQRSTUVWXYZ' })
    const receive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        }),
    )
    adapter.bindInboundReceiver(receive)
    await adapter.connect()
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(polls).toBe(1)
    accept()
    await vi.waitFor(() => expect(polls).toBe(2))
    expect(offsets).toEqual([undefined, 10])
    expect(JSON.stringify(receive.mock.calls)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  })
})
