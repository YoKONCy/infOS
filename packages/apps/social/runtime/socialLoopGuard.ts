import { t as __t } from './i18n'
import { createHash, randomUUID } from 'node:crypto'
import { createLogger } from '@infos/backend/applicationHostAbi'
import type { SocialBotMark, SocialTurnRecord } from '@infos/shared'
import type { InboundMessage } from './types'
import { currentSocialScope } from './socialStorageScope'
import { socialTriggerMessage } from './socialMessageContext'
import { socialDelay } from './socialRecovery'

const logger = createLogger('SocialLoopGuard')
const validId = (id: unknown): id is string =>
  // eslint-disable-next-line no-control-regex -- 显式拦截控制字符，防止标识或路径混入不可见内容。
  typeof id === 'string' && !!id.trim() && id.length <= 400 && !/[\u0000-\u001f]/.test(id)
export const socialIdentityKey = (platform: string | undefined, id: string) =>
  platform ? `${platform}:${id}` : id
interface ConfigPort {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}
export interface LoopPolicy {
  knownBotIds: string[]
  trustedHumanIds: string[]
  botMarks: SocialBotMark[]
  maxBotTurns: number
  maxTurnsPerWindow: number
  windowSeconds: number
  maxModelRequests: number
  maxSends: number
  cooldownSeconds: number
}
export const DEFAULT_LOOP_POLICY: LoopPolicy = {
  knownBotIds: [],
  trustedHumanIds: [],
  botMarks: [],
  maxBotTurns: 4,
  maxTurnsPerWindow: 20,
  windowSeconds: 60,
  maxModelRequests: 24,
  maxSends: 16,
  cooldownSeconds: 600,
}
export function normalizeLoopPolicy(
  input: Partial<LoopPolicy>,
  legacyPlatform?: string,
): LoopPolicy {
  const bounded = (key: keyof LoopPolicy, min: number, max: number) => {
    const value = Number(input[key] ?? DEFAULT_LOOP_POLICY[key])
    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.floor(value)))
      : Number(DEFAULT_LOOP_POLICY[key])
  }
  const ids = (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .map(String)
              .filter((id) => validId(id))
              .map((id) =>
                legacyPlatform && !id.includes(':') ? socialIdentityKey(legacyPlatform, id) : id,
              ),
          ),
        ].slice(0, 200)
      : []
  const trustedHumanIds = ids(input.trustedHumanIds)
  const knownBotIds = ids(input.knownBotIds).filter((id) => !trustedHumanIds.includes(id))
  const marked = new Set<string>()
  const botMarks: SocialBotMark[] = []
  for (const value of Array.isArray(input.botMarks) ? input.botMarks : []) {
    const platform = value?.platform ?? legacyPlatform
    if (
      !value ||
      typeof value !== 'object' ||
      !knownBotIds.includes(socialIdentityKey(platform, value.userId)) ||
      marked.has(socialIdentityKey(platform, value.userId))
    )
      continue
    if (
      typeof value.reason !== 'string' ||
      !value.reason.trim() ||
      typeof value.agentId !== 'string' ||
      !value.agentId ||
      typeof value.accountId !== 'string' ||
      !validId(value.accountId) ||
      typeof value.channelId !== 'string' ||
      !validId(value.channelId) ||
      !['private', 'group'].includes(value.channelType) ||
      (value.messageId !== undefined &&
        (typeof value.messageId !== 'string' || !value.messageId.trim())) ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))
    )
      continue
    marked.add(socialIdentityKey(platform, value.userId))
    botMarks.push({
      platform,
      userId: value.userId,
      reason: value.reason.trim().slice(0, 500),
      agentId: value.agentId.slice(0, 200),
      accountId: value.accountId,
      channelType: value.channelType,
      channelId: value.channelId,
      messageId: value.messageId?.slice(0, 200),
      createdAt: value.createdAt,
    })
  }
  return {
    knownBotIds,
    trustedHumanIds,
    botMarks,
    maxBotTurns: bounded('maxBotTurns', 1, 20),
    maxTurnsPerWindow: bounded('maxTurnsPerWindow', 1, 200),
    windowSeconds: bounded('windowSeconds', 10, 3600),
    maxModelRequests: bounded('maxModelRequests', 1, 100),
    maxSends: bounded('maxSends', 1, 100),
    cooldownSeconds: bounded('cooldownSeconds', 30, 86400),
  }
}
type Scope = Pick<
  SocialTurnRecord,
  'platform' | 'agentId' | 'accountId' | 'channelType' | 'channelId'
