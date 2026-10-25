import { t as __t } from './i18n'
import type { Attachment } from './types'
import { AppError } from '@infos/backend/applicationHostAbi'
import { currentSocialRecovery } from './socialRecovery'

export interface AccountSticker {
  id: string
  description: string
  url: string
  resourceId: string
  md5: string
  emojiId: string
}

/** 原生收藏与文件传输由适配器实现，社交层只使用账号和表情标识。 */
export interface AccountStickerProvider {
  imageHeaders?(sticker: AccountSticker): Record<string, string>
  list(accountId: string): Promise<{ stickers: AccountSticker[]; truncated: boolean }>
  collect(accountId: string, url: string): Promise<{ md5: string }>
  describe(accountId: string, sticker: AccountSticker, description: string): Promise<void>
  remove(accountId: string, sticker: AccountSticker): Promise<void>
}

export interface TextSegment {
  type: 'text'
  content: string
}
export interface StickerSegment {
  type: 'sticker'
  stickerId: string
}
export interface NativeEmojiSegment {
  type: 'native_emoji'
  reference: string
}
export type MessageSegment = TextSegment | StickerSegment | NativeEmojiSegment

/** 空收藏或无效标识也不向用户泄露内部标记。 */
export function splitStickerSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  const pattern = /\[\s*(sticker|native_emoji)\s*[:：]\s*([^\]\r\n]*)\]/gi
  let cursor = 0
  for (const match of content.matchAll(pattern)) {
    const text = content.slice(cursor, match.index).trim()
    if (text) segments.push({ type: 'text', content: text })
    const id = match[2]!.trim()
    if (match[1]!.toLowerCase() === 'native_emoji') {
      if (/^[^[\]\r\n]{1,240}$/.test(id)) segments.push({ type: 'native_emoji', reference: id })
    } else if (/^s_[a-f0-9]{24}$/.test(id)) segments.push({ type: 'sticker', stickerId: id })
    cursor = match.index! + match[0].length
  }
  const tail = content.slice(cursor).trim()
  if (tail) segments.push({ type: 'text', content: tail })
  return segments
}

export class StickerService {
  private cache = new Map<string, { at: number; stickers: AccountSticker[]; truncated: boolean }>()
  private pending = new Map<string, Promise<void>>()
  private revisions = new Map<string, number>()

  constructor(private readonly provider: AccountStickerProvider) {}

  /** 缓存按平台账号隔离，不读取角色资源，也不全量注入收藏。 */
  private async snapshot(accountId: string, refresh = false) {
    if (!accountId) throw new AppError('INVALID_PARAMETER', { message: '当前社交账号未确定' })
    const cached = this.cache.get(accountId)
    if (!refresh && cached && Date.now() - cached.at < 30_000) return cached
    const revision = this.revisions.get(accountId) ?? 0
    const result = await this.provider.list(accountId)
    const value = { ...result, at: Date.now() }
    // 写操作期间发出的旧查询，不能在写后重新覆盖缓存。
    if (revision === (this.revisions.get(accountId) ?? 0)) this.cache.set(accountId, value)
    return value
  }

  private invalidate(accountId: string) {
    this.revisions.set(accountId, (this.revisions.get(accountId) ?? 0) + 1)
    this.cache.delete(accountId)
  }

