/** Thread 工具执行模式；交互模式仍单独控制工具是否开放。 */
export const EXECUTION_MODES = ['manual', 'auto', 'auto_approve', 'full'] as const
export type ExecutionMode = (typeof EXECUTION_MODES)[number]

export interface AutomaticApprovalRecord {
  source: 'automatic_reviewer'
  decision: 'allow' | 'deny'
  errorCode?:
    | 'timeout'
    | 'model_error'
    | 'invalid_response'
    | 'context_unavailable'
    | 'context_changed'
  reason: string
  modelId?: string
}

export function parseAutomaticApproval(value: unknown): AutomaticApprovalRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (
    item.source !== 'automatic_reviewer' ||
    !['allow', 'deny'].includes(String(item.decision)) ||
    typeof item.reason !== 'string' ||
    !item.reason.trim()
  )
    return undefined
  return {
    source: 'automatic_reviewer',
    decision: item.decision as AutomaticApprovalRecord['decision'],
    reason: item.reason.slice(0, 600),
    modelId: typeof item.modelId === 'string' ? item.modelId : undefined,
    errorCode: [
      'timeout',
      'model_error',
      'invalid_response',
      'context_unavailable',
      'context_changed',
    ].includes(String(item.errorCode))
      ? (item.errorCode as AutomaticApprovalRecord['errorCode'])
      : undefined,
  }
}

export const EXECUTION_MODE_OPTIONS: ReadonlyArray<{
  value: ExecutionMode
  label: string
  description: string
}> = [
  { value: 'manual', label: '手动审批', description: '需要确认的操作由你审批' },
  { value: 'auto', label: '自动执行', description: '终端与工作区外删除仍由你确认' },
  {
    value: 'auto_approve',
    label: '自动审批',
    description: '其他审批由审批模型判断，终端与高危操作仍由你确认',
  },
  { value: 'full', label: '完整权限', description: '已开放工具直接执行，终端与高危操作仍由你确认' },
]

/** 兼容旧版布尔设置及尚未补齐字段的历史记录。 */
export function resolveExecutionMode(mode: unknown, legacyAutoExecute = false): ExecutionMode {
  return EXECUTION_MODES.includes(mode as ExecutionMode)
    ? (mode as ExecutionMode)
    : legacyAutoExecute
      ? 'auto'
      : 'manual'
}
