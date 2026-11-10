import { t as __t } from '../../lib/i18n'
/**
 * approvalService — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ToolApprovalRepository } from '../../repositories/toolApproval.repo'
import { AppError } from '../../lib/appError'
import type { ApprovalRiskLevel } from './policyEngine'
import { createLogger } from '../../lib/logger'
import { assertApprovalDecisionAllowed } from './approvalOnceOnly'

const logger = createLogger('ApprovalService')

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny_once'

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'consumed'

export interface ApprovalRequest {
  id: string
  agentId: string
  channel: string
  sessionId: string
  threadId: string
  taskId?: string
  toolName: string
  argsSummary: Record<string, unknown>
  argsFingerprint: string
  reason: string
  riskLevel: ApprovalRiskLevel
  status: ApprovalStatus
  decision?: ApprovalDecision
  /** 用户决策附言（同意/拒绝时写给 Agent 的理由，可选） */
  resolutionMessage?: string
  createdAt: string
  resolvedAt?: string
}

export interface CreateApprovalInput {
  agentId: string
  channel: string
  sessionId: string
  threadId: string
  taskId?: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  riskLevel?: ApprovalRiskLevel
}

export type ApprovalEventListener = (request: ApprovalRequest) => void | Promise<void>

/** SQLite 持久化的工具审批状态机与审计服务。 */
export class ApprovalService {
  private readonly requests = new Map<string, ApprovalRequest>()
  private readonly sessionGrants = new Set<string>()
  private readonly listeners = new Set<ApprovalEventListener>()
  private readonly resolvedListeners = new Set<ApprovalEventListener>()
  private readonly resolutionWaiters = new Map<string, Set<(request: ApprovalRequest) => void>>()
  private waitGuard?: (threadId: string) => () => void

  constructor(private readonly repository?: ToolApprovalRepository) {
    for (const request of repository?.list() ?? []) this.requests.set(request.id, request)
    if (repository) this.rejectPendingAfterRestart()
  }

