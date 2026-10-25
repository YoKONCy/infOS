import { t as __t } from './i18n'
import { getSocialTurnKind, SOCIAL_DELEGATED_TURN_PREFIX, type SocialTurnKind } from '@infos/shared'
/**
 * SocialBridge — 社交桥接 (Layer 0)
 *
 * 连接 ISocialAdapter ↔ SocialSessionManager ↔ SocialScheduler ↔ 回复回调。
 *
 * 核心职责:
 * 1. 监听 adapter.on('message') → SessionManager 缓冲 → Scheduler 审视 → generateReply()
 * 2. 将 AI 回复 → adapter.sendMessage()
 * 3. 持久化社交消息到 socialMessages 表
 * 4. 通过SocialEventPort推送社交状态到前端
 * 5. 管理适配器/调度器生命周期
 *
 * 方案 B：回复生成回调由 SocialAppRuntime 提供，
 * 使用应用自己的 Compiler + LLM，不再依赖主 Agent 的 AgentService.chat。
 *
 * @module packages/apps/social/runtime/socialBridge
 */

import type { AbstractSocialAdapter } from '../adapters/ISocialAdapter'
import { currentSocialScope, scopedSocialStorage, withSocialScope } from './socialStorageScope'
import { createHash, randomUUID } from 'node:crypto'
import {
  assertSocialActive,
  currentSocialRecovery,
  currentSocialStep,
  finishSocialTurn,
  runSocialRecovery,
  SOCIAL_TURN_DURATION_MS,
  socialDelay,
  socialRateGateOptions,
  socialFailure,
  SocialTurnEndedError,
} from './socialRecovery'
import type {
  SocialEventPort,
  SocialExecutionPort,
  SocialStoragePort,
  SocialMessageRecord,
  SocialTurnRecord,
  SocialTurnListItem,
} from '@infos/shared'
import type { InboundRouteRepository } from '@infos/backend/applicationHostAbi'
import type { Attachment, InboundMessage, OutboundMessage, SocialDeliveryReceipt } from './types'
import { orchestrationWait, notifyOrchestrationInbound } from './socialOrchestration'
import {
  SocialSessionManager,
  type FlushReason,
  type SocialSession,
  type SocialTurnOutcome,
} from './socialSessionManager'
import { SocialScheduler, type SocialSchedulerConfig } from './socialScheduler'
import type { ImageCacheManager } from './imageCacheManager'
import type { StickerService } from './stickerService'
import type { NativeEmojiScope } from './nativeEmoji'
import type { SocialLoopGuard } from './socialLoopGuard'
import { splitStickerSegments } from './stickerService'
import {
  formatSocialMessage,
  isSocialMention,
  restoreSocialMessage,
  socialMessageId,
  socialTriggerMessage,
} from './socialMessageContext'
import { createLogger, safeModelDiagnostic } from '@infos/backend/applicationHostAbi'

const logger = createLogger('SocialBridge')

// ─────────────────────────────────────────────
// 依赖
// ─────────────────────────────────────────────

export interface SocialBridgeDeps {
  socialEvents: SocialEventPort
  executions?: SocialExecutionPort
  socialMessageRepo: SocialStoragePort
  /** 图片缓存管理器 (可选) */
  imageCacheManager?: ImageCacheManager
  /** 表情包服务 (可选) */
  stickerService?: StickerService
  getStickerService?: (platform: string) => StickerService | undefined
  resolveNativeEmoji?: (scope: NativeEmojiScope, reference: string) => Promise<Attachment>
  loopGuard?: SocialLoopGuard
  /** 入站路由表 Repository (可选，第七阶段 #7：外部消息按来源+标识查询归属 Agent) */
  inboundRouteRepo?: InboundRouteRepository
  /** 入站策略过滤；返回 false 时不持久化、不缓冲、不回复。 */
  shouldAcceptInbound?: (message: InboundMessage) => boolean
  getOwnerId?: (platform?: string) => string | undefined
  legacyPlatform?: () => string | undefined
  getAgentId?: () => string
  /** 发送前再次核验会话是否仍允许激活，阻止锁定前已启动的并发回复漏发。 */
  shouldAllowSession?: (
    session: Pick<
      SocialSession,
      'agentId' | 'channelType' | 'channelId' | 'platform' | 'peerId'
    > & { checkpoint?: Record<string, unknown> },
  ) => boolean
  onMessagePersisted?: (agentId: string) => Promise<void>
  /** 回复生成回调：由 SocialAppRuntime 使用当前角色自己的主模型与 ReAct 执行。 */
  generateReply: (params: {
    platform?: string
    signal?: AbortSignal
    taskOrigin?: import('@infos/shared').TaskOrigin
    agentId: string
    channelType: 'private' | 'group'
    channelId: string
    combinedMessage: string
    trigger: FlushReason
    participation: SocialSession['participation']
    deferredIntent?: SocialSession['deferredIntent']
    routeChannel?: string
    routeThreadId?: string
    /**
     * 本次主要对话对象是否为当前配置的主人，由触发者平台账号 严格比对。
     */
    isOwner?: boolean
    /**
     * 触发本次回复的发送者 ID（群聊中是 @ Agent 的人，私聊中是对方）
     *
     * 用于跨会话上下文注入：
     * - 群聊场景下，用此 senderId 查询与该用户的最近私聊记录
     * - 作为补充上下文注入 system prompt，让 Agent 记得与该用户的历史互动
     * - 私聊场景下不需要（因为当前会话本身就是私聊，已在 history 中）
     */
    triggerSenderId?: string
    triggerSenderName?: string
    triggerMessageId?: string
    /** 与触发消息 ID、发送者绑定的原始正文，只作为回复对象核对资料。 */
    triggerMessageContent?: string
    /**
     * 本次 flush 的消息 msgId 列表（用于从 DB 历史中排除，避免重复）
     *
     * handleInbound 在消息入库时就持久化了，所以 DB 历史已包含本次消息。
     * 如果不从 history 中排除，combinedMessage 会在 messages 中出现两次。
     */
    flushMsgIds?: string[]
    /**
     * 触发消息中的图片附件（data URL 格式，供多模态 LLM 使用）
     *
     * 最多三张，优先触发消息、引用消息，再取同一发送者近期图片。
     */
    images?: string[]
    imageSources?: string[]
    /**
     * Bot 自身 平台账号（从适配器 accountInfo 获取）
     *
     * 注入到 system prompt 的 <session_context> 中，
     * 让 Agent 知道自己的 平台账号，用于身份识别和消息归属判断。
     */
    botSelfId?: string
    /**
     * Bot 自身昵称（从适配器 accountInfo 获取）
     *
     * 注入到 system prompt 的 <session_context> 中，
     * 让 Agent 知道自己在所属平台上的昵称。
     */
    botNickname?: string
  }) => Promise<SocialTurnOutcome>
}

// ─────────────────────────────────────────────
// Bridge
// ─────────────────────────────────────────────

export class SocialBridge {
  private deps: SocialBridgeDeps
  /** 已注册的适配器 (platform → adapter) */
  private adapters = new Map<string, AbstractSocialAdapter>()
  /** 运行标记 */
  private running = false
  private turnControllers = new Map<
    string,
    { controller: AbortController; session: SocialSession }
  >()
  private commandControllers = new Map<
    string,
    { controller: AbortController; session: SocialSession }
  >()
  /** 会话管理器 */
  private sessionManager: SocialSessionManager
  /** 图片缓存 */
  private imageCache: ImageCacheManager | null
  /** 表情包服务 */
  private stickerService: StickerService | null
  private stickersFor(platform: string): StickerService | undefined {
    return (
      this.deps.getStickerService?.(platform) ??
      (this.adapters.size === 1 ? (this.stickerService ?? undefined) : undefined)
    )
  }
  /** 同一平台只允许一个历史同步任务，避免重连风暴重复补拉。 */
  private historySyncs = new Map<string, Promise<void>>()
  /** 调度器 */
  private scheduler: SocialScheduler
  private planTimer?: ReturnType<typeof setTimeout>
  private planWakeAt = Infinity
  private resumingPlans = false

  constructor(deps: SocialBridgeDeps) {
    this.deps = { ...deps, socialMessageRepo: scopedSocialStorage(deps.socialMessageRepo) }
    this.imageCache = deps.imageCacheManager ?? null
    this.stickerService = deps.stickerService ?? null

    // 初始化 SessionManager (flush 回调 → generateReply)
    this.sessionManager = new SocialSessionManager(
      (session, messages, reason, signal) => this.onFlush(session, messages, reason, signal),
      undefined,
      (session) =>
        this.scheduler.getGroupPolicy(
          session.agentId,
          session.accountId,
          session.channelId,
          session.platform,
        ),
    )

    // 初始化 Scheduler：管理各群独立观察时钟与到期唤醒，不调用第二个决策模型。
    this.scheduler = new SocialScheduler({
      sessionManager: this.sessionManager,
      executions: deps.executions,
      legacyPlatform: deps.legacyPlatform,
      allowObservation: (session) =>
        this.getAdapter(session.platform ?? '')?.canObserveGroup(
          session.accountId ?? '',
          session.channelId,
        ) !== false,
      allowSession: (session) => this.deps.shouldAllowSession?.(session) ?? true,
      maintain: async () => {
        const agentId = this.deps.getAgentId?.()
        if (agentId) {
          for (const record of await this.deps.socialMessageRepo.listRecoverableTurns(
            agentId,
            true,
          )) {
            if (record.checkpoint.pendingHistory)
              await this.repairDeliveryHistory(record).catch((error) =>
                logger.warn(__t('apps.social.logs', '已送达消息补存失败：{0}', [String(error)])),
              )
          }
          await this.expireWaitingTurns(agentId)
          await this.resumeOrchestrations(agentId)
          await this.refillInbox(agentId)
        }
      },
    })
  }

  getSchedulerConfig(): SocialSchedulerConfig {
    return this.scheduler.getConfig()
  }

  updateSchedulerConfig(config: Partial<SocialSchedulerConfig>): SocialSchedulerConfig {
    return this.scheduler.updateConfig(config)
  }

  updateGroupPolicies(policies: unknown): void {
    this.scheduler.updateGroupPolicies(policies)
  }

  getGroupState(agentId: string, accountId: string, groupId: string, platform?: string) {
    if (!platform && this.adapters.size > 1) throw new Error('SOCIAL_PLATFORM_REQUIRED')
    platform ??= this.adapters.size === 1 ? this.adapters.keys().next().value : undefined
    const session = this.sessionManager
      .listSessions()
      .find(
        (item) =>
          item.agentId === agentId &&
          (!platform || item.platform === platform) &&
          item.accountId === accountId &&
          item.channelType === 'group' &&
          item.channelId === groupId,
      )
    const policyGate = this.scheduler.policyGate(agentId, accountId, groupId, platform)
    return {
      platform,
      agentId,
      accountId,
      groupId,
      policy: this.scheduler.getGroupPolicy(agentId, accountId, groupId, platform),
      phase: session?.phase ?? 'ready',
      participation: session?.participation ?? 'idle',
      pendingMessages: session?.pendingMessages.length ?? 0,
      lastReviewAt: session?.lastReviewTime ?? null,
      nextReviewAt: session ? Math.max(session.nextReviewTime, session.nextScanTime) : null,
      nextScanAt: session?.nextScanTime || null,
      gate:
        this.deps.shouldAllowSession &&
        !this.deps.shouldAllowSession({
          agentId,
          platform,
          channelType: 'group',
          channelId: groupId,
        })
          ? 'activation_policy'
          : session
            ? this.scheduler.reviewGate(session)
            : policyGate === 'ready'
              ? 'no_messages'
              : policyGate,
    }
  }

