import { t as __t } from '../../lib/i18n'
/**
 * Runtime State Service — 运行时状态管理
 *
 * 后端持久资源权威服务（不含全局活跃 Agent）。
 *
 * 三大职责：
 * 1. LLM 调用状态管理（整合旧 TaskManager）
 *    - 按 threadId 索引正在进行的 LLM 调用
 *    - 支持暂停/恢复/取消/指令注入/超时保护
 *    - 进度广播（Gateway 集成）
 *
 * 2. 窗口级活跃 Agent（替代旧 AgentManager.activeAgentId）
 *    - 前端窗口 → AgentId 映射
 *    - 不维护全局单一活跃 Agent（前端窗口级状态）
 *
 * 3. Thread 运行时状态
 *    - 正在打字的 Thread 标记
 *    - 最后活跃时间
 *
 * 设计原则：
 * - 不维护全局活跃 Agent（那是前端窗口级状态）
 * - 不持久化 Thread 状态（那是 ThreadService 的事）
 * - 不管理 Agent 定义（那是 AgentManager 的事）
 *
 * @module packages/backend/src/services/runtime/runtimeStateService
 */

import { createLogger } from '../../lib/logger'
import { AppError } from '../../lib/appError'

const logger = createLogger('RuntimeStateService')

/** 默认整轮任务执行时限（ms）— 6 小时。 */
// 整轮对话的安全上限；单次模型请求由独立的空闲超时管理。
const DEFAULT_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

/** LLM 调用任务状态 */
interface TaskState {
  /** 队列交接只取消模型生成，不取消已经开始的工具。 */
  handoffRequested: boolean
  modelController: AbortController
  /** 是否暂停 */
  paused: boolean
  /** 待注入的即时指令 */
  pendingInstruction: string | null
  /** 是否已请求取消 */
  cancelled: boolean
  /** 任务开始时间 */
  startedAt: number
  /** 当前轮次 */
  currentTurn: number
  /** Agent ID */
  agentId?: string
  /** 超时定时器 */
  timeoutTimer: ReturnType<typeof setTimeout> | null
  /** 取消在飞请求的控制器 */
  abortController: AbortController
}

/** 任务信息（给 API 返回） */
export interface TaskInfo {
  threadId: string
  state: 'running' | 'paused' | 'cancelled'
  startedAt: number
  currentTurn: number
  elapsedMs: number
  agentId?: string
}

/** 进度广播回调 */
export type ProgressBroadcaster = (params: {
  threadId: string
  turn: number
  state: 'running' | 'paused' | 'completed' | 'cancelled' | 'error'
  message?: string
}) => Promise<void>

/** Thread 运行时状态 */
interface ThreadRuntimeState {
  /** 是否正在生成回复（打字中） */
  isTyping: boolean
  /** 最后活跃时间戳 */
  lastActiveAt: number
}

// ─────────────────────────────────────────────
// RuntimeStateService
// ─────────────────────────────────────────────

export class RuntimeStateService {
  private readonly timeoutDeadlines = new WeakMap<TaskState, number>()
  private readonly timeoutSuspensions = new WeakMap<
    TaskState,
    { count: number; remaining: number }
  >()
  // ── LLM 调用状态（按 threadId 索引） ──
  private tasks = new Map<string, TaskState>()

  // ── 全局活跃 Agent（后端唯一权威） ──
  private activeAgentId: string | null = null

  // ── 窗口级活跃 Agent（兼容现有窗口映射） ──
  private windowAgents = new Map<string, string>()

  // ── Thread 运行时状态（按 threadId 索引） ──
  private threadStates = new Map<string, ThreadRuntimeState>()

  /** 进度广播回调（Gateway 注入） */
  private broadcaster: ProgressBroadcaster | null = null

  /** 任务超时时间（ms） */
  private timeoutMs: number

