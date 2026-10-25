import { Api, GrammyError, InputFile } from 'grammy'
import { ManagedSocialAdapter, delay, limitedBytes, type ManagedAccount } from '../managedAdapter'
import type {
  Attachment,
  InboundMessage,
  OutboundMessage,
  SocialDeliveryReceipt,
} from '../../runtime/types'
import { t } from '../../runtime/i18n'

// grammY 的声明采用旧版 AbortSignal；Node 的原生信号满足其运行时取消契约。
const telegramSignal = (signal?: AbortSignal) => signal as unknown as Parameters<Api['getMe']>[0]

type TelegramFetch = NonNullable<NonNullable<ConstructorParameters<typeof Api>[1]>['fetch']>
const clientFor = (token: string, timeoutSeconds: number) =>
  new Api(token, {
    timeoutSeconds,
    sensitiveLogs: false,
    fetch: globalThis.fetch as unknown as TelegramFetch,
  })

interface Entity {
  type: string
  offset: number
  length: number
  user?: { id: number }
}
interface File {
  file_id: string
  mime_type?: string
  file_name?: string
}
export interface TelegramMessage {
  message_id: number
  date: number
  message_thread_id?: number
  chat: { id: number; type: string; title?: string }
  from?: { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string }
  sender_chat?: { id: number; title?: string }
  text?: string
  caption?: string
  entities?: Entity[]
  caption_entities?: Entity[]
  reply_to_message?: TelegramMessage
  photo?: File[]
  document?: File
  video?: File
  voice?: File
  audio?: File
  sticker?: File & { is_animated?: boolean; is_video?: boolean; emoji?: string }
}
export function telegramAddress(chatId: string | number, topic?: number): string {
  return JSON.stringify([String(chatId), topic ?? null])
}
export function parseTelegramAddress(value: string): {
  chat_id: string
  message_thread_id?: number
} {
  const parsed: unknown = JSON.parse(value)
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !/^-?\d+$/.test(parsed[0]) ||
    (parsed[1] !== null && (!Number.isSafeInteger(parsed[1]) || Number(parsed[1]) <= 0))
  )
    throw new Error('SOCIAL_CHANNEL_INVALID')
  return {
    chat_id: parsed[0],
    ...(parsed[1] === null ? {} : { message_thread_id: Number(parsed[1]) }),
  }
}
export function telegramMention(
  message: TelegramMessage,
  selfId: string,
  username: string,
): boolean {
  const text = message.text ?? message.caption ?? ''
  return (
    String(message.reply_to_message?.from?.id ?? '') === selfId ||
    (message.entities ?? message.caption_entities ?? []).some((entity) => {
      const value = text.slice(entity.offset, entity.offset + entity.length).toLowerCase()
      return (
        (entity.type === 'text_mention' && String(entity.user?.id) === selfId) ||
        (entity.type === 'mention' && value === `@${username.toLowerCase()}`) ||
        (entity.type === 'bot_command' && value.endsWith(`@${username.toLowerCase()}`))
      )
    })
  )
}
export class TelegramAdapter extends ManagedSocialAdapter {
  readonly platform = 'telegram'
  get adapterType() {
    return 'telegram-bot'
  }
  get displayName() {
    return 'Telegram'
  }
  get capabilities() {
    return ['direct', 'groups', 'topics', 'media', 'managed_accounts']
  }
  private clients = new Map<string, Api>()
  serializeInbound() {
    return {}
  }
  canObserveGroup(accountId: string) {
    return this.state.accounts[accountId]?.options.fullGroupMessages === true
  }
  async getOwnerDestination(
    _accountId: string,
  ): Promise<{ channelId: string; channelType: 'private' }> {
    if (!this.ownerId) throw new Error('SOCIAL_OWNER_REQUIRED')
    return { channelId: telegramAddress(this.ownerId), channelType: 'private' }
  }
  validateOwnerId(id: string) {
    return !id || /^[1-9]\d{0,19}$/.test(id)
  }
  async manage(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action !== 'account_add') return super.manage(action, input)
    if (!this.store) await this.load()
    const token = String(input.token ?? '').trim()
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('SOCIAL_TOKEN_INVALID')
    const api = clientFor(token, 15)
    try {
      const me = await api.getMe()
      const webhook = await api.getWebhookInfo()
      // 不擅自删除其他部署的 Webhook，让用户先解除旧绑定。
      if (webhook.url) throw new Error('SOCIAL_WEBHOOK_CONFLICT')
      await this.putAccount({
        id: String(me.id),
        name: me.username ?? me.first_name,
        token,
        options: {
          username: me.username ?? '',
          fullGroupMessages: input.fullGroupMessages === true,
          canReadAllGroupMessages: me.can_read_all_group_messages === true,
        },
      })
      return { ...(await this.managementSnapshot()), changedAccountId: String(me.id) }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SOCIAL_')) throw error
      throw new Error('SOCIAL_TOKEN_INVALID')
    }
  }
  protected async runAccount(account: ManagedAccount, signal: AbortSignal) {
    const api = clientFor(account.token, 45)
    this.clients.set(account.id, api)
    let failures = 0
    try {
      const webhook = await api.getWebhookInfo(telegramSignal(signal))
      if (webhook.url) throw new Error('SOCIAL_WEBHOOK_CONFLICT')
      await api.getMe(telegramSignal(signal))
      this.markOnline(account.id)
      while (!signal.aborted) {
        try {
          const cursor = this.account(account.id).cursor
          const updates = await api.getUpdates(
            {
              timeout: 30,
              offset: cursor ? Number(cursor) : undefined,
              allowed_updates: ['message', 'my_chat_member'],
            },
            telegramSignal(signal),
          )
          for (const update of updates) {
            signal.throwIfAborted()
            if ('message' in update && update.message) {
              const message = update.message as unknown as TelegramMessage
              if (String(message.from?.id) !== account.id) {
                const normalized = await this.normalizeMessage(account, message, api, signal)
                await this.receive(normalized, signal)
              }
            }
            await this.cursor(account.id, String(update.update_id + 1))
          }
          failures = 0
          this.markOnline(account.id)
        } catch (error) {
          if (signal.aborted) return
          if (error instanceof GrammyError && [401, 409].includes(error.error_code)) {
            this.failures.set(
              account.id,
              error.error_code === 409 ? 'SOCIAL_CONSUMER_CONFLICT' : 'SOCIAL_TOKEN_INVALID',
            )
            return
          }
          this.online.delete(account.id)
          this.failures.set(account.id, 'SOCIAL_CONNECTION_FAILED')
          await delay(
            error instanceof GrammyError && error.parameters.retry_after
              ? error.parameters.retry_after * 1000
              : Math.min(30_000, 1000 * 2 ** Math.min(++failures, 5)),
            signal,
          )
        }
      }
    } finally {
      if (this.clients.get(account.id) === api) this.clients.delete(account.id)
    }
  }
  private async normalizeMessage(
    account: ManagedAccount,
    message: TelegramMessage,
    api: Api,
    signal: AbortSignal,
  ): Promise<InboundMessage> {
    const attachments: Attachment[] = []
    const content = message.text ?? message.caption ?? message.sticker?.emoji ?? ''
    const files = [
      message.photo?.at(-1),
      message.document,
      message.video,
      message.voice,
      message.audio,
      message.sticker && !message.sticker.is_animated ? message.sticker : undefined,
    ].filter((file): file is File => !!file)
    for (const file of files) {
      try {
        const remote = await api.getFile(file.file_id, telegramSignal(signal))
        if (!remote.file_path || (remote.file_size ?? 0) > 20 * 1024 * 1024)
          throw new Error('SOCIAL_MEDIA_TOO_LARGE')
        // 带 Bot Token 的下载地址仅在适配器内使用，通用历史只保存本地附件。
        const bytes = await limitedBytes(
          await fetch(`https://api.telegram.org/file/bot${account.token}/${remote.file_path}`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
            redirect: 'error',
          }),
          20 * 1024 * 1024,
        )
        attachments.push(
          await this.cacheMedia(
            bytes,
            file.mime_type ??
              (message.photo
                ? 'image/jpeg'
                : message.sticker
                  ? message.sticker.is_video
                    ? 'video/webm'
                    : 'image/webp'
                  : 'application/octet-stream'),
            file.file_name,
          ),
        )
      } catch {
        signal.throwIfAborted()
        attachments.push({ type: 'file', name: t('apps.social.ui', '附件暂不可读取') })
      }
    }
    return {
      platform: this.platform,
      accountId: account.id,
      messageId: String(message.message_id),
      timestampMs: message.date * 1000,
      channelId: telegramAddress(message.chat.id, message.message_thread_id),
      channelType: message.chat.type === 'private' ? 'private' : 'group',
      senderId: message.from
        ? String(message.from.id)
        : `chat:${message.sender_chat?.id ?? message.chat.id}`,
      senderName: message.from
        ? [message.from.first_name, message.from.last_name].filter(Boolean).join(' ')
        : (message.sender_chat?.title ?? message.chat.title ?? ''),
      senderKind: message.from?.is_bot ? 'bot' : 'unknown',
      platformBot: message.from?.is_bot === true,
      agentId: this.agentId,
      content: content || t('apps.social.ui', '附件消息'),
      attachments,
      replyTo: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined,
      isMentioned: telegramMention(message, account.id, String(account.options.username ?? '')),
    }
  }
  async sendMessage(
    message: OutboundMessage,
    signal?: AbortSignal,
  ): Promise<SocialDeliveryReceipt> {
    const account = this.account(message.accountId)
    const api = this.clients.get(account.id)
    if (!api)
      throw Object.assign(new Error('SOCIAL_ACCOUNT_NOT_CONNECTED'), { code: 'DELIVERY_NOT_SENT' })
    const address = parseTelegramAddress(message.channelId)
    const extra = {
      ...address,
      ...(message.replyTo ? { reply_parameters: { message_id: Number(message.replyTo) } } : {}),
    }
    const ids: string[] = []
    try {
      if (message.content || message.mentions?.length) {
        // 按码点切分，避免截断代理对；默认纯文本，平台控制标记不能来自模型正文。
        const users = message.mentions ?? []
        if (users.some((id) => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))))
          throw Object.assign(new Error('SOCIAL_INPUT_INVALID'), { code: 'DELIVERY_NOT_SENT' })
        let prefix = ''
        const entities = users.map((id) => {
          const offset = prefix.length
          const label = `@${id}`
          prefix += `${label} `
          return {
            type: 'text_link' as const,
            offset,
            length: label.length,
            url: `tg://user?id=${id}`,
          }
        })
        const points = [...`${prefix}${message.content}`]
        for (let i = 0; i < points.length; i += 2000) {
          const sent = await api.raw.sendMessage(
            {
              ...extra,
              text: points.slice(i, i + 2000).join(''),
              ...(i === 0 && entities.length ? { entities } : {}),
            },
            telegramSignal(signal),
          )
          ids.push(String(sent.message_id))
        }
      }
      for (const attachment of message.attachments ?? []) {
        const file = new InputFile(
          await this.attachmentBytes(attachment, signal),
          attachment.name ?? 'attachment',
        )
        const sent =
          attachment.type === 'image'
            ? await api.raw.sendPhoto({ ...extra, photo: file }, telegramSignal(signal))
            : attachment.type === 'video'
              ? await api.raw.sendVideo({ ...extra, video: file }, telegramSignal(signal))
              : attachment.type === 'audio'
                ? await api.raw.sendAudio({ ...extra, audio: file }, telegramSignal(signal))
                : await api.raw.sendDocument({ ...extra, document: file }, telegramSignal(signal))
        ids.push(String(sent.message_id))
      }
    } catch (error) {
      if (!ids.length && error instanceof GrammyError)
        throw Object.assign(
          new Error(error.error_code === 429 ? 'SOCIAL_RATE_LIMITED' : 'SOCIAL_PLATFORM_REJECTED'),
          { code: 'DELIVERY_NOT_SENT' },
        )
      throw new Error('SOCIAL_DELIVERY_UNCERTAIN')
    }
    return {
      sentAt: Date.now(),
      messageId: ids.at(-1),
      platformMessageIds: ids,
      acknowledgement: 'accepted',
    }
  }
}
