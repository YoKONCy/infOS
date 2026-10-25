import { createHash } from 'node:crypto'
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  type Message,
} from 'discord.js'
import { ManagedSocialAdapter, limitedBytes, delay, type ManagedAccount } from '../managedAdapter'
import type {
  Attachment,
  InboundMessage,
  OutboundMessage,
  SocialDeliveryReceipt,
} from '../../runtime/types'
import { t } from '../../runtime/i18n'

export class DiscordAdapter extends ManagedSocialAdapter {
  readonly platform = 'discord'
  get adapterType() {
    return 'discord-bot'
  }
  get displayName() {
    return 'Discord'
  }
  get capabilities() {
    return ['direct', 'groups', 'topics', 'media', 'history', 'message_lookup', 'managed_accounts']
  }
  private clients = new Map<string, Client>()
  private drains = new Map<string, Promise<void>>()
  serializeInbound() {
    return {}
  }
  validateOwnerId(id: string) {
    return !id || /^[1-9]\d{0,24}$/.test(id)
  }
  canObserveGroup(accountId: string, channelId: string) {
    const client = this.clients.get(accountId)
    const channel = client?.channels.cache.get(channelId)
    return (
      this.state.accounts[accountId]?.options.fullGroupMessages === true &&
      !!client?.user &&
      !!channel &&
      (!('permissionsFor' in channel) ||
        !!channel
          .permissionsFor(client.user)
          ?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            channel.isThread()
              ? PermissionFlagsBits.SendMessagesInThreads
              : PermissionFlagsBits.SendMessages,
          ]))
    )
  }
  async getOwnerDestination(
    accountId: string,
  ): Promise<{ channelId: string; channelType: 'private' }> {
    if (!this.ownerId) throw new Error('SOCIAL_OWNER_REQUIRED')
    const client = this.client(accountId)
    const user = await client.users.fetch(this.ownerId)
    return { channelId: (await user.createDM()).id, channelType: 'private' }
  }
  async getSendReadiness(message: OutboundMessage) {
    const status = await super.getSendReadiness(message)
    if (!status.ready) return status
    try {
      const client = this.client(message.accountId)
      const channel = await client.channels.fetch(message.channelId)
      if (!channel?.isSendable()) return { ready: false, reason: 'SOCIAL_CHANNEL_INVALID' }
      if ('permissionsFor' in channel && client.user) {
        const permissions = channel.permissionsFor(client.user)
        if (
          !permissions?.has([
            PermissionFlagsBits.ViewChannel,
            channel.isThread()
              ? PermissionFlagsBits.SendMessagesInThreads
              : PermissionFlagsBits.SendMessages,
          ])
        )
          return { ready: false, reason: 'SOCIAL_CHANNEL_INVALID' }
      }
      return { ready: true, reason: '' }
    } catch {
      return { ready: false, reason: 'SOCIAL_CHANNEL_INVALID' }
    }
  }
  async manage(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action !== 'account_add') return super.manage(action, input)
    if (!this.store) await this.load()
    const token = String(input.token ?? '').trim()
    if (!token || token.length > 512 || /\s/.test(token)) throw new Error('SOCIAL_TOKEN_INVALID')
    try {
      const me = (await new REST({ version: '10', retries: 0, timeout: 15_000 })
        .setToken(token)
        .get(Routes.user('@me'))) as { id: string; username: string; bot?: boolean }
      if (!me.bot) throw new Error('SOCIAL_TOKEN_INVALID')
      await this.putAccount({
        id: me.id,
        name: me.username,
        token,
        options: { fullGroupMessages: input.fullGroupMessages === true },
      })
      return { ...(await this.managementSnapshot()), changedAccountId: me.id }
    } catch {
      throw new Error('SOCIAL_TOKEN_INVALID')
    }
  }
  private client(id?: string) {
    const client = id ? this.clients.get(id) : undefined
    if (!client?.isReady()) throw new Error('SOCIAL_ACCOUNT_NOT_CONNECTED')
    return client
  }
  protected async runAccount(account: ManagedAccount, signal: AbortSignal) {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        ...(account.options.fullGroupMessages === true ? [GatewayIntentBits.MessageContent] : []),
      ],
      partials: [Partials.Channel],
      allowedMentions: { parse: [], repliedUser: false },
      rest: { retries: 0, timeout: 15_000 },
    })
    this.clients.set(account.id, client)
    const close = () => {
      void client.destroy()
    }
    signal.addEventListener('abort', close, { once: true })
    client.on(Events.Error, () => {
      this.failures.set(account.id, 'SOCIAL_CONNECTION_FAILED')
    })
    client.on(Events.ShardDisconnect, (event) => {
      this.online.delete(account.id)
      if (event.code === 4014) this.failures.set(account.id, 'SOCIAL_INTENT_REQUIRED')
      if (event.code === 4004) this.failures.set(account.id, 'SOCIAL_TOKEN_INVALID')
    })
    client.on(Events.ShardResume, () => this.markOnline(account.id))
    client.on(Events.MessageCreate, (message) => {
      if (
        message.author.id === account.id ||
        signal.aborted ||
        (!message.content && !message.attachments.size)
      )
        return
      // Gateway 回调先写私有收件箱，再异步解析附件和投递，不能等待模型回复。
      const inbound = this.snapshot(account.id, message)
      void this.update((state) => {
        const pending = ((state.pending ??= {})[account.id] ??= [])
        if (
          pending.some(
            (item) => item.messageId === inbound.messageId && item.channelId === inbound.channelId,
          )
        )
          return
        if (pending.length >= 1000) throw new Error('SOCIAL_INBOUND_BACKLOG')
        pending.push(inbound)
      })
        .then(() => this.drain(account.id, signal))
        .catch(() => this.failures.set(account.id, 'SOCIAL_INBOUND_FAILED'))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => done(new Error('SOCIAL_CONNECTION_FAILED')), 45_000)
        const abort = () => done(signal.reason)
        const ready = () => done()
        const done = (error?: unknown) => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', abort)
          client.off(Events.ClientReady, ready)
          if (error) reject(error)
          else resolve()
        }
        signal.addEventListener('abort', abort, { once: true })
        client.once(Events.ClientReady, ready)
        void client.login(account.token).catch(() => done(new Error('SOCIAL_TOKEN_INVALID')))
        if (signal.aborted) abort()
      })
      this.markOnline(account.id)
      while (!signal.aborted) {
        if (
          ['SOCIAL_INTENT_REQUIRED', 'SOCIAL_TOKEN_INVALID'].includes(
            this.failures.get(account.id) ?? '',
          )
        )
          return
        try {
          await this.drain(account.id, signal)
        } catch {
          this.failures.set(account.id, 'SOCIAL_INBOUND_FAILED')
        }
        await delay(2000, signal)
      }
    } finally {
      signal.removeEventListener('abort', close)
      await client.destroy()
      await this.drains.get(account.id)?.catch(() => {})
      if (this.clients.get(account.id) === client) this.clients.delete(account.id)
    }
  }
  private drain(id: string, signal: AbortSignal): Promise<void> {
    const existing = this.drains.get(id)
    if (existing) return existing.then(() => this.drain(id, signal))
    const job = (async () => {
      while (!signal.aborted) {
        const message = this.state.pending?.[id]?.[0]
        if (!message) return
        await this.receive(await this.materialize(message, signal), signal)
        await this.update((state) => {
          const pending = state.pending?.[id]
          if (
            pending &&
            pending[0]?.messageId === message.messageId &&
            pending[0]?.channelId === message.channelId
          )
            pending.shift()
        })
      }
    })().finally(() => {
      if (this.drains.get(id) === job) this.drains.delete(id)
    })
    this.drains.set(id, job)
    return job
  }
  private snapshot(accountId: string, message: Message): InboundMessage {
    return {
      platform: this.platform,
      accountId,
      messageId: message.id,
      timestampMs: message.createdTimestamp,
      channelId: message.channelId,
      channelType: message.inGuild() ? 'group' : 'private',
      senderId: message.author.id,
      senderName:
        message.member?.displayName ?? message.author.globalName ?? message.author.username,
      senderKind: message.author.bot || message.webhookId ? 'bot' : 'unknown',
      platformBot: message.author.bot || !!message.webhookId,
      agentId: this.agentId,
      content: message.content || t('apps.social.ui', '附件消息'),
      replyTo: message.reference?.messageId,
      isMentioned: message.mentions.users.has(accountId),
      attachments: [...message.attachments.values()].map((file) => ({
        type: file.contentType?.startsWith('image/')
          ? 'image'
          : file.contentType?.startsWith('video/')
            ? 'video'
            : file.contentType?.startsWith('audio/')
              ? 'audio'
              : 'file',
        url: file.url,
        name: file.name,
        mimeType: file.contentType ?? undefined,
      })),
    }
  }
  private async materialize(message: InboundMessage, signal: AbortSignal): Promise<InboundMessage> {
    const attachments: Attachment[] = []
    for (const attachment of message.attachments ?? []) {
      try {
        if (!attachment.url) continue
        const url = new URL(attachment.url)
        if (
          url.protocol !== 'https:' ||
          !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
        )
          throw new Error('SOCIAL_ENDPOINT_INVALID')
        const bytes = await limitedBytes(
          await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
            redirect: 'error',
          }),
        )
        attachments.push(
          await this.cacheMedia(
            bytes,
            attachment.mimeType ?? 'application/octet-stream',
            attachment.name,
          ),
        )
      } catch {
        signal.throwIfAborted()
        attachments.push({ type: 'file', name: t('apps.social.ui', '附件暂不可读取') })
      }
    }
    return { ...message, agentId: this.agentId, attachments }
  }
  async getHistoryPage(input: {
    channelId: string
    channelType: 'private' | 'group'
    accountId: string
    limit: number
    cursor?: string
  }) {
    const channel = await this.client(input.accountId).channels.fetch(input.channelId)
    if (!channel?.isTextBased() || !('messages' in channel))
      throw new Error('SOCIAL_CHANNEL_INVALID')
    const messages = await channel.messages.fetch({
      limit: Math.min(100, Math.max(1, input.limit)),
      ...(input.cursor ? { before: input.cursor } : {}),
    })
    return {
      messages: [...messages.values()].map((message) => ({
        msgId: message.id,
        accountId: input.accountId,
        channelId: message.channelId,
        channelType: input.channelType,
        senderId: message.author.id === input.accountId ? 'self' : message.author.id,
        senderName: message.author.username,
        content: message.content || t('apps.social.ui', '附件消息'),
        timestamp: Math.floor(message.createdTimestamp / 1000),
      })),
      nextCursor: messages.size ? messages.last()!.id : undefined,
    }
  }
  async getMessage(
    id: string,
    channelId: string,
    _type: 'private' | 'group',
    accountId: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted()
    const channel = await this.client(accountId).channels.fetch(channelId)
    if (!channel?.isTextBased() || !('messages' in channel)) return null
    const message = await channel.messages.fetch(id)
    return this.materialize(
      this.snapshot(accountId, message),
      signal ?? AbortSignal.timeout(30_000),
    )
  }
  async sendMessage(
    message: OutboundMessage,
    signal?: AbortSignal,
  ): Promise<SocialDeliveryReceipt> {
    signal?.throwIfAborted()
    const channel = await this.client(message.accountId).channels.fetch(message.channelId)
    if (!channel?.isSendable())
      throw Object.assign(new Error('SOCIAL_CHANNEL_INVALID'), { code: 'DELIVERY_NOT_SENT' })
    const users = message.mentions ?? []
    if (users.some((id) => !/^[1-9]\d{0,24}$/.test(id)))
      throw Object.assign(new Error('SOCIAL_INPUT_INVALID'), { code: 'DELIVERY_NOT_SENT' })
    const ids: string[] = []
    const text =
      users.map((id) => `<@${id}>`).join(' ') +
      (users.length && message.content ? ' ' : '') +
      message.content
    const points = [...text]
    const chunks: string[] = []
    for (let i = 0; i < points.length; i += 1900) chunks.push(points.slice(i, i + 1900).join(''))
    if (!chunks.length) chunks.push('')
    const files = await Promise.all(
      (message.attachments ?? []).map(async (attachment) => ({
        attachment: await this.attachmentBytes(attachment, signal),
        name: attachment.name ?? 'attachment',
      })),
    )
    for (const [index, content] of chunks.entries()) {
      signal?.throwIfAborted()
      const sent = await channel.send({
        content: content || undefined,
        ...(message.deliveryId
          ? {
              nonce: createHash('sha256')
                .update(`${message.deliveryId}:${index}`)
                .digest('hex')
                .slice(0, 24),
              enforceNonce: true,
            }
          : {}),
        allowedMentions: { parse: [], users: index === 0 ? users : [], repliedUser: false },
        ...(index === 0 && message.replyTo
          ? { reply: { messageReference: message.replyTo, failIfNotExists: true } }
          : {}),
        ...(index === 0 ? { files } : {}),
      })
      ids.push(sent.id)
    }
    return {
      sentAt: Date.now(),
      messageId: ids.at(-1),
      platformMessageIds: ids,
      acknowledgement: 'accepted',
    }
  }
}
