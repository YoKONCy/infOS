/** 陪看说过的话进上下文的条数。 */
export const WATCH_LINES_IN_CONTEXT = 12

/** 陪看约一分钟一句，一部片子上百条：进上下文的只留最近几条，聊天记录里照常都在。 */
export function keepRecentWatchLines<T extends { id: number; pairId?: string | null }>(
  loadedMessages: T[],
): T[] {
  const watchLines = loadedMessages.filter((message) => message.pairId?.startsWith('perception:'))
  const droppedWatchLines = new Set(watchLines.slice(0, -WATCH_LINES_IN_CONTEXT).map((message) => message.id))
  return droppedWatchLines.size
    ? loadedMessages.filter((message) => !droppedWatchLines.has(message.id))
    : loadedMessages
}
