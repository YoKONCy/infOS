/**
 * NapCat 消息解析器 — CQ码 ↔ 统一格式 双向转换
 *
 * 将 OneBot v11 的 CQ 码消息格式转换为平台无关的
 * InboundMessage / OutboundMessage 格式。
 *
 * @module packages/apps/social/adapters/napcat/napcatParser
 */

import type { Attachment } from '../../runtime/types'
import { t as __t } from '../../runtime/i18n'

// ─────────────────────────────────────────────
// OneBot v11 类型
// ─────────────────────────────────────────────

/** OneBot v11 消息段 */
export interface OneBotSegment {
  type: string
  data: Record<string, unknown>
}

/** OneBot v11 消息事件 */
export interface OneBotMessageEvent {
  post_type: 'message' | 'meta_event' | 'notice' | 'request'
  message_type?: 'private' | 'group'
  message_id?: number
  /** NapCat 会话内消息序号 */
  message_seq?: number | string
  messageSeq?: number | string
  msg_seq?: number | string
  /** Unix 秒时间戳 */
  time?: number
  self_id?: number | string
  user_id?: number | string
  target_id?: number | string
  group_id?: number | string
  sender?: {
    user_id?: number | string
    nickname?: string
    card?: string
  }
  message?: OneBotSegment[]
  raw_message?: string
  echo?: string
  status?: string
  retcode?: number
  data?: unknown
  request_type?: string
  flag?: string
  comment?: string
}

// ─────────────────────────────────────────────
// CQ码清洗 (入站: 平台 → 后端)
// ─────────────────────────────────────────────

/**
 * 清洗 CQ 码为人类可读文本
 *
 */
export function cleanCQCodes(content: string): string {
  if (!content.includes('[CQ:')) return content

  // 图片 → [图片] 或 [summary文本]
  content = content.replace(/\[CQ:image,[^\]]*\]/g, (match) => {
    const summaryMatch = match.match(/summary=\[?(.*?)\]?(?:,|\])/)
    if (summaryMatch?.[1]) {
      const text = summaryMatch[1]
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&amp;/g, '&')
      return text.startsWith('[') ? text : `[${text}]`
    }
    return '[图片]'
  })

  // 文件 → [文件: xxx]
  content = content.replace(/\[CQ:file,[^\]]*\]/g, (match) => {
    const nameMatch = match.match(/name=([^,\]]+)/)
    return `[文件: ${nameMatch?.[1] ?? '未知文件'}]`
  })

  // 保留系统表情的公开标识；商城凭据不能混入模型正文。
  content = content.replace(
    /\[CQ:face,[^\]]*\]/g,
    (match) => `[QQ表情:${match.match(/(?:,|\[)id=(\d+)/)?.[1] ?? '未知'}]`,
  )
  content = content.replace(/\[CQ:mface,[^\]]*\]/g, '[QQ商城表情]')

  // at → @昵称
  content = content.replace(/\[CQ:at,[^\]]*\]/g, (match) => {
    const nameMatch = match.match(/name=([^,\]]+)/)
    const qqMatch = match.match(/qq=([^,\]]+)/)
    return `@${nameMatch?.[1] ?? qqMatch?.[1] ?? '未知'}`
  })

  // 回复引用 → 移除
  content = content.replace(/\[CQ:reply,[^\]]*\]/g, '')

  // 转发消息 → [转发消息: id=xxx]（不默认展开，让 AI 通过 tool 主动读取）
  content = content.replace(/\[CQ:forward,[^\]]*\]/g, (match) => {
    const idMatch = match.match(/id=([^,\]]+)/)
    const forwardId = idMatch?.[1] ?? '未知'
    return `[转发消息: id=${forwardId}]`
  })

  // 其他未知 CQ码 → 移除
  content = content.replace(/\[CQ:[^\]]*\]/g, '')

  return content.trim()
}

/**
 * 从 OneBot 消息段提取附件
 */
