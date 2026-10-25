import type { SocialMessageRecord } from '@infos/shared'
import type { InboundMessage } from './types'

export function socialOwnerId(value: unknown): string | undefined {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  // eslint-disable-next-line no-control-regex -- 显式拦截控制字符，防止标识或路径混入不可见内容。
  return id && id.length <= 200 && !/[\x00-\x1f]/.test(id) ? id : undefined
}

export function isSocialMention(message: InboundMessage): boolean {
  return message.isMentioned === true
}

/** 同一回合只以最后一个明确提及者为主要对话对象，普通消息不会继承主人的身份。 */
export function socialTriggerMessage(messages: InboundMessage[]): InboundMessage | undefined {
  return [...messages].reverse().find(isSocialMention) ?? messages.at(-1)
}

export function socialMessageId(message: InboundMessage): string {
  return message.messageId ?? ''
}

export function formatSocialMessage(
  message: InboundMessage,
  ownerId?: string,
  isBot?: (id: string) => boolean,
): string {
  const identity =
    message.senderId === 'self'
      ? '自己'
      : ownerId && message.senderId === ownerId
        ? '主人'
        : '普通联系人'
  const id = socialMessageId(message)
  const reference = message.replyTo ? ` [引用:${message.replyTo}]` : ''
  const bot =
    identity === '普通联系人' && (isBot ? isBot(message.senderId) : message.senderKind === 'bot')
      ? ' [bot·无需刻意回应@]'
      : ''
  return `[${JSON.stringify(message.senderName)} 平台账号:${message.senderId} 身份:${identity}]${bot}${id ? ` [msg:${id}]` : ''}${reference}: ${message.content}`
}

/** 规范消息优先；旧协议正文仅交给所属适配器解释。 */
export function restoreSocialMessage(
  row: SocialMessageRecord,
  decode?: (row: SocialMessageRecord) => InboundMessage,
): InboundMessage {
  if (decode) return decode(row)
  let raw: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(row.rawEventJson || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value))
      raw = value as Record<string, unknown>
  } catch {
    /* 原始事件损坏不妨碍恢复规范文本。 */
  }
  const normalized = raw._infosInbound as Partial<InboundMessage> | undefined
  return {
    ...normalized,
    platform: row.platform,
    accountId: row.accountId,
    messageId: row.msgId,
    agentId: row.agentId,
    channelId: row.channelId,
    channelType: row.channelType as 'private' | 'group',
    senderId: row.senderId,
    senderName: row.senderName,
    content: row.content,
    rawEvent: raw,
  }
}
