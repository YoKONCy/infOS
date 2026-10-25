import { t as __t } from '../../runtime/i18n'
import type { SocialStoragePort } from '@infos/shared'
import { extractAttachments } from './napcatParser'
import type { Attachment } from '../../runtime/types'

export interface NativeEmojiScope {
  agentId: string
  accountId: string
  channelId: string
  channelType: 'private' | 'group'
  signal?: AbortSignal
}
interface Config {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}
interface SavedEmoji {
  reference: string
  description?: string
}
const rejected = (message: string) =>
  Object.assign(new Error(message), {
    rejected: true,
    code: 'NATIVE_EMOJI_SOURCE_INVALID',
  })

/** 仅保存来源引用；表情密钥始终从受账号与会话约束的原始消息中读取。 */
export class NativeEmojiService {
  constructor(
    private storage: SocialStoragePort,
    private config: Config,
  ) {}

  private key(scope: NativeEmojiScope) {
    return `social.nativeEmoji.${scope.agentId}.${scope.accountId}`
  }
  private async saved(scope: NativeEmojiScope): Promise<SavedEmoji[]> {
    const raw = await this.config.get(this.key(scope))
    if (!raw) return []
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value
          .slice(-128)
          .filter((item): item is SavedEmoji => item && typeof item.reference === 'string')
      : []
  }
  async resolve(scope: NativeEmojiScope, reference: string): Promise<Attachment> {
    scope.signal?.throwIfAborted()
    const match = /^(-?\d{1,30}):(\d{1,2})$/.exec(reference)
    if (!match) throw rejected('原生表情必须使用 emoji_list 返回的来源引用')
    const row = await this.storage.getByMsgId(scope.agentId, match[1]!, scope.accountId, {
      platform: 'qq',
      accountId: scope.accountId,
      channelType: undefined,
      channelId: undefined,
    })
    if (!row || row.platform !== 'qq' || row.accountId !== scope.accountId)
      throw rejected('表情来源已删除或不属于当前账号与会话')
    if (
      (row.channelId !== scope.channelId || row.channelType !== scope.channelType) &&
      !(await this.saved(scope)).some((item) => item.reference === reference)
    )
      throw rejected('只能复用当前会话来源，或当前角色已记录的账号表情引用')
    const event = JSON.parse(row.rawEventJson || '{}') as { message?: unknown }
    if (!Array.isArray(event.message)) throw rejected('来源消息没有可复用的原生表情')
    const emoji = extractAttachments(event.message).filter((item) => item.nativeEmoji)[
      Number(match[2]) - 1
    ]
    if (!emoji?.nativeEmoji) throw rejected('来源消息没有对应的原生表情')
    const native = emoji.nativeEmoji
    if (
      native.kind === 'market' &&
      (!/^\d{1,10}$/.test(native.packageId ?? '') ||
        !/^[a-f\d]{16,64}$/i.test(native.emojiId ?? '') ||
        !native.key)
    )
      throw rejected('商城表情来源缺少有效原生参数，可尝试按图片查看；不能假定已加入收藏')
    scope.signal?.throwIfAborted()
    return { ...emoji, type: 'native_emoji' }
  }
  async list(scope: NativeEmojiScope, messageIds?: string[]) {
    scope.signal?.throwIfAborted()
    const saved = await this.saved(scope)
    const rows = messageIds?.length
      ? await Promise.all(
          messageIds.map((id) => this.storage.getByMsgId(scope.agentId, id, scope.accountId)),
        )
      : await this.storage.getRecent(scope.agentId, scope.channelId, scope.channelType, 50)
    const references = new Map(saved.map((item) => [item.reference, item.description]))
    for (const row of rows) {
      if (
        !row ||
        row.accountId !== scope.accountId ||
        row.channelId !== scope.channelId ||
        row.channelType !== scope.channelType
      )
        continue
      try {
        const event = JSON.parse(row.rawEventJson || '{}')
        if (!Array.isArray(event.message)) continue
        extractAttachments(event.message)
          .filter((item) => item.nativeEmoji)
          .forEach((item, index) => references.set(`${row.msgId}:${index + 1}`, item.name))
      } catch {
        /* 损坏的历史不阻断其他来源。 */
      }
    }
    const emojis: Array<{
      reference: string
      kind: string
      description: string
      token: string
      faceId?: string
    }> = []
    for (const [reference, description] of [...references].slice(-128)) {
      scope.signal?.throwIfAborted()
      try {
        const item = await this.resolve(scope, reference)
        emojis.push({
          reference,
          kind: item.nativeEmoji!.kind,
          faceId: item.nativeEmoji!.faceId,
          description: description || item.name || __t('apps.social.ui', '原生表情'),
          token: `[native_emoji:${reference}]`,
        })
      } catch {
        /* 永久删除的来源不能被收藏索引复活。 */
      }
    }
    scope.signal?.throwIfAborted()
    return {
      emojis,
      hint: __t(
        'apps.social.ui',
        '原生表情按来源复用；不是 QQ 图片收藏。只有实际读取图片后才能描述画面。',
      ),
    }
  }
  async remember(scope: NativeEmojiScope, reference: string, description?: string) {
    await this.resolve(scope, reference)
    const saved = (await this.saved(scope)).filter((item) => item.reference !== reference)
    saved.push({ reference, description: description?.slice(0, 200) })
    scope.signal?.throwIfAborted()
    await this.config.set(this.key(scope), JSON.stringify(saved.slice(-128)))
    return {
      reference,
      token: `[native_emoji:${reference}]`,
      remembered: true,
      hint: __t(
        'apps.social.ui',
        '已记录当前角色在此账号的复用引用，没有向 QQ 提交图片收藏。删除来源消息后引用自动失效。',
      ),
    }
  }
}
