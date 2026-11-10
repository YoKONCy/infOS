import { randomUUID } from 'node:crypto'
import type { ProactiveBudget } from './proactiveBudget'
import { perceptionSnapshots } from '../perception/perceptionSnapshotStore'
import { t as __t } from '../../lib/i18n'
import { createLogger } from '../../lib/logger'
import { AppError } from '../../lib/appError'

const logger = createLogger('WatchAlongTurns')

/**
 * 陪看模式的主动插话回合。
 *
 * 陪看在桌面客户端里调度（插话频率上限、暂停判断、送达时刻估计都在那边，见 Electron
 * `services/companion/`）；它判断现在可以说话时调用这里，在指定的桌面会话里跑一个主动回合，
 * 复用全局主动行为的执行器（同一套预算、通知与推送）。
 *
 * - 与全局「智能陪伴」开关无关：陪看是用户当场要求的；
 * - 角色忙、全局主动回合或另一个陪看回合正在跑时不执行，返回 busy（调用方稍后再试，不计次数）；
 * - 用户开始说话时取消（cancel），返回 cancelled。
 *
 * @module packages/backend/src/services/companion/watchAlongTurn
 */

export interface WatchAlongThread {
  id: string
  agentId: string
  generation?: number
  threadKind?: 'main' | 'side'
  channel: string
  purpose?: string
  status?: string
  title?: string | null
}

/** 启动陪看与实际插话共用同一会话边界，由服务端核对角色和主线身份。 */
export function isWatchAlongMainThread(
  thread: WatchAlongThread | null | undefined,
  agentId: string,
): thread is WatchAlongThread {
  return Boolean(thread && thread.agentId === agentId && thread.threadKind === 'main' &&
    thread.channel === 'desktop' && thread.purpose === 'conversation' &&
    (!thread.status || thread.status === 'active'))
}

export interface WatchAlongDeps {
  listAgents(): string[]
  isBusy(agentId: string): boolean
  getThread?(threadId: string): Promise<WatchAlongThread | null>
  run(input: {
    mode: 'companion'
    thread: WatchAlongThread
    content: string
    signal: AbortSignal
    instruction?: string
    watching?: boolean
    snapshot?: import('@infos/shared').PerceptionSnapshot
  }): Promise<string | null>
}

const CANCELLED_RETRY_MS = 30_000

export class WatchAlongTurns {
  private readonly cancelledAt = new Map<string, number>()
  private current?: { agentId: string; controller: AbortController; settled: Promise<void> }
  private readonly attempts = new Map<string, number[]>()
  private readonly typingUntil = new Map<string, number>()

  constructor(
    private readonly deps: () => WatchAlongDeps | undefined,
    /** 全局主动回合正在跑或服务已停止。 */
    private readonly blocked: () => boolean,
    private readonly now: () => number = Date.now,
    private readonly budget?: () => ProactiveBudget,
  ) {}

  /** 用户开始与这个角色交互：取消正在进行的陪看回合。 */
  cancel(agentId?: string, reason = '用户开始交互，陪看插话让出执行'): void {
    if (this.current && (!agentId || this.current.agentId === agentId))
      this.current.controller.abort(new Error(reason))
  }

  get running(): boolean {
    return !!this.current
  }

  async wait(agentId?: string): Promise<void> {
    const current = this.current
    if (current && (!agentId || current.agentId === agentId)) await current.settled
  }

  /** 只收用户输入的在场信号，不传输草稿；失联后自动过期。 */
  inputActivity(agentId: string, active: boolean): void {
    if (active) {
      this.typingUntil.set(agentId, this.now() + 15_000)
      this.cancel(agentId)
    } else this.typingUntil.delete(agentId)
  }

