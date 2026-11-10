import type { InteractionMode } from '@infos/shared'
import { resolveExecutionMode, type ExecutionMode } from '@infos/shared'
import type { ThreadChannel, ThreadPurpose, ThreadRepository } from '../../repositories/thread.repo'

/** 新会话可继承的会话设置。 */
export interface InheritedThreadSettings {
  interactionMode: InteractionMode
  executionMode: ExecutionMode
  modelConfigId: number | null
  reasoningEffort: import('@infos/shared').ReasoningEffort | null
}

/**
 * 从上一个普通对话推导新会话设置。
 *
 * 执行权限只继承低风险档位：自动审批与完整权限会回落为手动审批，
 * 避免新会话在用户不知情时沿用放开的权限；运行时调试不在 Thread 上，天然不继承。
 */
export function inheritThreadSettings(previous: {
  interactionMode?: string | null
  executionMode?: string | null
  autoExecuteTools?: boolean | null
  modelConfigId?: number | null
  reasoningEffort?: string | null
}): InheritedThreadSettings {
  const executionMode = resolveExecutionMode(
    previous.executionMode,
    Boolean(previous.autoExecuteTools),
  )
  return {
    interactionMode:
      previous.interactionMode === 'minimal' || previous.interactionMode === 'work'
        ? previous.interactionMode
        : 'chat',
    executionMode:
      executionMode === 'manual' || executionMode === 'auto' ? executionMode : 'manual',
    modelConfigId: previous.modelConfigId ?? null,
    reasoningEffort:
      (previous.reasoningEffort as import('@infos/shared').ReasoningEffort | null | undefined) ??
      null,
  }
}

/**
 * 新建 Thread 时要继承的会话设置。
 *
 * 普通桌面对话沿用该角色最近活跃对话的会话设置；后台任务、群聊等其他 Thread 不继承。
 */
export async function inheritedThreadSettingsFor(
  repo: Pick<ThreadRepository, 'findLatestConversation'>,
  params: { agentId: string; channel: ThreadChannel; purpose?: ThreadPurpose },
): Promise<InheritedThreadSettings | undefined> {
  const conversation =
    params.channel === 'desktop' && (params.purpose ?? 'conversation') === 'conversation'
  const previous = conversation ? await repo.findLatestConversation(params.agentId) : undefined
  return previous ? inheritThreadSettings(previous) : undefined
}
