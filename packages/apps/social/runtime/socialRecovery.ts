import { t as __t } from './i18n'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SocialStoragePort, SocialTurnRecord } from '@infos/shared'
import {
  createLogger,
  safeModelDiagnostic,
  retryableLlmError,
} from '@infos/backend/applicationHostAbi'
import type { SocialRateWait } from './socialLoopGuard'

const logger = createLogger('SocialRecovery')

export const SOCIAL_TURN_DURATION_MS = 6 * 60 * 60_000

/** 每个固定消息批次共用恢复预算和取消信号，工具与发送共享同一执行现场。 */
export interface SocialRecovery {
  executionId?: string
  processId?: string
  record: SocialTurnRecord
  signal: AbortSignal
  save(): Promise<void>
}

/** 短时限流保留当前现场并展示等待原因，恢复后继续原任务。 */
export function socialRateGateOptions(recovery: SocialRecovery) {
  return {
    signal: recovery.signal,
    onWait: async (waiting?: SocialRateWait) => {
      if (recovery.signal.aborted) return
      if (waiting) {
        recovery.record.checkpoint.loopGuardWait = waiting
        const label = { turns: '处理批次', requests: '模型请求', sends: '平台发送' }[waiting.kind]
        recovery.record.error = `社交频率限制：${label}正在等待窗口恢复，预计 ${new Date(waiting.until).toLocaleString('zh-CN', { hour12: false })} 继续；消息已保留`
      } else {
        delete recovery.record.checkpoint.loopGuardWait
        if (recovery.record.error?.startsWith('社交频率限制：')) recovery.record.error = undefined
      }
      await recovery.save()
    },
  }
}

const current = new AsyncLocalStorage<SocialRecovery>()
const step = new AsyncLocalStorage<string>()
/** 终态任务携带明确的不可重试标志，外层不能再按错误文案重新接管。 */
export class SocialTurnEndedError extends Error {
  readonly code = 'SOCIAL_TURN_ENDED'
  readonly data = { retryable: false }
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SocialTurnEndedError'
  }
}
export const currentSocialRecovery = () => current.getStore()
export const currentSocialStep = () => step.getStore()
export function runSocialStep<T>(id: string, run: () => Promise<T>): Promise<T> {
  return step.run(id, run)
}
export function assertSocialActive(): void {
  current.getStore()?.signal.throwIfAborted()
}
export function runSocialRecovery<T>(recovery: SocialRecovery, run: () => Promise<T>): Promise<T> {
  return current.run(recovery, run)
}

export function socialFailure(error: unknown): {
  retryable: boolean
  cancelled: boolean
  message: string
} {
  const value = error as {
    code?: string
    message?: string
    data?: { retryable?: boolean; status?: number }
    name?: string
  }
  const message = value?.message || String(error)
  const cancelled =
    value?.name === 'AbortError' ||
    /SOCIAL_EXECUTION_(?:CANCELLED|TIMED_OUT)|社交任务已取消|社交任务已超时/.test(message)
  const retryable =
    !cancelled &&
    value?.data?.retryable !== false &&
    (value?.data?.retryable === true ||
      retryableLlmError(error) ||
      [408, 429, 500, 502, 503, 504].includes(value?.data?.status ?? 0) ||
      ['LLM_TIMEOUT', 'LLM_RATE_LIMITED', 'NETWORK_ERROR'].includes(value?.code ?? '') ||
      /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|网络连接/.test(message))
  return { retryable, cancelled, message }
}

export async function finishSocialTurn(
  storage: SocialStoragePort,
  record: SocialTurnRecord,
  status: SocialTurnRecord['status'],
  error?: string,
): Promise<void> {
  record.status = status
  record.error = error?.slice(0, 500)
  record.updatedAt = new Date().toISOString()
  const outcome = record.checkpoint.outcome as
    | { endParticipation?: boolean; lowActivity?: boolean }
    | undefined
  const participation =
    outcome && (outcome.endParticipation || outcome.lowActivity)
      ? {
          ...(outcome.endParticipation ? { endParticipation: true } : {}),
          ...(outcome.lowActivity ? { lowActivity: true } : {}),
        }
      : undefined
  // 托管等待保留恢复现场；终态仅留诊断摘要，以及尚未补存的已送达消息，不保留其余工具正文或图片。
  record.checkpoint =
    status === 'waiting' && record.checkpoint.orchestration
      ? record.checkpoint
      : status === 'waiting'
        ? {
            inbound: record.checkpoint.inbound,
            policy: record.checkpoint.policy,
            outcome: record.checkpoint.outcome,
          }
        : Object.keys((record.checkpoint.pendingHistory ?? {}) as object).length
          ? {
              pendingHistory: record.checkpoint.pendingHistory,
              deliveryDataVersion: record.checkpoint.deliveryDataVersion,
            }
          : {}
  if (participation && status !== 'waiting') record.checkpoint.participation = participation
  await storage.saveTurn(record)
  logger.info(__t('apps.social.logs', '社交回合状态已保存'), {
    turnId: record.id,
    agentId: record.agentId,
    accountId: record.accountId,
    channelId: record.channelId,
    status,
    outcome: record.outcome,
    modelResponses: record.generationSummary?.modelResponses,
    toolCalls: record.generationSummary?.toolCalls,
    error: error ? safeModelDiagnostic(error, 300) : undefined,
  })
}

export async function socialDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new Error('社交任务已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