  async list(accountId: string, query = '', offset = 0, limit = 20, refresh = false) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 60
    )
      throw new AppError('INVALID_PARAMETER', {
        message: 'offset 必须是非负整数，limit 必须在 1～60 之间',
      })
    const snapshot = await this.snapshot(accountId, refresh)
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const matches = snapshot.stickers.filter((sticker) =>
      terms.every((term) =>
        `${sticker.id} ${sticker.description}`.toLocaleLowerCase().includes(term),
      ),
    )
    return {
      accountId,
      stickers: matches.slice(offset, offset + limit),
      total: matches.length,
      offset,
      hasMore: offset + limit < matches.length,
      truncated: snapshot.truncated,
    }
  }

  async resolve(accountId: string, id: string): Promise<Attachment> {
    const sticker = await this.find(accountId, id)
    return { type: 'sticker', url: sticker.url, name: sticker.description || '表情' }
  }

  /** 仅代理账号收藏里的图片；控制下载大小并按真实文件头识别动图。 */
  async read(accountId: string, id: string) {
    const sticker = await this.find(accountId, id, false)
    const response = await fetch(sticker.url, {
      signal: AbortSignal.any([
        AbortSignal.timeout(15_000),
        ...(currentSocialRecovery() ? [currentSocialRecovery()!.signal] : []),
      ]),
      headers: this.provider.imageHeaders?.(sticker),
    })
    if (!response.ok || !response.body)
      throw new AppError('EXTERNAL_ERROR', { message: '收藏图片暂时无法读取，请重新同步' })
    const maximum = 20 * 1024 * 1024
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > maximum)
          throw new AppError('PAYLOAD_TOO_LARGE', { message: '收藏图片超过 20 MB，暂不支持预览' })
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const bytes = Buffer.concat(chunks)
    const mimeType = bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')
      ? 'image/gif'
      : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? 'image/jpeg'
          : bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
              bytes.subarray(8, 12).toString('ascii') === 'WEBP'
            ? 'image/webp'
            : ''
    if (!mimeType)
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
        message: '收藏图片不是支持的 PNG、JPEG、GIF 或 WebP 格式',
      })
    return { bytes, mimeType }
  }

  private async find(accountId: string, id: string, refresh = true) {
    const snapshot = await this.snapshot(accountId, refresh)
    const sticker = snapshot.stickers.find((item) => item.id === id)
    if (!sticker) throw new AppError('NOT_FOUND', { message: '表情不在当前账号收藏中，请重新查询' })
    return sticker
  }

  /** 同账号写操作串行，避免收藏、描述、删除互相覆盖。 */
  private async mutate<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(accountId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const tail = result.then(
      () => {},
      () => {},
    )
    this.pending.set(accountId, tail)
    try {
      return await result
    } finally {
      if (this.pending.get(accountId) === tail) this.pending.delete(accountId)
    }
  }

  async collect(accountId: string, url: string, description?: string) {
    if (description !== undefined && description.length > 200)
      throw Object.assign(new Error('表情描述最多 200 字'), { rejected: true, stage: 'preflight' })
    return this.mutate(accountId, async () => {
      let collected: { md5: string }
      try {
        collected = await this.provider.collect(accountId, url)
      } catch (error) {
        this.invalidate(accountId)
        throw error
      }
      this.invalidate(accountId)
      let snapshot: { stickers: AccountSticker[] }
      try {
        snapshot = await this.snapshot(accountId, true)
      } catch (error) {
        throw Object.assign(
          new Error(
            `收藏已提交，但刷新核验失败：${error instanceof Error ? error.message : String(error)}`,
          ),
          { uncertain: true, stage: 'verify', code: 'STICKER_VERIFY_UNAVAILABLE' },
        )
      }
      const sticker = snapshot.stickers.find(
        (item) => item.md5.toLowerCase() === collected.md5.toLowerCase(),
      )
      if (!sticker)
        throw Object.assign(
          new Error(
            __t(
              'errors.social',
              '收藏请求已发送，但尚未在平台收藏中确认；请强制刷新后确认，勿重复收藏',
            ),
          ),
          { uncertain: true, stage: 'verify', code: 'STICKER_NOT_CONFIRMED' },
        )
      if (description !== undefined) {
        try {
          return { sticker: await this.describeUnlocked(accountId, sticker, description) }
        } catch (error) {
          return {
            sticker,
            warning: `已收藏，描述未保存：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }
      return { sticker }
    })
  }

  private async describeUnlocked(accountId: string, sticker: AccountSticker, description: string) {
    await this.provider.describe(accountId, sticker, description)
    this.invalidate(accountId)
    let updated: AccountSticker
    try {
      updated = await this.find(accountId, sticker.id)
    } catch (error) {
      throw Object.assign(
        new Error(
          `描述已提交但未能核验：${error instanceof Error ? error.message : String(error)}`,
        ),
        { uncertain: true, rejected: false, stage: 'verify' },
      )
    }
    if (updated.description !== description)
      throw Object.assign(
        new Error(__t('errors.social', '平台尚未确认描述更新，请强制刷新后确认')),
        {
          uncertain: true,
          stage: 'verify',
        },
      )
    return updated
  }

  async describe(accountId: string, id: string, description: string) {
    if (description.length > 200)
      throw Object.assign(new Error('表情描述最多 200 字'), { rejected: true, stage: 'preflight' })
    return this.mutate(accountId, async () => {
      const sticker = await this.preflight(accountId, id)
      return this.describeUnlocked(accountId, sticker, description)
    })
  }

  private async preflight(accountId: string, id: string) {
    try {
      return await this.find(accountId, id)
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
        rejected: true,
        stage: 'lookup',
        code: 'STICKER_LOOKUP_FAILED',
      })
    }
  }

  async remove(accountId: string, id: string) {
    return this.mutate(accountId, async () => {
      const sticker = await this.preflight(accountId, id)
      await this.provider.remove(accountId, sticker)
      this.invalidate(accountId)
      try {
        if ((await this.snapshot(accountId, true)).stickers.some((item) => item.id === id))
          throw new Error(__t('errors.social', '平台尚未确认删除，请强制刷新后确认'))
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
          uncertain: true,
          stage: 'verify',
        })
      }
      return { removed: id }
    })
  }
}
