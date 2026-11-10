import { randomUUID } from 'node:crypto'
import {
  getAgentInputQuestions,
  type AgentInputOption,
  type AgentInputQuestion,
  type AgentInputAnswer,
  type AgentInputSubmission,
} from '@infos/shared'
import { normalizeAgentInputQuestions, validateAgentInputAnswers } from './agentInputAnswers'
import { AppError } from '../../lib/appError'
import type { AgentInputRepository } from '../../repositories/agentInput.repo'

export type AgentInputStatus = 'pending' | 'answered' | 'skipped' | 'cancelled' | 'interrupted'

export const AGENT_INPUT_TIMEOUT_MS = 10 * 60_000
export const AGENT_INPUT_UNANSWERED_MESSAGE = '已经过去10分钟未响应，用户可能正在忙，暂时无法回应。'

export function isUnansweredAgentInput(request: AgentInputRequest): boolean {
  return (
    (request.status === 'pending' || request.status === 'skipped') &&
    request.responseMessage === AGENT_INPUT_UNANSWERED_MESSAGE
  )
}

export type { AgentInputOption } from '@infos/shared'

export interface AgentInputRequest {
  id: string
  agentId: string
  channel: string
  sessionId: string
  threadId: string
  taskId?: string
  questions?: AgentInputQuestion[]
  answers?: AgentInputAnswer[]
  question: string
  context?: string
  options: AgentInputOption[]
  allowFreeText: boolean
  required: boolean
  status: AgentInputStatus
  selectedOptionIds: string[]
  responseMessage?: string
  createdAt: string
  resolvedAt?: string
}

export interface CreateAgentInput {
  agentId: string
  channel: string
  sessionId: string
  threadId: string
  taskId?: string
  questions?: unknown
  question?: string
  context?: string
  options?: AgentInputOption[]
  allowFreeText?: boolean
  required?: boolean
}

export type AgentInputEventListener = (request: AgentInputRequest) => void | Promise<void>

/** Agent主动向用户求助时使用的持久化等待状态机。 */
export class AgentInputService {
  private readonly requests = new Map<string, AgentInputRequest>()
  private readonly requestedListeners = new Set<AgentInputEventListener>()
  private readonly resolvedListeners = new Set<AgentInputEventListener>()
  private readonly waiters = new Map<string, Set<(request: AgentInputRequest) => void>>()
  private waitGuard?: (threadId: string) => () => void

  constructor(private readonly repository?: AgentInputRepository) {
    for (const request of repository?.list() ?? []) this.requests.set(request.id, request)
    if (repository) this.interruptPendingAfterRestart()
  }

  onRequested(listener: AgentInputEventListener): () => void {
    this.requestedListeners.add(listener)
    return () => this.requestedListeners.delete(listener)
  }

  setWaitGuard(guard: (threadId: string) => () => void): void {
    this.waitGuard = guard
  }

  onResolved(listener: AgentInputEventListener): () => void {
    this.resolvedListeners.add(listener)
    return () => this.resolvedListeners.delete(listener)
  }

  create(input: CreateAgentInput): AgentInputRequest {
    if (this.list({ status: 'pending', sessionId: input.sessionId }).length > 0) {
      throw new AppError('CONFLICT', {
        message: '当前对话已有一个等待用户回答的问题',
      })
    }
    const questions =
      input.questions !== undefined ? normalizeAgentInputQuestions(input.questions) : undefined
    const question = questions?.[0]?.question ?? input.question?.trim() ?? ''
    if (!question) throw new AppError('VALIDATION_ERROR', { message: '问题不能为空' })
    const options = questions?.[0]?.options ?? this.normalizeOptions(input.options ?? [])
    const allowFreeText = questions ? true : input.allowFreeText !== false
    if (!allowFreeText && options.length === 0) {
      throw new AppError('VALIDATION_ERROR', { message: '禁用自由回答时必须提供选项' })
    }
    const request: AgentInputRequest = {
      id: randomUUID(),
      agentId: input.agentId,
      channel: input.channel,
      sessionId: input.sessionId,
      threadId: input.threadId,
      taskId: input.taskId,
      questions,
      answers: [],
      question: question.slice(0, 2_000),
      context: input.context?.trim().slice(0, 2_000) || undefined,
      options,
      allowFreeText,
      required: input.required === true,
      status: 'pending',
      selectedOptionIds: [],
      createdAt: new Date().toISOString(),
    }
    this.requests.set(request.id, request)
    this.repository?.create(request)
    for (const listener of this.requestedListeners) void listener(request)
    return request
  }

  resolve(id: string, input: AgentInputSubmission): AgentInputRequest {
    const request = this.get(id)
    if (!request) throw new AppError('NOT_FOUND', { message: '求助请求不存在' })
    this.expireRequest(request, Date.now())
    if (request.status !== 'pending') {
      throw new AppError('CONFLICT', { message: `求助请求当前不可回答: ${request.status}` })
    }
    if (input.skipped) {
      if (request.required) throw new AppError('VALIDATION_ERROR', { message: '这个问题需要回答' })
      request.status = 'skipped'
    } else {
      const questions = getAgentInputQuestions(request)
      const answers = validateAgentInputAnswers(
        request,
        input.answers ??
          (questions.length === 1
            ? [
                {
                  questionId: questions[0]!.id,
                  selectedOptionIds: input.selectedOptionIds ?? [],
                  message: input.message,
                },
              ]
            : []),
      )
      request.status = 'answered'
      request.answers = answers
      request.selectedOptionIds = answers.length === 1 ? answers[0]!.selectedOptionIds : []
      request.responseMessage = answers.length === 1 ? answers[0]!.message : undefined
    }
    request.resolvedAt = new Date().toISOString()
    this.persist(request)
    this.finish(request)
    return request
  }

