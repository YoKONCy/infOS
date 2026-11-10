import { t as __t } from '../../lib/i18n'
/**
 * ReAct 循环里的回答预填充状态提示与日志。
 *
 * 由 runReActLoop 调用：首轮「正在思考」状态里说明预填充被跳过的原因，
 * 以及记录上游未按预填充续写的情况。
 *
 * @module packages/backend/src/services/agent/prefillStatus
 */
import type { AssistantPrefillSkipReason } from '@infos/shared'
import { createLogger } from '../../lib/logger'
import { assistantPrefillSkipText } from '../prompt/assistantPrefillNotice'
import type { PrefillOutcome } from '../prompt/prefillContinuation'

const logger = createLogger('ReActLoop')

/** 「正在思考」状态文案；预填充因模型能力被跳过时带上简短原因并记录日志。 */
export function thinkingStatusMessage(
  skipped: { reason: AssistantPrefillSkipReason } | undefined,
  modelId: string,
): string {
  if (skipped)
    logger.info(__t('logs.agent', '当前模型组合不支持回答预填充，本次执行不发送'), {
      reason: skipped.reason,
      modelId,
    })
  return skipped
    ? __t('server.agent', '正在思考...（未使用回答预填充：{0}）', [
        assistantPrefillSkipText(skipped.reason),
      ])
    : __t('server.agent', '正在思考...')
}

/** 上游没有按预填充续写时记录日志；此时本轮回复不拼回预填充。 */
export function logPrefillOutcome(outcome: PrefillOutcome, turn: number): void {
  if (outcome === 'ignored' || outcome === 'restarted')
    logger.info(__t('logs.agent', '上游未按预填充续写，本轮回复未拼回预填充'), {
      outcome,
      turn,
    })
}
