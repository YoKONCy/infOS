import type { ToolCallView } from './toolCallView'

/** 只使用任务工具的结构化返回值，避免将任意工具正文误识别成任务入口。 */
export function toolTaskTarget(tool: ToolCallView): string | null {
  if (tool.isError || tool.interrupted || !tool.result) return null
  if (!['manage_task', 'interact_with_social'].includes(tool.name)) return null
  try {
    const result = JSON.parse(tool.result)
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null
    if (result.success === false || result.error) return null
    const id = tool.name === 'manage_task' ? result.id : result.taskId
    return typeof id === 'string' && id.trim() && id.length <= 160 ? id : null
  } catch {
    return null
  }
}
