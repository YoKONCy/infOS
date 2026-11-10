import { getDisplayLocale } from '../i18n/index'
import { t as __t } from '../i18n/index'
/**
 * 客户端历史记录导出器
 *
 * 只消费服务端权威 Projection，并通过浏览器下载能力保存 Markdown，不向服务端写文件。
 */
import type { ConversationMessageProjection, StrongholdMessageProjection } from '@infos/shared'

export interface HistoryExportOptions {
  includeThinking: boolean
  includeTools: boolean
}

export interface ConversationHistoryExport {
  title: string
  channelLabel: string
  participantNames?: Record<string, string>
  messages: ConversationMessageProjection[]
}

export interface StrongholdHistoryExport {
  title: string
  participantNames?: Record<string, string>
  messages: StrongholdMessageProjection[]
}

function safeFileName(value: string): string {
  const withoutReserved = value.trim().replace(/[<>:"/\\|?*]/g, '_')
  const normalized = Array.from(withoutReserved, (character) =>
    character.charCodeAt(0) <= 31 ? '_' : character,
  ).join('')
  return normalized.slice(0, 80) || __t('ui.historyExport', '历史记录')
}

function formatTime(value?: string | null): string {
  if (!value) return __t('ui.historyExport', '时间未知')
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(getDisplayLocale(), { hour12: false })
}

function fenced(value: string, language = ''): string {
  const fence = value.includes('```') ? '````' : '```'
  return `${fence}${language}\n${value}\n${fence}`
}

function roleName(
  role: ConversationMessageProjection['role'] | StrongholdMessageProjection['role'],
  senderId: string | null | undefined,
  names: Record<string, string> = {},
): string {
  if (senderId && names[senderId]) return names[senderId]
  if (role === 'user') return __t('ui.historyExport', '用户')
  if (role === 'assistant') return senderId || __t('ui.historyExport', '助手')
  if (role === 'tool') return __t('ui.historyExport', '工具')
  return __t('ui.historyExport', '系统')
}

function thinkingSections(message: ConversationMessageProjection): string[] {
  const blocks = message.contentBlocks
    .filter((block) => block.kind === 'thinking' || block.kind === 'native_reasoning')
    .sort((left, right) => left.sequence - right.sequence)
  if (blocks.length > 0) {
    return blocks.map((block) => {
      const tag = block.kind === 'native_reasoning' ? 'think' : 'selfMinding'
      return `<${tag}>\n${block.content}\n</${tag}>`
    })
  }

  const raw = message.rawContent ?? ''
  return [
    ...raw.matchAll(/<(innerVoice|selfMinding|think|thinking|thought)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi),
  ].map((match) => {
    const lower = match[1]!.toLowerCase()
    const tag =
      lower === 'selfminding' ? 'selfMinding' : lower === 'innervoice' ? 'innerVoice' : lower
    return `<${tag}>${match[2] ?? ''}</${tag}>`
  })
}

function toolSections(message: ConversationMessageProjection): string[] {
  const tools = message.toolCalls.length
    ? message.toolCalls
    : message.contentBlocks
        .filter((block) => block.kind === 'tool')
        .sort((left, right) => left.sequence - right.sequence)
        .map((block) => ({
          callId: block.callId,
          name: block.name,
          args: block.args,
          result: block.result,
          isError: block.isError,
          durationMs: block.durationMs,
        }))

  return tools.map((tool) => {
    const lines = [`### 工具调用：${tool.name}`]
    if (tool.callId) lines.push(`- 调用 ID：\`${tool.callId}\``)
    if (tool.durationMs !== undefined) lines.push(`- 耗时：${tool.durationMs} ms`)
    if (tool.isError !== undefined) lines.push(`- 状态：${tool.isError ? '失败' : '成功'}`)
    lines.push('', '**参数**', '', fenced(tool.args || '{}', 'json'))
    if (tool.result !== undefined) {
      lines.push('', '**结果**', '', fenced(tool.result))
    }
    return lines.join('\n')
  })
}

export function buildConversationMarkdown(
  input: ConversationHistoryExport,
  options: HistoryExportOptions,
): string {
  const lines = [
    `# ${input.title}`,
    '',
    `- 频道：${input.channelLabel}`,
    `- 导出时间：${formatTime(new Date().toISOString())}`,
    `- 包含思考内容：${options.includeThinking ? '是' : '否'}`,
    `- 包含工具调用：${options.includeTools ? '是' : '否'}`,
    '',
    '---',
  ]

  for (const message of input.messages) {
    if (message.role === 'tool' && !options.includeTools) continue
    const senderId = message.senderId ?? message.agentId
    lines.push(
      '',
      `## ${roleName(message.role, senderId, input.participantNames)} · ${formatTime(message.timestamp)}`,
      '',
    )
    if (message.content.trim()) lines.push(message.content.trim())
    if (options.includeThinking)
      lines.push(...thinkingSections(message).flatMap((item) => ['', item]))
    if (options.includeTools) lines.push(...toolSections(message).flatMap((item) => ['', item]))
    if (message.attachments.length) {
      lines.push('', '**附件**')
      for (const attachment of message.attachments) {
        lines.push(`- ${attachment.name}（${attachment.mimeType}，${attachment.sizeBytes} 字节）`)
      }
    }
  }
  return `${lines.join('\n').trim()}\n`
}

export function buildStrongholdMarkdown(input: StrongholdHistoryExport): string {
  const lines = [
    `# ${input.title}`,
    '',
    '- 频道：据点房间',
    `- 导出时间：${formatTime(new Date().toISOString())}`,
    '',
    '---',
  ]
  for (const message of input.messages) {
    lines.push(
      '',
      `## ${roleName(message.role, message.senderId, input.participantNames)} · ${formatTime(message.timestamp)}`,
      '',
      message.content.trim(),
    )
  }
  return `${lines.join('\n').trim()}\n`
}

export function downloadMarkdown(title: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeFileName(title)}-${new Date().toISOString().slice(0, 10)}.md`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