  onRequested(listener: ApprovalEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setWaitGuard(guard: (threadId: string) => () => void): void {
    this.waitGuard = guard
  }

  /** 通知订阅者失败不能阻断原工具的审批等待与续行。 */
  private notify(listeners: Set<ApprovalEventListener>, request: ApprovalRequest): void {
    for (const listener of listeners) {
      try {
        void Promise.resolve(listener({ ...request })).catch((error) =>
          logger.warn(__t('logs.execution', '审批状态通知失败'), { approvalId: request.id, error }),
        )
      } catch (error) {
        logger.warn(__t('logs.execution', '审批状态通知失败'), { approvalId: request.id, error })
      }
    }
  }

  private finish(request: ApprovalRequest): void {
    const waiters = [...(this.resolutionWaiters.get(request.id) ?? [])]
    this.resolutionWaiters.delete(request.id)
    // 每个调用接收不可共享变更的决策副本，消费凭证不会改变已交付的决策。
    for (const waiter of waiters) waiter({ ...request })
    this.notify(this.resolvedListeners, request)
  }

  /** 订阅审批完成事件，供 Gateway 立即同步所有前端。 */
  onResolved(listener: ApprovalEventListener): () => void {
    this.resolvedListeners.add(listener)
    return () => this.resolvedListeners.delete(listener)
  }

  create(input: CreateApprovalInput): ApprovalRequest {
    const fingerprint = this.fingerprint(input.args)
    const existing = this.list({
      status: 'pending',
      agentId: input.agentId,
      sessionId: input.sessionId,
    }).find(
      (request) =>
        request.toolName === input.toolName &&
        request.argsFingerprint === fingerprint &&
        request.taskId === input.taskId &&
        request.threadId === input.threadId,
    )
    if (existing) {
      this.requests.set(existing.id, existing)
      return existing
    }

    const now = Date.now()
    const request: ApprovalRequest = {
      id: randomUUID(),
      agentId: input.agentId,
      channel: input.channel,
      sessionId: input.sessionId,
      threadId: input.threadId,
      taskId: input.taskId,
      toolName: input.toolName,
      argsSummary: this.sanitizeArgs(input.args),
      argsFingerprint: fingerprint,
      reason: input.reason,
      riskLevel: input.riskLevel ?? 'low',
      status: 'pending',
      createdAt: new Date(now).toISOString(),
    }
    this.requests.set(request.id, request)
    this.repository?.create(request)
    this.audit(request, 'requested', { reason: request.reason, argsSummary: request.argsSummary })
    this.notify(this.listeners, request)
    return request
  }

  resolve(id: string, decision: ApprovalDecision, message?: string): ApprovalRequest {
    const request = this.get(id)
    if (!request) throw new AppError('NOT_FOUND', { message: `审批请求不存在: ${id}` })
    if (request.status !== 'pending') {
      throw new AppError('CONFLICT', { message: `审批请求当前不可决策: ${request.status}` })
    }
    assertApprovalDecisionAllowed(request, decision)
    request.decision = decision
    request.resolutionMessage = message?.trim() ? message.trim().slice(0, 2_000) : undefined
    request.resolvedAt = new Date().toISOString()
    request.status = decision.startsWith('allow_') ? 'approved' : 'denied'

    if (decision === 'allow_session')
      this.sessionGrants.add(this.sessionKey(request.sessionId, request.toolName))
    this.persist(request)
    this.audit(request, 'resolved', { decision, message: request.resolutionMessage })
    this.finish(request)
    return request
  }

  /** 等待审批决策；用于保持原工具调用并在用户决策后原地续行。 */
  waitForResolution(id: string, signal?: AbortSignal): Promise<ApprovalRequest> {
    const current = this.get(id)
    if (!current) return Promise.reject(new Error(`审批请求不存在: ${id}`))
    if (current.status !== 'pending') return Promise.resolve({ ...current })
    return new Promise<ApprovalRequest>((resolve, reject) => {
      const releaseGuard = this.waitGuard?.(current.threadId)
      const cleanup = () => {
        releaseGuard?.()
        signal?.removeEventListener('abort', abort)
        const waiters = this.resolutionWaiters.get(id)
        waiters?.delete(done)
        if (waiters?.size === 0) this.resolutionWaiters.delete(id)
      }
      const done = (request: ApprovalRequest) => {
        cleanup()
        resolve(request)
      }
      const abort = () => {
        cleanup()
        this.cancel(id, '当前执行已停止，旧审批已取消，请勿复用。')
        reject(new Error('审批等待已取消'))
      }
      const waiters = this.resolutionWaiters.get(id) ?? new Set()
      waiters.add(done)
      this.resolutionWaiters.set(id, waiters)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /** 原执行取消后同步关闭卡片与凭证，不让后继会话消费旧审批。 */
  private cancel(id: string, message: string): void {
    const request = this.get(id)
    if (!request || !['pending', 'approved'].includes(request.status)) return
    request.decision = 'deny_once'
    request.status = 'consumed'
    request.resolutionMessage = message
    request.resolvedAt = new Date().toISOString()
    this.persist(request)
    this.audit(request, 'cancelled', { message })
    this.finish(request)
  }

  cancelThread(threadId: string, message: string): void {
    for (const request of this.list())
      if (request.threadId === threadId && ['pending', 'approved'].includes(request.status)) this.cancel(request.id, message)
  }

  get(id: string): ApprovalRequest | undefined {
    const request = this.requests.get(id) ?? this.repository?.get(id)
    if (request) this.requests.set(id, request)
    return request
  }

  list(
    filter: { status?: ApprovalStatus; agentId?: string; sessionId?: string } = {},
  ): ApprovalRequest[] {
    if (this.repository) return this.repository.list(filter)
    return [...this.requests.values()].filter(
      (request) =>
        (!filter.status || request.status === filter.status) &&
        (!filter.agentId || request.agentId === filter.agentId) &&
        (!filter.sessionId || request.sessionId === filter.sessionId),
    )
  }

  listAudit(filter: { approvalId?: string; sessionId?: string } = {}) {
    return this.repository?.listAudit(filter) ?? []
  }

  /** 查找同工具同参数最近一次带附言的拒绝决策（用于把用户理由回传给 Agent）。 */
  findDeniedMessage(input: {
    agentId: string
    sessionId: string
    toolName: string
    args: Record<string, unknown>
  }): string | undefined {
    const fingerprint = this.fingerprint(input.args)
    return this.list({ status: 'denied', agentId: input.agentId })
      .filter(
        (request) =>
          request.toolName === input.toolName &&
          request.sessionId === input.sessionId &&
          request.argsFingerprint === fingerprint,
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
      ?.resolutionMessage
  }

  /** 消费一次性拒绝，把用户附言作为下一次同参数调用的工具观察回传给 Agent。 */
  consumeDeniedOnce(input: {
    agentId: string
    sessionId: string
    taskId?: string
    threadId?: string
    toolName: string
    args: Record<string, unknown>
  }): string | undefined {
    const fingerprint = this.fingerprint(input.args)
    const request = this.list({
      status: 'denied',
      agentId: input.agentId,
      sessionId: input.taskId ? undefined : input.sessionId,
    })
      .filter(
        (candidate) =>
          candidate.decision === 'deny_once' &&
          (!input.taskId ||
            (candidate.taskId === input.taskId && candidate.threadId === input.threadId)) &&
          candidate.toolName === input.toolName &&
          candidate.argsFingerprint === fingerprint,
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
    if (!request) return undefined
    request.status = 'consumed'
    this.persist(request)
    this.audit(request, 'consumed', {
      decision: request.decision,
      message: request.resolutionMessage,
    })
    return request.resolutionMessage ?? '用户拒绝了本次工具调用。'
  }

  authorize(input: {
    approvalId?: string
    onceOnly?: boolean
    taskId?: string
    threadId?: string
    agentId: string
    sessionId: string
    toolName: string
    args: Record<string, unknown>
  }): 'allow' | 'deny' | 'none' {
    if (!input.onceOnly && this.sessionGrants.has(this.sessionKey(input.sessionId, input.toolName)))
      return 'allow'
    const fingerprint = this.fingerprint(input.args)
    const request = input.approvalId
      ? this.get(input.approvalId)
      : this.list({ status: 'approved', agentId: input.agentId, sessionId: input.sessionId }).find(
          (candidate) =>
            candidate.decision === 'allow_once' &&
            candidate.toolName === input.toolName &&
            candidate.argsFingerprint === fingerprint &&
            (!input.onceOnly ||
              (candidate.taskId === input.taskId && candidate.threadId === input.threadId)),
        )
    if (!request || request.status !== 'approved') return 'none'
    if (
      input.onceOnly &&
      (request.decision !== 'allow_once' ||
        request.taskId !== input.taskId ||
        request.threadId !== input.threadId)
    )
      return 'none'
    if (
      request.agentId !== input.agentId ||
      request.sessionId !== input.sessionId ||
      request.toolName !== input.toolName ||
      request.argsFingerprint !== fingerprint
    )
      return 'deny'
    if (request.decision === 'allow_once') {
      request.status = 'consumed'
      this.persist(request)
      this.audit(request, 'consumed', { argsFingerprint: fingerprint })
    }
    return 'allow'
  }

  clearSession(sessionId: string): void {
    for (const key of this.sessionGrants)
      if (key.startsWith(`${sessionId}:`)) this.sessionGrants.delete(key)
    for (const request of this.requests.values()) {
      if (request.sessionId === sessionId && ['pending', 'approved'].includes(request.status)) {
        request.decision = 'deny_once'
        request.status = 'denied'
        request.resolutionMessage = '会话已结束，待处理审批已自动拒绝。'
        request.resolvedAt = new Date().toISOString()
        this.persist(request)
        this.audit(request, 'session_cleared', {})
        this.finish(request)
      }
    }
  }

  /** 服务启动时拒绝上个进程遗留的审批，避免恢复流程复用失效调用栈。 */
  private rejectPendingAfterRestart(): void {
    for (const request of this.repository?.list({ status: 'pending' }) ?? []) {
      if (request.taskId) continue
      request.decision = 'deny_once'
      request.status = 'denied'
      request.resolutionMessage = '服务已重启，旧审批已自动拒绝。'
      request.resolvedAt = new Date().toISOString()
      this.persist(request)
      this.audit(request, 'restart_rejected', { reason: request.resolutionMessage })
    }
  }

  /** 正常关闭时拒绝当前进程仍在等待的全部审批。 */
  rejectAllPending(message = '服务正在关闭，待处理审批已自动拒绝。'): void {
    for (const request of this.list({ status: 'pending' })) {
      if (request.taskId) continue
      request.decision = 'deny_once'
      request.status = 'denied'
      request.resolutionMessage = message
      request.resolvedAt = new Date().toISOString()
      this.persist(request)
      this.audit(request, 'shutdown_rejected', { reason: message })
      this.finish(request)
    }
  }

  private persist(request: ApprovalRequest): void {
    this.requests.set(request.id, request)
    this.repository?.update(request)
  }

  private audit(
    request: ApprovalRequest,
    event:
      | 'requested'
      | 'resolved'
      | 'consumed'
      | 'session_cleared'
      | 'restart_rejected'
      | 'shutdown_rejected'
      | 'cancelled',
    detail: Record<string, unknown>,
  ): void {
    this.repository?.appendAudit({
      approvalId: request.id,
      event,
      agentId: request.agentId,
      sessionId: request.sessionId,
      toolName: request.toolName,
      detail,
    })
  }

  private fingerprint(args: Record<string, unknown>): string {
    return createHash('sha256').update(this.stableStringify(args)).digest('hex')
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value))
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.stableStringify(object[key])}`)
        .join(',')}}`
    }
    return JSON.stringify(value)
  }

  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sensitive = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential/i
    const seen = new WeakSet<object>()
    const sanitize = (value: unknown, key = '', depth = 0): unknown => {
      if (sensitive.test(key)) return '[已隐藏]'
      if (depth > 12) return '[嵌套过深]'
      if (typeof value === 'string') {
        const redacted = value
          .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已隐藏]')
          .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏]')
        return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted
      }
      if (!value || typeof value !== 'object') return value
      if (seen.has(value)) return '[循环引用]'
      seen.add(value)
      if (Array.isArray(value)) return value.map((item) => sanitize(item, '', depth + 1))
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          sanitize(childValue, childKey, depth + 1),
        ]),
      )
    }
    return sanitize(args) as Record<string, unknown>
  }

  private sessionKey(sessionId: string, toolName: string): string {
    return `${sessionId}:${toolName}`
  }
}