  // ── 适配器管理 ──

  /** 注册一个社交适配器 */
  registerAdapter(adapter: AbstractSocialAdapter): void {
    const platform = adapter.platform
    if (this.adapters.has(platform)) throw new Error('SOCIAL_PLATFORM_DUPLICATE')

    this.adapters.set(platform, adapter)
    adapter.bindInboundReceiver(
      (message) =>
        new Promise<void>((resolve, reject) => {
          let committed = false
          void this.handleInbound(message, () => {
            committed = true
            resolve()
          }).catch((error) => {
            if (!committed) reject(error)
            else logger.error(__t('apps.social.logs', '处理入站消息失败: {0}', [String(error)]))
          })
        }),
    )

    // 监听消息事件 → SessionManager 缓冲
    adapter.on('message', (msg: InboundMessage) => {
      this.handleInbound(msg).catch((err) => {
        logger.error(__t('apps.social.logs', '处理入站消息失败: {0}', [err]))
      })
    })

    adapter.on('connected', () => {
      logger.info(__t('apps.social.logs', '社交适配器已连接: {0}', [platform]))
      this.notifyFrontend('social_adapter_connected', { platform })
      // 注册连接事件早于 Bot 信息查询，稍后启动补拉以等待账号信息就绪。
      setTimeout(() => {
        if (this.running)
          this.syncOfflineHistory(platform).catch((err) =>
            logger.warn(__t('apps.social.logs', '离线历史补拉失败 [{0}]: {1}', [platform, err])),
          )
      }, 800)
    })

    adapter.on('disconnected', (reason?: string) => {
      logger.info(__t('apps.social.logs', '社交适配器已断开: {0}, reason={1}', [platform, reason]))
      this.notifyFrontend('social_adapter_disconnected', { platform, reason })
    })

    adapter.on('error', (err: Error) => {
      logger.error(__t('apps.social.logs', '社交适配器错误 [{0}]: {1}', [platform, err.message]))
    })

    logger.info(__t('apps.social.logs', '社交适配器已注册: {0}', [platform]))
  }

  /** 注销适配器 */
  unregisterAdapter(platform: string): void {
    const adapter = this.adapters.get(platform)
    if (adapter) {
      adapter.bindInboundReceiver(undefined)
      adapter.removeAllListeners()
      this.adapters.delete(platform)
      logger.info(__t('apps.social.logs', '社交适配器已注销: {0}', [platform]))
    }
  }

  /** 获取适配器 */
  getAdapter(platform: string): AbstractSocialAdapter | undefined {
    return this.adapters.get(platform)
  }

  async syncOfflineHistory(platform: string): Promise<void> {
    const existing = this.historySyncs.get(platform)
    if (existing) return existing
    const task = this.performOfflineHistorySync(platform).finally(() =>
      this.historySyncs.delete(platform),
    )
    this.historySyncs.set(platform, task)
    return task
  }

  private async performOfflineHistorySync(platform: string): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (!adapter || !adapter.capabilities.includes('history')) return
    const accountIds = adapter.getConnectedAccountIds()
    if (accountIds.length === 0) return

