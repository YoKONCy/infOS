import { t as __t } from '../../lib/i18n'
import type { QueuedConversationInput, ConversationQueueSnapshot } from '@infos/shared'
import { ConversationQueueRepository } from '../../repositories/conversationQueue.repo'
import type { RuntimeStateService } from '../runtime/runtimeStateService'
import type { ThreadService } from '../thread/threadService'
import type { AttachmentRepository } from '../../repositories/attachment.repo'
import { AppError } from '../../lib/appError'
import { createLogger } from '../../lib/logger'
import type { ConversationSurfaceSession } from '../../projections/conversationSurfaceSession'

const logger = createLogger('ConversationQueue')
export interface QueuedTurnOutcome {
  success: boolean
  paused?: boolean
  handoff?: boolean
  error?: string
}

/** 服务端独立驱动队列，客户端只提交和观察；浏览器断线不会改变派发权。 */
export class ConversationQueueService {
  private running = new Map<string, symbol>()
  private historyChanging = new Set<string>()
  private live = new Map<string, ConversationSurfaceSession>()
  private timer?: ReturnType<typeof setInterval>
  private runner?: (
    input: QueuedConversationInput & { queueMessageId: string },
  ) => Promise<QueuedTurnOutcome>
  constructor(
    private readonly repo: ConversationQueueRepository,
    private readonly runtime: RuntimeStateService,
    private readonly threads: ThreadService,
    private readonly attachments: AttachmentRepository,
    private readonly isOtherWorkBusy: (threadId: string) => boolean | Promise<boolean>,
    private readonly onUserInput?: (agentId: string, threadId: string) => Promise<void>,
  ) {}

  setRunner(runner: NonNullable<ConversationQueueService['runner']>): void {
    this.runner = runner
  }
  start(): void {
    if (this.timer) return
    this.repo.recover()
    this.timer = setInterval(() => {
      try {
        for (const threadId of this.repo.readyThreads()) this.kick(threadId)
      } catch (error) {
        logger.error(__t('logs.conversation', '读取持久队列失败，暂停自动派发'), {
          error: String(error),
        })
        this.stop()
      }
    }, 1_000)
    this.timer.unref?.()
  }
  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
  snapshot(threadId: string): ConversationQueueSnapshot {
    return { ...this.repo.snapshot(threadId), active: Boolean(this.runtime.getTaskInfo(threadId)) }
  }

  referencesAttachment(id: string): boolean {
    return this.repo.referencesAttachment(id)
  }
  historyChanged(threadId: string, deleted = false, discardPending = false): void {
    this.repo.historyChanged(threadId, deleted, discardPending)
    if (discardPending || deleted) this.running.delete(threadId)
  }
  setLive(threadId: string, surface?: ConversationSurfaceSession): void {
    if (surface) this.live.set(threadId, surface)
    else this.live.delete(threadId)
  }
  getLive(threadId: string) {
    return this.live.get(threadId)?.liveSnapshot() ?? null
  }

  /** 历史修改期间禁止其他客户端重新派发旧分支消息。 */
  beginHistoryChange(threadId: string): () => void {
    this.assertQueueMutable(threadId)
    this.repo.pause(threadId, true)
    this.historyChanging.add(threadId)
    return () => {
      this.historyChanging.delete(threadId)
    }
  }

  private assertQueueMutable(threadId: string): void {
    if (this.historyChanging.has(threadId))
      throw new AppError('CONFLICT', { message: '历史正在更新，请稍后操作' })
  }
  assertHistoryStable(threadId: string): void {
    this.assertQueueMutable(threadId)
  }

