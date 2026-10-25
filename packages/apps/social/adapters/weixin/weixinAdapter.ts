import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { ManagedSocialAdapter, delay, limitedBytes, type ManagedAccount } from '../managedAdapter'
import type {
  Attachment,
  InboundMessage,
  OutboundMessage,
  SocialDeliveryReceipt,
} from '../../runtime/types'
import { t } from '../../runtime/i18n'

const API = 'https://ilinkai.weixin.qq.com'
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c'
// 协议兼容版本独立于 infOS 版本，依据腾讯公开客户端 2.4.10。
const VERSION = '2.4.10'
interface Media {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}
interface Item {
  type?: number
  text_item?: { text?: string }
  ref_msg?: { svr_id?: string }
  image_item?: { media?: Media; aeskey?: string }
  file_item?: { media?: Media; file_name?: string }
  video_item?: { media?: Media }
  voice_item?: { media?: Media; text?: string; encode_type?: number }
}
interface WeixinMessage {
  message_id?: string
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  message_type?: number
  group_id?: string
  context_token?: string
  item_list?: Item[]
}
interface PollResponse {
  ret?: number
  errcode?: number
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}
interface Login {
  id: string
  qr: string
  qrText: string
  baseUrl: string
  status: string
  startedAt: number
  controller: AbortController
  polling?: Promise<Record<string, unknown>>
}
/** 大整数消息标识在 JSON 解析前转成字符串，不能先转为不精确的 Number。 */
export function parseWeixinJson<T>(text: string): T {
  return JSON.parse(
    text.replace(/(?<!\\)"(message_id|msg_id|svr_id)"\s*:\s*(\d+)(?=\s*[,}])/g, '"$1":"$2"'),
  ) as T
}
function trustedUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !['weixin.qq.com', 'wechat.com', 'qq.com'].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error('SOCIAL_ENDPOINT_INVALID')
  return url.toString()
}
export class WeixinAdapter extends ManagedSocialAdapter {
  readonly platform = 'weixin'
  get adapterType() {
    return 'weixin-ilink'
  }
  get displayName() {
    return t('apps.social.ui', '微信')
  }
  get capabilities() {
    return ['direct', 'media', 'managed_accounts', 'qr_login']
  }
  private login?: Login
  canObserveGroup() {
    return false
  }
  serializeInbound() {
    return {}
  }
  async getOwnerDestination(
    accountId: string,
  ): Promise<{ channelId: string; channelType: 'private' }> {
    const account = this.account(accountId)
    const owner = this.ownerId ?? String(account.options.scannerId ?? '')
    if (!owner) throw new Error('SOCIAL_OWNER_REQUIRED')
    return { channelId: owner, channelType: 'private' }
  }
  getOwnerId() {
    return (
      this.ownerId ??
      Object.values(this.state.accounts)
        .map((a) => String(a.options.scannerId ?? ''))
        .find(Boolean)
    )
  }
  protected async request<T>(
    baseUrl: string,
    endpoint: string,
    token?: string,
    body?: unknown,
    signal?: AbortSignal,
    timeout = 20_000,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(timeout)
    const response = await fetch(new URL(endpoint, `${trustedUrl(baseUrl).replace(/\/$/, '')}/`), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body:
        body === undefined
          ? undefined
          : JSON.stringify({
              ...(body as object),
              base_info: { channel_version: VERSION, bot_agent: 'infOS/1' },
            }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      redirect: 'error',
    })
    if (response.status === 401) throw new Error('SOCIAL_LOGIN_EXPIRED')
    if (response.status === 429) throw new Error('SOCIAL_RATE_LIMITED')
    if (!response.ok) throw new Error('SOCIAL_PLATFORM_REJECTED')
    const result = parseWeixinJson<T & { ret?: number; errcode?: number }>(
      (await limitedBytes(response, 4 * 1024 * 1024)).toString('utf8'),
    )
    if (result.ret === -14 || result.errcode === -14) throw new Error('SOCIAL_LOGIN_EXPIRED')
    if (result.ret || result.errcode) throw new Error('SOCIAL_PLATFORM_REJECTED')
    return result
  }
  async managementSnapshot(): Promise<Record<string, unknown>> {
    return {
      ...(await super.managementSnapshot()),
      login: this.login
        ? { id: this.login.id, qrText: this.login.qrText, status: this.login.status }
        : undefined,
    }
  }
  async manage(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.store) await this.load()
    if (action === 'login_start') {
      this.login?.controller.abort()
      const controller = new AbortController()
      const result = await this.request<{ qrcode: string; qrcode_img_content: string }>(
        API,
        'ilink/bot/get_bot_qrcode?bot_type=3',
        undefined,
        { local_token_list: Object.values(this.state.accounts).map((a) => a.token) },
        controller.signal,
      )
      if (!result.qrcode || !result.qrcode_img_content) throw new Error('SOCIAL_LOGIN_FAILED')
      this.login = {
        id: randomUUID(),
        qr: result.qrcode,
        qrText: result.qrcode_img_content,
        baseUrl: API,
        status: 'wait',
        startedAt: Date.now(),
        controller,
      }
      return this.managementSnapshot()
    }
    if (action === 'login_cancel') {
      this.login?.controller.abort()
      this.login = undefined
      return this.managementSnapshot()
    }
    if (action === 'login_poll' || action === 'login_verify') {
      const login = this.login
      if (!login || input.loginId !== login.id || Date.now() - login.startedAt > 300_000)
        throw new Error('SOCIAL_LOGIN_EXPIRED')
      if (login.polling) return login.polling
      const code = action === 'login_verify' ? String(input.code ?? '').trim() : ''
      if (action === 'login_verify' && !/^\d{1,12}$/.test(code))
        throw new Error('SOCIAL_INPUT_INVALID')
      login.polling = this.pollLogin(login, code).finally(() => {
        login.polling = undefined
      })
      return login.polling
    }
    return super.manage(action, input)
  }
  private async pollLogin(login: Login, code: string) {
    const result = await this.request<{
      status: string
      bot_token?: string
      ilink_bot_id?: string
      ilink_user_id?: string
      baseurl?: string
      redirect_host?: string
    }>(
      login.baseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qr)}${code ? `&verify_code=${encodeURIComponent(code)}` : ''}`,
      undefined,
      undefined,
      login.controller.signal,
      40_000,
    )
    if (this.login !== login || login.controller.signal.aborted)
      throw new Error('SOCIAL_LOGIN_EXPIRED')
    login.status = result.status
    if (result.status === 'scaned_but_redirect' && result.redirect_host)
      login.baseUrl = trustedUrl(`https://${result.redirect_host}`)
    if (result.status === 'confirmed') {
      if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id)
        throw new Error('SOCIAL_LOGIN_FAILED')
      await this.putAccount({
        id: result.ilink_bot_id,
        name: result.ilink_bot_id,
        token: result.bot_token,
        options: {
          baseUrl: trustedUrl(result.baseurl ?? login.baseUrl),
          scannerId: result.ilink_user_id,
        },
      })
      this.login = undefined
    }
    return this.managementSnapshot()
  }
  async disconnect() {
    this.login?.controller.abort()
    this.login = undefined
    const accounts = [...this.online].map((id) => this.account(id))
    await super.disconnect()
    await Promise.allSettled(accounts.map((account) => this.notifyStop(account)))
  }
  protected async stopAccount(id: string) {
    const account = this.state.accounts[id]
    const online = this.online.has(id)
    await super.stopAccount(id)
    if (account && online) await this.notifyStop(account)
  }
  private async notifyStop(account: ManagedAccount) {
    await this.request(
      String(account.options.baseUrl ?? API),
      'ilink/bot/msg/notifystop',
      account.token,
      {},
      undefined,
      3000,
    ).catch(() => {})
  }
  protected async runAccount(account: ManagedAccount, signal: AbortSignal) {
    const base = String(account.options.baseUrl ?? API)
    let failures = 0
    await this.request(base, 'ilink/bot/msg/notifystart', account.token, {}, signal, 5000).catch(
      () => {
        signal.throwIfAborted()
      },
    )
    while (!signal.aborted) {
      try {
        const current = this.account(account.id)
        const response = await this.request<PollResponse>(
          base,
          'ilink/bot/getupdates',
          account.token,
          { get_updates_buf: current.cursor ?? '' },
          signal,
          45_000,
        )
        this.markOnline(account.id)
        for (const message of response.msgs ?? []) {
          signal.throwIfAborted()
          if (message.group_id || message.message_type === 2 || !message.from_user_id) continue
          if (!message.message_id) throw new Error('SOCIAL_MESSAGE_ID_REQUIRED')
          if (message.context_token)
            await this.update((state) => {
              const owner = state.accounts[account.id]!
              owner.peers ??= {}
              owner.peers[message.from_user_id!] = {
                token: message.context_token,
                seenAt: Date.now(),
              }
            })
          await this.receive(await this.normalizeMessage(account.id, message, signal), signal)
        }
        // 只有整批规范消息被持久接收后，才提交下一次长轮询游标。
        if (response.get_updates_buf) await this.cursor(account.id, response.get_updates_buf)
        failures = 0
        if (!response.msgs?.length) await delay(250, signal)
      } catch (error) {
        if (signal.aborted) return
        const code = error instanceof Error ? error.message : ''
        if (code === 'SOCIAL_LOGIN_EXPIRED') {
          this.failures.set(account.id, code)
          return
        }
        this.failures.set(
          account.id,
          code.startsWith('SOCIAL_') ? code : 'SOCIAL_CONNECTION_FAILED',
        )
        this.online.delete(account.id)
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(++failures, 5)), signal)
      }
    }
  }
  private async normalizeMessage(
    accountId: string,
    message: WeixinMessage,
    signal: AbortSignal,
  ): Promise<InboundMessage> {
    const text: string[] = []
    const attachments: Attachment[] = []
    for (const item of message.item_list ?? []) {
      if (item.text_item?.text) text.push(item.text_item.text)
      if (item.voice_item?.text) text.push(item.voice_item.text)
      const part = item.image_item ?? item.file_item ?? item.video_item ?? item.voice_item
      if (part?.media) {
        try {
          const media = part.media
          const address =
            media.full_url ??
            `${CDN}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? '')}`
          const encrypted = await limitedBytes(
            await fetch(trustedUrl(address), {
              signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
              redirect: 'error',
            }),
          )
          const encodedKey = media.aes_key ? Buffer.from(media.aes_key, 'base64') : undefined
          // 部分客户端把十六进制密钥文本再做 base64 编码，兼容两种线上形式。
          const key = item.image_item?.aeskey
            ? Buffer.from(item.image_item.aeskey, 'hex')
            : encodedKey?.length === 32 && /^[a-f\d]{32}$/i.test(encodedKey.toString())
              ? Buffer.from(encodedKey.toString(), 'hex')
              : encodedKey
          let bytes = encrypted
          if (key) {
            if (key.length !== 16) throw new Error('SOCIAL_MEDIA_UNAVAILABLE')
            const cipher = createDecipheriv('aes-128-ecb', key, null)
            bytes = Buffer.concat([cipher.update(encrypted), cipher.final()])
          }
          const mime = item.image_item
            ? 'image/jpeg'
            : item.video_item
              ? 'video/mp4'
              : item.voice_item
                ? 'audio/octet-stream'
                : 'application/octet-stream'
          attachments.push(await this.cacheMedia(bytes, mime, item.file_item?.file_name))
        } catch {
          signal.throwIfAborted()
          text.push(t('apps.social.ui', '附件暂不可读取'))
        }
      }
    }
    return {
      platform: this.platform,
      accountId,
      messageId: message.message_id,
      channelId: message.from_user_id!,
      channelType: 'private',
      senderId: message.from_user_id!,
      senderName: message.from_user_id!,
      agentId: this.agentId,
      timestampMs: message.create_time_ms,
      content: text.join('\n') || t('apps.social.ui', '附件消息'),
      attachments,
      replyTo: message.item_list?.find((item) => item.ref_msg?.svr_id)?.ref_msg?.svr_id,
    }
  }
  async getSendReadiness(message: OutboundMessage) {
    const base = await super.getSendReadiness(message)
    if (!base.ready) return base
    return {
      ready:
        message.channelType === 'private' &&
        !!this.account(message.accountId).peers?.[message.channelId]?.token,
      reason: 'SOCIAL_CONTEXT_REQUIRED',
    }
  }
  async sendMessage(
    message: OutboundMessage,
    signal?: AbortSignal,
  ): Promise<SocialDeliveryReceipt> {
    const ready = await this.getSendReadiness(message)
    if (!ready.ready) throw Object.assign(new Error(ready.reason), { code: 'DELIVERY_NOT_SENT' })
    const account = this.account(message.accountId)
    const items: Record<string, unknown>[] = []
    if (message.content) items.push({ type: 1, text_item: { text: message.content } })
    for (const attachment of message.attachments ?? [])
      items.push(await this.upload(account, message.channelId, attachment, signal))
    if (!items.length || message.mentions?.length)
      throw Object.assign(new Error('SOCIAL_INPUT_INVALID'), { code: 'DELIVERY_NOT_SENT' })
    const ids: string[] = []
    for (const [index, item] of items.entries()) {
      const response = await this.request<{ message_id?: string }>(
        String(account.options.baseUrl ?? API),
        'ilink/bot/sendmessage',
        account.token,
        {
          msg: {
            from_user_id: '',
            to_user_id: message.channelId,
            client_id: message.deliveryId
              ? `infos-${message.deliveryId}-${index}`
              : `infos-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            context_token: account.peers?.[message.channelId]?.token,
            item_list: [item],
          },
        },
        signal,
      )
      if (response.message_id) ids.push(response.message_id)
    }
    return {
      sentAt: Date.now(),
      messageId: ids.at(-1),
      platformMessageIds: ids,
      acknowledgement: 'accepted',
    }
  }
  private async upload(
    account: ManagedAccount,
    to: string,
    attachment: Attachment,
    signal?: AbortSignal,
  ) {
    const bytes = await this.attachmentBytes(attachment, signal)
    const key = randomBytes(16)
    const filekey = randomUUID().replaceAll('-', '')
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
    const type = attachment.type === 'image' ? 1 : attachment.type === 'video' ? 2 : 3
    const upload = await this.request<{ upload_full_url?: string; upload_param?: string }>(
      String(account.options.baseUrl ?? API),
      'ilink/bot/getuploadurl',
      account.token,
      {
        filekey,
        media_type: type,
        to_user_id: to,
        rawsize: bytes.length,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: encrypted.length,
        no_need_thumb: true,
        aeskey: key.toString('hex'),
      },
      signal,
    )
    const address =
      upload.upload_full_url ??
      `${CDN}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param ?? '')}&filekey=${filekey}`
    if (!upload.upload_full_url && !upload.upload_param) throw new Error('SOCIAL_MEDIA_UNAVAILABLE')
    const response = await fetch(trustedUrl(address), {
      method: 'POST',
      body: new Uint8Array(encrypted),
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    const download = response.headers.get('x-encrypted-param')
    if (!response.ok || !download) throw new Error('SOCIAL_MEDIA_UNAVAILABLE')
    const media = {
      encrypt_query_param: download,
      aes_key: Buffer.from(key.toString('hex')).toString('base64'),
      encrypt_type: 1,
    }
    if (type === 1) return { type: 2, image_item: { media, mid_size: encrypted.length } }
    if (type === 2) return { type: 5, video_item: { media, video_size: encrypted.length } }
    return {
      type: 4,
      file_item: { media, file_name: attachment.name ?? 'attachment', len: String(bytes.length) },
    }
  }
}