export function extractAttachments(segments: OneBotSegment[]): Attachment[] {
  const attachments: Attachment[] = []
  for (const seg of segments) {
    if (seg.type === 'face' && /^\d+$/.test(String(seg.data.id ?? ''))) {
      const raw =
        seg.data.raw && typeof seg.data.raw === 'object'
          ? (seg.data.raw as Record<string, unknown>)
          : {}
      attachments.push({
        type: 'native_emoji',
        name:
          typeof raw.faceText === 'string' ? raw.faceText.slice(0, 100) : `QQ表情 ${seg.data.id}`,
        ...(typeof seg.data.url === 'string' ? { url: seg.data.url } : {}),
        nativeEmoji: { kind: 'face', faceId: String(seg.data.id) },
      })
    } else if (
      seg.type === 'mface' ||
      (seg.type === 'image' && seg.data.emoji_id && seg.data.emoji_package_id)
    ) {
      attachments.push({
        type: seg.type === 'image' ? 'image' : 'native_emoji',
        url: typeof seg.data.url === 'string' ? seg.data.url : undefined,
        name: String(seg.data.summary ?? 'QQ商城表情'),
        nativeEmoji: {
          kind: 'market',
          packageId: String(seg.data.emoji_package_id ?? ''),
          emojiId: String(seg.data.emoji_id ?? ''),
          key: String(seg.data.key ?? ''),
        },
      })
    } else if (seg.type === 'image') {
      attachments.push({
        type: 'image',
        url: seg.data.url as string | undefined,
        name: seg.data.file as string | undefined,
      })
    } else if (seg.type === 'file') {
      attachments.push({
        type: 'file',
        url: seg.data.url as string | undefined,
        name: seg.data.name as string | undefined,
      })
    } else if (seg.type === 'forward') {
      // 转发消息：记录 ID，AI 可通过 social_read_forward_msg tool 主动读取内容
      attachments.push({
        type: 'forward',
        forwardId: String(seg.data.id ?? seg.data.resId ?? ''),
      })
    }
  }
  return attachments
}

/** 引用 ID 只接受平台真实消息标识，避免向 NapCat 发送 undefined 等无效参数。 */
export function extractReplyId(segments: OneBotSegment[]): string | undefined {
  const id = segments.find((segment) => segment.type === 'reply')?.data.id
  const value = typeof id === 'number' || typeof id === 'string' ? String(id).trim() : ''
  return /^-?\d+$/.test(value) ? value : undefined
}

/**
 * 将 OneBot 消息段数组转换为 CQ 码字符串
 *
 * 用于 getForwardMsg：当转发节点没有 raw_message 字段时，
 * 从 segments 重建 CQ 码字符串，再用 cleanCQCodes 清洗。
 */
export function segmentsToCQString(segments: OneBotSegment[]): string {
  const escape = (value: unknown) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/\[/g, '&#91;')
      .replace(/\]/g, '&#93;')
      .replace(/,/g, '&#44;')
  return segments
    .map((seg) => {
      if (seg.type === 'text') return String(seg.data.text ?? '')
      // 其他段转为 [CQ:type,key=val,...] 格式，让 cleanCQCodes 处理
      const dataStr = Object.entries(seg.data)
        .map(([k, v]) => `${k}=${escape(v)}`)
        .join(',')
      return `[CQ:${seg.type},${dataStr}]`
    })
    .join('')
}

/**
 * 检查消息段中是否 at 了指定 QQ
 *
 * 匹配规则：
 * 1. at 段的 qq 字段 === selfId（精确匹配）
 * 2. at 段的 qq 字段 === 'all'（@全体成员，视为被提及）
 *
 * @param segments OneBot v11 消息段数组
 * @param selfId   Bot 自身 QQ 号
 */
export function checkIsMentioned(segments: OneBotSegment[], selfId: string): boolean {
  for (const seg of segments) {
    if (seg.type !== 'at') continue
    const qq = String(seg.data.qq ?? '')
    // @全体成员 (OneBot v11 中 qq='all')
    if (qq === 'all') return true
    // 精确匹配 Bot QQ
    if (selfId && qq === selfId) return true
  }
  return false
}

