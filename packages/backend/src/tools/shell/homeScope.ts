import type { ToolContext } from '../../services/agent/toolRegistry'

/** 新建卡片与全部预制件操作（收纳框）注入运行上下文的身份。 */
export function shellHomeInput(operation: string, input: unknown, context: ToolContext): unknown {
  const isCardCreate =
    operation === 'card' && (input as { action?: string } | undefined)?.action === 'create'
  return isCardCreate || operation === 'prefab' ? withShellHomeScope(input, context) : input
}

/** 身份来自工具运行上下文，丢弃模型参数中的同名字段。 */
export function withShellHomeScope(input: unknown, context: ToolContext): Record<string, unknown> {
  const {
    __homeScope: _ignored,
    homeBinding: _binding,
    createdBy: _creator,
    ...parameters
  } = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return {
    ...parameters,
    __homeScope: { agentId: context.agentId, sessionId: context.threadId },
  }
}
