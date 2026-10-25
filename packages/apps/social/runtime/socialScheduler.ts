import { t as __t } from './i18n'
import {
  normalizeSocialSchedulerConfig,
  normalizeSocialGroupPolicy,
  normalizeSocialGroupPolicies,
  socialGroupPolicyKey,
  SOCIAL_INITIAL_REVIEW_DELAY_MS,
  type SocialSchedulerConfig,
  type SocialGroupPolicies,
  type SocialGroupPolicy,
  type SocialExecutionPort,
} from '@infos/shared'
import type { SocialSessionManager, SocialSession } from './socialSessionManager'
import { createLogger } from '@infos/backend/applicationHostAbi'

export type { SocialSchedulerConfig } from '@infos/shared'
const logger = createLogger('SocialScheduler')

export interface SocialSchedulerDeps {
  sessionManager: SocialSessionManager
  executions?: SocialExecutionPort
  legacyPlatform?(): string | undefined
  allowObservation?(session: SocialSession): boolean
  maintain?(): Promise<void>
  allowSession?(session: SocialSession): boolean
}

/** 各群独立计时；共享轮询只负责发现到期会话，不共享冷却和观察名额。 */
export class SocialScheduler {
  private config: SocialSchedulerConfig
  private groupPolicies: SocialGroupPolicies = {}
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private reviewing = new WeakSet<SocialSession>()

  constructor(
    private readonly deps: SocialSchedulerDeps,
    config?: Partial<SocialSchedulerConfig>,
  ) {
    this.config = normalizeSocialSchedulerConfig(config ?? {})
  }

  getConfig(): SocialSchedulerConfig {
    return { ...this.config }
  }

  updateConfig(config: Partial<SocialSchedulerConfig>): SocialSchedulerConfig {
    this.config = normalizeSocialSchedulerConfig({ ...this.config, ...config })
    this.rebaseReviews()
    return this.getConfig()
  }

  updateGroupPolicies(policies: unknown): void {
    this.groupPolicies = normalizeSocialGroupPolicies(policies)
    this.rebaseReviews()
  }

  getGroupPolicy(
    agentId: string,
    accountId: string,
    groupId: string,
    platform?: string,
  ): SocialGroupPolicy {
    return normalizeSocialGroupPolicy(
      this.groupPolicies[socialGroupPolicyKey(agentId, accountId, groupId, platform)] ??
        (platform === this.deps.legacyPlatform?.()
          ? this.groupPolicies[socialGroupPolicyKey(agentId, accountId, groupId)]
          : undefined) ??
        {},
      this.config,
    )
  }

  private rebaseReviews(): void {
    const now = Date.now()
    for (const session of this.deps.sessionManager.listSessions()) {
      if (session.channelType !== 'group') continue
      const policy = this.policy(session)
      // 只重算主动观察时间，不改写重试、延后意图或托管编排的唤醒时间。
      session.nextReviewTime =
        session.lastReviewTime !== undefined
          ? Math.max(now, session.lastReviewTime + policy.reviewIntervalSeconds * 1000)
          : Math.min(
              session.nextReviewTime ?? now + SOCIAL_INITIAL_REVIEW_DELAY_MS,
              now + SOCIAL_INITIAL_REVIEW_DELAY_MS,
            )
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedulePoll()
    logger.info(__t('apps.social.logs', '社交调度器已启动（单 Agent 确定性门控）'))
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedulePoll(): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.scan()
        .catch((error) =>
          logger.error(__t('apps.social.logs', '社交调度扫描失败: {0}', [String(error)])),
        )
        .finally(() => this.schedulePoll())
    }, 10_000)
  }

  private policy(session: SocialSession): SocialGroupPolicy {
    return this.getGroupPolicy(
      session.agentId,
      session.accountId ?? '',
      session.channelId,
      session.platform,
    )
  }

  policyGate(agentId: string, accountId: string, groupId: string, platform?: string): string {
    const policy = this.getGroupPolicy(agentId, accountId, groupId, platform)
    if (!policy.proactiveGroupEnabled) return 'disabled'
    return this.isNightSilence(policy) ? 'night_silence' : 'ready'
  }

  reviewGate(session: SocialSession, now = Date.now()): string {
    if (this.deps.allowSession && !this.deps.allowSession(session)) return 'activation_policy'
    if (this.deps.allowObservation?.(session) === false) return 'platform_visibility'
    const gate = this.policyGate(
      session.agentId,
      session.accountId ?? '',
      session.channelId,
      session.platform,
    )
    if (gate !== 'ready') return gate
    const policy = this.policy(session)
    if (
      this.reviewing.has(session) ||
      session.phase === 'running' ||
      session.phase === 'retrying' ||
      session.phase === 'collecting' ||
      session.orchestrationTurnId
    )
      return 'busy'
    if (session.deferredIntent) return 'deferred'
    if (session.pendingMessages.length < policy.minMessagesForReview) return 'insufficient_messages'
    if (now < (session.nextReviewTime ?? 0) || now < session.nextScanTime) return 'cooldown'
    return 'ready'
  }

  private async scan(): Promise<void> {
    // 维护失败不应连带关闭所有群聊的调度。
    try {
      await this.deps.maintain?.()
    } catch (error) {
      logger.error(__t('apps.social.logs', '社交调度扫描失败: {0}', [String(error)]))
    }
    const now = Date.now()
    const sessions = this.deps.sessionManager.listSessions()
    for (const session of sessions) {
      this.deps.sessionManager.checkActiveExpiry(session)
      if (session.phase === 'retrying') {
        if (now >= session.nextScanTime) {
          void this.deps.sessionManager
            .retry(session)
            .catch((error) =>
              logger.warn(__t('apps.social.logs', '社交恢复失败: {0}', [String(error)])),
            )
        }
        continue
      }
      if (this.deps.sessionManager.dueDeferredIntent(session, now)) {
        this.runReview(session, 'intent_due')
        continue
      }
      if (session.channelType !== 'group' || this.reviewGate(session, now) !== 'ready') continue
      // 先占本会话的时间槽，慢请求和失败都不会占用其他群的观察机会。
      session.lastReviewTime = now
      session.nextReviewTime = now + this.policy(session).reviewIntervalSeconds * 1000
      this.runReview(session, 'proactive_review')
    }
  }

  private runReview(session: SocialSession, reason: 'proactive_review' | 'intent_due'): void {
    if (this.reviewing.has(session)) return
    this.reviewing.add(session)
    void this.deps.sessionManager
      .review(session, reason)
      .catch((error) =>
        logger.warn(
          __t(
            'apps.social.logs',
            reason === 'intent_due' ? '延后任务唤醒失败: {0}' : '自主观察失败: {0}',
            [String(error)],
          ),
        ),
      )
      .finally(() => this.reviewing.delete(session))
  }

  private isNightSilence(policy: SocialGroupPolicy): boolean {
    if (!policy.nightSilenceEnabled) return false
    const hour = new Date().getHours()
    const { nightSilenceStart: start, nightSilenceEnd: end } = policy
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end
  }
}