  waitForResolution(id: string, signal?: AbortSignal): Promise<AgentInputRequest> {
    const current = this.get(id)
    if (!current) return Promise.reject(new Error(`求助请求不存在: ${id}`))
    this.expireRequest(current, Date.now())
    if (current.status !== 'pending' || isUnansweredAgentInput(current))
      return Promise.resolve(current)
    return new Promise<AgentInputRequest>((resolve, reject) => {
      const releaseGuard = this.waitGuard?.(current.threadId)
      let timeout: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        releaseGuard?.()
        if (timeout) clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        this.waiters.get(id)?.delete(done)
      }
      const done = (request: AgentInputRequest) => {
        cleanup()
        resolve(request)
      }
      const abort = () => {
        cleanup()
        this.cancel(id, '当前ReAct已停止，求助请求已取消。')
        reject(new Error('用户回答等待已取消'))
      }
      const waiters = this.waiters.get(id) ?? new Set()
      waiters.add(done)
      this.waiters.set(id, waiters)
      if (signal?.aborted) abort()
      else {
        signal?.addEventListener('abort', abort, { once: true })
        timeout = setTimeout(
          () => {
            try {
              const request = this.get(id)
              if (request) this.expireRequest(request, Date.now())
            } catch (error) {
              cleanup()
              reject(error)
            }
          },
          Math.max(0, Date.parse(current.createdAt) + AGENT_INPUT_TIMEOUT_MS - Date.now()),
        )
      }
    })
  }

  hasActiveWaiter(id: string): boolean {
    return (this.waiters.get(id)?.size ?? 0) > 0
  }

  /** 后台问题按创建时间兜底，重启不重置等待期限。 */
  expireUnanswered(now = Date.now()): void {
    for (const request of this.list({ status: 'pending' })) this.expireRequest(request, now)
  }

  private expireRequest(request: AgentInputRequest, now: number): void {
    if (
      request.status !== 'pending' ||
      isUnansweredAgentInput(request) ||
      now - Date.parse(request.createdAt) < AGENT_INPUT_TIMEOUT_MS
    )
      return
    request.responseMessage = AGENT_INPUT_UNANSWERED_MESSAGE
    if (!request.required) {
      request.status = 'skipped'
      request.resolvedAt = new Date(now).toISOString()
    }
    this.persist(request)
    if (request.required) {
      // 必答问题仍可回答，只释放本次执行等待并刷新已有求助卡片。
      for (const listener of this.requestedListeners) void listener(request)
      this.releaseWaiters(request)
    } else this.finish(request)
  }

  get(id: string): AgentInputRequest | undefined {
    const request = this.requests.get(id) ?? this.repository?.get(id)
    if (request) this.requests.set(id, request)
    return request
  }

  list(
    filter: {
      status?: AgentInputStatus
      agentId?: string
      sessionId?: string
      threadId?: string
    } = {},
  ): AgentInputRequest[] {
    if (this.repository) return this.repository.list(filter)
    return [...this.requests.values()].filter(
      (request) =>
        (!filter.status || request.status === filter.status) &&
        (!filter.agentId || request.agentId === filter.agentId) &&
        (!filter.sessionId || request.sessionId === filter.sessionId) &&
        (!filter.threadId || request.threadId === filter.threadId),
    )
  }

  cancelAllPending(message = '服务正在关闭，待回答问题已自动取消。'): void {
    for (const request of this.list({ status: 'pending' })) {
      if (request.taskId) continue
      if (request.required) this.releaseWaiters(request)
      else this.cancel(request.id, message)
    }
  }

  cancelTask(taskId: string): void {
    for (const request of this.list({ status: 'pending' }))
      if (request.taskId === taskId) this.cancel(request.id, '任务已调整或停止，旧问题已取消。')
  }

  cancelThread(threadId: string, message: string): void {
    for (const request of this.list({ threadId, status: 'pending' })) this.cancel(request.id, message)
  }

  private cancel(id: string, message: string): void {
    const request = this.get(id)
    if (!request || request.status !== 'pending') return
    request.status = 'cancelled'
    request.responseMessage = message
    request.resolvedAt = new Date().toISOString()
    this.persist(request)
    this.finish(request)
  }

  private interruptPendingAfterRestart(): void {
    for (const request of this.repository?.list({ status: 'pending' }) ?? []) {
      if (request.taskId || request.required) continue
      this.expireRequest(request, Date.now())
      if (request.status !== 'pending') continue
      request.status = 'interrupted'
      request.responseMessage = '服务已重启，旧问题已中断。'
      request.resolvedAt = new Date().toISOString()
      this.persist(request)
    }
  }

  private finish(request: AgentInputRequest): void {
    for (const listener of this.resolvedListeners) void listener(request)
    this.releaseWaiters(request)
  }

  private releaseWaiters(request: AgentInputRequest): void {
    for (const waiter of this.waiters.get(request.id) ?? []) waiter(request)
    this.waiters.delete(request.id)
  }

  private persist(request: AgentInputRequest): void {
    this.requests.set(request.id, request)
    this.repository?.update(request)
  }

  private normalizeOptions(options: AgentInputOption[]): AgentInputOption[] {
    if (options.length > 4) throw new AppError('VALIDATION_ERROR', { message: '最多提供四个选项' })
    const ids = new Set<string>()
    return options.map((option) => {
      const id = option.id.trim().slice(0, 80)
      const label = option.label.trim().slice(0, 80)
      if (!id || !label || ids.has(id)) {
        throw new AppError('VALIDATION_ERROR', { message: '选项ID和标题必须非空且ID不可重复' })
      }
      ids.add(id)
      return {
        id,
        label,
        description: option.description?.trim().slice(0, 240) || undefined,
      }
    })
  }
}
