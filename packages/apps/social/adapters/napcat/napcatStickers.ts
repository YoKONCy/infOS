import { createHash } from 'node:crypto'
import type { AccountSticker, AccountStickerProvider } from '../../runtime/stickerService'

type CallApi = (
  action: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
  accountId?: string,
) => Promise<unknown>
const MAX_STICKERS = 4096

/** 下载在 NapCat 一侧执行，支持与 infOS 分机部署。 */
export class NapcatStickers implements AccountStickerProvider {
  imageHeaders(): Record<string, string> {
    return { 'User-Agent': 'Mozilla/5.0', Referer: 'https://qq.com' }
  }
  constructor(private readonly callApi: CallApi) {}

  private async invoke(
    accountId: string,
    action: string,
    params: Record<string, unknown>,
    timeout = 15_000,
  ) {
    const mutation = ['add_custom_face', 'set_custom_face_desc', 'delete_custom_face'].includes(
      action,
    )
    const raw = (await this.callApi(action, params, timeout, accountId).catch((error: unknown) => {
      const code = (error as { code?: string })?.code
      const rejected = !mutation || code === 'DELIVERY_NOT_SENT' || code === 'DELIVERY_REJECTED'
      throw Object.assign(
        new Error(error instanceof Error ? error.message : 'NapCat 表情接口暂不可用'),
        { rejected, uncertain: !rejected, code: code ?? 'STICKER_TRANSPORT_FAILED', stage: action },
      )
    })) as {
      status?: string
      retcode?: number
      message?: string
      wording?: string
      data?: unknown
    }
    if (raw?.status !== 'ok' || raw.retcode !== 0)
      throw Object.assign(new Error(raw?.message || raw?.wording || 'NapCat 表情接口暂不可用'), {
        rejected: true,
        code: 'STICKER_PLATFORM_REJECTED',
        stage: action,
      })
    const native = raw.data
    if (typeof native === 'number' && native !== 0)
      throw Object.assign(new Error('QQ 拒绝了表情操作'), { rejected: true, stage: action })
    if (
      native &&
      typeof native === 'object' &&
      'result' in native &&
      typeof native.result === 'number' &&
      native.result !== 0
    )
      throw Object.assign(
        new Error('errMsg' in native ? String(native.errMsg) : 'QQ 拒绝了表情操作'),
        { rejected: true, code: 'STICKER_PLATFORM_REJECTED', stage: action },
      )
    return raw.data
  }

  async list(accountId: string) {
    const raw = await this.invoke(accountId, 'fetch_custom_face_detail', { count: MAX_STICKERS })
    if (!Array.isArray(raw))
      throw Object.assign(new Error('NapCat 返回的收藏表情列表格式异常'), {
        rejected: true,
        stage: 'list',
      })
    const stickers: AccountSticker[] = []
    const seen = new Set<string>()
    for (const entry of raw.slice(0, MAX_STICKERS)) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const resourceId = String(item.resId ?? '')
      const url = String(item.url ?? '')
      if (!resourceId || !/^https?:\/\//i.test(url)) continue
      const id = `s_${createHash('sha256').update(resourceId).digest('hex').slice(0, 24)}`
      if (seen.has(id)) continue
      seen.add(id)
      stickers.push({
        id,
        resourceId,
        url,
        md5: String(item.md5 ?? ''),
        emojiId: String(item.emoId ?? item.emojiId ?? '0'),
        description: String(item.desc ?? '').slice(0, 200),
      })
    }
    return { stickers, truncated: raw.length >= MAX_STICKERS }
  }

  async collect(accountId: string, url: string) {
    if (!/^https?:\/\//i.test(url))
      throw Object.assign(new Error('收藏图片必须来自有效的消息图片链接'), {
        rejected: true,
        stage: 'preflight',
      })
    const downloaded = (await this.invoke(
      accountId,
      'download_file',
      { url, headers: ['User-Agent=Mozilla/5.0', 'Referer=https://qq.com'] },
      60_000,
    )) as { file?: string }
    // download_file 未指定 name 时，NapCat 使用内容 MD5 作为文件名。
    const md5 = downloaded?.file
      ?.split(/[\\/]/)
      .at(-1)
      ?.match(/^([a-f\d]{32})(?:\.[a-z\d]+)?$/i)?.[1]
      ?.toLowerCase()
    if (!md5 || !/^[a-f0-9]{32}$/.test(md5))
      throw Object.assign(new Error('NapCat 下载结果未提供可确认的图片 MD5，尚未提交收藏'), {
        rejected: true,
        code: 'STICKER_DOWNLOAD_INVALID',
        stage: 'download',
      })
    const existing = await this.list(accountId)
    if (!existing.stickers.some((item) => item.md5.toLowerCase() === md5))
      await this.invoke(accountId, 'add_custom_face', { file: downloaded.file, md5 }, 60_000)
    return { md5 }
  }

  async describe(accountId: string, sticker: AccountSticker, description: string) {
    await this.invoke(accountId, 'set_custom_face_desc', {
      emoji_id: sticker.emojiId,
      res_id: sticker.resourceId,
      md5: sticker.md5,
      desc: description,
    })
  }

  async remove(accountId: string, sticker: AccountSticker) {
    await this.invoke(accountId, 'delete_custom_face', { res_id: sticker.resourceId })
  }
}
