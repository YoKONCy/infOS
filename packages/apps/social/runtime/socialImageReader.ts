import type { SocialMessageRecord, SocialStoragePort } from '@infos/shared'
import type { Attachment, InboundMessage } from './types'
import type { ImageCacheManager } from './imageCacheManager'
import { currentSocialRecovery } from './socialRecovery'

export const MAX_SOCIAL_IMAGES = 3

export function isSocialImageAttachment(item: Attachment): boolean {
  return (
    item.type === 'image' || (item.type === 'native_emoji' && Boolean(item.url || item.localPath))
  )
}

export interface SocialImageReadResult {
  images: string[]
  sources: Array<{ message_id: string; image_index: number }>
  unavailable: Array<{
    message_id: string
    reason:
      | 'not_found'
      | 'no_image'
      | 'native_emoji_no_pixels'
      | 'image_unavailable'
      | 'read_failed'
  }>
}

export interface SocialImageReaderProvider {
  readImages(
    agentId: string,
    messageIds: string[],
    maxImages?: number,
  ): Promise<SocialImageReadResult>
}

/** 显式读取当前回合的图片；原生表情没有实际资源时只报告状态，不猜测 CDN 或画面。 */
export function createSocialImageReader(
  storage: Pick<SocialStoragePort, 'getByMsgId'>,
  decode: (row: SocialMessageRecord) => InboundMessage,
  cache: Pick<ImageCacheManager, 'download' | 'readAsDataUrl'>,
  fetchMessage?: (
    source: {
      platform: string
      accountId: string
      channelId: string
      channelType: 'private' | 'group'
      messageId: string
    },
    signal: AbortSignal,
  ) => Promise<InboundMessage | null>,
): SocialImageReaderProvider {
  return {
    async readImages(agentId, messageIds, maxImages = MAX_SOCIAL_IMAGES) {
      const recovery = currentSocialRecovery()
      if (!recovery || recovery.record.agentId !== agentId)
        throw new Error('SOCIAL_IMAGE_SCOPE_REQUIRED')
      if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > MAX_SOCIAL_IMAGES)
        throw new Error('SOCIAL_IMAGE_LIMIT_INVALID')
      const scope = recovery.record
      const platform =
        scope.platform ?? (scope.checkpoint.inbound as InboundMessage[] | undefined)?.[0]?.platform
      if (!platform) throw new Error('SOCIAL_IMAGE_SCOPE_REQUIRED')
      const result: SocialImageReadResult = { images: [], sources: [], unavailable: [] }
      const seen = new Set<string>()
      for (const messageId of [...new Set(messageIds)]) {
        recovery.signal.throwIfAborted()
        if (result.images.length >= maxImages) break
        try {
          const row = await storage.getByMsgId(agentId, messageId, scope.accountId, {
            platform,
            accountId: scope.accountId,
            channelId: scope.channelId,
            channelType: scope.channelType,
          })
          if (
            row &&
            (row.agentId !== agentId ||
              row.platform !== platform ||
              row.accountId !== scope.accountId ||
              row.channelId !== scope.channelId ||
              row.channelType !== scope.channelType)
          ) {
            result.unavailable.push({ message_id: messageId, reason: 'not_found' })
            continue
          }
          const message: InboundMessage | null | undefined = row
            ? decode(row)
            : await fetchMessage?.(
                {
                  platform,
                  accountId: scope.accountId,
                  channelId: scope.channelId,
                  channelType: scope.channelType,
                  messageId,
                },
                recovery.signal,
              )
          if (
            !message ||
            message.accountId !== scope.accountId ||
            message.platform !== platform ||
            message.channelId !== scope.channelId ||
            message.channelType !== scope.channelType ||
            message.messageId !== messageId
          ) {
            result.unavailable.push({ message_id: messageId, reason: 'not_found' })
            continue
          }
          const attachments = message.attachments ?? []
          const nativeWithoutPixels = attachments.some(
            (item) => item.type === 'native_emoji' && !item.url && !item.localPath,
          )
          if (nativeWithoutPixels)
            result.unavailable.push({ message_id: messageId, reason: 'native_emoji_no_pixels' })
          const pictures = attachments.filter(isSocialImageAttachment)
          if (!pictures.length) {
            if (!nativeWithoutPixels)
              result.unavailable.push({ message_id: messageId, reason: 'no_image' })
            continue
          }
          for (const [index, picture] of pictures.entries()) {
            recovery.signal.throwIfAborted()
            if (result.images.length >= maxImages) break
            const source = picture.url || picture.localPath
            if (source && seen.has(source)) continue
            const local =
              picture.localPath ?? (picture.url ? await cache.download(picture.url) : null)
            recovery.signal.throwIfAborted()
            const image = local ? cache.readAsDataUrl(local) : null
            if (image) {
              result.images.push(image)
              result.sources.push({ message_id: messageId, image_index: index + 1 })
              if (source) seen.add(source)
            } else {
              result.unavailable.push({ message_id: messageId, reason: 'image_unavailable' })
            }
          }
        } catch {
          recovery.signal.throwIfAborted()
          result.unavailable.push({ message_id: messageId, reason: 'read_failed' })
        }
      }
      return result
    },
  }
}