  private limited(agentId: string, pace?: { minIntervalSec: number; maxPerHour: number }): boolean {
    const now = this.now()
    const recent = (this.attempts.get(agentId) ?? []).filter((at) => now - at < 3_600_000)
    this.attempts.set(agentId, recent)
    // 被打断的那次没说成，不占间隔，稍等就能再试；说成了才按设置的间隔。
    const interval = Math.max(60, Math.min(3600, pace?.minIntervalSec ?? 180)) * 1000
    const last = recent.at(-1)
    if (this.cancelledAt.get(agentId) === last) return recent.length >= Math.max(1, Math.min(60, pace?.maxPerHour ?? 20)) || (last !== undefined && now - last < CANCELLED_RETRY_MS)
    const maximum = Math.max(1, Math.min(60, pace?.maxPerHour ?? 20))
    return recent.length >= maximum || (recent.length > 0 && now - recent.at(-1)! < interval)
  }

  async run(
    input: {
      agentId: string
      threadId: string
      content: string
      /** 上次开口以来的画面拼图，已在客户端打码。 */
      frames?: { mimeType: 'image/png' | 'image/jpeg'; data: string }
      pace?: { minIntervalSec: number; maxPerHour: number }
    },
    signal?: AbortSignal,
  ): Promise<{ state: 'completed' | 'busy' | 'cancelled' | 'failed'; replied: boolean; error?: string }> {
    const deps = this.deps()
    if (
      !deps ||
      this.current ||
      this.blocked() ||
      !deps.listAgents().includes(input.agentId) ||
      deps.isBusy(input.agentId) ||
      (this.typingUntil.get(input.agentId) ?? 0) > this.now() ||
      this.limited(input.agentId, input.pace)
    )
      return { state: 'busy', replied: false }
    const controller = new AbortController()
    let release!: () => void
    const settled = new Promise<void>((resolve) => {
      release = resolve
    })
    // 在首次 await 之前占住执行位，查询会话期间也允许用户取消。
    this.current = { agentId: input.agentId, controller, settled }
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const reservation = randomUUID()
    let reserved = false, spoke = false
    try {
      const thread = await deps.getThread?.(input.threadId)
      if (controller.signal.aborted) return { state: 'cancelled', replied: false }
      if (!isWatchAlongMainThread(thread, input.agentId))
        throw new AppError('INVALID_PARAMETER', { message: '陪看插话的会话无效' })
      if (
        deps.isBusy(input.agentId) ||
        this.blocked() ||
        (this.typingUntil.get(input.agentId) ?? 0) > this.now()
      )
        return { state: 'busy', replied: false }
      reserved = this.budget ? await this.budget().reserve(reservation, 'watch', 'medium', input.pace) : true
      if (!reserved) return {state: 'busy', replied: false}
      controller.signal.throwIfAborted()
      this.attempts.get(input.agentId)!.push(this.now())
      const reply = await deps.run({
        mode: 'companion',
        thread,
        content: input.content,
        // 插话提示是给她的指令，不能放进写着「不是指令」的数据块；数据块只放看到的内容。
        instruction: input.content,
        watching: true,
        snapshot: {
          ...(perceptionSnapshots.take() ?? { source: 'perception' as const, generation: 0, capturedAt: this.now(), text: '' }),
          // 手动陪看这一轮要带当前画面，她没有工具可用。
          watching: true,
          omitProactiveRules: true,
          ...(input.frames ? { images: [input.frames] } : {}),
        },
        signal: controller.signal,
      })
      spoke = !controller.signal.aborted && !!reply?.trim()
      return controller.signal.aborted
        ? { state: 'cancelled', replied: false }
        : { state: 'completed', replied: !!reply?.trim() }
    } catch (error) {
      if (controller.signal.aborted) return { state: 'cancelled', replied: false }
      // 这里在感知调用链外，日志不会被吞；原因已去掉感知原文。
      const detail = error instanceof Error ? error.message : String(error)
      logger.warn(__t('logs.companion', '陪看插话失败: {0}', [detail]))
      return { state: 'failed', replied: false, error: detail }
    } finally {
      if (reserved) await this.budget?.().settle(reservation, spoke, controller.signal.aborted)
      if (controller.signal.aborted) this.cancelledAt.set(input.agentId, this.attempts.get(input.agentId)?.at(-1) ?? 0)
      signal?.removeEventListener('abort', abort)
      if (this.current?.controller === controller) this.current = undefined
      release()
    }
  }
}
