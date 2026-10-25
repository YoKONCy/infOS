import { t as __t } from './i18n'
/**
 * SocialSessionManager — 平台无关的社交回合与消息批次管理。
 *
 * 程序只管理节奏、批次和可靠性；是否回复始终由当前角色自己的 Agent 决定。
 */
import type { InboundMessage } from './types'
import {
  DEFAULT_SOCIAL_SCHEDULER_CONFIG,
  SOCIAL_INITIAL_REVIEW_DELAY_MS,
  type SocialGroupPolicy,
} from '@infos/shared'
import { createLogger, safeModelDiagnostic } from '@infos/backend/applicationHostAbi'
import { socialFailure } from './socialRecovery'

const logger = createLogger('SocialSessionManager')

export type ParticipationState = 'idle' | 'listening' | 'engaged'
export type ProcessingPhase =
  | 'ready'
  | 'collecting'
  | 'running'
  | 'cooldown'
  | 'retrying'
  | 'failed'

export interface SocialWaitRequest {
  reason: 'continuation_expected' | 'missing_context' | 'conversation_unsettled'
  duration: 'short' | 'normal' | 'long'
}

export interface DeferredSocialIntent {
  intention: string
  timing: 'soon' | 'later' | 'much_later'
  expires: 'one_hour' | 'today' | 'one_day'
  condition?: string
  notBefore: number
  expiresAt: number
  sourceMessages: InboundMessage[]
}

export type SocialTurnOutcome =
  | { type: 'orchestration'; wakeAt: number; expiresAt: number }
  | {
      type: 'reply'
      content: string
      /** 工具已完成图片等附件投递，桥接层仅确认回合。 */ delivered?: boolean
    }
  | { type: 'pass' }
  | { type: 'wait'; wait: SocialWaitRequest }
  | {
      type: 'defer'
      intent: Omit<DeferredSocialIntent, 'notBefore' | 'expiresAt' | 'sourceMessages'>
      schedule?: { notBefore: number; expiresAt: number }
    }

export interface SocialSession {
  platform?: string
  connectionId?: string
  /** 私聊对端账号与会话 ID 分开保存。 */
  peerId?: string
  accountId: string
  channelId: string
  channelType: 'private' | 'group'
  agentId: string
  participation: ParticipationState
  phase: ProcessingPhase
  pendingMessages: InboundMessage[]
  inFlightMessages: InboundMessage[]
  lastActiveTime: number
  lastMessageTime: number
  isMentioned: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
  nextScanTime: number
  /** 主动观察与重试、延后意图分别计时，按角色、账号和群聊隔离。 */
  nextReviewTime: number
  lastReviewTime?: number
  collectionStartedAt: number
  waitCount: number
  deferredIntent?: DeferredSocialIntent
  controller?: AbortController
  retryMessages?: InboundMessage[]
  retryCount?: number
  lastError?: string
  turnId?: string
  waitingTurnId?: string
  /** 托管编排期间，普通群消息仍收集，但不另起同会话的并行回复。 */
  orchestrationTurnId?: string
}

export type FlushReason =
  | 'direct_timeout'
  | 'buffer_timeout'
  | 'buffer_full'
  | 'proactive_review'
  | 'intent_due'

export type FlushCallback = (
  session: SocialSession,
  messages: InboundMessage[],
  reason: FlushReason,
  signal: AbortSignal,
) => Promise<SocialTurnOutcome>

export interface SessionManagerConfig {
  privateCollectTimeout: number
  groupCollectTimeout: number
  bufferTimeout: number
  maxBufferSize: number
  engagedDuration: number
  maxCollectionDuration: number
  maxWaitCount: number
}

const DEFAULT_CONFIG: SessionManagerConfig = {
  privateCollectTimeout: 3,
  groupCollectTimeout: 6,
  bufferTimeout: 20,
  maxBufferSize: 10,
  engagedDuration: 120,
  maxCollectionDuration: 20,
  maxWaitCount: 2,
}

export class SocialSessionManager {
  private sessions = new Map<string, SocialSession>()
  private config: SessionManagerConfig

