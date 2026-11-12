import { t as __t } from '../../lib/i18n'
import { createLogger } from '../../lib/logger'
import type { AgentManager } from '../agent/agentManager'
import type { GatewayHub } from '../gateway/gatewayHub'
import type { ThreadService } from '../thread/threadService'
import type { GroupChatDispatcher } from './groupChatDispatcher'
import type { GroupChatService, StrongholdReplyIntent } from './groupChatService'
import type { StrongholdService } from './strongholdService'
import type { StrongholdTurnService } from './strongholdTurnService'

const logger = createLogger('StrongholdRoundService')

/** 用户消息持有持久回复意图，内核负责执行；进程重启后从同一轮次继续投递。 */
export class StrongholdRoundService {
  private readonly preparing = new Map<number, Promise<StrongholdReplyIntent | undefined>>()
  private readonly running = new Map<number, Promise<void>>()
  private readonly roomsRunning = new Map<string, Promise<void>>()
  private stopped = false

  constructor(
    private readonly chat: GroupChatService,
    private readonly rooms: StrongholdService,
    private readonly dispatcher: GroupChatDispatcher,
    private readonly turns: StrongholdTurnService,
    private readonly agents: AgentManager,
    private readonly threads: ThreadService,
    private readonly gateway: GatewayHub,
    private readonly allowsAutonomy: (agentId: string) => boolean = () => false,
  ) {}

  prepare(messageId: number): Promise<StrongholdReplyIntent | undefined> {
    const current = this.preparing.get(messageId)
    if (current) return current
    const operation = this.prepareOnce(messageId).finally(() => this.preparing.delete(messageId))
    this.preparing.set(messageId, operation)
    return operation
  }

  private async prepareOnce(messageId: number): Promise<StrongholdReplyIntent | undefined> {
    const source = this.chat.getReplyIntent(messageId)
    if (!source || source.intent.queue) return source?.intent
    const { message, intent } = source
    const history = await this.chat.getHistory(message.roomId, 10, message.id)
    const dispatch = await this.dispatcher.decideNextTurn(message.roomId, history)
    if (this.stopped) return undefined
    const current = this.chat.getReplyIntent(messageId)
    if (!current || current.intent.queue || current.intent.status !== 'pending') return current?.intent
    const eligible = intent.targets.map((target) => target.agentId)
      .filter((agentId) => !intent.autonomous || this.allowsAutonomy(agentId))
    const allMention = dispatch.agentIds.includes('@all')
    const requested = allMention
      ? [...eligible]
      : dispatch.agentIds.filter((id) => eligible.includes(id))
    const queue = [...new Set(requested)]
    if (!queue.length && eligible.length && message.role === 'user') queue.push(eligible[0]!)
    intent.queue = queue
    intent.initialQueue = [...queue]
    intent.reason = dispatch.reason
    intent.allMention = allMention
    intent.allowAutoFollowUp = false
    intent.allowSummon = true
    if (!queue.length) intent.status = 'completed'
    this.chat.saveReplyIntent(messageId, intent)
    return intent
  }

  hasPending(): boolean {
    return !this.stopped && this.chat.pendingReplyIds().some((id) => !this.running.has(id))
  }

  isRoomBusy(roomId: string): boolean {
    return this.roomsRunning.has(roomId) || this.chat.pendingReplyIds().some((id) => this.chat.getReplyIntent(id)?.message.roomId === roomId)
  }