>
type UsageKind = 'turns' | 'requests' | 'sends'
interface UsageEntry {
  id: string
  at: number
}
interface BotState {
  epoch: string
  turns: string[]
  lastSendAt?: number
  blockedUntil?: number
}
interface GuardState {
  version: 2
  epoch: string
  admitted: string[]
  usage: Record<UsageKind, UsageEntry[]>
  bots: Record<string, BotState>
  seen: string[]
}
export interface SocialRateWait {
  kind: UsageKind
  until: number
}
interface GateOptions {
  signal?: AbortSignal
  onWait?(waiting?: SocialRateWait): Promise<void>
}
const blocked = (message: string) =>
  Object.assign(new Error(message), {
    code: 'SOCIAL_LOOP_BLOCKED',
    rejected: true,
    data: { retryable: false },
  })

/** 机器人按回复对象熔断；所有会话的资源消耗按滑动窗口限流并自动等待。 */
export class SocialLoopGuard {
  private queues = new Map<string, Promise<unknown>>()
  constructor(
    private config: ConfigPort,
    private policy: () => LoopPolicy,
    private accounts: (platform?: string) => string[],
    private owner: (platform?: string) => string | undefined,
    private updatePolicy?: (change: (current: LoopPolicy) => LoopPolicy) => Promise<LoopPolicy>,
    private legacyPlatform: () => string | undefined = () => undefined,
  ) {}

  /** 按账号保存全局标记；会话字段仅供审计，可选消息由业务工具核验。 */
  async markBot(
    scope: Scope & { signal?: AbortSignal },
    input: { userId: string; messageId?: string; reason: string },
  ) {
    if (!this.updatePolicy) throw new Error('机器人标记持久化服务尚未就绪')
    const reason = input.reason.trim()
    if (
      !validId(input.userId) ||
      (input.messageId !== undefined &&
        (!input.messageId.trim() || input.messageId.length > 200)) ||
      !reason ||
      reason.length > 500
    )
      throw new Error('机器人标记需要有效账号和判断依据，来源消息可选')
    let added = false
    const policy = await this.updatePolicy((current) => {
      scope.signal?.throwIfAborted()
      // 在配置写入队列内再次检查，避免覆盖用户刚登记的真人身份。
      if (
        input.userId === this.owner(scope.platform) ||
        this.includes(current.trustedHumanIds, input.userId, scope.platform)
      )
        throw new Error('不能给主人或用户登记的可信真人添加机器人标记')
      if (
        this.accounts(scope.platform).includes(input.userId) ||
        this.includes(current.knownBotIds, input.userId, scope.platform)
      )
        return current
      if (current.knownBotIds.length >= 200)
        throw new Error('机器人名单已满，请用户在社交设置中整理')
      added = true
      return normalizeLoopPolicy({
        ...current,
        knownBotIds: [...current.knownBotIds, socialIdentityKey(scope.platform, input.userId)],
        botMarks: [
          ...current.botMarks,
          {
            platform: scope.platform,
            agentId: scope.agentId,
            accountId: scope.accountId,
            channelType: scope.channelType,
            channelId: scope.channelId,
            userId: input.userId,
            messageId: input.messageId,
            reason,
            createdAt: new Date().toISOString(),
          },
        ],
      })
    })
    if (added)
      logger.info(__t('apps.social.logs', '模型已添加本地机器人标记'), {
        agentId: scope.agentId,
        accountId: scope.accountId,
        channelType: scope.channelType,
        channelId: scope.channelId,
        userId: input.userId,
        messageId: input.messageId,
      })
    return {
      user_id: input.userId,
      kind: 'bot',
      added,
      mark: policy.botMarks.find(
        (item) => item.userId === input.userId && item.platform === scope.platform,
      ),
      hint: __t(
        'apps.social.ui',
        '账号标记已全局生效，适用于所有群聊和私聊；连续互聊预算保持不变，用户可在社交设置中纠正',
      ),
    }
  }