  async enqueue(id: string, input: QueuedConversationInput): Promise<ConversationQueueSnapshot> {
    this.assertQueueMutable(input.threadId)
    const thread = await this.threads.getThread(input.threadId)
    if (!thread || thread.channel !== 'desktop' || thread.status !== 'active')
      throw new AppError('NOT_FOUND', { message: '目标对话不存在' })
    if (input.agentId && thread.agentId !== input.agentId)
      throw new AppError('CONFLICT', { message: '角色与目标会话不匹配' })
    const existing = this.repo.get(id)
    if (!existing) {
      const attachmentRows = await this.attachments.findByIds(input.attachmentIds ?? [])
      if (
        attachmentRows.length !== (input.attachmentIds?.length ?? 0) ||
        attachmentRows.some(
          (row) =>
            row.threadId !== thread.id || row.status !== 'uploaded' || row.messageId !== null,
        )
      )
        throw new AppError('CONFLICT', { message: '附件尚未就绪、已经发送或属于其他会话' })
    }
    this.assertQueueMutable(input.threadId)
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== thread.generation)
      throw new AppError('CONFLICT', { message: '会话已重置，本次执行已过期' })
    this.repo.enqueue(id, { ...input, agentId: thread.agentId, expectedGeneration: thread.generation })
    if (!existing && !input.taskResultEvent && this.onUserInput) {
      await this.onUserInput(thread.agentId, thread.id).catch((error) =>
        logger.warn(__t('logs.companion', '保存主动行为活动时间失败'), { error }))
    }
    this.kick(thread.id)
    return this.snapshot(thread.id)
  }

  async regenerate(id: string, threadId: string, messageId: number, revision: number): Promise<ConversationQueueSnapshot> {
    this.assertQueueMutable(threadId)
    const existing = this.repo.get(id)
    if (existing) {
      const original = existing.input.regeneration
      if (existing.input.threadId !== threadId || !original || original.messageId !== messageId || original.revision !== revision)
        throw new AppError('CONFLICT', { message: __t('server.conversation', '消息已变化，请重新选择后再生成') })
      return this.snapshot(threadId)
    }
    const source = await this.threads.getRegenerationSource(threadId, messageId, revision)
    const thread = await this.threads.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: '会话不存在' })
    this.pause(threadId, true)
    await this.enqueue(id, {
      threadId, agentId: thread.agentId, expectedGeneration: thread.generation,
      content: source.message.content, regeneration: { messageId, revision },
    })
    const queued = this.repo.get(id)!
    return this.change(threadId, id, queued.revision, { immediate: true })
  }

  async change(
    threadId: string,
    id: string,
    revision: number,
    change: { content?: string; cancel?: boolean; immediate?: boolean; draft?: boolean },
  ): Promise<ConversationQueueSnapshot> {
    this.assertQueueMutable(threadId)
    if (this.repo.get(id)?.input.regeneration && (change.content !== undefined || change.draft))
      throw new AppError('INVALID_PARAMETER', { message: __t('server.conversation', '重新生成动作可取消后重新发起') })
    this.repo.mutate(threadId, id, revision, change)
    if (change.immediate) {
      // 先确认交接消息已经落盘，之后才中断在飞模型；工具使用的父信号不受影响。
      this.repo.pause(threadId, false)
      this.runtime.requestHandoff(threadId)
    }
    this.kick(threadId)
    return this.snapshot(threadId)
  }

  reorder(
    threadId: string,
    order: Array<{ id: string; revision: number }>,
  ): ConversationQueueSnapshot {
    this.assertQueueMutable(threadId)
    this.repo.reorder(threadId, order)
    return this.snapshot(threadId)
  }

  pause(threadId: string, paused: boolean): ConversationQueueSnapshot {
    if (!paused) this.assertQueueMutable(threadId)
    this.repo.pause(threadId, paused, paused ? '队列已暂停' : undefined)
    if (!paused) this.kick(threadId)
    return this.snapshot(threadId)
  }

  afterTurn(threadId: string, outcome: QueuedTurnOutcome): void {
    if (!outcome.success || outcome.paused || this.runtime.isCancelled(threadId)) {
      if (outcome.error)
        logger.warn(__t('logs.conversation', '当前回合结束，队列已暂停'), {
          threadId,
          error: outcome.error,
        })
      this.repo.pause(
        threadId,
        true,
        outcome.error ? '执行失败，队列已暂停' : '任务已停止，队列已暂停',
      )
    }
  }

  private kick(threadId: string): void {
    if (
      !this.timer ||
      !this.runner ||
      this.historyChanging.has(threadId) ||
      this.running.has(threadId) ||
      this.runtime.getTaskInfo(threadId)
    )
      return
    const owner = Symbol(threadId)
    this.running.set(threadId, owner)
    void this.drainOne(threadId, owner)
      .catch((error) => {
        if (this.running.get(threadId) !== owner) return
        logger.error(__t('logs.conversation', '消息队列派发失败，已保留持久记录'), {
          threadId,
          error: String(error),
        })
        try {
          this.repo.pause(threadId, true, '发送失败，队列已暂停')
        } catch (writeError) {
          logger.error(
            __t('logs.conversation', '队列暂停状态写入失败，停止自动派发以避免重复执行'),
            {
              error: String(writeError),
            },
          )
          this.stop()
        }
      })
      .finally(() => { if (this.running.get(threadId) === owner) this.running.delete(threadId) })
  }

  private async drainOne(threadId: string, owner: symbol): Promise<void> {
    if (await this.isOtherWorkBusy(threadId)) return
    const thread = await this.threads.getThread(threadId)
    if (!thread || thread.status !== 'active') {
      this.repo.historyChanged(threadId, true)
      return
    }
    // 异步查询后重新检查并同步注册，避免多客户端或普通发送插队到同一 Thread。
    if (this.running.get(threadId) !== owner || this.runtime.getTaskInfo(threadId) || this.historyChanging.has(threadId)) return
    const entry = this.repo.claim(threadId)
    if (!entry) return
    if (entry.input.expectedGeneration !== undefined && entry.input.expectedGeneration !== thread.generation) {
      this.repo.settle(entry.id, 'cancelled')
      return
    }
    this.runtime.registerTask(threadId, entry.input.agentId)
    const ownedSignal = this.runtime.getAbortSignal(threadId)
    logger.info(__t('logs.conversation', '开始派发队列消息'), {
      threadId,
      messageId: entry.id,
      immediate: entry.immediate,
    })
    try {
      const outcome = await this.runner!({ ...entry.input, queueMessageId: entry.id })
      if (this.running.get(threadId) !== owner) return
      if (!outcome.success || outcome.paused) this.afterTurn(threadId, outcome)
      this.repo.settle(entry.id, outcome.success ? 'completed' : 'interrupted', outcome.error)
    } catch (error) {
      if (this.running.get(threadId) !== owner) return
      this.repo.settle(entry.id, 'failed', String(error))
      this.repo.pause(threadId, true, '执行失败，后续消息已暂停')
      throw error
    } finally {
      // Runner 正常负责注销；启动前失败也必须释放本次占用。
      if (this.runtime.getAbortSignal(threadId) === ownedSignal)
        this.runtime.unregisterTask(threadId, ownedSignal)
    }
  }
}
