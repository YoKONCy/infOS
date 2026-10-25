import { t as __t } from '../runtime/i18n'
import type { SocialStoragePort } from '@infos/shared'
import type { StickerService } from '../runtime/stickerService'
import { restoreSocialMessage } from '../runtime/socialMessageContext'
import type { SocialMessageRecord } from '@infos/shared'
import type { InboundMessage } from '../runtime/types'

export interface StickerTurnScope {
  platform?: string
  agentId: string
  accountId: string
  channelId: string
  channelType: 'private' | 'group'
}

/** 账号与会话由可信入站消息绑定，模型不能自行指定其他账号或文件路径。 */
export async function executeSocialSticker(
  service: StickerService,
  storage: SocialStoragePort,
  scope: StickerTurnScope,
  args: Record<string, unknown>,
  decode: (row: SocialMessageRecord) => InboundMessage = restoreSocialMessage,
): Promise<string> {
  const action = String(args.action ?? '')
  let stage = 'preflight'
  try {
    if (action === 'list' || action === 'search') {
      const result = await service.list(
        scope.accountId,
        String(args.query ?? '').slice(0, 200),
        Number(args.offset ?? 0),
        Number(args.limit ?? 20),
        args.refresh === true,
      )
      return JSON.stringify({
        success: true,
        ...result,
        stickers: result.stickers.map(({ id, description }) => ({
          id,
          description: description || __t('apps.social.ui', '暂无描述，可用 read 查看'),
        })),
      })
    }
    if (action === 'read') {
      const image = await service.read(scope.accountId, String(args.sticker_id ?? ''))
      return JSON.stringify({
        success: true,
        images: [`data:${image.mimeType};base64,${image.bytes.toString('base64')}`],
      })
    }
    if (action === 'collect') {
      const messageId = String(args.message_id ?? '')
      if (!messageId || messageId.length > 100) throw new Error('收藏需要提供来源 message_id')
      const row = await storage.getByMsgId(scope.agentId, messageId, scope.accountId, scope)
      if (
        !row ||
        (scope.platform !== undefined && row.platform !== scope.platform) ||
        row.channelId !== scope.channelId ||
        row.channelType !== scope.channelType
      )
        throw new Error('只能收藏当前会话中已收到的图片')
      if (row.accountId !== scope.accountId) throw new Error('SOCIAL_MESSAGE_SOURCE_INVALID')
      const images = (decode(row).attachments ?? []).filter((item) => item.type === 'image')
      const index = Number(args.image_index ?? 1)
      if (!Number.isInteger(index) || index < 1)
        throw new Error('image_index 必须是从 1 开始的整数')
      const url = images[index - 1]?.url
      if (!url)
        throw new Error(
          __t(
            'errors.social',
            '该消息中没有对应图片或原图链接已不可用；原生表情请使用当前平台提供的表情能力',
          ),
        )
      stage = 'collect'
      const result = await service.collect(
        scope.accountId,
        url,
        args.description === undefined ? undefined : String(args.description),
      )
      return JSON.stringify({
        success: true,
        sticker: { id: result.sticker.id, description: result.sticker.description },
        ...('warning' in result ? { warning: result.warning } : {}),
      })
    }
    if (action === 'describe') {
      if (typeof args.description !== 'string') throw new Error('请提供 description')
      stage = 'describe'
      const sticker = await service.describe(
        scope.accountId,
        String(args.sticker_id ?? ''),
        args.description,
      )
      return JSON.stringify({
        success: true,
        sticker: { id: sticker.id, description: sticker.description },
      })
    }
    if (action === 'delete') {
      stage = 'delete'
      return JSON.stringify({
        success: true,
        ...(await service.remove(scope.accountId, String(args.sticker_id ?? ''))),
      })
    }
    throw new Error('未知表情操作')
  } catch (error) {
    const detail = error as {
      rejected?: boolean
      uncertain?: boolean
      code?: string
      stage?: string
    }
    const mutation = ['collect', 'describe', 'delete'].includes(action)
    const uncertain =
      detail.uncertain === true || (mutation && stage !== 'preflight' && detail.rejected !== true)
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: detail.code ?? (uncertain ? 'STICKER_WRITE_UNCERTAIN' : 'STICKER_OPERATION_FAILED'),
      stage: detail.stage ?? stage,
      rejected: !uncertain,
      uncertain,
      ...(uncertain
        ? {
            hint: __t(
              'apps.social.ui',
              '请用 sticker_list 的 refresh:true 强制核验；确认前不要重复提交，也不要猜测平台能力限制',
            ),
          }
        : {}),
    })
  }
}
