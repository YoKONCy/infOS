import type { BuiltinTool } from '../index'
import type { WorkContextClearRepository } from '../../repositories/workContextClear.repo'
import type { ToolContextService } from '../../services/context/toolContextService'
import { toolSuccess, toolFailure } from '../../services/execution/toolResult'
import { clearPromptReplay } from '../../services/llm/promptCache'
import { NotebookContextProvider } from '../../services/memory/notebook'
import { getProductivityRuntime } from '../productivityRuntimeHolder'
import { t } from '../../lib/i18n'

let repository: WorkContextClearRepository | undefined
let toolContext: ToolContextService | undefined

export function setWorkContextClearDeps(repo: WorkContextClearRepository, context: ToolContextService): void {
  repository = repo
  toolContext = context
}

export const clearWorkContextTool: BuiltinTool = {
  name: 'clear_work_context',
  allowedSources: ['desktop'],
  async execute(_args, ctx) {
    if (!repository || ctx.realmId || ctx.taskId || ctx.generation === undefined || !ctx.pairId || !ctx.toolCallId)
      return toolFailure('WORK_CONTEXT_SCOPE_REQUIRED', t('server.agent', '上下文清理需要当前对话的有效执行身份'))
    ctx.signal?.throwIfAborted()
    const notebook = await new NotebookContextProvider(getProductivityRuntime().workspace).provide({
      agentId: ctx.agentId, threadId: ctx.threadId, channel: ctx.channel,
      tokenBudget: 0, now: new Date().toISOString(),
    })
    ctx.signal?.throwIfAborted()
    const boundary = repository.clear({ threadId: ctx.threadId, agentId: ctx.agentId,
      generation: ctx.generation, pairId: ctx.pairId, toolCallId: ctx.toolCallId })
    if (boundary.applied) {
      clearPromptReplay(`desktop:${ctx.agentId}:${ctx.threadId}`)
      toolContext?.deleteThread(ctx.threadId)
    }
    return toolSuccess(JSON.stringify({ cleared: true, boundaryId: boundary.id }),
      { workContextCleared: boundary.applied, notebookContext: notebook[0]?.content })
  },
}