  async runIdle(roomId: string, agentId: string, signal: AbortSignal): Promise<{ reply?: string }> {
    if (this.stopped || this.isRoomBusy(roomId) || !this.allowsAutonomy(agentId)) return {}
    signal.throwIfAborted()
    const deferredId = this.chat.claimDeferredReply(roomId, agentId)
    if (deferredId !== undefined) {
      await this.kick(deferredId, signal)
      signal.throwIfAborted()
      const source = this.chat.getReplyIntent(deferredId)
      const target = source?.intent.targets.find((entry) => entry.agentId === agentId)
      const message = source && target && this.chat.getSceneReply(roomId, agentId, source.message.pairId!,
        { ...target, sourceMessageId: deferredId })
      return { reply: message?.content }
    }
    if (this.chat.hasDeferredReply(roomId, agentId)) return {}
    const roundId = `idle:${crypto.randomUUID()}`
    let reply: string | undefined
    const push = (action: string, extra: Record<string, unknown>) => this.gateway.broadcast({
      protocolVersion: 1, type: 'push', id: '', sourceId: 'backend', targetId: 'broadcast',
      payload: { action, roomId, roundId, agentId, ...extra }, timestamp: Date.now(),
    })
    const operation = (async () => {
      await push('stronghold_round_started', { agentIds: [agentId] })
      try {
        const outcome = await this.turns.execute(roomId, agentId, undefined, { autonomous: true, signal, roundId })
        reply = outcome.reply
      } catch (error) {
        await push('stronghold_agent_failed', { error: String(error) })
        throw error
      } finally {
        await push('stronghold_round_completed', {})
      }
    })().finally(() => {
      if (this.roomsRunning.get(roomId) === operation) this.roomsRunning.delete(roomId)
    })
    this.roomsRunning.set(roomId, operation)
    await operation
    return { reply }
  }

  /** 只派发独立轮次，扫描本身及时释放 Outbox 或周期任务的执行占用。 */
  resumePending(): void {
    if (this.stopped) return
    for (const id of this.chat.pendingReplyIds()) void this.kick(id)
  }

