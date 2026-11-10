import type { ChatMessage } from '../llm/types'
import { tokenCounter } from '../tokenizer/tokenCounter'
import {
  modelToolObservation,
  retainToolObservation,
  type ToolObservationOwner,
} from '../execution/toolObservation'

interface Group {
  start: number
  end: number
  tool: boolean
}
const WINDOW_KEY = 'infos.work.sliding-window'

/** 上游 Tokenizer 或窗口配置与本地估算不同，只处理明确的输入容量拒绝。 */
export function isContextCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /context[_ -]length[_ -]exceeded|maximum context length|prompt is too long|input token count[^\n]*exceeds|输入[^\n]*(?:超出|超过)[^\n]*(?:上下文|token)/i.test(
    message,
  )
}

/** 工具调用、全部结果和附随媒体构成一个不可拆的协议组。 */
function groupsOf(messages: ChatMessage[]): Group[] {
  const groups: Group[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'system' || message.role === 'tool') continue
    if (!message.toolCalls?.length) {
      groups.push({ start: index, end: index + 1, tool: false })
      continue
    }
    let end = index + 1
    while (
      end < messages.length &&
      messages[end]!.role !== 'assistant' &&
      messages[end]!.role !== 'system' &&
      messages[end]!.cacheControl?.kind !== 'current' &&
      !messages[end]!.cacheControl?.turnStart &&
      !(
        messages[end]!.role === 'user' &&
        messages[end]!.cacheControl?.kind === 'history' &&
        messages[end]!.cacheControl?.historyMessageId !== message.cacheControl?.historyMessageId
      )
    )
      end++
    const answered = new Set(
      messages
        .slice(index + 1, end)
        .filter((item) => item.role === 'tool')
        .map((item) => item.toolCallId),
    )
    if (message.toolCalls.every((call) => answered.has(call.id)))
      groups.push({ start: index, end, tool: true })
    index = end - 1
  }
  return groups
}

/** 每次派发前自动滑窗；只改变模型投影，原始执行记录由单轮记录独立持有。 */
export function slidePromptWindow(
  messages: ChatMessage[],
  budget: number,
  count: () => number,
  owner: ToolObservationOwner = {},
): { usedTokens: number; removedMessages: number } {
  let usedTokens = count()
  if (budget <= 0 || usedTokens <= budget) return { usedTokens, removedMessages: 0 }
  // 批量留出增长余量，避免每个工具轮都移动前缀。
  const target = Math.floor(budget * 0.8)
  const current =
    [...messages].reverse().find((message) => message.cacheControl?.kind === 'current') ??
    [...messages]
      .reverse()
      .find((message) => message.cacheControl?.turnStart && message.role === 'user') ??
    messages.find((message) => message.role === 'user' && message.cacheControl?.kind !== 'history')
  let removedMessages = 0
  const discarded: ChatMessage[] = []
  const removeGroups = (allowLatest: boolean): boolean => {
    const groups = groupsOf(messages)
    const latestTool = [...groups].reverse().find((group) => group.tool)
    const removable = groups.filter((group) => {
      const items = messages.slice(group.start, group.end)
      return (
        (allowLatest || group !== latestTool) &&
        !items.some(
          (item) =>
            item === current ||
            item.cacheControl?.key === WINDOW_KEY ||
            // 本轮框架槽位保持完整；旧轮快照可随窗口退出，释放对应来源锚点。
            (item.cacheControl?.key?.startsWith('prompt-slot:') &&
              (!current?.cacheControl?.replayAnchor ||
                !item.cacheControl.replayAnchor ||
                item.cacheControl.replayAnchor.key === current.cacheControl.replayAnchor.key)),
        )
      )
    })
    const removals = new Set<number>()
    let estimated = usedTokens
    for (const group of removable) {
      if (estimated <= target) break
      const items = messages.slice(group.start, group.end)
      estimated -= tokenCounter.countTokens(JSON.stringify(items))
      for (let index = group.start; index < group.end; index++) removals.add(index)
    }
    if (!removals.size) return false
    const kept = messages.filter((_, index) => !removals.has(index))
    discarded.push(...messages.filter((_, index) => removals.has(index)))
    removedMessages += removals.size
    messages.splice(0, messages.length, ...kept)
    usedTokens = count()
    return true
  }
  while (usedTokens > target && removeGroups(false)) {
    /* 按完整闭合组前移。 */
  }
  if (usedTokens > budget) {
    // 最新工具组单独就很大时，把原件交给已有的分段读取入口，保留最近结果及版本事实。
    const latest = groupsOf(messages)
      .reverse()
      .find((group) => group.tool)
    if (latest) {
      const items = messages.slice(latest.start, latest.end)
      const source = JSON.stringify({
        results: items.filter((item) => item.role === 'tool'),
        calls: items[0]!.toolCalls,
      })
      const observation = modelToolObservation(
        source,
        owner,
        Math.max(512, Math.min(16_000, Math.floor(budget / 4))),
      )
      const replacement: ChatMessage = {
        role: 'user',
        content:
          '【已完成工具组的容量交接：数据】\n以下是已记录的执行结果；引用正文可用 read_file_range 继续查看。不要因历史滑出而重复执行有副作用的操作。\n' +
          observation,
        fileObservations: items.flatMap((item) => item.fileObservations ?? []),
        ...(items[0]!.cacheControl?.replayAnchor
          ? {
              cacheControl: {
                kind: 'snapshot' as const,
                replayAnchor: items[0]!.cacheControl.replayAnchor,
              },
            }
          : {}),
      }
      messages.splice(latest.start, latest.end - latest.start, replacement)
      discarded.push(...items)
      removedMessages += items.length - 1
      usedTokens = count()
    }
  }
  while (usedTokens > budget && removeGroups(true)) {
    /* 继续滑出旧的辅助数据。 */
  }
  if (discarded.length) {
    const previous = messages.find((message) => message.cacheControl?.key === WINDOW_KEY)
    const previousRef =
      typeof previous?.content === 'string'
        ? previous.content.match(/tool-result:[0-9a-f-]{36}/i)?.[0]
        : undefined
    const ref = retainToolObservation(JSON.stringify({ previousRef, messages: discarded }), owner)
    const notice: ChatMessage = previous ?? {
      role: 'user',
      cacheControl: { kind: 'snapshot', key: WINDOW_KEY },
      content:
        '【上下文窗口：数据】较早的完整交互已自动滑出本次请求，原执行记录仍随会话保存。继续当前任务；旧工具结果只代表当时状态，不要自动重放已经执行的操作。',
    }
    notice.content =
      '【上下文窗口：数据】较早的完整交互已自动滑出。继续当前任务，不要自动重放已经执行的操作。' +
      (ref
        ? `\n原始记录：${ref}。需要细节时用 read_file_range 的 path=该引用、offset、limit 分段查看；previousRef 可追溯更早材料。`
        : '')
    // 交接引用随本次滑窗更新，避免旧通知永久固定已经退出的历史起点。
    if (current?.cacheControl?.replayAnchor)
      notice.cacheControl = {
        ...notice.cacheControl,
        kind: 'snapshot',
        replayAnchor: current.cacheControl.replayAnchor,
      }
    if (!previous) {
      const at = messages.findIndex((message) => message.role !== 'system')
      messages.splice(at < 0 ? messages.length : at, 0, notice)
    }
    usedTokens = count()
  }
  return { usedTokens, removedMessages }
}
