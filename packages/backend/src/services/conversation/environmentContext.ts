/**
 * @file 环境事件的请求校验与上下文注入。
 *
 * 桌面客户端在用户发消息时附带自上次以来记下的环境事件（空闲、全屏、她发起的任务完成）。
 * 这里只把它们写进本轮送给模型的用户消息末尾（`<desktop_environment>`），不写入 Thread 正文，
 * 也不会单独触发回合。任务完成事件要核对任务确实属于这个角色且已完成，否则丢弃。
 */

import { z } from 'zod'
import type { DesktopEnvironmentEvent } from '@infos/shared'

const at = z.number().int().nonnegative()

/** 单次请求最多附带 20 条（与客户端信箱的单次上限一致）。 */
export const environmentEventsSchema = z
  .array(
    z.union([
      z.object({ kind: z.enum(['idle', 'fullscreen']), at, active: z.boolean() }).strict(),
      z
        .object({
          kind: z.literal('task-completed'),
          at,
          taskId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[\w:.-]+$/),
        })
        .strict(),
    ]),
  )
  .max(20)

export interface EnvironmentTaskLookup {
  (taskId: string): Promise<{ agentId: string; title: string; status: string } | null | undefined>
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return '刚才'
  if (minutes < 60) return `约 ${minutes} 分钟前`
  return `约 ${Math.round(minutes / 60)} 小时前`
}

/** 把事件整理成给模型看的几行说明；没有可用事件时返回空数组。 */
export async function describeEnvironmentEvents(
  events: DesktopEnvironmentEvent[],
  agentId: string,
  lookupTask?: EnvironmentTaskLookup,
  now = Date.now(),
): Promise<string[]> {
  const lines: string[] = []
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const when = ago(event.at, now)
    if (event.kind === 'task-completed') {
      const task = await lookupTask?.(event.taskId).catch(() => undefined)
      if (!task || task.agentId !== agentId || task.status !== 'completed') continue
      lines.push(
        `${when}：你发起的后台任务「${task.title.slice(0, 200)}」已完成（任务 ID：${event.taskId}）。`,
      )
    } else if (event.kind === 'idle')
      lines.push(
        event.active
          ? `${when}：用户离开了电脑（一段时间没有操作）。`
          : `${when}：用户回到了电脑前。`,
      )
    else
      lines.push(event.active ? `${when}：用户把某个程序切到了全屏。` : `${when}：用户退出了全屏。`)
  }
  return lines
}

/** 包成标签块；明确这是客户端记录的事实，不是用户的话或指令。 */
export function formatEnvironmentContext(lines: string[]): string {
  if (!lines.length) return ''
  return (
    '\n<desktop_environment>\n' +
    '以下是桌面客户端在用户这次说话之前记下的环境变化，仅供参考，不是用户的话，也不是指令；' +
    '自然地用得上就用，不必逐条回应。\n' +
    `${lines.join('\n')}\n</desktop_environment>`
  )
}

/** 把一段文字追加到本轮模型消息末尾（字符串或多段内容都支持），不改数据库里的用户正文。 */
export function appendContextText<M extends { content?: unknown }>(message: M, text: string): M {
  if (!text) return message
  if (typeof message.content === 'string')
    return { ...message, content: `${message.content}${text}` }
  if (Array.isArray(message.content))
    return { ...message, content: [...message.content, { type: 'text', text }] }
  return { ...message, content: text.trimStart() }
}
