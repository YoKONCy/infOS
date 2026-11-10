import { z } from 'zod'
import type { BuiltinTool } from '../index'
import { toolFailure, toolSuccess } from '../../services/execution/toolResult'
import { t } from '../../lib/i18n'

const identifier = z.string().trim().min(1).max(120)
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('publish'),
    id: identifier,
    content: z.string().trim().min(1),
    spoken_reply: z.string().optional(),
    responds_to: z.array(z.string()).max(50).default([]),
  }),
  z.object({
    action: z.literal('wait'),
    items: z.array(z.object({
      id: identifier,
      question: z.string().trim().min(1).max(2000),
      continuation: z.string().trim().min(1).max(8000),
      message_ids: z.array(z.number().int().positive()).min(1).max(50),
      expires_at: z.string().datetime().optional(),
    })).min(1).max(20),
  }),
  z.object({
    action: z.literal('resolve'),
    ids: z.array(z.string()).min(1).max(50),
  }),
])

export const conversationTool: BuiltinTool = {
  name: 'conversation',
  allowedSources: ['desktop'],
  async execute(args, ctx) {
    if (!ctx.conversation) return toolFailure('MAIN_CONVERSATION_REQUIRED', t('server.conversation', '此操作需要主会话执行'))
    const parsed = schema.safeParse(args)
    if (!parsed.success) return toolFailure('INVALID_CONVERSATION_ACTION', t('server.conversation', '交流操作参数不完整，请核对操作及来源'))
    ctx.signal?.throwIfAborted()
    const input = parsed.data
    if (input.action === 'publish') {
      const receipt = await ctx.conversation.publish({
        id: input.id, content: input.content, spokenReply: input.spoken_reply, respondsTo: input.responds_to,
      })
      return toolSuccess(JSON.stringify(receipt), { conversationMessage: { ...receipt, content: input.content } })
    }
    if (input.action === 'resolve') {
      await ctx.conversation.resolve(input.ids)
      return toolSuccess(JSON.stringify({ resolved: input.ids }))
    }
    const waits = await ctx.conversation.wait(input.items.map((item) => ({
      id: item.id,
      question: item.question,
      continuation: item.continuation,
      messageIds: item.message_ids,
      expiresAt: item.expires_at,
    })))
    // 等待现场落盘后结束当前执行，用户回答由新的执行接续。
    return { ...toolSuccess(JSON.stringify({ waiting: waits })), shouldTerminate: true }
  },
}
