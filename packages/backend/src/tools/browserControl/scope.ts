import type { AgentBrowserScope } from '@infos/shared'
import type { ToolContext } from '../../services/agent/toolRegistry'

/** 身份只能由执行上下文派生；普通对话和后台任务分别保留活动页面。 */
export function browserToolScope(context: ToolContext): AgentBrowserScope {
  return (
    context.browserScope ?? {
      profileId: 'desktop',
      sessionId: JSON.stringify([context.threadId, context.taskId ?? null]),
    }
  )
}
