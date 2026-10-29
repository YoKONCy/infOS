/** 设置页、Agent 工具与社交运行时共用同一份策略和边界。 */
export const SOCIAL_INITIAL_REVIEW_DELAY_MS = 30_000

/** 三档旁观退避均执行后，再次 PASS 才进入仅提及唤醒。 */
export const SOCIAL_PASS_BACKOFF_MINUTES = [10, 20, 60] as const
export type SocialActivityMode = 'normal' | 'mention_only'
export interface SocialGroupActivity {
  mode: SocialActivityMode
  passCount: number
  reviewNotBefore: number
  lastTurnId?: string
}
export interface SocialGroupActivityItem extends SocialGroupActivity {
  platform: string
  agentId: string
  accountId: string
  groupId: string
  participation: 'idle' | 'listening' | 'engaged'
  nextReviewAt: number | null
}

export const SOCIAL_GROUP_POLICY_LIMITS = {
  minMessagesForReview: [1, 20],
  reviewIntervalSeconds: [30, 3600],
  nightSilenceStart: [0, 23],
  nightSilenceEnd: [0, 23],
} as const

export interface SocialGroupPolicy {
  proactiveGroupEnabled: boolean
  minMessagesForReview: number
  reviewIntervalSeconds: number
  nightSilenceEnabled: boolean
  nightSilenceStart: number
  nightSilenceEnd: number
}

export interface SocialSchedulerConfig extends SocialGroupPolicy {
  taskTimeoutMinutes: number
  modelIdleMinutes: number
  modelRequestMinutes: number
  maxRetries: number
}

export type SocialGroupPolicies = Record<string, Partial<SocialGroupPolicy>>

export const DEFAULT_SOCIAL_SCHEDULER_CONFIG: Readonly<SocialSchedulerConfig> = {
  proactiveGroupEnabled: true,
  minMessagesForReview: 3,
  reviewIntervalSeconds: 180,
  nightSilenceEnabled: true,
  nightSilenceStart: 0,
  nightSilenceEnd: 8,
  taskTimeoutMinutes: 360,
  modelIdleMinutes: 10,
  modelRequestMinutes: 30,
  maxRetries: 2,
}

const integer = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback

export function normalizeSocialGroupPolicy(
  input: Partial<SocialGroupPolicy>,
  defaults: SocialGroupPolicy = DEFAULT_SOCIAL_SCHEDULER_CONFIG,
): SocialGroupPolicy {
  return {
    proactiveGroupEnabled:
      typeof input.proactiveGroupEnabled === 'boolean'
        ? input.proactiveGroupEnabled
        : defaults.proactiveGroupEnabled,
    minMessagesForReview: integer(
      input.minMessagesForReview,
      defaults.minMessagesForReview,
      ...SOCIAL_GROUP_POLICY_LIMITS.minMessagesForReview,
    ),
    reviewIntervalSeconds: integer(
      input.reviewIntervalSeconds,
      defaults.reviewIntervalSeconds,
      ...SOCIAL_GROUP_POLICY_LIMITS.reviewIntervalSeconds,
    ),
    nightSilenceEnabled:
      typeof input.nightSilenceEnabled === 'boolean'
        ? input.nightSilenceEnabled
        : defaults.nightSilenceEnabled,
    nightSilenceStart: integer(
      input.nightSilenceStart,
      defaults.nightSilenceStart,
      ...SOCIAL_GROUP_POLICY_LIMITS.nightSilenceStart,
    ),
    nightSilenceEnd: integer(
      input.nightSilenceEnd,
      defaults.nightSilenceEnd,
      ...SOCIAL_GROUP_POLICY_LIMITS.nightSilenceEnd,
    ),
  }
}

export function normalizeSocialSchedulerConfig(
  input: Partial<SocialSchedulerConfig>,
): SocialSchedulerConfig {
  const defaults = DEFAULT_SOCIAL_SCHEDULER_CONFIG
  const modelIdleMinutes = integer(input.modelIdleMinutes, defaults.modelIdleMinutes, 1, 60)
  return {
    ...normalizeSocialGroupPolicy(input),
    taskTimeoutMinutes: integer(input.taskTimeoutMinutes, defaults.taskTimeoutMinutes, 1, 360),
    modelIdleMinutes,
    modelRequestMinutes: integer(
      input.modelRequestMinutes,
      Math.max(defaults.modelRequestMinutes, modelIdleMinutes),
      modelIdleMinutes,
      360,
    ),
    maxRetries: integer(input.maxRetries, defaults.maxRetries, 0, 2),
  }
}

export function socialGroupPolicyKey(
  agentId: string,
  accountId: string,
  groupId: string,
  platform?: string,
): string {
  return JSON.stringify(
    platform ? [platform, agentId, accountId, groupId] : [agentId, accountId, groupId],
  )
}

/** 持久化配置只接受已知策略字段；群覆盖不复制默认值，便于继续继承全局设置。 */
export function normalizeSocialGroupPolicies(input: unknown): SocialGroupPolicies {
  const policies: SocialGroupPolicies = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return policies
  const fields = Object.keys(normalizeSocialGroupPolicy({})) as Array<keyof SocialGroupPolicy>
  for (const [key, value] of Object.entries(input)) {
    try {
      const identity: unknown = JSON.parse(key)
      if (
        !Array.isArray(identity) ||
        ![3, 4].includes(identity.length) ||
        identity.some((part) => typeof part !== 'string' || !part || part.length > 200) ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      )
        continue
      const patch = value as Partial<SocialGroupPolicy>
      const normalized = normalizeSocialGroupPolicy(patch)
      policies[key] = Object.fromEntries(
        fields
          .filter(
            (field) =>
              Object.hasOwn(patch, field) && typeof patch[field] === typeof normalized[field],
          )
          .map((field) => [field, normalized[field]]),
      )
    } catch {
      // 损坏或旧格式的单个群覆盖不影响其他群配置。
    }
  }
  return policies
}