    for (const accountId of accountIds) {
      const agentId = adapter.resolveAgentId(accountId)
      if (!agentId) {
        logger.warn(
          __t('apps.social.logs', '无法确定平台账号 {0} 对应的 Agent，跳过历史补拉', [accountId]),
        )
        continue
      }
      const accountChannels = await this.deps.socialMessageRepo.getRecentChannelsForPlatform(
        platform,
        100,
        { agentId, accountId },
      )
      if (accountChannels.length === 0) continue
      const startedAt = Math.floor(Date.now() / 1000)
      const cursor = await this.deps.socialMessageRepo.getSyncCursor(agentId, platform, accountId)
      // 首次启用只建立游标，不导入账号既有历史；后续仅补断开窗口。
      if (!cursor) {
        await this.deps.socialMessageRepo.markSyncCompleted(agentId, platform, accountId, startedAt)
        continue
      }
      await this.deps.socialMessageRepo.markSyncStarted(agentId, platform, accountId, startedAt)
      try {
        for (const channel of accountChannels.filter((item) => item.agentId === agentId)) {
          let pageCursor: string | undefined
          const seenPageStarts = new Set<string>()
          while (this.running) {
            const page = await adapter.getHistoryPage({
              channelId: channel.channelId,
              channelType: channel.channelType as 'private' | 'group',
              limit: 100,
              cursor: pageCursor,
              accountId,
            })
            const history = page.messages
            if (history.length === 0) break
            for (const message of history) {
              if (message.timestamp <= cursor.lastSuccessfulSyncAt || message.timestamp > startedAt)
                continue
              if (
                await this.deps.socialMessageRepo.isDeletedByTombstone({
                  agentId,
                  platform,
                  accountId,
                  channelType: message.channelType,
                  channelId: message.channelId,
                  timestamp: message.timestamp,
                })
              )
                continue
              await this.deps.socialMessageRepo.insert({
                msgId: message.msgId,
                platform,
                accountId,
                channelId: message.channelId,
                channelType: message.channelType,
                senderId: message.senderId,
                senderName: message.senderName,
                content: message.content,
                agentId,
                rawEventJson: JSON.stringify({
                  ...((message.rawEvent as object) ?? {}),
                  _historySync: true,
                }),
                timestamp: new Date(message.timestamp * 1000).toISOString(),
              })
            }

            const oldestTimestamp = Math.min(...history.map((message) => message.timestamp))
            if (oldestTimestamp <= cursor.lastSuccessfulSyncAt || history.length < 100) break
            if (!page.nextCursor) break
            if (seenPageStarts.has(page.nextCursor) || page.nextCursor === pageCursor)
              throw new Error('SOCIAL_HISTORY_CURSOR_STALLED')
            seenPageStarts.add(page.nextCursor)
            pageCursor = page.nextCursor
          }
          if (!this.running) throw new Error('社交应用停止，历史同步将在下次启动时继续')
        }
        // 所有频道成功后一次推进游标；中途断电不会丢消息，重启会依靠唯一索引安全重放。
        await this.deps.socialMessageRepo.markSyncCompleted(agentId, platform, accountId, startedAt)
      } catch (err) {
        await this.deps.socialMessageRepo.markSyncFailed(agentId, platform, accountId, String(err))
        throw err
      }
    }
  }

  // ── 启动 / 停止 ──

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.running = true

    for (const [platform, adapter] of this.adapters) {
      try {
        await adapter.connect(signal)
        signal?.throwIfAborted()
        logger.info(__t('apps.social.logs', '社交适配器启动: {0}', [platform]))
      } catch (err) {
        signal?.throwIfAborted()
        logger.error(__t('apps.social.logs', '社交适配器 {0} 启动失败: {1}', [platform, err]))
      }
    }

    // 冷启动: 从 DB 恢复最近活跃的会话
    await this.reviveSessionsFromDb()
    signal?.throwIfAborted()

    // 启动调度器
    this.scheduler.start()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.planTimer) clearTimeout(this.planTimer)
    this.planTimer = undefined
    this.planWakeAt = Infinity
    for (const { controller } of this.commandControllers.values())
      controller.abort(new Error('社交任务已取消：应用停止'))
    const ids = new Set([
      ...this.turnControllers.keys(),
      ...this.commandControllers.keys(),
      ...this.sessionManager
        .listSessions()
        .flatMap((session) =>
          [session.turnId, session.waitingTurnId, session.orchestrationTurnId].filter(
            (id): id is string => Boolean(id),
          ),
        ),
    ])
    await Promise.allSettled([...ids].map((id) => this.cancelTurn(id)))
    for (const { controller } of this.turnControllers.values())
      controller.abort(new Error('社交任务已取消：应用停止'))
    this.scheduler.stop()
    this.sessionManager.stop()

    for (const [platform, adapter] of this.adapters) {
      try {
        await adapter.disconnect()
      } catch (err) {
        logger.error(__t('apps.social.logs', '社交适配器 {0} 停止失败: {1}', [platform, err]))
      }
    }
  }

  // ── 核心消息处理 ──

  /**
   * 处理入站消息
   *
   * 流程: adapter → 路由归属 → 激活策略 → 持久化 → SessionManager 缓冲 → flush → generateReply
   */
  private handleInbound(inbound: InboundMessage, committed?: () => void): Promise<void> {
    const normalized = this.getAdapter(inbound.platform)?.normalizeInbound(inbound) ?? inbound
    return withSocialScope(normalized, () => this.handleNormalizedInbound(normalized, committed))
  }

  private async handleNormalizedInbound(
    inbound: InboundMessage,
    committed?: () => void,
  ): Promise<void> {
    if (!this.running) {
      if (committed) throw new Error('SOCIAL_INBOUND_UNAVAILABLE')
      return
    }

    const { channelId, channelType, senderName, platform, content } = inbound
    logger.info(
      __t('apps.social.logs', '[{0}] 入站: channel={1}({2}), ', [
        platform,
        channelId,
        channelType,
      ]) + `from=${senderName}, "${content.slice(0, 50)}..."`,
    )

    // 第七阶段 #7: 入站路由表查询，覆盖 agentId
    // 根据 (source, identifier) 查询 inbound_routes 表决定归属 Agent
    // 未命中时保持 inbound.agentId（由 adapter 设置的默认值）
    if (this.deps.inboundRouteRepo) {
      const routeSource = `${platform}_${channelType}`
      const resolved = await this.deps.inboundRouteRepo.resolve(routeSource, channelId)
      if (resolved) {
        inbound.agentId = resolved.agentId
        logger.info(
          __t('apps.social.logs', '入站路由命中: {0}/{1} → agent={2}', [
            routeSource,
            channelId,
            resolved.agentId,
          ]),
        )
        // 外部平台私聊与群聊统一使用 social，具体会话形态由 channelType 区分。
        inbound.routeChannel = 'social'
        inbound.routeThreadId = resolved.threadId ?? undefined
      }
    }

    if (this.deps.shouldAcceptInbound && !this.deps.shouldAcceptInbound(inbound)) {
      committed?.()
      logger.debug(
        __t('apps.social.logs', '入站消息被社交激活策略忽略: agent={0}, channel={1}, sender={2}', [
          inbound.agentId,
          channelId,
          inbound.senderId,
        ]),
      )
      return
    }

    const raw = this.getAdapter(inbound.platform)?.serializeInbound(inbound) ?? {}
    inbound = this.getAdapter(inbound.platform)?.normalizeInbound(inbound) ?? inbound
    const accountId = inbound.accountId ?? ''
    const msgId = inbound.messageId || randomUUID()
    inbound.messageId = msgId
    if (!accountId) throw new Error('SOCIAL_ACCOUNT_REQUIRED')
    if (
      Boolean(inbound.messageId) &&
      (await this.deps.socialMessageRepo.getByMsgId(inbound.agentId, msgId, accountId, inbound))
    ) {
      committed?.()
      await this.refillInbox(inbound.agentId)
      return
    }
    inbound.rawEvent = { ...raw, _infosInbound: { ...inbound, rawEvent: undefined } }
    await this.deps.loopGuard?.observe(inbound)
    const observed = this.sessionManager.getOrCreate(inbound)
    this.sessionManager.checkActiveExpiry(observed)
    const queueForReply =
      channelType === 'private' ||
      inbound.isMentioned === true ||
      observed.participation === 'engaged'
    const continuationOnly = channelType === 'group' && !inbound.isMentioned
    // 入站正文与待处理标识在同一事务提交，进程退出后仍能恢复明确请求。
    try {
      await this.deps.socialMessageRepo.insert({
        msgId,
        platform,
        accountId,
        queueForReply,
        channelId,
        channelType,
        senderId: inbound.senderId,
        senderName,
        content,
        agentId: inbound.agentId,
        rawEventJson: JSON.stringify({
          ...(inbound.rawEvent as Record<string, unknown>),
          _infosQueuedForReply: queueForReply,
          _infosContinuation: continuationOnly,
          _infosInbound: {
            attachments: inbound.attachments,
            replyTo: inbound.replyTo,
            routeThreadId: inbound.routeThreadId,
            isMentioned: inbound.isMentioned,
            senderKind: inbound.senderKind,
            platformBot: inbound.platformBot,
            timestampMs: inbound.timestampMs,
            connectionId: inbound.connectionId,
          },
        }),
        timestamp: inbound.timestampMs ? new Date(inbound.timestampMs).toISOString() : undefined,
      })
    } catch (err) {
      logger.warn(__t('apps.social.logs', '消息持久化失败 (非致命): {0}', [err]))
      throw err
    }

    committed?.()
    if (!this.running) return

    if (this.deps.onMessagePersisted) {
      void this.deps.onMessagePersisted(inbound.agentId).catch((err) => {
        logger.warn(__t('apps.social.logs', '社交消息后置任务触发失败: {0}', [err]))
      })
    }

    // 2. 异步下载图片到本地缓存 (非阻塞)
    if (this.imageCache && inbound.attachments) {
      for (const att of inbound.attachments) {
        if (att.type === 'image' && att.url && !att.localPath) {
          // 异步下载，不阻塞消息处理
          this.imageCache
            .download(att.url)
            .then((localPath) => {
              if (localPath) att.localPath = localPath
            })
            .catch(() => {
              /* 下载失败不影响主流程 */
            })
        }
      }
    }

    // 3. 交给 SessionManager 缓冲处理
    if (!(await this.handleOrchestrationInbound(inbound)) && this.running)
      await this.sessionManager.handleInbound(inbound)

    // 3. 通知前端
    this.notifyFrontend('social_message', {
      platform,
      channelId,
      channelType,
      direction: 'inbound',
      senderName,
      content: content.slice(0, 100),
    })
  }

  /**
   * 将附件转换为 data URL（base64）
   *
   * 优先用已下载的本地路径，否则等待下载完成。
   * 用于多模态 LLM 图片输入。
   */
  private async attachmentToDataUrl(att: Attachment): Promise<string | null> {
    if (!this.imageCache) return null
    try {
      // att.localPath 类型是 string | undefined，download 返回 string | null
      // 用 ?? null 统一为 string | null，避免类型不兼容
      let localPath: string | null = att.localPath ?? null
      if (!localPath && att.url) {
        localPath = await this.imageCache.download(att.url)
      }
      if (localPath) {
        return this.imageCache.readAsDataUrl(localPath)
      }
    } catch {
      // 单张图片失败不影响其他图片
    }
    return null
  }

  /** 只读取当前账号、当前会话的图片；按消息标识保留来源并限制每轮图片数量。 */
  private async collectImageContext(
    messages: InboundMessage[],
    trigger: InboundMessage,
    accountId?: string,
  ): Promise<{ images: string[]; sources: string[]; context: string }> {
    const signal = currentSocialRecovery()?.signal
    const candidates = [trigger]
    const context: string[] = []
    if (trigger.replyTo && accountId) {
      try {
        const row = await this.deps.socialMessageRepo.getByMsgId(
          trigger.agentId,
          trigger.replyTo,
          accountId,
        )
        const stored =
          row &&
          row.platform === trigger.platform &&
          row.accountId === accountId &&
          row.channelId === trigger.channelId &&
          row.channelType === trigger.channelType
            ? this.restoreStoredMessage(row)
            : null
        const reference =
          stored ??
          (await this.getAdapter(trigger.platform)?.getMessage?.(
            trigger.replyTo,
            trigger.channelId,
            trigger.channelType,
            accountId,
            signal,
          ))
        if (reference) {
          candidates.push(reference)
          const excerpt = { ...reference, content: reference.content.slice(0, 4000) }
          context.push(
            `引用原消息：${formatSocialMessage(excerpt, this.deps.getOwnerId?.(trigger.platform), (id) => this.deps.loopGuard?.isBotAccount(id) ?? false)}`,
          )
        } else {
          context.push(`引用消息 ${trigger.replyTo} 暂不可读取，不要推测其内容。`)
        }
      } catch (error) {
        signal?.throwIfAborted()
        logger.warn(
          __t('apps.social.logs', '引用消息读取失败：{0}', [
            error instanceof Error ? error.message : String(error),
          ]),
        )
        context.push(`引用消息 ${trigger.replyTo} 读取失败，不要推测其内容。`)
      }
    }
    const sameSender = [...messages]
      .reverse()
      .filter((message) => message !== trigger && message.senderId === trigger.senderId)
    candidates.push(...sameSender)

    // 支持先发图再单独提及，补图仅看同一发送者最近两分钟内的消息。
    if (
      accountId &&
      !candidates.some((message) => message.attachments?.some((item) => item.type === 'image'))
    ) {
      try {
        const rows = await this.deps.socialMessageRepo.getRecent(
          trigger.agentId,
          trigger.channelId,
          trigger.channelType,
          20,
        )
        const triggerTime = trigger.timestampMs || Date.now()
        const recent = [...rows].sort(
          (a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? ''),
        )
        for (const row of recent) {
          const time = Date.parse(row.timestamp ?? '')
          if (
            row.accountId === accountId &&
            row.platform === trigger.platform &&
            row.senderId === trigger.senderId &&
            time <= triggerTime &&
            time >= triggerTime - 120_000
          ) {
            candidates.push(this.restoreStoredMessage(row))
          }
        }
      } catch (error) {
        signal?.throwIfAborted()
        logger.debug(__t('apps.social.logs', '近期图片上下文读取失败：{0}', [String(error)]))
      }
    }

    const seen = new Set<string>()
    const selected: Array<{ attachment: Attachment; source: string }> = []
    for (const message of candidates) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.type !== 'image') continue
        const key = attachment.url || attachment.localPath
        if (!key || seen.has(key)) continue
        seen.add(key)
        selected.push({
          attachment,
          source: `消息 ${socialMessageId(message) || '当前'}，发送者 ${JSON.stringify(message.senderName)}（账号:${message.senderId}）`,
        })
        if (selected.length >= 3) break
      }
      if (selected.length >= 3) break
    }
    const loaded = await Promise.all(
      selected.map(async (item) => ({
        ...item,
        image: await this.attachmentToDataUrl(item.attachment),
      })),
    )
    signal?.throwIfAborted()
    const images: string[] = []
    const sources: string[] = []
    for (const item of loaded) {
      if (item.image) {
        images.push(item.image)
        sources.push(item.source)
      } else {
        context.push(`${item.source} 的图片未能读取，不要声称已经看过。`)
      }
    }
    if (images.length)
      logger.info(
        __t('apps.social.logs', '[{0}] 已准备 {1} 张社交图片', [trigger.channelId, images.length]),
      )
    return { images, sources, context: context.join('\n') }
  }

  /**
   * flush 回调 (SessionManager 缓冲到期时调用)
   */
  private async onFlush(
    session: SocialSession,
    messages: InboundMessage[],
    reason: FlushReason,
    signal: AbortSignal,
  ): Promise<SocialTurnOutcome> {
    return this.executeReply(session, messages, reason, signal)
  }

  /** 主 Agent 委派也进入相同的持久化、取消和发送检查点。 */
  async runCommand(
    id: string,
    agentId: string,
    channelId: string,
    content: string,
    senderId: string,
    platform?: string,
    requestedAccountId?: string,
    signal?: AbortSignal,
    execution?: { executionId: string; processId: string },
  ): Promise<SocialTurnOutcome> {
    if (!this.running) throw new Error('社交应用尚未运行')
    const adapter = platform
      ? this.adapters.get(platform)
      : this.adapters.size === 1
        ? this.adapters.values().next().value
        : undefined
    if (!adapter) throw new Error('SOCIAL_PLATFORM_REQUIRED')
    const accounts = adapter
      .getConnectedAccountIds()
      .filter(
        (account) =>
          adapter.resolveAgentId(account) === agentId &&
          (!requestedAccountId || requestedAccountId === account),
      )
    if (accounts.length !== 1) throw new Error('无法唯一确定发送账号，请检查社交账号连接')
    const message: InboundMessage = {
      platform: adapter.platform,
      accountId: accounts[0],
      messageId: `command:${id}`,
      connectionId: adapter.connectionId,
      agentId,
      channelId,
      channelType: 'group',
      senderId,
      senderName: '主 Agent',
      content,
      isOwner: true,
      rawEvent: { _infosSingleTask: true },
    }
    const session = {
      ...this.sessionManager.getOrCreate(message),
      turnId: `${SOCIAL_DELEGATED_TURN_PREFIX}${createHash('sha256').update(id).digest('hex')}`,
      waitingTurnId: undefined,
      pendingMessages: [],
      inFlightMessages: [message],
    }
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    this.commandControllers.set(session.turnId, { controller, session })
    try {
      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          return await this.executeReply(
            session,
            [message],
            'proactive_review',
            controller.signal,
            execution,
          )
        } catch (error) {
          controller.signal.throwIfAborted()
          if (
            (await this.deps.socialMessageRepo.getTurn(session.turnId))?.status !== 'retrying' ||
            attempt === 2
          )
            throw error
          await socialDelay(30_000 * 2 ** attempt, controller.signal)
        }
      }
      throw new Error('社交委派已结束重试')
    } finally {
      signal?.removeEventListener('abort', cancel)
      this.commandControllers.delete(session.turnId)
    }
  }

  /**
   * 执行 AI 回复
   *
   * 将缓冲消息合并后调用 generateReply 回调，
   * 由 SocialAppRuntime 使用应用自己的 Compiler + LLM 生成回复。
   */
  private readonly replyLanes = new Map<string, Promise<unknown>>()

  private async executeReply(
    session: SocialSession,
    messages: InboundMessage[],
    reason: FlushReason,
    cancellation: AbortSignal,
    execution?: { executionId: string; processId: string },
  ): Promise<SocialTurnOutcome> {
    const key = JSON.stringify([
      session.agentId,
      session.platform,
      session.accountId,
      session.channelType,
      session.channelId,
    ])
    const previous = this.replyLanes.get(key) ?? Promise.resolve()
    const result = previous
      .catch(() => undefined)
      .then(() =>
        withSocialScope(
          {
            platform: messages[0]?.platform ?? session.platform,
            accountId: session.accountId,
            channelType: session.channelType,
            channelId: session.channelId,
          },
          () => this.executeScopedReply(session, messages, reason, cancellation, execution),
        ),
      )
    this.replyLanes.set(key, result)
    try {
      return await result
    } finally {
      if (this.replyLanes.get(key) === result) this.replyLanes.delete(key)
    }
  }

  private async executeScopedReply(
    session: SocialSession,
    messages: InboundMessage[],
    reason: FlushReason,
    cancellation: AbortSignal,
    execution?: { executionId: string; processId: string },
  ): Promise<SocialTurnOutcome> {
    if (messages.length === 0) return { type: 'pass' }
    if (!(await this.deps.socialMessageRepo.memoryAvailable(session.agentId)))
      throw new Error('社交数据正在清理，请先完成数据清理再继续')
    const accountId = messages[0]?.accountId ?? ''
    const identity = messages.map((message) => socialMessageId(message)).filter(Boolean)
    const id = session.turnId ?? `social:${randomUUID()}`
    session.turnId = id
    const stored = await this.deps.socialMessageRepo.getTurn(id)
    if (
      stored &&
      ['completed', 'failed', 'cancelled', 'delivery_unknown'].includes(stored.status)
    ) {
      if (stored.status !== 'completed')
        throw new SocialTurnEndedError(stored.error || '该任务已经结束，未重复执行')
      return stored.outcome === 'reply'
        ? { type: 'reply', content: '', delivered: true }
        : { type: 'pass' }
    }
    if (
      stored &&
      (stored.platform !== messages[0]!.platform ||
        stored.accountId !== accountId ||
        stored.channelId !== session.channelId ||
        stored.channelType !== session.channelType ||
        stored.agentId !== session.agentId)
    )
      throw new Error('SOCIAL_TURN_SCOPE_INVALID')
    const now = new Date().toISOString()
    const triggerMessage = socialTriggerMessage(messages)
    const record: SocialTurnRecord = stored ?? {
      id,
      platform: messages[0]!.platform,
      kind:
        (messages[0]?.rawEvent as Record<string, unknown> | undefined)?._infosSingleTask === true
          ? 'task'
          : getSocialTurnKind({ id }),
      agentId: session.agentId,
      accountId,
      channelType: session.channelType,
      channelId: session.channelId,
      status: 'running' as const,
      startedAt: now,
      deadline: new Date(
        Date.now() +
          (this.scheduler.getConfig().taskTimeoutMinutes * 60_000 || SOCIAL_TURN_DURATION_MS),
      ).toISOString(),
      attempts: 0,
      updatedAt: now,
      sourceMessageIds: identity,
      triggerMessageId: triggerMessage ? socialMessageId(triggerMessage) : undefined,
      checkpoint: { inbound: messages, policy: this.scheduler.getConfig() } as Record<
        string,
        unknown
      >,
    }
    record.kind = getSocialTurnKind(record)
    if (!stored && session.waitingTurnId) {
      const previous = await this.deps.socialMessageRepo.getTurn(session.waitingTurnId)
      if (previous) record.deadline = previous.deadline
    }
    const remaining = Date.parse(record.deadline) - Date.now()
    if (remaining <= 0) {
      await finishSocialTurn(this.deps.socialMessageRepo, record, 'failed', '社交任务已超时')
      throw new Error('社交任务已超时')
    }
    record.attempts++
    record.status = 'running'
    record.error = undefined
    const controller = new AbortController()
    this.turnControllers.set(id, { controller, session })
    const lifetime = AbortSignal.any([
      cancellation,
      controller.signal,
      AbortSignal.timeout(remaining),
    ])
    const run = async (
      kernelSignal?: AbortSignal,
      execution?: { executionId: string; processId: string },
    ) => {
      const dataController = new AbortController()
      const version = await this.deps.socialMessageRepo.getDataVersion(
        record.agentId,
        record.channelType,
        record.channelId,
        record,
      )
      record.checkpoint.deliveryDataVersion ??= version
      const signal = AbortSignal.any([
        lifetime,
        dataController.signal,
        ...(kernelSignal ? [kernelSignal] : []),
      ])
      const dataTimer = setInterval(() => {
        void this.deps.socialMessageRepo
          .getDataVersion(record.agentId, record.channelType, record.channelId, record)
          .then((current) => {
            if (current !== version) dataController.abort(new Error('社交任务已取消：数据已经清理'))
          })
          .catch(() => {
            dataController.abort(new Error('社交任务已取消：无法核验数据版本'))
          })
      }, 2000)
      dataTimer.unref?.()
      const recovery = {
        ...execution,
        record,
        signal,
        save: async () => {
          signal.throwIfAborted()
          record.updatedAt = new Date().toISOString()
          await this.deps.socialMessageRepo.saveTurn(record)
          this.notifyFrontend('social_turn_progress', {
            id,
            channelId: record.channelId,
            status: record.status,
            error: record.error,
            attempts: record.attempts,
          })
        },
      }
      try {
        return await runSocialRecovery(recovery, async () => {
          try {
            await recovery.save()
            if (session.waitingTurnId && session.waitingTurnId !== id) {
              const previous = await this.deps.socialMessageRepo.getTurn(session.waitingTurnId)
              if (previous?.status === 'waiting') {
                if (Date.parse(previous.deadline) <= Date.now()) {
                  await finishSocialTurn(
                    this.deps.socialMessageRepo,
                    previous,
                    'failed',
                    '等待任务已超过期限',
                  )
                  throw new Error('社交任务已超时')
                }
                await finishSocialTurn(this.deps.socialMessageRepo, previous, 'completed')
              }
              session.waitingTurnId = undefined
            }
            let outcome = await this.executeReplyWork(session, messages, reason)
            signal.throwIfAborted()
            if (
              (messages[0]?.rawEvent as Record<string, unknown> | undefined)?._infosSingleTask &&
              outcome.type !== 'reply' &&
              outcome.type !== 'orchestration'
            )
              outcome = { type: 'pass' }
            if (
              outcome.type === 'wait' &&
              (session.waitCount >= 2 || Date.now() - session.collectionStartedAt >= 20_000)
            )
              outcome = { type: 'pass' }
            if (outcome.type === 'defer')
              outcome.schedule ??= this.sessionManager.deferredSchedule(outcome.intent)
            if (outcome.type === 'orchestration') {
              // 推理期间已收集的补充消息也必须交给刚建立的观察或延迟计划。
              for (const pending of session.pendingMessages) {
                if (!notifyOrchestrationInbound(record.checkpoint, pending)) continue
                const messageId = socialMessageId(pending)
                if (messageId)
                  record.sourceMessageIds = [
                    ...new Set([...(record.sourceMessageIds ?? []), messageId]),
                  ]
                session.pendingMessages = session.pendingMessages.filter(
                  (message) => message !== pending,
                )
                break
              }
            }
            record.outcome = outcome.type
            if (record.kind === 'task' && outcome.type !== 'orchestration')
              record.commandResult = {
                sent: outcome.type === 'reply',
                ...(outcome.type === 'reply' ? { content: outcome.content } : {}),
              }
            record.checkpoint.outcome = outcome
            const waiting =
              outcome.type === 'wait' ||
              outcome.type === 'defer' ||
              outcome.type === 'orchestration'
            const uncertain =
              Boolean(record.orchestrationSummary?.stepsUncertain) ||
              record.generationSummary?.tools.some((tool) => tool.status === 'unknown') ||
              Object.values(
                (record.checkpoint.deliveries ?? {}) as Record<string, string>,
              ).includes('sending')
            await finishSocialTurn(
              this.deps.socialMessageRepo,
              record,
              waiting ? 'waiting' : uncertain ? 'delivery_unknown' : 'completed',
              !waiting && uncertain
                ? '部分社交操作的结果尚未确认，请先核验，未自动重放'
                : undefined,
            )
            if (waiting) {
              session.waitingTurnId = id
              if (outcome.type === 'orchestration') {
                const target = this.sessionManager.getOrCreate(messages[0]!)
                target.orchestrationTurnId = id
                target.waitingTurnId = id
                this.scheduleOrchestration(
                  orchestrationWait(record.checkpoint)?.event ? Date.now() : outcome.wakeAt,
                )
              }
            } else
              await this.deps.socialMessageRepo.completeQueuedMessages(
                record.agentId,
                record.accountId,
                record.sourceMessageIds ?? [],
                record,
              )
            return outcome
          } catch (error) {
            const failure = socialFailure(error)
            const generation = record.checkpoint.generation as
              | { toolStarted?: boolean; retries?: number }
              | undefined
            const deliveries = record.checkpoint.deliveries as Record<string, string> | undefined
            const unknown =
              generation?.toolStarted || Object.values(deliveries ?? {}).includes('sending')
            const retryLimit =
              (record.checkpoint.policy as SocialSchedulerConfig | undefined)?.maxRetries ?? 2
            const retry =
              !signal.aborted &&
              !unknown &&
              failure.retryable &&
              record.attempts + (generation?.retries ?? 0) <= retryLimit
            if (retry) {
              record.status = 'retrying'
              record.error = failure.message
              await recovery.save()
            } else {
              await finishSocialTurn(
                this.deps.socialMessageRepo,
                record,
                unknown ? 'delivery_unknown' : signal.aborted ? 'cancelled' : 'failed',
                failure.message,
              )
              await this.deps.socialMessageRepo.completeQueuedMessages(
                record.agentId,
                record.accountId,
                record.sourceMessageIds ?? [],
                record,
              )
            }
            if (!retry)
              throw new SocialTurnEndedError(
                `${failure.message}；自动恢复已结束，未重复执行操作`,
                error,
              )
            throw error
          }
        })
      } finally {
        clearInterval(dataTimer)
        if (!signal.aborted)
          await this.refillInbox(record.agentId).catch((error) =>
            logger.warn(__t('apps.social.logs', '社交待处理消息补入失败: {0}', [String(error)])),
          )
      }
    }
    try {
      lifetime.throwIfAborted()
      await this.deps.socialMessageRepo.saveTurn(record)
      if (execution) return await run(lifetime, execution)
      try {
        await this.deps.loopGuard?.admit(
          record,
          socialRateGateOptions({
            record,
            signal: lifetime,
            save: async () => {
              lifetime.throwIfAborted()
              const live = await this.deps.socialMessageRepo.getTurn(id)
              lifetime.throwIfAborted()
              if (
                live &&
                ['completed', 'failed', 'cancelled', 'delivery_unknown'].includes(live.status)
              )
                throw new SocialTurnEndedError('该社交任务已结束，未恢复限流等待')
              await this.deps.socialMessageRepo.saveTurn(record)
            },
          }),
        )
      } catch (error) {
        if ((error as { code?: string }).code !== 'SOCIAL_LOOP_BLOCKED') throw error
        await finishSocialTurn(
          this.deps.socialMessageRepo,
          record,
          'cancelled',
          (error as Error).message,
        )
        await this.deps.socialMessageRepo.completeQueuedMessages(
          record.agentId,
          record.accountId,
          record.sourceMessageIds ?? [],
          record,
        )
        logger.info(
          __t('apps.social.logs', '已跳过受保护的机器人回复对象，其他联系人仍可触发交流'),
          {
            turnId: id,
            channelId: record.channelId,
            reason: (error as Error).message,
          },
        )
        return { type: 'pass' }
      }
      lifetime.throwIfAborted()
      await this.deps.socialMessageRepo.saveTurn(record)
      if (!this.deps.executions) return await run()
      return await this.deps.executions.run({
        taskId: id,
        class: 'background',
        priority: session.channelType === 'private' ? 6 : 4,
        resourceKey: `social-session:${JSON.stringify([session.platform, session.agentId, accountId, session.channelType, session.channelId])}`,
        maxDurationMs: remaining,
        signal: lifetime,
        run: ({ signal, executionId, processId }) => run(signal, { executionId, processId }),
      })
    } catch (error) {
      if (record.status === 'running') {
        await finishSocialTurn(
          this.deps.socialMessageRepo,
          record,
          lifetime.aborted ? 'cancelled' : 'failed',
          socialFailure(error).message,
        ).catch(() => {})
        await this.deps.socialMessageRepo.completeQueuedMessages(
          record.agentId,
          record.accountId,
          record.sourceMessageIds ?? [],
          record,
        )
      }
      throw error
    } finally {
      if (this.turnControllers.get(id)?.controller === controller) this.turnControllers.delete(id)
    }
  }

  private async executeReplyWork(
    session: SocialSession,
    messages: InboundMessage[],
    reason: FlushReason,
  ): Promise<SocialTurnOutcome> {
    assertSocialActive()
    if (messages.length === 0) return { type: 'pass' }

    const { channelId, channelType, agentId } = session
    // 外部平台会话始终使用 social；routeThreadId 仅决定上下文复用。
    const firstMsg = messages[0]!
    const routeChannel = 'social'
    const routeThreadId = firstMsg.routeThreadId
    const directMessage = [...messages].reverse().find(isSocialMention)
    const triggerMessage = socialTriggerMessage(messages)!
    const replyTo =
      channelType === 'group' && directMessage
        ? socialMessageId(directMessage) || undefined
        : undefined

    // 构建合并的用户消息
    // 每条消息带上 message_id，供 AI 调用 social_read_image 工具时引用
    const ownerId = this.deps.getOwnerId?.(firstMsg.platform)
    const combined = messages
      .map((message) =>
        formatSocialMessage(
          message,
          ownerId,
          (id) => this.deps.loopGuard?.isBotAccount(id) ?? false,
        ),
      )
      .join('\n')

    // 提取触发者 senderId（用于跨会话上下文注入）
    // 群聊场景：取最后一条提及 Bot 的消息发送者
    // 私聊场景：取唯一发送者（虽然私聊不需要跨会话补充，但统一传递由 generateReply 判断）
    const triggerSenderId = triggerMessage.senderId
    const isOwner = Boolean(ownerId && triggerSenderId === ownerId)

    // 提取本次 flush 消息的 msgId 列表（用于从 DB 历史中排除，避免重复）
    // handleInbound 已将这些消息持久化到 DB，如果不排除，combinedMessage 会在 messages 中出现两次
    const flushMsgIds = messages.map((m) => socialMessageId(m)).filter((id) => id.length > 0)

    // ── 获取 Bot 自身信息（平台账号 + 昵称），注入到上下文让 Agent 知道自己是谁 ──
    const platform = messages[0]!.platform
    const adapter = this.getAdapter(platform)
    // 使用本批消息的规范账号标识，不能拿适配器默认账号管理另一账号的收藏。
    const sourceAccounts = [
      ...new Set(messages.map((message) => message.accountId ?? '').filter(Boolean)),
    ]
    if (
      sourceAccounts.length !== 1 ||
      messages.some(
        (message) =>
          message.platform !== platform ||
          message.channelId !== channelId ||
          message.channelType !== channelType,
      )
    )
      throw new Error('社交消息批次混入多个账号，已阻止跨账号发送')
    let botSelfId: string | undefined = sourceAccounts[0]
    let botNickname: string | undefined
    if (adapter) {
      try {
        const status = await adapter.getStatus()
        const acct = status.accountInfo as Record<string, unknown> | undefined
        if (acct) {
          if (!botSelfId && adapter.getConnectedAccountIds().length === 1)
            botSelfId = acct.id != null ? String(acct.id) : undefined
          if (String(acct.id ?? '') === botSelfId)
            botNickname = acct.name != null ? String(acct.name) : undefined
        }
      } catch {
        // 获取 Bot 信息失败不影响主流程
      }
    }

    const imageContext = await this.collectImageContext(messages, triggerMessage, botSelfId)

    try {
      const recovery = currentSocialRecovery()
      const outcome =
        (recovery?.record.checkpoint.outcome as SocialTurnOutcome | undefined) ??
        (await this.deps.generateReply({
          platform,
          signal: recovery?.signal,
          taskOrigin:
            channelType === 'private' &&
            messages.at(-1)?.senderId === this.deps.getOwnerId?.(platform) &&
            socialMessageId(messages.at(-1)!)
              ? {
                  platform,
                  accountId: messages.at(-1)?.accountId ?? botSelfId ?? '',
                  channelType: 'private',
                  channelId,
                  senderId: messages.at(-1)!.senderId,
                  messageId: socialMessageId(messages.at(-1)!),
                }
              : undefined,
          agentId,
          channelType,
          channelId,
          combinedMessage: [combined, imageContext.context].filter(Boolean).join('\n'),
          trigger: reason,
          participation: session.participation,
          deferredIntent: reason === 'intent_due' ? session.deferredIntent : undefined,
          routeChannel,
          routeThreadId,
          isOwner,
          triggerSenderId,
          triggerSenderName: triggerMessage.senderName,
          triggerMessageId: socialMessageId(triggerMessage),
          triggerMessageContent: triggerMessage.content,
          flushMsgIds: flushMsgIds.length > 0 ? flushMsgIds : undefined,
          images: imageContext.images,
          imageSources: imageContext.sources,
          botSelfId,
          botNickname,
        }))

      assertSocialActive()
      if (recovery) {
        recovery.record.checkpoint.outcome = outcome
        await recovery.save()
      }
      if (outcome.type !== 'reply') return outcome
      // 状态卡片等工具已经投递，仍按已回复推进会话，避免重复发送或记为放弃。
      if (outcome.delivered) return outcome
      if (this.deps.shouldAllowSession && !this.deps.shouldAllowSession(session)) {
        logger.info(
          __t('apps.social.logs', '[{0}] 社交激活策略已变化，丢弃尚未发送的回复', [channelId]),
        )
        return { type: 'pass' }
      }
      const reply = outcome.content.trim()
      if (!reply) throw new Error('角色 Agent 返回了空回复')

      // 保留原始换行与标点，仅在表情包标记处保留必要的媒体顺序。
      const segments = splitStickerSegments(reply)
      const delivered: string[] = []

      for (let index = 0; index < segments.length; index++) {
        assertSocialActive()
        if (recovery) recovery.record.checkpoint.deliveryCursor = index
        const segment = segments[index]!
        if (segment.type === 'text') {
          await this.sendReply(platform, {
            accountId: botSelfId,
            channelId,
            channelType,
            content: segment.content,
            // 混合媒体回复仅在首条文字中引用，避免重复引用同一消息。
            replyTo: delivered.length === 0 ? replyTo : undefined,
          })
          delivered.push(segment.content)
        } else if (segment.type === 'native_emoji') {
          if (!botSelfId || !this.deps.resolveNativeEmoji) throw new Error('原生表情服务未就绪')
          const attachment = await this.deps.resolveNativeEmoji(
            { platform, agentId, accountId: botSelfId, channelId, channelType },
            segment.reference,
          )
          await this.sendReply(
            platform,
            {
              accountId: botSelfId,
              channelId,
              channelType,
              content: '',
              attachments: [attachment],
            },
            undefined,
            undefined,
            `[native_emoji:${segment.reference}]`,
          )
          delivered.push(`[native_emoji:${segment.reference}]`)
        } else {
          let attachment: Attachment
          try {
            const stickers = this.stickersFor(platform)
            if (!stickers || !botSelfId) throw new Error('当前账号没有收藏表情服务')
            attachment = await stickers.resolve(botSelfId, segment.stickerId)
          } catch (error) {
            logger.warn(
              __t('apps.social.logs', '表情未发送：{0}', [
                error instanceof Error ? error.message : String(error),
              ]),
            )
            continue
          }
          await this.sendReply(platform, {
            accountId: botSelfId,
            channelId,
            channelType,
            content: '',
            attachments: [attachment],
          })
          delivered.push(`[sticker:${segment.stickerId}]`)
        }
      }

      if (!delivered.length) return { type: 'pass' }
      const deliveredReply = delivered.join('\n')

      try {
        await this.deps.socialMessageRepo.insert({
          msgId: `agent_${Date.now()}`,
          turnId: recovery?.record.id,
          platform,
          accountId: botSelfId,
          channelId,
          channelType,
          senderId: 'self',
          senderName: agentId,
          content: deliveredReply,
          agentId,
        })
      } catch (error) {
        logger.warn(__t('apps.social.logs', 'Agent 回复持久化失败 (非致命): {0}', [error]))
      }

      this.notifyFrontend('social_message', {
        platform,
        channelId,
        direction: 'outbound',
        content: deliveredReply.slice(0, 100),
      })
      return { type: 'reply', content: deliveredReply }
    } catch (error) {
      logger.error(__t('apps.social.logs', '回复生成或发送失败: {0}', [error]))
      throw error
    }
  }

  /**
   * 发送回复到指定平台
   */
  async sendReply(
    platform: string,
    msg: OutboundMessage,
    signal?: AbortSignal,
    deliveryKey?: string,
    historyContent?: string,
  ): Promise<SocialDeliveryReceipt> {
    assertSocialActive()
    const recovery = currentSocialRecovery()
    signal ??= recovery?.signal
    signal?.throwIfAborted()
    if (!msg.accountId && recovery?.record.accountId)
      msg = { ...msg, accountId: recovery.record.accountId }
    msg = { ...msg, content: msg.content.replace(/\r\n?/g, '\n').replace(/\n(?:[ \t]*\n)+/g, '\n') }
    const adapter = this.adapters.get(platform)
    if (!adapter) {
      throw new Error(`社交适配器 ${platform} 未连接，无法发送到 ${msg.channelId}`)
    }
    if (recovery?.record.platform && recovery.record.platform !== platform)
      throw Object.assign(new Error('SOCIAL_TURN_SCOPE_INVALID'), { code: 'DELIVERY_NOT_SENT' })
    if (!msg.accountId) {
      const accounts = adapter.getConnectedAccountIds()
      if (accounts.length !== 1)
        throw Object.assign(new Error('SOCIAL_ACCOUNT_REQUIRED'), { code: 'DELIVERY_NOT_SENT' })
      msg = { ...msg, accountId: accounts[0] }
    }
    const generation = recovery?.record.checkpoint.generation as
      | { round: number; index: number; pending?: unknown }
      | undefined
    const stage =
      deliveryKey ??
      currentSocialStep() ??
      (generation?.pending
        ? `tool:${generation.round}:${generation.index}`
        : `reply:${recovery?.record.checkpoint.deliveryCursor ?? 0}`)
    const files = msg.attachments?.filter((attachment) => attachment.type === 'file') ?? []
    const media = msg.attachments?.filter((attachment) => attachment.type !== 'file') ?? []
    if (files.length && (msg.content || msg.mentions?.length || media.length || files.length > 1)) {
      // 文件上传与说明是不同的实际消息，分别留回执，避免文件失败后把已发说明再次发送。
      const sent: SocialDeliveryReceipt[] = []
      if (msg.content || msg.mentions?.length || media.length)
        sent.push(
          await this.sendReply(
            platform,
            { ...msg, attachments: media },
            signal,
            `${stage}:caption`,
          ),
        )
      for (const [index, file] of files.entries())
        sent.push(
          await this.sendReply(
            platform,
            { ...msg, content: '', replyTo: undefined, mentions: undefined, attachments: [file] },
            signal,
            `${stage}:file:${index}`,
            historyContent,
          ),
        )
      return {
        sentAt: sent.at(-1)!.sentAt,
        messageId: sent.at(-1)!.messageId,
        platformMessageIds: sent.flatMap(
          (receipt) => receipt.platformMessageIds ?? (receipt.messageId ? [receipt.messageId] : []),
        ),
      }
    }
    const key = `${stage}:${createHash('sha256')
      .update(JSON.stringify([platform, msg]))
      .digest('hex')}`
    const deliveries = (recovery?.record.checkpoint.deliveries ?? {}) as Record<string, string>
    const receipts = (recovery?.record.checkpoint.deliveryReceipts ?? {}) as Record<
      string,
      SocialDeliveryReceipt
    >
    const receipt = receipts[key]
    const persistHistory = async (sent: SocialDeliveryReceipt) => {
      if (!recovery?.record.checkpoint.orchestration) return
      const record = recovery.record
      const content =
        historyContent ??
        [
          msg.content,
          ...(msg.attachments ?? []).map(
            (attachment) =>
              `[${attachment.type === 'image' ? '图片' : attachment.type === 'sticker' ? '表情' : '文件'}] ${attachment.name ?? ''}`,
          ),
        ]
          .filter(Boolean)
          .join('\n')
      const history: Parameters<SocialStoragePort['insert']>[0] = {
        msgId:
          sent.messageId ??
          `social_delivery_${createHash('sha256').update(`${record.id}:${key}`).digest('hex')}`,
        turnId: record.id,
        platform,
        accountId: msg.accountId,
        channelId: msg.channelId,
        channelType: msg.channelType,
        senderId: 'self',
        senderName: record.agentId,
        agentId: record.agentId,
        content,
        timestamp: new Date(sent.sentAt).toISOString(),
        rawEventJson: JSON.stringify({
          _infosDelivery: {
            turnId: record.id,
            stepId: stage,
            receipt: sent,
            replyTo: msg.replyTo,
            mentions: msg.mentions,
            attachments: msg.attachments?.map(({ type, name, mimeType }) => ({
              type,
              name,
              mimeType,
            })),
          },
        }),
      }
      const messages = (record.checkpoint.sentMessages ?? {}) as Record<
        string,
        {
          key: string
          content: string
          sentAt: number
          messageId?: string
          channelId?: string
          channelType?: string
          accountId?: string
        }
      >
      messages[key] = {
        key,
        content,
        sentAt: sent.sentAt,
        messageId: history.msgId,
        channelId: msg.channelId,
        channelType: msg.channelType,
        accountId: msg.accountId,
      }
      record.checkpoint.sentMessages = messages
      const pendingHistory = (record.checkpoint.pendingHistory ?? {}) as Record<
        string,
        typeof history
      >
      pendingHistory[key] = history
      record.checkpoint.pendingHistory = pendingHistory
      if (recovery.signal.aborted) {
        // 取消只阻止后继动作；平台已确认的实际消息仍应入库，不能重新打开执行或复活已清理数据。
        const live = await this.deps.socialMessageRepo.getTurn(record.id)
        const version = await this.deps.socialMessageRepo.getDataVersion(
          record.agentId,
          record.channelType,
          record.channelId,
          record,
        )
        if (!live || version !== record.checkpoint.deliveryDataVersion)
          throw new Error('社交数据已清理，不能补写旧发送记录')
        if (['running', 'retrying', 'waiting'].includes(live.status)) live.status = 'cancelled'
        live.checkpoint.pendingHistory = {
          ...((live.checkpoint.pendingHistory as object) ?? {}),
          [key]: history,
        }
        live.checkpoint.deliveryDataVersion = version
        await this.deps.socialMessageRepo.saveTurn(live)
        await this.deps.socialMessageRepo.insert({ ...history, confirmedDeliveryKey: key })
        delete (live.checkpoint.pendingHistory as Record<string, unknown>)[key]
        await this.deps.socialMessageRepo.saveTurn(live)
      } else {
        await recovery.save()
        await this.deps.socialMessageRepo.insert(history)
      }
      delete pendingHistory[key]
      this.notifyFrontend('social_message', {
        platform,
        channelId: msg.channelId,
        direction: 'outbound',
        content: content.slice(0, 100),
      })
    }
    if (deliveries[key] === 'sent') {
      logger.info(__t('apps.social.logs', '社交消息已确认送达，复用回执而不重复发送'), {
        turnId: recovery?.record.id,
        channelId: msg.channelId,
        stage,
        messageId: receipt?.messageId,
      })
      const sent = receipt ?? { sentAt: Date.parse(recovery?.record.updatedAt ?? '') || Date.now() }
      await persistHistory(sent)
      return sent
    }
    if (deliveries[key] === 'sending') throw new Error('社交消息发送结果无法确认，已停止自动重发')
    const fingerprint = key.slice(key.lastIndexOf(':') + 1)
    if (
      Object.entries(deliveries).some(
        ([existing, state]) => state === 'sending' && existing.endsWith(`:${fingerprint}`),
      )
    )
      throw Object.assign(new Error('相同消息的发送结果尚未确认，已阻止重复发送'), {
        uncertain: true,
      })
    const readiness = await adapter.getSendReadiness(msg)
    if (!readiness.ready)
      throw Object.assign(new Error(readiness.reason ?? 'SOCIAL_ACCOUNT_NOT_CONNECTED'), {
        code: 'DELIVERY_NOT_SENT',
      })
    if (recovery) {
      try {
        await this.deps.loopGuard?.consume(
          recovery.record,
          'sends',
          key,
          socialRateGateOptions(recovery),
        )
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
          code: 'DELIVERY_NOT_SENT',
          rejected: true,
          data: { retryable: false },
        })
      }
    }
    if (recovery) {
      const plan = recovery.record.checkpoint.orchestration as { sends: number } | undefined
      if (plan && plan.sends >= 24)
        throw Object.assign(new Error('本回合的平台发送次数已达到上限'), {
          code: 'DELIVERY_NOT_SENT',
        })
      if (plan) plan.sends++
      deliveries[key] = 'sending'
      recovery.record.checkpoint.deliveries = deliveries
      await recovery.save()
    }
    let sent: SocialDeliveryReceipt
    logger.info(__t('apps.social.logs', '正在发送社交消息'), {
      turnId: recovery?.record.id,
      accountId: msg.accountId,
      channelId: msg.channelId,
      channelType: msg.channelType,
      stage,
      replyTo: msg.replyTo,
      preview: safeModelDiagnostic(msg.content, 240),
      attachments: msg.attachments?.map((item) => item.type) ?? [],
    })
    try {
      sent = (await adapter.sendMessage(
        {
          ...msg,
          deliveryId: createHash('sha256')
            .update(`${recovery?.record.id ?? randomUUID()}:${key}`)
            .digest('hex')
            .slice(0, 24),
        },
        signal,
      )) ?? { sentAt: Date.now() }
    } catch (error) {
      logger.warn(__t('apps.social.logs', '社交消息发送失败'), {
        turnId: recovery?.record.id,
        channelId: msg.channelId,
        stage,
        reason: safeModelDiagnostic(error instanceof Error ? error.message : String(error)),
      })
      if (
        ['DELIVERY_NOT_SENT', 'DELIVERY_REJECTED'].includes(
          (error as { code?: string }).code ?? '',
        ) &&
        recovery
      ) {
        delete deliveries[key]
        const plan = recovery.record.checkpoint.orchestration as { sends: number } | undefined
        if (plan) plan.sends = Math.max(0, plan.sends - 1)
        await this.deps.loopGuard?.releaseSend(recovery.record, key)
        await recovery.save()
      }
      throw error
    }
    if (recovery) {
      deliveries[key] = 'sent'
      receipts[key] = sent
      recovery.record.checkpoint.deliveryReceipts = receipts
      if (!recovery.signal.aborted) await recovery.save()
    }
    // 已确认发送后先落盘，再允许后继步骤；记录失败不可以重发外部消息。
    try {
      await persistHistory(sent)
      if (recovery && !recovery.signal.aborted) await recovery.save()
    } catch (error) {
      throw Object.assign(new Error(`消息已送达，但发送记录尚未保存：${String(error)}`), {
        code: 'DELIVERY_HISTORY_PENDING',
        uncertain: true,
      })
    }
    assertSocialActive()
    signal?.throwIfAborted()
    logger.info(__t('apps.social.logs', '社交消息已送达并保存记录'), {
      turnId: recovery?.record.id,
      platform,
      channelId: msg.channelId,
      stage,
      messageId: sent.messageId,
      platformMessageIds: sent.platformMessageIds,
    })
    return sent
  }

  /** 文字与收藏表情按顺序逐条确认、逐条入库，恢复时使用同一发送标识。 */
  async sendOrchestratedMessage(
    msg: OutboundMessage,
    key: string,
  ): Promise<SocialDeliveryReceipt[]> {
    const recovery = currentSocialRecovery()
    if (!recovery) throw new Error('社交发送缺少持久化回合')
    if (this.deps.shouldAllowSession && !this.deps.shouldAllowSession(recovery.record))
      throw Object.assign(new Error('当前社交会话已关闭'), { code: 'DELIVERY_NOT_SENT' })
    if (msg.replyTo) {
      const inbound = recovery.record.checkpoint.inbound as InboundMessage[] | undefined
      if (!inbound?.some((message) => socialMessageId(message) === msg.replyTo)) {
        const row = await this.deps.socialMessageRepo.getByMsgId(
          recovery.record.agentId,
          msg.replyTo,
          msg.accountId,
        )
        if (
          !row ||
          row.accountId !== msg.accountId ||
          row.channelId !== msg.channelId ||
          row.channelType !== msg.channelType
        )
          throw Object.assign(new Error('引用消息不属于当前账号与会话'), {
            code: 'DELIVERY_NOT_SENT',
          })
      }
    }
    const platform =
      recovery.record.platform ??
      (recovery.record.checkpoint.inbound as InboundMessage[] | undefined)?.[0]?.platform
    if (!platform) throw new Error('SOCIAL_PLATFORM_REQUIRED')
    const receipts: SocialDeliveryReceipt[] = []
    const segments = splitStickerSegments(msg.content)
    if (!segments.length && !msg.attachments?.length)
      throw Object.assign(new Error('消息没有可发送的正文或有效表情引用'), {
        code: 'DELIVERY_NOT_SENT',
      })
    // 所有来源先校验，再执行发送，避免前半段送达后才发现后续引用无效。
    const resolved = new Map<number, Attachment>()
    for (const [index, segment] of segments.entries()) {
      if (segment.type === 'text') continue
      if (!msg.accountId)
        throw Object.assign(new Error('发送表情缺少账号'), { code: 'DELIVERY_NOT_SENT' })
      try {
        if (segment.type === 'native_emoji') {
          if (!this.deps.resolveNativeEmoji) throw new Error('原生表情服务未就绪')
          resolved.set(
            index,
            await this.deps.resolveNativeEmoji(
              {
                platform,
                agentId: recovery.record.agentId,
                accountId: msg.accountId,
                channelId: msg.channelId,
                channelType: msg.channelType,
                signal: recovery.signal,
              },
              segment.reference,
            ),
          )
        } else {
          if (!this.stickersFor(platform)) throw new Error('收藏表情服务未就绪')
          resolved.set(
            index,
            await this.stickersFor(platform)!.resolve(msg.accountId, segment.stickerId),
          )
        }
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
          code: 'DELIVERY_NOT_SENT',
        })
      }
    }
    for (const [index, segment] of segments.entries()) {
      if (segment.type === 'text') {
        receipts.push(
          await this.sendReply(
            platform,
            {
              ...msg,
              content: segment.content,
              replyTo: index === 0 ? msg.replyTo : undefined,
              mentions: index === 0 ? msg.mentions : undefined,
            },
            recovery.signal,
            `${key}:${index}`,
          ),
        )
      } else {
        const attachment = resolved.get(index)!
        receipts.push(
          await this.sendReply(
            platform,
            {
              ...msg,
              content: '',
              attachments: [attachment],
              replyTo: index === 0 ? msg.replyTo : undefined,
              mentions: index === 0 ? msg.mentions : undefined,
            },
            recovery.signal,
            `${key}:${index}`,
            segment.type === 'native_emoji'
              ? `[native_emoji:${segment.reference}]`
              : `[sticker:${segment.stickerId}]`,
          ),
        )
      }
    }
    return receipts
  }

  // ── 状态查询 ──

  /** 获取所有适配器状态 */
  async getAllStatus(): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = []
    for (const [platform, adapter] of this.adapters) {
      try {
        const status = await adapter.getStatus()
        results.push({
          ...status,
          connectionId: adapter.connectionId,
          displayName: adapter.displayName,
          accounts: adapter.getConnectedAccountIds(),
          capabilities: adapter.capabilities,
        })
      } catch {
        results.push({ platform, connected: false, error: __t('apps.social.ui', '获取状态失败') })
      }
    }
    return results
  }

  // ── 前端通知 ──

  private notifyFrontend(action: string, data: Record<string, unknown>): void {
    this.deps.socialEvents.publish(action, data).catch(() => {
      /* 忽略广播错误 */
    })
  }

  // ── 冷启动会话复活 ──

  /**
   * 从 DB 恢复最近活跃的会话到 SessionManager
   *
   * 查询最近活跃频道涉及的角色，只恢复有可靠现场的回合和明确请求。
   * 按原入站账号恢复未完成回合；普通新消息按本群时钟观察，不创建无账号的空会话。
   */
  private async reviveSessionsFromDb(): Promise<void> {
    try {
      const recentChannels = (
        await Promise.all(
          [...this.adapters.keys()].map((platform) =>
            this.deps.socialMessageRepo.getRecentChannelsForPlatform(platform, 20),
          ),
        )
      ).flat()

      const agentIds = new Set(
        [...recentChannels.map((channel) => channel.agentId), this.deps.getAgentId?.()].filter(
          (id): id is string => Boolean(id),
        ),
      )
      for (const agentId of agentIds) {
        for (const record of await this.deps.socialMessageRepo.listRecoverableTurns(agentId)) {
          if (Date.parse(record.deadline) <= Date.now()) {
            await finishSocialTurn(
              this.deps.socialMessageRepo,
              record,
              'failed',
              '进程恢复时任务已超过期限',
            )
            continue
          }
          const saved = record.checkpoint.inbound as InboundMessage[] | undefined
          const inbound = saved?.map(
            (message) => this.getAdapter(message.platform)?.normalizeInbound(message) ?? message,
          )
          if (inbound) record.checkpoint.inbound = inbound
          if (
            !inbound?.length ||
            (!this.deps.shouldAllowSession?.(record) && this.deps.shouldAllowSession)
          ) {
            await finishSocialTurn(this.deps.socialMessageRepo, record, 'cancelled', '原会话已关闭')
            continue
          }
          const session = this.sessionManager.getOrCreate(inbound[0]!)
          if (record.status === 'waiting') {
            const outcome = record.checkpoint.outcome as SocialTurnOutcome | undefined
            session.waitingTurnId = record.id
            const pending = orchestrationWait(record.checkpoint)
            if (pending) {
              session.orchestrationTurnId = record.id
              session.nextScanTime = pending.until
              this.scheduleOrchestration(pending.until)
              continue
            }
            if (
              outcome?.type === 'defer' &&
              outcome.schedule &&
              outcome.schedule.expiresAt > Date.now()
            ) {
              session.deferredIntent = {
                ...outcome.intent,
                ...outcome.schedule,
                sourceMessages: inbound,
              }
              session.nextScanTime = outcome.schedule.notBefore
            } else if (
              outcome?.type === 'wait' &&
              Date.now() - Date.parse(record.startedAt) < 20_000
            ) {
              session.pendingMessages.push(...inbound)
              session.waitCount = 1
              session.collectionStartedAt = Date.parse(record.startedAt)
              session.phase = 'ready'
              void this.sessionManager
                .review(session, 'direct_timeout')
                .catch((error) =>
                  logger.warn(__t('apps.social.logs', '等待任务恢复失败: {0}', [String(error)])),
                )
            } else {
              await finishSocialTurn(
                this.deps.socialMessageRepo,
                record,
                'cancelled',
                '等待窗口已结束',
              )
              await this.deps.socialMessageRepo.completeQueuedMessages(
                agentId,
                record.accountId,
                record.sourceMessageIds ?? [],
                record,
              )
            }
            continue
          }
          if (session.retryMessages?.length) {
            await finishSocialTurn(
              this.deps.socialMessageRepo,
              record,
              'cancelled',
              '已有更新的恢复批次，旧任务不再重放',
            )
            continue
          }
          session.turnId = record.id
          session.retryMessages = inbound
          session.retryCount = Math.max(0, record.attempts - 1)
          session.phase = 'retrying'
          session.nextScanTime = Date.now() + 30_000
        }
        await this.refillInbox(agentId)
      }
      const revivedCount = this.sessionManager.listSessions().length
      if (revivedCount > 0) {
        logger.info(__t('apps.social.logs', '冷启动: 从 DB 恢复了 {0} 个会话', [revivedCount]))
      } else {
        logger.info(__t('apps.social.logs', '冷启动: 无历史会话需要恢复'))
      }
    } catch (err) {
      logger.warn(__t('apps.social.logs', '冷启动会话恢复失败 (非致命): {0}', [err]))
    }
  }

  private async refillInbox(agentId: string): Promise<void> {
    if (!this.running) return
    if (!(await this.deps.socialMessageRepo.memoryAvailable(agentId))) return
    for (const row of await this.deps.socialMessageRepo.queuedMessages(agentId)) {
      const adapter = this.getAdapter(row.platform)
      if (!adapter) continue
      const inbound = restoreSocialMessage(row, (record) => adapter.restoreMessage(record))
      const ownerId = this.deps.getOwnerId?.(row.platform)
      inbound.isOwner = Boolean(ownerId && row.senderId === ownerId)
      if (this.deps.shouldAcceptInbound && !this.deps.shouldAcceptInbound(inbound)) {
        await this.deps.socialMessageRepo.completeQueuedMessages(
          agentId,
          row.accountId,
          [row.msgId],
          row,
        )
        continue
      }
      await this.sessionManager.handleInbound(inbound)
    }
  }

  private scheduleOrchestration(wakeAt: number): void {
    if (!this.running) return
    if (this.planTimer && this.planWakeAt <= wakeAt) return
    // 取最早唤醒；调度扫描仍负责兜底，不为长时间观察保持活跃执行。
    if (this.planTimer) clearTimeout(this.planTimer)
    this.planWakeAt = wakeAt
    this.planTimer = setTimeout(
      () => {
        this.planTimer = undefined
        this.planWakeAt = Infinity
        const agentId = this.deps.getAgentId?.()
        if (agentId)
          void this.resumeOrchestrations(agentId).catch((error) =>
            logger.warn(__t('apps.social.logs', '社交编排恢复失败：{0}', [String(error)])),
          )
      },
      Math.max(20, Math.min(60000, wakeAt - Date.now())),
    )
    this.planTimer.unref?.()
  }

  private async resumeOrchestrations(agentId: string): Promise<void> {
    if (!this.running || this.resumingPlans) return
    this.resumingPlans = true
    let next = Infinity
    try {
      const records = await this.deps.socialMessageRepo.listRecoverableTurns(agentId)
      for (const record of records) {
        const pending = orchestrationWait(record.checkpoint)
        if (record.status !== 'waiting' || !pending) continue
        if (Date.parse(record.deadline) <= Date.now()) continue
        const inbound = record.checkpoint.inbound as InboundMessage[] | undefined
        if (
          !inbound?.length ||
          (this.deps.shouldAllowSession && !this.deps.shouldAllowSession(record))
        ) {
          await this.cancelTurn(record.id)
          continue
        }
        if (!pending.event && Date.now() < pending.until) {
          next = Math.min(next, pending.until)
          continue
        }
        const session = this.sessionManager.getOrCreate(inbound[0]!)
        if (session.phase === 'running' || session.phase === 'retrying') {
          next = Math.min(next, Date.now() + 1000)
          continue
        }
        session.orchestrationTurnId = undefined
        session.waitingTurnId = undefined
        session.turnId = record.id
        session.retryMessages = inbound
        session.phase = 'retrying'
        const claim = new AbortController()
        session.controller = claim
        record.status = 'retrying'
        delete record.checkpoint.outcome
        await this.deps.socialMessageRepo.saveTurn(record)
        claim.signal.throwIfAborted()
        try {
          const rows = await this.deps.socialMessageRepo.getRecent(
            record.agentId,
            record.channelId,
            record.channelType,
            20,
            record,
          )
          const original = new Set(inbound.map(socialMessageId))
          const recent = rows
            .filter(
              (row) =>
                row.accountId === record.accountId &&
                !original.has(row.msgId) &&
                Date.parse(row.timestamp ?? '') >=
                  (pending.startedAt ?? Date.parse(record.startedAt)),
            )
            .slice(-12)
          record.checkpoint.orchestrationContext = recent.map((row) =>
            formatSocialMessage(
              { ...this.restoreStoredMessage(row), content: row.content.slice(0, 1200) },
              this.deps.getOwnerId?.(row.platform),
              (id) => this.deps.loopGuard?.isBotAccount(id) ?? false,
            ),
          )
          // 重启或领取窗口内错过的实时事件，从同账号的新历史中补匹配一次。
          for (const row of recent) {
            if (
              row.senderId === 'self' ||
              !notifyOrchestrationInbound(record.checkpoint, this.restoreStoredMessage(row))
            )
              continue
            record.sourceMessageIds = [...new Set([...(record.sourceMessageIds ?? []), row.msgId])]
            session.pendingMessages = session.pendingMessages.filter(
              (message) => socialMessageId(message) !== row.msgId,
            )
            break
          }
        } catch {
          claim.signal.throwIfAborted()
          record.checkpoint.orchestrationContext = [
            '等待期间的最新消息暂不可读取，请勿假定语境没有变化。',
          ]
        }
        claim.signal.throwIfAborted()
        await this.deps.socialMessageRepo.saveTurn(record)
        claim.signal.throwIfAborted()
        // 不等待模型或网络完成，短延迟计划互不阻塞；同会话仍由 SessionManager 串行。
        void this.sessionManager
          .retry(session)
          .catch((error) =>
            logger.warn(__t('apps.social.logs', '社交编排唤醒失败：{0}', [String(error)])),
          )
      }
    } finally {
      this.resumingPlans = false
      if (Number.isFinite(next)) this.scheduleOrchestration(next)
    }
  }

  private async repairDeliveryHistory(record: SocialTurnRecord): Promise<void> {
    const pending = record.checkpoint.pendingHistory as
      | Record<string, Parameters<SocialStoragePort['insert']>[0]>
      | undefined
    if (!pending || !Object.keys(pending).length) return
    // 已送达消息可以补存，但数据清理的版本围栏仍然有效，绝不再次发送到平台。
    const version = await this.deps.socialMessageRepo.getDataVersion(
      record.agentId,
      record.channelType,
      record.channelId,
      record,
    )
    if (record.checkpoint.deliveryDataVersion !== version) return
    for (const [key, history] of Object.entries(pending)) {
      const live = await this.deps.socialMessageRepo.getTurn(record.id)
      if (!live) return
      if (['running', 'retrying', 'waiting'].includes(live.status)) return
      await this.deps.socialMessageRepo.insert({ ...history, confirmedDeliveryKey: key })
      delete pending[key]
    }
    await this.deps.socialMessageRepo.saveTurn(record)
  }

  private async handleOrchestrationInbound(message: InboundMessage): Promise<boolean> {
    const accountId = message.accountId ?? ''
    for (const record of await this.deps.socialMessageRepo.listRecoverableTurns(message.agentId)) {
      if (
        record.status !== 'waiting' ||
        record.platform !== message.platform ||
        record.accountId !== accountId ||
        record.channelType !== message.channelType ||
        record.channelId !== message.channelId
      )
        continue
      if (!notifyOrchestrationInbound(record.checkpoint, message)) continue
      const id = socialMessageId(message)
      if (id && !record.sourceMessageIds?.includes(id))
        record.sourceMessageIds = [...(record.sourceMessageIds ?? []), id]
      await this.deps.socialMessageRepo.saveTurn(record)
      this.scheduleOrchestration(Date.now())
      return true
    }
    return false
  }

  private restoreStoredMessage(row: SocialMessageRecord): InboundMessage {
    return this.getAdapter(row.platform)?.restoreMessage(row) ?? restoreSocialMessage(row)
  }

  listSessions() {
    return this.sessionManager
      .listSessions()
      .map(({ controller: _controller, flushTimer: _timer, ...session }) => ({
        ...session,
        groupState:
          session.channelType === 'group'
            ? this.getGroupState(
                session.agentId,
                session.accountId,
                session.channelId,
                session.platform,
              )
            : undefined,
      }))
  }

  async listTurns(agentId: string, kind?: SocialTurnKind): Promise<SocialTurnListItem[]> {
    await this.expireWaitingTurns(agentId)
    const records = kind
      ? await this.deps.socialMessageRepo.listRecoverableTurns(agentId, true, kind)
      : await this.deps.socialMessageRepo.listRecoverableTurns(agentId, true)
    const visible = records.filter((record) => !kind || getSocialTurnKind(record) === kind)
    return Promise.all(
      visible.map(async ({ checkpoint, ...record }) => {
        const inbound = checkpoint.inbound as InboundMessage[] | undefined
        let source = socialTriggerMessage(inbound ?? [])
        // 终态恢复现场已清空，从原消息读取有限摘要；旧记录也能展示，不另存聊天正文。
        if (!source) {
          const messages: InboundMessage[] = []
          const sourceIds = record.triggerMessageId
            ? [record.triggerMessageId]
            : (record.sourceMessageIds ?? []).slice(-3)
          for (const id of sourceIds) {
            const message = await this.deps.socialMessageRepo.getByMsgId(
              agentId,
              id,
              record.accountId,
              record,
            )
            if (
              message &&
              message.channelId === record.channelId &&
              message.channelType === record.channelType
            ) {
              messages.push(this.restoreStoredMessage(message))
            }
          }
          source = socialTriggerMessage(messages)
        }
        const terminal = !['running', 'retrying', 'waiting'].includes(record.status)
        const needsAttention =
          ['failed', 'delivery_unknown'].includes(record.status) ||
          Boolean(
            record.orchestrationSummary?.stepsFailed || record.orchestrationSummary?.stepsUncertain,
          )
        const retention = needsAttention ? 7 : 1
        const updatedAt = Date.parse(record.updatedAt)
        return {
          ...record,
          kind: getSocialTurnKind(record),
          sourcePreview: source
            ? {
                senderName: source.senderName.slice(0, 100),
                content:
                  source.content.length > 600 ? `${source.content.slice(0, 600)}…` : source.content,
              }
            : undefined,
          sourceCount: record.sourceMessageIds?.length || inbound?.length || 0,
          displayExpiresAt:
            terminal && Number.isFinite(updatedAt)
              ? new Date(updatedAt + retention * 86_400_000).toISOString()
              : undefined,
        }
      }),
    )
  }
  private async expireWaitingTurns(agentId: string): Promise<void> {
    const records = await this.deps.socialMessageRepo.listRecoverableTurns(agentId)
    for (const record of records) {
      const outcome = record.checkpoint.outcome as SocialTurnOutcome | undefined
      const timedOut = Date.parse(record.deadline) <= Date.now()
      const expired =
        outcome?.type === 'defer' && outcome.schedule && outcome.schedule.expiresAt <= Date.now()
      if (record.status !== 'waiting' || (!timedOut && !expired)) continue
      this.sessionManager.cancel(
        record.agentId,
        record.channelType,
        record.channelId,
        record.accountId,
        record.sourceMessageIds,
        record.platform,
      )
      await finishSocialTurn(
        this.deps.socialMessageRepo,
        record,
        timedOut ? 'failed' : 'cancelled',
        timedOut ? '等待任务已超过期限' : '延后意图已过期',
      )
      await this.deps.socialMessageRepo.completeQueuedMessages(
        record.agentId,
        record.accountId,
        record.sourceMessageIds ?? [],
        record,
      )
    }
  }
  async cancelTurn(id: string): Promise<void> {
    this.turnControllers.get(id)?.controller.abort(new Error('社交任务已取消'))
    this.commandControllers.get(id)?.controller.abort(new Error('社交任务已取消'))
    const record = await this.deps.socialMessageRepo.getTurn(id)
    if (!record || !['running', 'retrying', 'waiting'].includes(record.status)) return
    this.sessionManager.cancel(
      record.agentId,
      record.channelType,
      record.channelId,
      record.accountId,
      record.sourceMessageIds,
      record.platform,
    )
    await finishSocialTurn(
      this.deps.socialMessageRepo,
      record,
      'cancelled',
      '用户取消了本次社交任务',
    )
    await this.deps.socialMessageRepo.completeQueuedMessages(
      record.agentId,
      record.accountId,
      record.sourceMessageIds ?? [],
      record,
    )
  }
  async acknowledgeTurn(id: string, agentId?: string): Promise<void> {
    const record = await this.deps.socialMessageRepo.getTurn(id)
    if (
      !record ||
      (agentId && record.agentId !== agentId) ||
      ['running', 'retrying', 'waiting'].includes(record.status)
    )
      return
    if (record.acknowledgedAt) return
    record.acknowledgedAt = new Date().toISOString()
    await this.deps.socialMessageRepo.saveTurn(record)
  }

  async acknowledgeTurns(agentId: string, ids: string[]): Promise<void> {
    // 只处理用户当时看到的快照，不把请求期间新完成的任务一起标为已阅。
    for (const id of new Set(ids)) await this.acknowledgeTurn(id, agentId)
  }

  async allowLimitedConversation(
    accountId: string,
    channelType: 'private' | 'group',
    channelId: string,
    platform?: string,
  ) {
    const matches = [...this.adapters.values()].filter(
      (adapter) =>
        (!platform || adapter.platform === platform) &&
        adapter.getConnectedAccountIds().includes(accountId),
    )
    if (matches.length !== 1) throw new Error('SOCIAL_PLATFORM_REQUIRED')
    platform = matches[0]!.platform
    const agentId = this.deps.getAgentId?.()
    if (
      !agentId ||
      !this.deps.loopGuard ||
      ![...this.adapters.values()].some((adapter) =>
        adapter.getConnectedAccountIds().includes(accountId),
      )
    )
      throw new Error('所选社交账号未连接，不能重新授权')
    return this.deps.loopGuard.allow({ platform, agentId, accountId, channelType, channelId })
  }

  closeSession(
    agentId: string,
    channelId: string,
    scope?: { platform: string; accountId: string; channelType: string },
  ): boolean {
    const matches = this.sessionManager
      .listSessions()
      .filter(
        (session) =>
          session.agentId === agentId &&
          session.channelId === channelId &&
          (!scope ||
            (session.platform === scope.platform &&
              session.accountId === scope.accountId &&
              session.channelType === scope.channelType)),
      )
    if (matches.length > 1) throw new Error('SOCIAL_SESSION_SCOPE_REQUIRED')
    return matches.length === 1 && this.closeSessionsExcept((session) => session !== matches[0]) > 0
  }

  closeSessionsExcept(predicate: (session: SocialSession) => boolean): number {
    for (const session of this.sessionManager.listSessions())
      if (!predicate(session)) this.cancelSessionRecords(session)
    for (const entry of this.turnControllers.values())
      if (!predicate(entry.session))
        entry.controller.abort(new Error('社交任务已取消：会话策略已变化'))
    for (const entry of this.commandControllers.values())
      if (!predicate(entry.session))
        entry.controller.abort(new Error('社交任务已取消：会话策略已变化'))
    return this.sessionManager.closeSessionsExcept(predicate)
  }
  private cancelSessionRecords(session: SocialSession): void {
    for (const id of new Set([session.turnId, session.waitingTurnId, session.orchestrationTurnId]))
      if (id)
        void this.cancelTurn(id).catch((error) =>
          logger.warn(__t('apps.social.logs', '社交任务取消记录失败: {0}', [String(error)])),
        )
  }

  // ── 社交工具Provider桥接 ──

  /** 检查是否有已注册的活跃适配器 */
  hasActiveAdapter(): boolean {
    return this.adapters.size > 0
  }

  /**
   * 创建 SocialMessagingProvider — 桥接适配器到工具层
   *
   * 将 AbstractSocialAdapter 的方法包装为 SocialMessagingProvider 接口，
   * 供 SocialAppRuntime 注入到社交工具 (socialOps) 使用。
   *
   * 平台与账号从可信现场取得，选择不明确时拒绝默认路由。
   */
  createMessagingProvider(): import('../tools').SocialMessagingProvider | null {
    if (this.adapters.size === 0) return null

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 对象字面量方法需通过闭包引用外层 this
    const bridge = this
    // 有可信现场时按现场路由；只有唯一平台才允许省略选择。
    const select = () => {
      const record = currentSocialRecovery()?.record
      const platform =
        currentSocialScope()?.platform ??
        record?.platform ??
        (record?.checkpoint.inbound as InboundMessage[] | undefined)?.[0]?.platform
      const entry = platform
        ? ([platform, this.adapters.get(platform)] as const)
        : this.adapters.size === 1
          ? this.adapters.entries().next().value
          : undefined
      if (!entry?.[1]) throw new Error('SOCIAL_PLATFORM_REQUIRED')
      return { platform: entry[0], adapter: entry[1] }
    }

    const account = () => {
      const adapter = select().adapter
      const id =
        currentSocialScope()?.accountId ??
        (adapter.getConnectedAccountIds().length === 1
          ? adapter.getConnectedAccountIds()[0]
          : undefined)
      if (!id || !adapter.getConnectedAccountIds().includes(id))
        throw new Error('SOCIAL_ACCOUNT_REQUIRED')
      return id
    }

    return {
      get platform() {
        return bridge.adapters.size === 1 ? select().platform : 'multiple'
      },

      async sendMessage(agentId, target, content, type) {
        const accountId =
          currentSocialScope()?.accountId ??
          (select().adapter.getConnectedAccountIds().length === 1
            ? select().adapter.getConnectedAccountIds()[0]
            : undefined)
        if (!accountId) throw new Error('SOCIAL_ACCOUNT_REQUIRED')
        await bridge.sendReply(select().platform, {
          accountId,
          channelId: target,
          channelType: type,
          content,
        })
        await bridge.deps.socialMessageRepo.insert({
          msgId: `agent_tool_${Date.now()}`,
          turnId: currentSocialRecovery()?.record.id,
          platform: select().platform,
          accountId,
          channelId: target,
          channelType: type,
          senderId: 'self',
          senderName: agentId,
          content,
          agentId,
        })
      },

      async getContacts() {
        return select().adapter.getContacts(account())
      },
      async getGroups() {
        return select().adapter.getGroups(account())
      },
      async getContactInfo(userId) {
        return select().adapter.getContactInfo(userId, account())
      },
      async getGroupInfo(groupId) {
        return select().adapter.getGroupInfo(groupId, account())
      },
      async getGroupMembers(groupId) {
        return select().adapter.getGroupMembers(groupId, account())
      },
      async handleFriendRequest(flag, approve, remark) {
        return select().adapter.handleFriendRequest(flag, approve, remark, account())
      },
      async removeFriend(userId) {
        return select().adapter.removeFriend(userId, account())
      },
      async getForwardMsg(forwardId) {
        return select().adapter.getForwardMsg(forwardId, account())
      },

      async notifyOwner(content, importance) {
        const owner = bridge.deps.getOwnerId?.(select().platform)
        if (!owner) throw new Error('尚未绑定主人账号，无法发送通知')
        const status = await select().adapter.getStatus()
        const accountId = account()
        if (!status.connected || !accountId) throw new Error('社交账号未连接，无法发送通知')
        const destination = await select().adapter.getOwnerDestination(accountId)
        await bridge.sendReply(select().platform, {
          accountId,
          ...destination,
          content,
        })
        bridge.notifyFrontend('social_owner_notification', {
          content,
          importance: importance ?? 'medium',
          platform: select().platform,
        })
      },
    }
  }
}