  constructor(
    private readonly flushCallback: FlushCallback,
    config?: Partial<SessionManagerConfig>,
    private readonly groupPolicy?: (session: SocialSession) => SocialGroupPolicy,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  getOrCreate(msg: InboundMessage): SocialSession {
    const accountId = msg.accountId ?? ''
    const key = this.sessionKey(
      msg.agentId,
      msg.channelType,
      msg.channelId,
      accountId,
      msg.platform,
    )
    let session = this.sessions.get(key)
    if (!session) {
      session = {
        platform: msg.platform,
        connectionId: msg.connectionId,
        accountId,
        peerId: msg.channelType === 'private' && msg.senderId !== 'self' ? msg.senderId : undefined,
        channelId: msg.channelId,
        channelType: msg.channelType,
        agentId: msg.agentId,
        participation: 'idle',
        phase: 'ready',
        pendingMessages: [],
        inFlightMessages: [],
        lastActiveTime: 0,
        lastMessageTime: Date.now(),
        isMentioned: false,
        flushTimer: null,
        nextScanTime: 0,
        nextReviewTime: Date.now() + SOCIAL_INITIAL_REVIEW_DELAY_MS,
        collectionStartedAt: 0,
        waitCount: 0,
      }
      this.sessions.set(key, session)
    }
    return session
  }

  listSessions(): SocialSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastMessageTime - a.lastMessageTime)
  }

  closeSession(
    agentId: string,
    channelId: string,
    scope?: { platform: string; accountId: string; channelType: string },
  ): boolean {
    const matches = [...this.sessions].filter(
      ([, session]) =>
        session.agentId === agentId &&
        session.channelId === channelId &&
        (!scope ||
          (session.platform === scope.platform &&
            session.accountId === scope.accountId &&
            session.channelType === scope.channelType)),
    )
    if (matches.length !== 1) return false
    const [key, session] = matches[0]!
    this.clearTimer(session)
    session.controller?.abort(new Error('社交任务已取消：会话关闭'))
    this.sessions.delete(key)
    return true
  }

  closeSessionsExcept(predicate: (session: SocialSession) => boolean): number {
    let closed = 0
    for (const [key, session] of this.sessions) {
      if (predicate(session)) continue
      this.clearTimer(session)
      session.controller?.abort(new Error('社交任务已取消：会话关闭'))
      this.sessions.delete(key)
      closed++
    }
    return closed
  }

  getActiveSessions(channelType?: 'private' | 'group', limit = 5): SocialSession[] {
    return this.listSessions()
      .filter((session) => !channelType || session.channelType === channelType)
      .slice(0, limit)
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    const session = this.getOrCreate(msg)
    this.checkActiveExpiry(session)
    const now = Date.now()
    const rawEvent = msg.rawEvent as Record<string, unknown> | undefined
    const directlyTriggered =
      msg.isMentioned === true ||
      msg.channelType === 'private' ||
      (rawEvent?._infosQueuedForReply === true && rawEvent?._infosContinuation !== true)

    const msgId = msg.messageId
    if (
      Boolean(msgId) &&
      [
        ...session.pendingMessages,
        ...session.inFlightMessages,
        ...(session.retryMessages ?? []),
      ].some((message) => message.messageId === String(msgId))
    )
      return
    // 明确请求由持久队列保留；内存只保留下一批窗口，完成一批后再补入。
    if (session.pendingMessages.length >= 100) return

    session.lastMessageTime = now
    session.pendingMessages.push(msg)
    if (directlyTriggered) {
      session.isMentioned = true
      session.participation = session.participation === 'engaged' ? 'engaged' : 'listening'
    }

    // running 期间的新消息只进入下一批，绝不悄悄并入正在推理的上下文。
    if (
      session.phase === 'running' ||
      session.phase === 'retrying' ||
      session.orchestrationTurnId
    ) {
      if (directlyTriggered)
        logger.info(__t('apps.social.logs', '新消息已排队，等待当前社交回合结束'), {
          channelId: session.channelId,
          turnId: session.turnId,
          phase: session.phase,
          pendingMessages: session.pendingMessages.length,
        })
      return
    }

    const directCollection = directlyTriggered || session.isMentioned
    const engagedContinuation = session.participation === 'engaged'

    // 普通大群消息只进入有界观察窗口，不按消息数或固定超时直接唤醒 Agent。
    // 自主观察按各群自己的时钟触发；观察容量必须覆盖实际配置的消息门槛。
    if (!directCollection && !engagedContinuation) {
      session.phase = 'ready'
      const capacity = Math.max(
        this.config.maxBufferSize,
        this.policy(session).minMessagesForReview,
      )
      if (session.pendingMessages.length > capacity) {
        session.pendingMessages.splice(0, session.pendingMessages.length - capacity)
      }
      return
    }

    if (session.phase !== 'collecting') {
      session.phase = 'collecting'
      session.collectionStartedAt = now
      session.waitCount = 0
    }

    if (session.pendingMessages.length >= this.config.maxBufferSize) {
      void this.triggerFlush(session, 'buffer_full').catch((error) =>
        logger.warn(__t('apps.social.logs', '社交批次触发失败: {0}', [String(error)])),
      )
      return
    }

    const timeout = directCollection
      ? msg.channelType === 'private'
        ? this.config.privateCollectTimeout
        : this.config.groupCollectTimeout
      : this.config.bufferTimeout
    this.scheduleFlush(session, timeout, directCollection ? 'direct_timeout' : 'buffer_timeout')
  }

  async review(session: SocialSession, reason: FlushReason = 'proactive_review'): Promise<void> {
    await this.triggerFlush(session, reason)
  }

  async retry(session: SocialSession): Promise<void> {
    if (session.phase !== 'retrying' || !session.retryMessages?.length) return
    session.phase = 'ready'
    await this.triggerFlush(session, 'buffer_timeout')
  }

  markReplied(session: SocialSession): void {
    // 此处仅冷却自主观察；明确触发与续聊保留各自窗口，跨回合防循环由宿主预算负责。
    session.participation = 'engaged'
    session.phase = 'cooldown'
    session.lastActiveTime = Date.now()
    session.isMentioned = false
    session.nextScanTime = 0
    this.cooldownReview(session)
  }

  private policy(session: SocialSession): SocialGroupPolicy {
    return this.groupPolicy?.(session) ?? DEFAULT_SOCIAL_SCHEDULER_CONFIG
  }

  private cooldownReview(session: SocialSession): void {
    if (session.channelType !== 'group') return
    session.lastReviewTime = Date.now()
    session.nextReviewTime =
      session.lastReviewTime + this.policy(session).reviewIntervalSeconds * 1000
  }

  checkActiveExpiry(session: SocialSession): void {
    if (session.participation !== 'engaged') return
    if (Date.now() - session.lastActiveTime > this.config.engagedDuration * 1000) {
      session.participation = 'idle'
      if (session.phase === 'cooldown') session.phase = 'ready'
      if (
        session.channelType === 'group' &&
        !session.isMentioned &&
        !session.orchestrationTurnId &&
        session.phase === 'collecting'
      ) {
        this.clearTimer(session)
        session.phase = 'ready'
      }
    }
  }

  dueDeferredIntent(session: SocialSession, now = Date.now()): DeferredSocialIntent | undefined {
    const intent = session.deferredIntent
    if (!intent) return undefined
    if (now >= intent.expiresAt) {
      session.deferredIntent = undefined
      return undefined
    }
    return now >= intent.notBefore ? intent : undefined
  }

  private async triggerFlush(session: SocialSession, reason: FlushReason): Promise<void> {
    this.checkActiveExpiry(session)
    this.clearTimer(session)
    if (session.phase === 'running' || session.phase === 'retrying' || session.orchestrationTurnId)
      return
    if (
      session.channelType === 'group' &&
      session.participation !== 'engaged' &&
      !session.isMentioned &&
      ['buffer_timeout', 'buffer_full'].includes(reason) &&
      !session.retryMessages?.length
    ) {
      session.phase = 'ready'
      return
    }

    if (reason === 'intent_due' && session.deferredIntent) {
      session.pendingMessages.unshift(...session.deferredIntent.sourceMessages)
    }
    if (session.pendingMessages.length === 0 && !session.retryMessages?.length) return

    const recovering = Boolean(session.retryMessages?.length)
    const batchSize =
      reason === 'proactive_review'
        ? Math.max(this.config.maxBufferSize, this.policy(session).minMessagesForReview)
        : this.config.maxBufferSize
    const messages = recovering
      ? session.retryMessages!
      : session.pendingMessages.splice(0, batchSize)
    if (!recovering) session.retryCount = 0
    session.retryMessages = undefined
    session.lastError = undefined
    const controller = new AbortController()
    session.controller = controller
    session.inFlightMessages = messages
    session.phase = 'running'
    logger.info(
      __t('apps.social.logs', '[{0}] 社交批次开始: reason={1}, msgs={2}', [
        session.channelId,
        reason,
        messages.length,
      ]),
    )

    try {
      const outcome = await this.flushCallback(session, messages, reason, controller.signal)
      controller.signal.throwIfAborted()
      session.retryCount = 0
      await this.applyOutcome(session, messages, outcome)
      logger.info(__t('apps.social.logs', '社交批次处理完成'), {
        channelId: session.channelId,
        turnId: session.turnId,
        outcome: outcome.type,
        phase: session.phase,
        pendingMessages: session.pendingMessages.length,
        nextWakeAt: outcome.type === 'orchestration' ? outcome.wakeAt : undefined,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      const failure = socialFailure(error)
      session.inFlightMessages = []
      session.lastError = failure.message
      session.retryCount = (session.retryCount ?? 0) + 1
      if (failure.retryable && session.retryCount <= 2) {
        // 重试保持原批次；推理期间的新消息仍属于下一批，不能混入恢复现场。
        session.retryMessages = messages
        session.phase = 'retrying'
        session.nextScanTime = Date.now() + 30_000 * 2 ** (session.retryCount - 1)
      } else {
        session.phase = 'failed'
        session.isMentioned = false
        session.deferredIntent = undefined
        session.nextScanTime = session.channelType === 'group' ? 0 : Date.now() + 5 * 60_000
        this.cooldownReview(session)
      }
      logger.warn(
        __t('apps.social.logs', '[{0}] 社交批次{1}: {2}', [
          session.channelId,
          session.phase === 'retrying' ? '等待有限重试' : '已结束失败',
          safeModelDiagnostic(failure.message),
        ]),
        {
          turnId: session.turnId,
          retryCount: session.retryCount,
          retryable: failure.retryable,
          retryAfterSeconds:
            session.phase === 'retrying'
              ? Math.round((session.nextScanTime - Date.now()) / 1000)
              : undefined,
          pendingMessages: session.pendingMessages.length,
        },
      )
    } finally {
      if (session.controller === controller) {
        session.controller = undefined
        if (session.phase !== 'retrying') session.turnId = undefined
        if (
          !controller.signal.aborted &&
          !session.flushTimer &&
          session.pendingMessages.length &&
          !session.orchestrationTurnId &&
          session.phase !== 'retrying' &&
          (session.channelType === 'private' ||
            session.isMentioned ||
            session.participation === 'engaged')
        ) {
          session.phase = 'collecting'
          session.collectionStartedAt = Date.now()
          this.scheduleFlush(session, 3, 'buffer_timeout')
        }
      }
    }
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      this.clearTimer(session)
      session.controller?.abort(new Error('社交任务已取消：应用停止'))
    }
    this.sessions.clear()
  }

  cancel(
    agentId: string,
    channelType: string,
    channelId: string,
    accountId: string,
    msgIds: string[] = [],
    platform?: string,
  ): void {
    const session = this.sessions.get(
      this.sessionKey(agentId, channelType, channelId, accountId, platform),
    )
    if (!session) return
    this.clearTimer(session)
    session.controller?.abort(new Error('社交任务已取消'))
    session.retryMessages = undefined
    session.inFlightMessages = []
    session.deferredIntent = undefined
    session.waitingTurnId = undefined
    session.orchestrationTurnId = undefined
    session.turnId = undefined
    const cancelled = new Set(msgIds)
    session.pendingMessages = session.pendingMessages.filter(
      (message) => !cancelled.has(message.messageId ?? ''),
    )
    session.phase = 'ready'
    if (session.pendingMessages.length) this.scheduleFlush(session, 3, 'buffer_timeout')
  }

  private async applyOutcome(
    session: SocialSession,
    messages: InboundMessage[],
    outcome: SocialTurnOutcome,
  ): Promise<void> {
    session.inFlightMessages = []
    if (outcome.type === 'orchestration') {
      session.orchestrationTurnId = session.turnId
      session.phase = 'ready'
      session.isMentioned = false
      session.nextScanTime = outcome.wakeAt
      return
    }
    session.orchestrationTurnId = undefined
    if (outcome.type === 'reply') {
      session.waitingTurnId = undefined
      session.deferredIntent = undefined
      this.markReplied(session)
      return
    }
    if (outcome.type === 'pass') {
      session.waitingTurnId = undefined
      session.deferredIntent = undefined
      session.phase = 'ready'
      session.isMentioned = false
      session.nextScanTime = 0
      this.cooldownReview(session)
      if (session.participation !== 'engaged') session.participation = 'idle'
      return
    }
    if (outcome.type === 'wait') {
      session.pendingMessages.unshift(...messages)
      session.phase = 'collecting'
      session.waitCount++
      const elapsed = Date.now() - session.collectionStartedAt
      const hardRemaining = Math.max(0, this.config.maxCollectionDuration * 1000 - elapsed)
      if (session.waitCount > this.config.maxWaitCount || hardRemaining === 0) {
        session.phase = 'ready'
        session.pendingMessages.splice(0, messages.length)
        return
      }
      const seconds = this.waitSeconds(session.channelType, outcome.wait.duration)
      this.scheduleFlush(session, Math.min(seconds * 1000, hardRemaining) / 1000, 'direct_timeout')
      return
    }

    const schedule = outcome.schedule ?? this.deferredSchedule(outcome.intent)
    session.deferredIntent = {
      ...outcome.intent,
      ...schedule,
      sourceMessages: messages,
    }
    session.phase = 'ready'
    session.isMentioned = false
    session.nextScanTime = schedule.notBefore
  }

  deferredSchedule(intent: {
    timing: DeferredSocialIntent['timing']
    expires: DeferredSocialIntent['expires']
  }): { notBefore: number; expiresAt: number } {
    const now = Date.now()
    return {
      notBefore: now + this.deferDelay(intent.timing),
      expiresAt: this.deferLifetime(intent.expires, now),
    }
  }

  private scheduleFlush(session: SocialSession, seconds: number, reason: FlushReason): void {
    this.clearTimer(session)
    session.flushTimer = setTimeout(
      () => {
        this.triggerFlush(session, reason).catch((error) =>
          logger.error(
            __t('apps.social.logs', '[{0}] 社交计时触发失败: {1}', [
              session.channelId,
              String(error),
            ]),
          ),
        )
      },
      Math.max(0, seconds * 1000),
    )
  }

  private waitSeconds(type: 'private' | 'group', duration: SocialWaitRequest['duration']): number {
    const table =
      type === 'private' ? { short: 2, normal: 5, long: 10 } : { short: 4, normal: 10, long: 20 }
    return table[duration]
  }

  private deferDelay(timing: DeferredSocialIntent['timing']): number {
    const ranges = { soon: [5, 15], later: [30, 90], much_later: [120, 360] } as const
    const [min, max] = ranges[timing]
    return (min + Math.floor(Math.random() * (max - min + 1))) * 60_000
  }

  private deferLifetime(expires: DeferredSocialIntent['expires'], now: number): number {
    if (expires === 'one_hour') return now + 60 * 60_000
    if (expires === 'one_day') return now + 24 * 60 * 60_000
    const end = new Date(now)
    end.setHours(23, 59, 59, 999)
    return end.getTime()
  }

  private sessionKey(
    agentId: string,
    channelType: string,
    channelId: string,
    accountId: string,
    platform?: string,
  ): string {
    return JSON.stringify([platform, agentId, accountId, channelType, channelId])
  }

  private clearTimer(session: SocialSession): void {
    if (!session.flushTimer) return
    clearTimeout(session.flushTimer)
    session.flushTimer = null
  }
}