// ─────────────────────────────────────────────
// 出站转换 (后端 → 平台)
// ─────────────────────────────────────────────

/** 拒绝把入站表情占位当作正文或发送指令。 */
export function assertQQOutboundContent(content: string): void {
  if (/\[\s*QQ(?:表情\s*[:：][^\]\r\n]*|商城表情)\s*\]/u.test(content))
    throw Object.assign(
      new Error(
        __t(
          'errors.social',
          'QQ 表情占位不能直接发送；请用 emoji_list 返回的 native_emoji 引用，或改写正文',
        ),
      ),
      { code: 'DELIVERY_NOT_SENT', rejected: true },
    )
}

/** 将 OutboundMessage 的内容转换为 OneBot v11 消息段数组。 */
export function toOneBotSegments(content: string, attachments?: Attachment[]): OneBotSegment[] {
  assertQQOutboundContent(content)
  const segments: OneBotSegment[] = []

  // 文本段
  if (content) {
    // 统一换行符并将连续空行合并为一次换行，兼容仅含空格或制表符的空行。
    const text = content.replace(/\r\n?/g, '\n').replace(/\n(?:[ \t]*\n)+/g, '\n')
    segments.push({ type: 'text', data: { text } })
  }

  // 附件段
  if (attachments) {
    for (const att of attachments) {
      if (att.type === 'native_emoji') {
        const emoji = att.nativeEmoji
        if (emoji?.kind === 'face' && /^\d+$/.test(emoji.faceId ?? ''))
          segments.push({ type: 'face', data: { id: emoji.faceId } })
        else if (
          emoji?.kind === 'market' &&
          /^\d{1,10}$/.test(emoji.packageId ?? '') &&
          /^[a-f\d]{16,64}$/i.test(emoji.emojiId ?? '') &&
          emoji.key
        )
          segments.push({
            type: 'mface',
            data: {
              emoji_package_id: Number(emoji.packageId),
              emoji_id: emoji.emojiId,
              key: emoji.key,
              summary: att.name ?? '[商城表情]',
            },
          })
        else
          throw Object.assign(new Error('原生表情缺少有效来源参数'), { code: 'DELIVERY_NOT_SENT' })
      } else if (att.type === 'sticker') {
        // 自定义表情使用 NapCat 的图片子类型，字段必须是下划线形式。
        const file = att.localPath
          ? `file:///${att.localPath.replace(/\\/g, '/')}`
          : (att.url?.replace(/^data:[^;]+;base64,/, 'base64://') ?? '')
        segments.push({
          type: 'image',
          data: {
            file,
            sub_type: 1,
            summary: '[表情]', // 非图形界面的摘要显示
          },
        })
      } else if (att.type === 'image') {
        const file = att.localPath
          ? `file:///${att.localPath}`
          : (att.url?.replace(/^data:[^;]+;base64,/, 'base64://') ?? '')
        segments.push({ type: 'image', data: { file } })
      } else if (att.type === 'audio' || att.type === 'video') {
        const file = att.localPath
          ? `file:///${att.localPath.replaceAll('\\', '/')}`
          : (att.url?.replace(/^data:[^;]+;base64,/, 'base64://') ?? '')
        if (!file) throw new Error('媒体附件缺少来源')
        segments.push({ type: att.type === 'audio' ? 'record' : 'video', data: { file } })
      } else if (att.type !== 'file') {
        throw new Error(`不支持发送附件类型: ${att.type}`)
      }
    }
  }

  return segments
}

/**
 * 构建 OneBot v11 send_msg API 参数
 */
export function buildSendParams(
  channelId: string,
  channelType: 'private' | 'group',
  segments: OneBotSegment[],
): Record<string, unknown> {
  if (channelType === 'group') {
    return {
      group_id: Number(channelId),
      message: segments,
    }
  }
  return {
    user_id: Number(channelId),
    message: segments,
  }
}