  private key(scope: Scope) {
    return `social.loopGuard.${createHash('sha256')
      .update(
        JSON.stringify([
          scope.platform,
          scope.agentId,
          scope.accountId,
          scope.channelType,
          scope.channelId,
        ]),
      )
      .digest('hex')}`
  }
  private fresh(seen: string[] = []): GuardState {
    return {
      version: 2,
      epoch: randomUUID(),
      admitted: [],
      usage: { turns: [], requests: [], sends: [] },
      bots: {},
      seen,
    }
  }
  private async locked<T>(
    scope: Scope,
    run: (state: GuardState) => Promise<T> | T,
    repair = false,
  ): Promise<T> {
    const key = this.key(scope)
    const pending = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        let raw = await this.config.get(key)
        if (!raw && scope.platform && scope.platform === this.legacyPlatform()) {
          const oldKey = `social.loopGuard.${createHash('sha256')
            .update(
              JSON.stringify([scope.agentId, scope.accountId, scope.channelType, scope.channelId]),
            )
            .digest('hex')}`
          raw = await this.config.get(oldKey)
        }
        let state: GuardState
        let parsed: unknown
        try {
          parsed = raw ? JSON.parse(raw) : this.fresh()
        } catch {
          if (!repair) throw blocked('社交互聊保护记录异常，请在设置中重新授权，未自动放行')
          parsed = this.fresh()
        }
        const value = parsed as Record<string, unknown> | undefined
        if (
          value &&
          value.version === undefined &&
          typeof value.epoch === 'string' &&
          value.epoch &&
          Array.isArray(value.turns) &&
          Array.isArray(value.requests) &&
          Array.isArray(value.sends) &&
          Array.isArray(value.seen)
        ) {
          // 旧计数混入普通群友和 PASS，不能作为机器人证据继续封锁；保留代际与已领取任务，避免中断在途任务。
          state = {
            ...this.fresh(
              value.seen.filter((id): id is string => typeof id === 'string').slice(-200),
            ),
            epoch: value.epoch,
            admitted: (Array.isArray(value.admitted) ? value.admitted : value.turns)
              .filter((id): id is string => typeof id === 'string')
              .slice(-200),
          }
          logger.info(__t('apps.social.logs', '已迁移旧版社交保护记录，移除累计无人介入熔断'), {
            agentId: scope.agentId,
            accountId: scope.accountId,
            channelType: scope.channelType,
            channelId: scope.channelId,
          })
        } else if (
          value?.version === 2 &&
          typeof value.epoch === 'string' &&
          value.epoch &&
          Array.isArray(value.admitted) &&
          Array.isArray(value.seen) &&
          value.bots &&
          typeof value.bots === 'object' &&
          !Array.isArray(value.bots) &&
          Object.values(value.bots as Record<string, BotState>).every(
            (peer) =>
              peer &&
              typeof peer.epoch === 'string' &&
              Array.isArray(peer.turns) &&
              peer.turns.every((id) => typeof id === 'string') &&
              (peer.blockedUntil === undefined || Number.isFinite(peer.blockedUntil)) &&
              (peer.lastSendAt === undefined || Number.isFinite(peer.lastSendAt)),
          ) &&
          value.usage &&
          typeof value.usage === 'object' &&
          (['turns', 'requests', 'sends'] as const).every(
            (kind) =>
              Array.isArray((value.usage as GuardState['usage'])[kind]) &&
              (value.usage as GuardState['usage'])[kind].every(
                (entry) => entry && typeof entry.id === 'string' && Number.isFinite(entry.at),
              ),
          )
        ) {
          state = value as unknown as GuardState
        } else {
          if (!repair) throw blocked('社交互聊保护记录异常，请在设置中重新授权，未自动放行')
          state = this.fresh()
        }
        try {
          return await run(state)
        } finally {
          await this.config.set(key, JSON.stringify(state))
        }
      })
    this.queues.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.queues.get(key) === pending) this.queues.delete(key)
    }
  }
  private includes(ids: string[], userId: string, platform?: string) {
    return (
      ids.includes(socialIdentityKey(platform, userId)) ||
      (platform === this.legacyPlatform() && ids.includes(userId))
    )
  }
  botIds(platform?: string): string[] {
    const prefix = platform ? `${platform}:` : ''
    return [
      ...new Set([
        ...this.accounts(platform),
        ...this.policy().knownBotIds.flatMap((id) =>
          prefix && id.startsWith(prefix)
            ? [id.slice(prefix.length)]
            : platform === this.legacyPlatform() && !id.includes(':')
              ? [id]
              : [],
        ),
      ]),
    ].filter((id) => this.isBotAccount(id, platform))
  }
  classify(message: InboundMessage): 'human' | 'bot' | 'unknown' {
    if (
      message.senderId === this.owner(message.platform) ||
      this.includes(this.policy().trustedHumanIds, message.senderId, message.platform)
    )
      return 'human'
    return message.platformBot === true || this.isBotAccount(message.senderId, message.platform)
      ? 'bot'
      : 'unknown'
  }
  isBotAccount(userId: string, platform = currentSocialScope()?.platform): boolean {
    return (
      userId !== this.owner(platform) &&
      !this.includes(this.policy().trustedHumanIds, userId, platform) &&
      (this.accounts(platform).includes(userId) ||
        this.includes(this.policy().knownBotIds, userId, platform))
    )
  }
  async observe(message: InboundMessage): Promise<void> {
    message.senderKind = this.classify(message)
    // 普通群友无需登记真人名单；未知身份不会被当成机器人，也不能重置其他机器人的计数。
    if (message.senderKind !== 'human') return
    const scope = { ...message, accountId: message.accountId ?? '' }
    await this.locked(scope, (state) => {
      const id = message.messageId ?? ''
      if (!id || state.seen.includes(id)) return
      state.seen = [...state.seen, id].slice(-200)
      for (const [id, peer] of Object.entries(state.bots)) {
        // 只撤销已熔断机器人的旧计划；普通补充消息不取消正在发送的任务。
        state.bots[id] = { epoch: peer.blockedUntil ? randomUUID() : peer.epoch, turns: [] }
      }
      // 真人身份不重置滑动窗口，避免普通流量通过频繁发言绕过限流。
    })
  }
  private assertState(state: GuardState, record: SocialTurnRecord): BotState | undefined {
    const epoch = record.checkpoint.loopGuardEpoch
    if (epoch !== undefined && epoch !== state.epoch)
      throw blocked('旧社交计划的互聊预算已失效，未恢复执行')
    const inbound = record.checkpoint.inbound as InboundMessage[] | undefined
    const trigger = socialTriggerMessage(inbound ?? [])
    if (!trigger || this.classify(trigger) !== 'bot') return
    const id = trigger.senderId
    const now = Date.now()
    let peer = state.bots[id]
    if (
      !peer ||
      (peer.blockedUntil
        ? now >= peer.blockedUntil
        : peer.lastSendAt !== undefined &&
          now - peer.lastSendAt >= this.policy().cooldownSeconds * 1000)
    ) {
      peer = state.bots[id] = { epoch: randomUUID(), turns: [] }
    }
    const epochs = (record.checkpoint.loopGuardBotEpochs ??= {}) as Record<string, string>
    if (epochs[id] !== undefined && epochs[id] !== peer.epoch)
      throw blocked('旧社交计划的机器人互聊预算已失效，未恢复执行')
    epochs[id] ??= peer.epoch
    if (peer.blockedUntil && now < peer.blockedUntil)
      throw blocked(
        `与账号 ${id} 的机器人互聊已暂停；冷却至 ${new Date(peer.blockedUntil).toISOString()}，其他联系人不受影响`,
      )
    if (!peer.turns.includes(record.id) && peer.turns.length >= this.policy().maxBotTurns) {
      peer.blockedUntil = now + this.policy().cooldownSeconds * 1000
      logger.warn(__t('apps.social.logs', '单个机器人互聊已熔断，其他联系人仍可交流'), {
        agentId: record.agentId,
        accountId: record.accountId,
        channelId: record.channelId,
        peerId: id,
        until: new Date(peer.blockedUntil).toISOString(),
      })
      throw blocked(`与账号 ${id} 的机器人互聊达到上限，等待真人介入或冷却结束；其他联系人不受影响`)
    }
    // 本轮先发送、后识别为机器人时，已确认送达的回合也要补计，不能借标记时序重置预算。
    const delivered = record.checkpoint.deliveries as Record<string, string> | undefined
    if (!peer.turns.includes(record.id) && Object.values(delivered ?? {}).includes('sent')) {
      peer.turns.push(record.id)
      peer.lastSendAt = now
    }
    return peer
  }
  private async gate(
    record: SocialTurnRecord,
    kind: UsageKind,
    id: string,
    options: GateOptions,
  ): Promise<void> {
    const remaining = Date.parse(record.deadline) - Date.now()
    if (!(remaining > 0)) throw new Error('社交任务已超时')
    const signal = AbortSignal.any([
      AbortSignal.timeout(Math.min(remaining, 2147483647)),
      ...(options.signal ? [options.signal] : []),
    ])
    let waiting = false
    try {
      for (;;) {
        signal.throwIfAborted()
        const until = await this.locked(record, (state) => {
          signal.throwIfAborted()
          const peer = this.assertState(state, record)
          if (kind === 'turns') {
            record.checkpoint.loopGuardEpoch ??= state.epoch
            if (state.admitted.includes(record.id)) return 0
          } else if (!state.admitted.includes(record.id)) throw blocked('社交任务尚未领取交互预算')
          const now = Date.now()
          const windowMs = this.policy().windowSeconds * 1000
          for (const key of ['turns', 'requests', 'sends'] as const)
            state.usage[key] = state.usage[key].filter((entry) => entry.at > now - windowMs)
          const entries = state.usage[kind]
          if (entries.some((entry) => entry.id === id)) return 0
          const limit =
            kind === 'turns'
              ? this.policy().maxTurnsPerWindow
              : kind === 'requests'
                ? this.policy().maxModelRequests
                : this.policy().maxSends
          if (entries.length >= limit) return entries[entries.length - limit]!.at + windowMs
          entries.push({ id, at: now })
          if (kind === 'turns') state.admitted = [...state.admitted, record.id].slice(-200)
          if (kind === 'sends' && peer) {
            if (!peer.turns.includes(record.id)) peer.turns.push(record.id)
            peer.lastSendAt = now
          }
          return 0
        })
        if (!until) return
        waiting = true
        logger.info(__t('apps.social.logs', '社交频率达到窗口上限，保留当前消息并等待恢复'), {
          agentId: record.agentId,
          accountId: record.accountId,
          channelId: record.channelId,
          turnId: record.id,
          kind,
          resumeAt: new Date(until).toISOString(),
        })
        await options.onWait?.({ kind, until })
        await socialDelay(Math.max(1, until - Date.now()), signal)
      }
    } finally {
      if (waiting && !signal.aborted) await options.onWait?.()
    }
  }
  async admit(record: SocialTurnRecord, options: GateOptions = {}): Promise<void> {
    return this.gate(record, 'turns', record.id, options)
  }
  async consume(
    record: SocialTurnRecord,
    kind: 'requests' | 'sends',
    id: string,
    options: GateOptions = {},
  ): Promise<void> {
    return this.gate(record, kind, `${record.id}:${id}`, options)
  }
  /** 平台明确未发送时退还预约；不撤销结果未知或已送达的消耗。 */
  async releaseSend(record: SocialTurnRecord, id: string): Promise<void> {
    await this.locked(record, (state) => {
      if (record.checkpoint.loopGuardEpoch !== state.epoch) return
      const deliveries = record.checkpoint.deliveries as Record<string, string> | undefined
      if (deliveries?.[id] === 'sent' || deliveries?.[id] === 'sending') return
      state.usage.sends = state.usage.sends.filter((entry) => entry.id !== `${record.id}:${id}`)
      if (Object.values(deliveries ?? {}).some((value) => value === 'sent' || value === 'sending'))
        return
      for (const peer of Object.values(state.bots))
        peer.turns = peer.turns.filter((turn) => turn !== record.id)
    })
  }
  async check(record: SocialTurnRecord): Promise<void> {
    await this.locked(record, (state) => {
      this.assertState(state, record)
      if (!state.admitted.includes(record.id)) throw blocked('社交任务尚未领取交互预算')
    })
  }
  /** 只有应用设置入口调用，模型工具不开放恢复授权。 */
  async allow(scope: Scope) {
    return this.locked(
      scope,
      (state) => {
        Object.assign(state, this.fresh(state.seen))
        logger.info(__t('apps.social.logs', '用户重新授权有限社交交流预算'), {
          agentId: scope.agentId,
          accountId: scope.accountId,
          channelType: scope.channelType,
          channelId: scope.channelId,
        })
        return { renewed: true, policy: this.policy() }
      },
      true,
    )
  }
}
