/**
 * 高危审批只能逐次批准：高/严重风险或命中高危名单的请求不得授予会话级许可。
 *
 * 由 ApprovalService.resolve 在写入决策前调用。
 *
 * @module packages/backend/src/services/execution/approvalOnceOnly
 */
import { homedir } from 'node:os'
import { isHighRiskToolCall } from '@infos/shared'
import { AppError } from '../../lib/appError'
import type { ApprovalDecision, ApprovalRequest } from './approvalService'

/** 高危请求选择「本会话允许」时抛出 CONFLICT（APPROVAL_ONCE_ONLY）。 */
export function assertApprovalDecisionAllowed(
  request: ApprovalRequest,
  decision: ApprovalDecision,
): void {
  const highRisk = isHighRiskToolCall(
    {
      toolName: request.toolName,
      args: request.argsSummary,
      readOnlyTerminal: false,
      runtimeScoped: false,
      deleteOutsideWorkspace: false,
    },
    { platform: process.platform, env: process.env, home: homedir() },
  )
  if (
    decision === 'allow_session' &&
    (request.riskLevel === 'high' || request.riskLevel === 'critical' || highRisk)
  )
    throw new AppError('CONFLICT', { message: 'APPROVAL_ONCE_ONLY' })
}