  kick(messageId: number, signal?: AbortSignal): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const current = this.running.get(messageId)
    if (current) return current
    const roomId = this.chat.getReplyIntent(messageId)?.message.roomId
    if (!roomId) return Promise.resolve()
    const previous = this.roomsRunning.get(roomId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.run(messageId, signal)).catch((error) => {
      if (this.stopped) return
      const source = this.chat.getReplyIntent(messageId)
      if (!source) return
      if (signal?.aborted) {
        this.chat.saveReplyIntent(messageId, { ...source.intent, retryAt: Date.now() + 1000 })
        return
      }
      source.intent.attempts++
      source.intent.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** source.intent.attempts)
      if (source.intent.attempts >= 3) source.intent.status = 'completed'
      this.chat.saveReplyIntent(messageId, source.intent)
      logger.warn(__t('logs.stronghold', '据点回合处理失败'), { messageId, error })
    }).finally(() => {
      this.running.delete(messageId)
      if (this.roomsRunning.get(roomId) === operation) this.roomsRunning.delete(roomId)
    })
    this.running.set(messageId, operation)
    this.roomsRunning.set(roomId, operation)
    return operation
  }

  stop(): void {
    this.stopped = true
  }

  private async run(messageId: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.prepare(messageId)
    if (this.stopped) return
    let source = this.chat.getReplyIntent(messageId)
    if (!source || source.intent.status !== 'pending' || this.stopped) return
    if (!source.intent.queue?.length && source.intent.deferredAgentIds?.length) return
    const { message } = source
    const roomId = message.roomId
    const explicitPending = source.intent.autonomous && this.chat.pendingReplyIds().some((id) => {
      const other = id === messageId ? undefined : this.chat.getReplyIntent(id)
      return other?.message.roomId === roomId && !other.intent.autonomous
    })
    if (explicitPending) {
      this.chat.saveReplyIntent(messageId, { ...source.intent, retryAt: Date.now() + 1000 })
      return
    }
    const pairId = message.pairId!
    const roundId = message.role === 'user' ? pairId : `${pairId}:${message.id}`
    const push = (action: string, payload: Record<string, unknown> = {}) => this.gateway.broadcast({
      protocolVersion: 1, type: 'push', id: '', sourceId: 'backend', targetId: 'broadcast',
      payload: { action, roomId, roundId, pairId, ...payload }, timestamp: Date.now(),
    })
    await push('stronghold_round_started', { agentIds: source.intent.queue })
    while (!this.stopped) {
      source = this.chat.getReplyIntent(messageId)
      if (!source || source.intent.status !== 'pending') return
      let { intent } = source
      const agentId = intent.queue?.[0]
      if (!agentId) {
        if (intent.deferredAgentIds?.length) {
          this.chat.saveReplyIntent(messageId, { ...intent, retryAt: undefined })
          await push('stronghold_round_completed', { completedAgentIds: intent.completed, failedAgentIds: intent.failedAgentIds ?? [] })
          return
        }
        intent.status = 'completed'
        this.chat.saveReplyIntent(messageId, intent)
        await push('stronghold_round_completed', { completedAgentIds: intent.completed, failedAgentIds: intent.failedAgentIds ?? [] })
        return
      }
      const target = intent.targets.find((entry) => entry.agentId === agentId)
      const thread = target && await this.threads.getThread(target.threadId)
      const present = await this.rooms.getRoomAgents(roomId)
      const enabled = this.agents.listAgents().some((agent) => agent.id === agentId && agent.isEnabled)
      source = this.chat.getReplyIntent(messageId)
      if (!source || source.intent.status !== 'pending') return
      intent = source.intent
      if (!intent.queue?.includes(agentId)) continue
      if (!this.chat.isReplySourceCurrent(source.message)) {
        this.chat.saveReplyIntent(messageId, { ...intent, status: 'completed', queue: [], deferredAgentIds: [] })
        await push('stronghold_round_completed', { completedAgentIds: intent.completed, failedAgentIds: intent.failedAgentIds ?? [] })
        return
      }
      if (intent.completed.includes(agentId) || !enabled || !present.includes(agentId) ||
        (intent.autonomous && !this.allowsAutonomy(agentId)) ||
        !target || !thread || thread.threadKind !== 'main' || thread.agentId !== agentId ||
        thread.generation !== target.generation || thread.status !== 'active') {
        intent.queue = intent.queue.filter((id) => id !== agentId)
        this.chat.saveReplyIntent(messageId, intent)
        continue
      }
      try {
        const result = await this.turns.execute(roomId, agentId, pairId, {
          allowSummon: intent.allowSummon,
          summonedBy: intent.summonedBy,
          summonReason: intent.summonReason,
          roundId,
          expectedThread: target,
          sourceMessageId: message.id,
          autonomous: intent.autonomous,
          signal,
        })
        // 执行期间事件可为原消息追加接收者，按最新持久队列结算本角色。
        source = this.chat.getReplyIntent(messageId)
        if (this.stopped || !source || source.intent.status !== 'pending') return
        intent = source.intent
        if (result.deferred) {
          intent.retryAt = Date.now() + 1000
          this.chat.saveReplyIntent(messageId, intent)
          return
        }
        // 结算以原消息仍有效为前提；回复本身按来源幂等，可恢复提交后尚未推进的轮次。
        intent.queue = intent.queue?.filter((id) => id !== agentId) ?? []
        if (!intent.completed.includes(agentId)) intent.completed.push(agentId)
        intent.attempts = 0
        intent.retryAt = undefined
        // 角色提出的新问题由其已提交消息持有独立请求，恢复时沿消息身份去重。
        this.chat.saveReplyIntent(messageId, intent)
        for (const id of intent.queue!) await push('stronghold_agent_queued', { agentId: id })
      } catch (error) {
        if (signal?.aborted) throw error
        source = this.chat.getReplyIntent(messageId)
        if (this.stopped || !source || source.intent.status !== 'pending') return
        intent = source.intent
        await push('stronghold_agent_failed', { agentId, error: error instanceof Error ? error.message : String(error) })
        // 单个角色最多尝试三次，随后保留失败状态并让本轮其他角色继续。
        if (intent.attempts >= 2) {
          intent.queue = intent.queue?.filter((id) => id !== agentId) ?? []
          if (!intent.completed.includes(agentId)) intent.completed.push(agentId)
          intent.failedAgentIds = [...(intent.failedAgentIds ?? []), agentId]
          intent.attempts = 0
          intent.allowSummon = false
          this.chat.saveReplyIntent(messageId, intent)
          continue
        }
        throw error
      }
    }
  }
}