  constructor(timeoutMs: number = DEFAULT_TASK_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  // ─────────────────────────────────────────
  // 1. LLM 调用状态管理（整合旧 TaskManager）
  // ─────────────────────────────────────────

  /** 注入进度广播回调 */
  setBroadcaster(broadcaster: ProgressBroadcaster): void {
    this.broadcaster = broadcaster
  }

  /**
   * 注册任务（LLM 调用开始时调用）
   * @param threadId  Thread ID
   * @param agentId   执行任务的 Agent ID
   */
  registerTask(threadId: string, agentId?: string): void {
    if (this.tasks.has(threadId))
      throw new AppError('RESOURCE_BUSY', { message: '当前会话仍在执行，请先排队或等待结束' })
    // 清理可能的旧任务
    this.cleanupTask(threadId)

    const state: TaskState = {
      handoffRequested: false,
      modelController: new AbortController(),
      paused: false,
      pendingInstruction: null,
      cancelled: false,
      startedAt: Date.now(),
      currentTurn: 0,
      agentId,
      timeoutTimer: null,
      abortController: new AbortController(),
    }

    // 设置超时定时器
    this.timeoutDeadlines.set(state, Date.now() + this.timeoutMs)
    state.timeoutTimer = setTimeout(() => {
      this.handleTimeout(threadId)
    }, this.timeoutMs)

    this.tasks.set(threadId, state)
    logger.debug(
      __t('logs.runtime', '任务注册: thread={0}, agent={1}', [threadId, agentId ?? 'default']),
    )

    // 标记 Thread 为打字中
    this.setThreadTyping(threadId, true)

    // 广播进度
    this.broadcastProgress(threadId, 'running', '任务已开始')
  }

  /**
   * 注销任务（LLM 调用时调用）
   * @param threadId  Thread ID
   */
  unregisterTask(threadId: string, expectedSignal?: AbortSignal): void {
    const state = this.tasks.get(threadId)
    if (expectedSignal && state?.abortController.signal !== expectedSignal) return
    if (state) {
      // 清理超时定时器
      if (state.timeoutTimer) {
        clearTimeout(state.timeoutTimer)
      }
      // 广播完成
      this.broadcastProgress(threadId, 'completed', '任务完成')
    }
    this.tasks.delete(threadId)
    logger.debug(__t('logs.runtime', '任务注销: thread={0}', [threadId]))

    // 取消 Thread 打字状态
    this.setThreadTyping(threadId, false)
  }

  /** 等待用户期间暂停执行超时，结束等待后恢复原有剩余预算。 */
  suspendTimeout(threadId: string): () => void {
    const state = this.tasks.get(threadId)
    if (!state || state.cancelled) return () => {}
    let suspension = this.timeoutSuspensions.get(state)
    if (!suspension) {
      if (!state.timeoutTimer) return () => {}
      suspension = {
        count: 0,
        remaining: Math.max(0, (this.timeoutDeadlines.get(state) ?? Date.now()) - Date.now()),
      }
      this.timeoutSuspensions.set(state, suspension)
      clearTimeout(state.timeoutTimer)
      state.timeoutTimer = null
    }
    const activeSuspension = suspension
    activeSuspension.count++
    let released = false
    return () => {
      if (released) return
      released = true
      if (--activeSuspension.count > 0) return
      this.timeoutSuspensions.delete(state)
      if (this.tasks.get(threadId) !== state || state.cancelled) return
      this.timeoutDeadlines.set(state, Date.now() + activeSuspension.remaining)
      state.timeoutTimer = setTimeout(
        () => this.handleTimeout(threadId),
        activeSuspension.remaining,
      )
    }
  }

  /** 更新当前轮次 */
  updateTurn(threadId: string, turn: number): void {
    const state = this.tasks.get(threadId)
    if (!state) return
    state.currentTurn = turn
  }

  /** 检查暂停（ReAct 每轮开始时调用） */
  async checkPause(threadId: string): Promise<void> {
    const state = this.tasks.get(threadId)
    if (!state?.paused) return

    logger.info(__t('logs.runtime', '任务暂停中: thread={0}', [threadId]))
    this.broadcastProgress(threadId, 'paused', '任务已暂停')

    // 等待恢复（轮询，每 500ms 检查一次）
    while (state.paused && !state.cancelled) {
      await new Promise((r) => setTimeout(r, 500))
    }
    logger.info(__t('logs.runtime', '任务已恢复: thread={0}', [threadId]))
    this.broadcastProgress(threadId, 'running', '任务已恢复')
  }

  /** 获取并清空待注入的即时指令 */
  getInjectedInstruction(threadId: string): string | null {
    const state = this.tasks.get(threadId)
    if (!state?.pendingInstruction) return null
    const instruction = state.pendingInstruction
    state.pendingInstruction = null
    return instruction
  }

  requestHandoff(threadId: string): boolean {
    const state = this.tasks.get(threadId)
    if (!state || state.cancelled) return false
    state.handoffRequested = true
    state.paused = false
    state.modelController.abort(new Error('用户已提交新指令，正在交接当前执行'))
    this.broadcastProgress(threadId, 'running', '正在保存已有进度并接续新指令')
    return true
  }

  isHandoffRequested(threadId: string): boolean {
    return this.tasks.get(threadId)?.handoffRequested ?? false
  }

  getModelInterruptSignal(threadId: string): AbortSignal | undefined {
    return this.tasks.get(threadId)?.modelController.signal
  }

  /** 暂停任务 */
  pauseTask(threadId: string): boolean {
    const state = this.tasks.get(threadId)
    if (!state) return false
    state.paused = true
    logger.info(__t('logs.runtime', '暂停: thread={0}', [threadId]))
    this.broadcastProgress(threadId, 'paused', '任务已暂停')
    return true
  }

  /** 恢复任务 */
  resumeTask(threadId: string): boolean {
    const state = this.tasks.get(threadId)
    if (!state) return false
    state.paused = false
    logger.info(__t('logs.runtime', '恢复: thread={0}', [threadId]))
    this.broadcastProgress(threadId, 'running', '任务已恢复')
    return true
  }

  /** 注入即时指令（下一轮 ReAct 开始时注入到消息中） */
  injectInstruction(threadId: string, instruction: string): boolean {
    const state = this.tasks.get(threadId)
    if (!state) return false
    state.pendingInstruction = instruction
    logger.info(
      __t('logs.runtime', '注入指令: thread={0} → "{1}..."', [threadId, instruction.slice(0, 30)]),
    )
    return true
  }

  /** 取消任务 */
  cancelTask(threadId: string): boolean {
    const state = this.tasks.get(threadId)
    if (!state) return false
    state.cancelled = true
    state.paused = false // 如果在暂停中则释放
    state.abortController.abort()
    logger.info(__t('logs.runtime', '取消: thread={0}', [threadId]))
    this.broadcastProgress(threadId, 'cancelled', '任务已取消')
    return true
  }

  /** 检查是否已取消 */
  isCancelled(threadId: string): boolean {
    return this.tasks.get(threadId)?.cancelled ?? false
  }

  /** 获取任务取消信号 */
  getAbortSignal(threadId: string): AbortSignal | undefined {
    return this.tasks.get(threadId)?.abortController.signal
  }

  /** 获取活跃任务数 */
  get activeTaskCount(): number {
    return this.tasks.size
  }

  /** 获取活跃任务列表（给 API） */
  listActiveTasks(): TaskInfo[] {
    const now = Date.now()
    return [...this.tasks.entries()].map(([threadId, state]) => ({
      threadId,
      state: state.cancelled
        ? ('cancelled' as const)
        : state.paused
          ? ('paused' as const)
          : ('running' as const),
      startedAt: state.startedAt,
      currentTurn: state.currentTurn,
      elapsedMs: now - state.startedAt,
      agentId: state.agentId,
    }))
  }

  /** 获取单个任务状态 */
  getTaskInfo(threadId: string): TaskInfo | null {
    const state = this.tasks.get(threadId)
    if (!state) return null
    return {
      threadId,
      state: state.cancelled ? 'cancelled' : state.paused ? 'paused' : 'running',
      startedAt: state.startedAt,
      currentTurn: state.currentTurn,
      elapsedMs: Date.now() - state.startedAt,
      agentId: state.agentId,
    }
  }

  /** 设置全局活跃 Agent，作为所有前端入口读取的唯一权威状态。 */
  setActiveAgent(agentId: string): void {
    if (this.activeAgentId === agentId) return
    this.activeAgentId = agentId
    logger.info(__t('logs.runtime', '全局活跃 Agent 已切换: {0}', [agentId]))
  }

  /** 获取全局活跃 Agent；未设置时由调用方回退默认角色。 */
  getActiveAgent(): string | null {
    return this.activeAgentId
  }

  // ─────────────────────────────────────────
  // 3. 窗口级 Agent 映射（兼容）
  // ─────────────────────────────────────────

  /**
   * 设置窗口的活跃 Agent
   * @param windowId  前端窗口 ID（前端自行生成，如 uuid）
   * @param agentId   Agent ID
   */
  setWindowAgent(windowId: string, agentId: string): void {
    this.windowAgents.set(windowId, agentId)
    logger.debug(__t('logs.runtime', '窗口活跃 Agent: window={0}, agent={1}', [windowId, agentId]))
  }

  /**
   * 获取窗口的活跃 Agent
   * @returns Agent ID，如果窗口不存在返回 undefined
   */
  getWindowAgent(windowId: string): string | undefined {
    return this.windowAgents.get(windowId)
  }

  /**
   * 移除窗口（窗口关闭时调用）
   */
  removeWindow(windowId: string): void {
    this.windowAgents.delete(windowId)
    logger.debug(__t('logs.runtime', '窗口已移除: {0}', [windowId]))
  }

  /**
   * 获取所有窗口的活跃 Agent 映射
   * @returns Map<windowId, agentId>
   */
  getAllWindowAgents(): Map<string, string> {
    return new Map(this.windowAgents)
  }

  /**
   * 获取使用指定 Agent 的窗口列表
   * @param agentId Agent ID
   * @returns 使用该 Agent 的窗口 ID 列表
   */
  getWindowsByAgent(agentId: string): string[] {
    const windows: string[] = []
    for (const [windowId, id] of this.windowAgents) {
      if (id === agentId) windows.push(windowId)
    }
    return windows
  }

  // ─────────────────────────────────────────
  // 3. Thread 运行时状态
  // ─────────────────────────────────────────

  /**
   * 设置 Thread 的打字状态
   * @param threadId  Thread ID
   * @param isTyping  是否正在生成回复
   */
  setThreadTyping(threadId: string, isTyping: boolean): void {
    const state = this.threadStates.get(threadId) ?? {
      isTyping: false,
      lastActiveAt: Date.now(),
    }
    state.isTyping = isTyping
    state.lastActiveAt = Date.now()
    this.threadStates.set(threadId, state)
  }

  /**
   * 检查 Thread 是否正在打字
   */
  isThreadTyping(threadId: string): boolean {
    return this.threadStates.get(threadId)?.isTyping ?? false
  }

  /**
   * 获取 Thread 最后活跃时间
   */
  getThreadLastActiveAt(threadId: string): number | undefined {
    return this.threadStates.get(threadId)?.lastActiveAt
  }

  /**
   * 清理 Thread 运行时状态（Thread 被删除时调用）
   */
  clearThreadState(threadId: string): void {
    this.threadStates.delete(threadId)
  }

  // ─────────────────────────────────────────
  // 内部方法
  // ─────────────────────────────────────────

  /** 超时处理 */
  private handleTimeout(threadId: string): void {
    const state = this.tasks.get(threadId)
    if (!state || state.cancelled) return

    logger.warn(
      __t('logs.runtime', '任务超时: thread={0} ({1}s)', [threadId, this.timeoutMs / 1000]),
    )
    state.cancelled = true
    state.paused = false
    state.abortController.abort(
      new Error(
        `本轮任务已达到 ${Math.round(this.timeoutMs / 60_000)} 分钟执行时限，请继续任务或拆分处理`,
      ),
    )
    this.setThreadTyping(threadId, false)
    this.broadcastProgress(threadId, 'error', `任务超时 (${this.timeoutMs / 1000}s)`)
  }

  /** 清理任务（释放定时器） */
  private cleanupTask(threadId: string): void {
    const existing = this.tasks.get(threadId)
    if (existing?.timeoutTimer) {
      clearTimeout(existing.timeoutTimer)
    }
    this.tasks.delete(threadId)
  }

  /** 广播进度 */
  private broadcastProgress(
    threadId: string,
    state: 'running' | 'paused' | 'completed' | 'cancelled' | 'error',
    message?: string,
  ): void {
    if (!this.broadcaster) return
    const taskState = this.tasks.get(threadId)
    this.broadcaster({
      threadId,
      turn: taskState?.currentTurn ?? 0,
      state,
      message,
    }).catch((err) => {
      logger.warn(__t('logs.runtime', '进度广播失败: {0}', [err]))
    })
  }
}
