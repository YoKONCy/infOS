import { t as __t } from '../../runtime/i18n'
/**
 * NapCat 适配器 — OneBot v11 WebSocket 客户端 (Layer 3)
 *
 * 这是整个社交系统中**唯一知道 QQ / OneBot 协议**的层。
 * 负责:
 * 1. 连接 NapCat 的 OneBot v11 反向 WebSocket
 * 2. 接收 WS 事件 → 解析为 InboundMessage → emit('message')
 * 3. 接收 OutboundMessage → 转为 OneBot API → 通过 WS 发出
 * 4. 好友请求自动处理 (平台特有逻辑)
 *
 * 兼容两种模式: 当作为 WS Server 时由 socialRouter 注入连接。
 *
 * @module packages/apps/social/adapters/napcat/napcatAdapter
 */

import { v4 as uuidv4 } from 'uuid'
import { currentSocialRecovery } from '../../runtime/socialRecovery'
import { AbstractSocialAdapter } from '../ISocialAdapter'
import { NapcatOperations, socialImageData } from './napcatOperations'
import { NapcatStickers } from './napcatStickers'
import { StickerService } from '../../runtime/stickerService'
import { NativeEmojiService } from './nativeEmoji'
import type { SocialOperationDependencies } from '../../runtime/socialOperations'
import type { SocialMessageRecord, SocialStoragePort } from '@infos/shared'
import type {
  OutboundMessage,
  InboundMessage,
  AdapterStatus,
  SocialHistoryMessageRecord,
} from '../../runtime/types'
import type { OneBotMessageEvent, OneBotSegment } from './napcatParser'
import {
  cleanCQCodes,
  extractAttachments,
  extractReplyId,
  checkIsMentioned,
  toOneBotSegments,
  buildSendParams,
  segmentsToCQString,
} from './napcatParser'
import { createLogger } from '@infos/backend/applicationHostAbi'

const logger = createLogger('NapcatAdapter')

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────

/** NapCat 适配器配置 */
export interface NapcatConfig {
  legacyConfiguration?: boolean
  connectionId?: string
  /** 单实例 Social 当前绑定的 Agent ID */
  defaultAgentId: string
  /** 好友请求自动接受 */
  autoAcceptFriend?: boolean
  /**
   * 主人的 QQ 号（可选）
   *
   * 用于权限识别：入站消息的 senderId 与此值比对，
   * 命中时 InboundMessage.isOwner = true。
   * 由 SocialAppRuntime 从 social 配置读取并注入。
   */
  ownerQq?: string
}

// ─────────────────────────────────────────────
// WebSocket 发送接口 (解耦 WebSocket 实现)
// ─────────────────────────────────────────────

/** WS 发送接口 — 允许外部注入 WebSocket 实例 */
export interface WsSender {
  send(data: string): void | Promise<void>
  close(): void
}

// ─────────────────────────────────────────────
// 适配器
// ─────────────────────────────────────────────

export class NapcatAdapter extends AbstractSocialAdapter {
  private accountStickerService?: StickerService
  get legacyConfiguration(): boolean {
    return this.config.legacyConfiguration === true
  }
  get connectionId(): string {
    return this.config.connectionId ?? 'qq'
  }
  get displayName(): string {
    return 'QQ'
  }
  get adapterType(): string {
    return 'napcat'
  }
  mediaHeaders(url: string): Record<string, string> | undefined {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'qq.com' || host.endsWith('.qq.com') || host.endsWith('.qq.com.cn')
      ? { 'User-Agent': 'Mozilla/5.0', Referer: 'https://qq.com' }
      : undefined
  }
  validateOwnerId(ownerId: string): boolean {
    return !ownerId || /^[1-9]\d{4,19}$/.test(ownerId)
  }
  get capabilities(): readonly string[] {
    return ['history', 'message_lookup', 'contacts', 'groups', 'stickers', 'native_emoji']
  }
  promptVariables(): Record<string, unknown> {
    return { owner_qq: this.config.ownerQq || '未配置' }
  }
  getOwnerId(): string | undefined {
    return this.config.ownerQq
  }
  async getOwnerDestination(
    _accountId: string,
  ): Promise<{ channelId: string; channelType: 'private' }> {
    if (!this.config.ownerQq) throw new Error('SOCIAL_OWNER_REQUIRED')
    return { channelId: this.config.ownerQq, channelType: 'private' }
  }
  prepareImage(filePath: string): Promise<string> {
    return socialImageData(filePath)
  }
  setOwnerId(ownerId: string | undefined): void {
    this.setOwnerQq(ownerId)
  }
  configure(config: Record<string, unknown>): void {
    const owner = String(config.ownerId ?? config.ownerQq ?? '').trim()
    this.setOwnerId(/^[1-9]\d{4,19}$/.test(owner) ? owner : undefined)
  }
  normalizeInbound(message: InboundMessage): InboundMessage {
    const raw = message.rawEvent as Record<string, unknown> | undefined
    return {
      ...super.normalizeInbound(message),
      messageId: message.messageId ?? String(raw?.message_id ?? ''),
      accountId: message.accountId ?? String(raw?.self_id ?? ''),
      timestampMs:
        message.timestampMs ?? (Number(raw?.time) > 0 ? Number(raw?.time) * 1000 : undefined),
      isMentioned: message.isMentioned === true || raw?._isMentioned === true,
    }
  }
  getStickerService(): StickerService {
    return (this.accountStickerService ??= new StickerService(
      new NapcatStickers(async (...args) => {
        if (!args[3] || !this.getConnectedAccountIds().includes(args[3]))
          throw new Error('SOCIAL_ACCOUNT_NOT_CONNECTED')
        return this.callApi(...args)
      }),
    ))
  }
  createOperations(deps: SocialOperationDependencies): NapcatOperations {
    return new NapcatOperations({ ...deps, adapter: () => this })
  }
  createNativeEmojiProvider(
    storage: SocialStoragePort,
    config: SocialOperationDependencies['config'],
  ) {
    return new NativeEmojiService(storage, config)
  }
  getWebSocketTransport() {
    return {
      accountHeader: 'x-self-id',
      registerConnection: this.registerConnection.bind(this),
      unregisterConnection: this.unregisterConnection.bind(this),
      handleRawEvent: this.handleRawEvent.bind(this),
    }
  }
  restoreMessage(row: SocialMessageRecord): InboundMessage {
    const message = super.restoreMessage(row)
    const raw = message.rawEvent as Record<string, unknown>
    const segments = Array.isArray(raw.message) ? (raw.message as OneBotSegment[]) : []
    return this.normalizeInbound({
      ...message,
      attachments: message.attachments ?? extractAttachments(segments),
      replyTo: message.replyTo ?? extractReplyId(segments),
      rawEvent: { ...raw, self_id: row.accountId, message_id: row.msgId },
    })
  }
  readonly platform = 'qq'

  private config: NapcatConfig
  /** WS 连接池: selfId → sender */
  private connections = new Map<string, WsSender>()
  /** 默认连接 (无 selfId 时使用) */
  private defaultConnection: WsSender | null = null
  /** Bot 信息缓存 */
  private botInfos = new Map<string, Record<string, unknown>>()
  /** 待响应的 API 请求 */
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (reason: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  constructor(config: NapcatConfig) {
    super()
    this.config = config
    logger.info(
      __t('apps.social.logs', 'NapcatAdapter 已创建, Social Agent: {0}', [config.defaultAgentId]),
    )
  }

  // ── Layer 2 接口实现 ──

  async connect(): Promise<void> {
    // NapCat 使用反向 WS (NapCat 主动连接我们)
    // 实际连接注入由 socialRouter 的 WS 升级端点处理
    logger.info(__t('apps.social.logs', 'NapcatAdapter 等待反向 WS 连接...'))
  }

  async disconnect(): Promise<void> {
    const senders = new Set(this.connections.values())
    if (this.defaultConnection) senders.add(this.defaultConnection)
    this.connections.clear()
    this.defaultConnection = null
    for (const sender of senders) sender.close()
    this.emitDisconnected('手动断开')
  }

  async sendMessage(
    msg: OutboundMessage,
    signal?: AbortSignal,
  ): Promise<import('../../runtime/types').SocialDeliveryReceipt> {
    signal?.throwIfAborted()
    if (!this.getActiveSender(msg.accountId))
      throw Object.assign(new Error('社交账号尚未连接，本次消息尚未发送'), {
        code: 'DELIVERY_NOT_SENT',
        data: { retryable: true },
      })
    const segments = toOneBotSegments(msg.content, msg.attachments)
    for (const qq of [...new Set(msg.mentions ?? [])].reverse()) {
      if (!/^[1-9]\d{4,19}$/.test(qq))
        throw Object.assign(new Error('提及账号格式不正确'), { code: 'DELIVERY_NOT_SENT' })
      segments.unshift({ type: 'at', data: { qq } })
    }
    const params = buildSendParams(msg.channelId, msg.channelType, segments)

    // 如果有回复引用，添加 reply 段
    if (msg.replyTo) {
      ;(params.message as OneBotSegment[]).unshift({
        type: 'reply',
        data: { id: msg.replyTo },
      })
    }

    const ids: string[] = []
    const check = (value: unknown) => {
      const response = value as {
        status?: string
        retcode?: number
        message?: string
        wording?: string
        data?: { message_id?: string | number }
      } | null
      if (response?.status !== 'ok' || response.retcode !== 0)
        throw Object.assign(
          new Error(response?.message || response?.wording || '社交平台拒绝发送'),
          { code: 'DELIVERY_REJECTED' },
        )
      if (response?.data?.message_id !== undefined) ids.push(String(response.data.message_id))
    }
    if (segments.length)
      check(
        await this.callApi(
          'send_msg',
          params,
          msg.attachments?.length ? 90_000 : 10000,
          msg.accountId,
          signal,
        ),
      )
    // 普通文件走上传接口；先发送说明，避免文件已交付后因说明失败而被误判为未发送。
    for (const file of msg.attachments?.filter((item) => item.type === 'file') ?? []) {
      const source = file.localPath || file.url
      if (!source) throw new Error('文件附件缺少来源')
      check(
        await this.callApi(
          msg.channelType === 'group' ? 'upload_group_file' : 'upload_private_file',
          {
            [msg.channelType === 'group' ? 'group_id' : 'user_id']: msg.channelId,
            file: source,
            name: file.name || '文件',
          },
          90_000,
          msg.accountId,
          signal,
        ),
      )
    }
    logger.debug(
      __t('apps.social.logs', '消息已发送: channel={0}, type={1}', [
        msg.channelId,
        msg.channelType,
      ]),
    )
    return { messageId: ids[0], platformMessageIds: ids, sentAt: Date.now() }
  }

  async getStatus(): Promise<AdapterStatus> {
    const connected = this.connections.size > 0 || this.defaultConnection !== null
    let latencyMs = -1

    if (connected) {
      const start = Date.now()
      try {
        const resp = (await this.callApi('get_version_info', {}, 3000)) as Record<
          string,
          unknown
        > | null
        if (resp && resp.status === 'ok') {
          latencyMs = Date.now() - start
        }
      } catch {
        // 超时, 保持 -1
      }
    }

    // 取第一个 Bot 的信息
    const firstBotInfo = this.botInfos.size > 0 ? this.botInfos.values().next().value : undefined

    return {
      connected,
      platform: 'qq',
      latencyMs,
      accountInfo: firstBotInfo
        ? { ...firstBotInfo, id: String(firstBotInfo.user_id), name: firstBotInfo.nickname }
        : undefined,
    }
  }

  getConnectedAccountIds(): string[] {
    const ids = [...this.connections.keys()]
    if (ids.length > 0) return ids
    return [...this.botInfos.keys()]
  }

  resolveAgentId(_accountId: string): string {
    return this.config.defaultAgentId
  }

  setAgentId(agentId: string): void {
    this.config.defaultAgentId = agentId
  }

  async getHistoryPage(input: {
    channelId: string
    channelType: 'private' | 'group'
    accountId: string
    limit: number
    cursor?: string
  }) {
    const messages = await this.getMessageHistory(
      input.channelId,
      input.channelType,
      input.limit,
      input.cursor === undefined ? undefined : Number(input.cursor),
      input.accountId,
    )
    if (messages.length < input.limit) return { messages }
    const sequences = messages.flatMap((message) =>
      message.messageSeq !== undefined ? [message.messageSeq] : [],
    )
    if (!sequences.length) throw new Error('SOCIAL_HISTORY_CURSOR_MISSING')
    return { messages, nextCursor: String(Math.min(...sequences)) }
  }

  async getMessageHistory(
    channelId: string,
    channelType: 'private' | 'group',
    limit: number,
    beforeMessageSeq?: number,
    requestedAccountId?: string,
  ): Promise<Array<SocialHistoryMessageRecord & { messageSeq?: number }>> {
    const action = channelType === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
    const idKey = channelType === 'group' ? 'group_id' : 'user_id'
    const params: Record<string, unknown> = {
      [idKey]: Number(channelId),
      count: limit,
      reverse_order: false,
    }
    if (beforeMessageSeq !== undefined) params.message_seq = beforeMessageSeq
    const resp = (await this.callApi(action, params, 15000, requestedAccountId)) as Record<
      string,
      unknown
    > | null
    // API 失败不能当成空历史，否则补拉任务会错误地推进同步游标。
    if (!resp || resp.status !== 'ok') {
      const reason = resp?.message || resp?.wording || 'NapCat 未返回成功响应'
      throw new Error(`历史消息查询失败（${action}）：${String(reason)}`)
    }
    const data = resp.data as Record<string, unknown> | undefined
    const messages = (
      Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : []
    ) as OneBotMessageEvent[]
    const accountId =
      requestedAccountId || String(messages[0]?.self_id ?? this.getConnectedAccountIds()[0] ?? '')
    return messages
      .map((event) => {
        const messageType = event.message_type === 'group' ? 'group' : 'private'
        const senderId = String(event.user_id ?? event.sender?.user_id ?? '')
        const rawContent = event.message?.length
          ? segmentsToCQString(event.message)
          : (event.raw_message ?? '')
        return {
          msgId: String(event.message_id ?? ''),
          messageSeq:
            Number(event.message_seq ?? event.messageSeq ?? event.msg_seq ?? 0) || undefined,
          accountId,
          channelId: messageType === 'group' ? String(event.group_id ?? channelId) : channelId,
          channelType: messageType,
          senderId: senderId === accountId ? 'self' : senderId,
          senderName: event.sender?.card ?? event.sender?.nickname ?? senderId,
          content: cleanCQCodes(rawContent),
          timestamp: Number(event.time ?? 0),
          rawEvent: event,
        } satisfies SocialHistoryMessageRecord & { messageSeq?: number }
      })
      .filter((message) => message.msgId && message.timestamp > 0)
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  async getMessage(
    messageId: string,
    channelId: string,
    channelType: 'private' | 'group',
    accountId: string,
    signal?: AbortSignal,
  ): Promise<InboundMessage | null> {
    if (!/^-?\d+$/.test(messageId) || !this.getConnectedAccountIds().includes(accountId))
      return null
    const response = (await this.callApi(
      'get_msg',
      { message_id: messageId },
      5000,
      accountId,
      signal,
    )) as { status?: string; data?: OneBotMessageEvent } | null
    const event = response?.data
    if (response?.status !== 'ok' || !event || String(event.message_id) !== messageId) return null
    const senderId = String(event.user_id ?? event.sender?.user_id ?? '')
    if (channelType === 'group') {
      if (event.message_type !== 'group' || String(event.group_id ?? '') !== channelId) return null
    } else if (
      event.message_type !== 'private' ||
      (senderId !== channelId &&
        !(senderId === accountId && String(event.target_id ?? '') === channelId))
    ) {
      return null
    }
    return {
      platform: this.platform,
      messageId,
      accountId,
      connectionId: this.connectionId,
      timestampMs: Number(event.time) * 1000 || undefined,
      agentId: this.config.defaultAgentId,
      channelId,
      channelType,
      senderId: senderId === accountId ? 'self' : senderId,
      senderName: event.sender?.card ?? event.sender?.nickname ?? senderId,
      content: cleanCQCodes(
        event.message?.length ? segmentsToCQString(event.message) : (event.raw_message ?? ''),
      ),
      attachments: extractAttachments(event.message ?? []),
      replyTo: extractReplyId(event.message ?? []),
      rawEvent: { ...event, self_id: accountId },
    }
  }

  // ── 连接管理 (由 socialRouter WS 端点调用) ──

  /**
   * 注入一个反向 WS 连接
   *
   * NapCat 主动连接我们的 WS 端点时调用此方法。
   * selfId 从 `X-Self-ID` header 获取。
   */
  registerConnection(selfId: string | undefined, sender: WsSender): void {
    const previous = selfId ? this.connections.get(String(selfId)) : this.defaultConnection
    if (selfId) {
      this.connections.set(String(selfId), sender)
      logger.info(
        __t('apps.social.logs', '已注册 QQ 连接: {0} → Social Agent {1}', [
          selfId,
          this.config.defaultAgentId,
        ]),
      )
    } else {
      this.defaultConnection = sender
      logger.info(__t('apps.social.logs', '已注册默认 QQ 连接 (无 X-Self-ID)'))
    }
    if (previous && previous !== sender) previous.close()
    this.emitConnected()

    // 异步获取 Bot 自身信息 (昵称、QQ号等)
    this.fetchBotInfo(selfId).catch((err) => {
      logger.warn(__t('apps.social.logs', '获取 Bot 信息失败 (非致命): {0}', [err]))
    })
  }

  /** 获取 Bot 自身信息并缓存 */
  private async fetchBotInfo(selfId?: string): Promise<void> {
    try {
      const resp = (await this.callApi('get_login_info', {}, 5000, selfId)) as Record<
        string,
        unknown
      > | null
      if (resp && resp.status === 'ok') {
        const data = resp.data as Record<string, unknown> | undefined
        if (data) {
          const botId = String(data.user_id ?? selfId ?? '')
          this.botInfos.set(botId, {
            user_id: botId,
            nickname: data.nickname ?? '',
          })
          logger.info(__t('apps.social.logs', 'Bot 信息已获取: {0} ({1})', [data.nickname, botId]))
        }
      }
    } catch {
      // get_login_info 超时/不支持, 使用 selfId 兜底
      if (selfId && !this.botInfos.has(selfId)) {
        this.botInfos.set(selfId, { user_id: selfId })
      }
    }
  }

  /** 获取所有已缓存的 Bot 信息 (供外部使用) */
  getBotInfos(): Map<string, Record<string, unknown>> {
    return this.botInfos
  }

  /**
   * 动态更新主人 QQ 号
   *
   * 由 SocialAppRuntime 在配置变更时调用，无需重启适配器。
   * 传空字符串/undefined 表示取消主人识别。
   */
  setOwnerQq(qq: string | undefined): void {
    this.config.ownerQq = qq || undefined
    logger.info(__t('apps.social.logs', '主人 QQ 已更新: {0}', [this.config.ownerQq ?? '(未配置)']))
  }

  /** 注销连接 */
  unregisterConnection(selfId: string | undefined, sender?: WsSender): void {
    const current = selfId ? this.connections.get(String(selfId)) : this.defaultConnection
    if (sender && current !== sender) return
    if (selfId && this.connections.has(String(selfId))) {
      this.connections.delete(String(selfId))
      logger.info(__t('apps.social.logs', 'QQ 连接已断开: {0}', [selfId]))
    } else if (!selfId && this.defaultConnection) {
      this.defaultConnection = null
      logger.info(__t('apps.social.logs', '默认 QQ 连接已断开'))
    }

    if (this.connections.size === 0 && !this.defaultConnection) {
      this.emitDisconnected('所有连接关闭')
    }
  }

  // ── 原始事件处理 ──

  /**
   * 处理来自 WS 的原始 JSON 文本
   *
   * 由 socialRouter 的 WS onMessage 调用。
   */
  async handleRawEvent(rawData: string): Promise<void> {
    let event: OneBotMessageEvent
    try {
      event = JSON.parse(rawData) as OneBotMessageEvent
    } catch {
      return // 非 JSON, 忽略
    }

    // 处理 API 响应 (echo 字段)
    if (event.echo) {
      const pending = this.pendingRequests.get(event.echo)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(event.echo)
        pending.resolve(event)
      }
      return
    }

    const postType = event.post_type

    // 心跳忽略
    if (postType === 'meta_event') return

    // 消息事件
    if (postType === 'message') {
      await this.handleMessageEvent(event)
      return
    }

    // 好友请求事件
    if (postType === 'request' && event.request_type === 'friend') {
      await this.handleAutoFriendRequest(event)
      return
    }

    // 其他事件暂忽略 (notice 等)
  }

  // ── 私有方法 ──

  /**
   * 处理消息事件 → 转为 InboundMessage → emit
   */
  private async handleMessageEvent(event: OneBotMessageEvent): Promise<void> {
    const msgType = event.message_type
    if (!msgType) return

    // selfId 兜底策略：event.self_id → botInfos 缓存 → connections 注册表
    // 某些 NapCat 版本/配置下 event.self_id 可能缺失，导致 @ 检测失效
    let selfId = String(event.self_id ?? '')
    if (!selfId) {
      // 从已缓存的 Bot 信息中获取（fetchBotInfo 时缓存）
      const botIds = [...this.botInfos.keys()]
      if (botIds.length === 1) {
        selfId = botIds[0]!
        logger.debug(
          __t('apps.social.logs', 'event.self_id 缺失，从 botInfos 兜底获取 selfId={0}', [selfId]),
        )
      } else if (this.connections.size === 1) {
        // 只有一个连接时，直接用该连接的 selfId
        selfId = [...this.connections.keys()][0]!
        logger.debug(
          __t('apps.social.logs', 'event.self_id 缺失，从 connections 兜底获取 selfId={0}', [
            selfId,
          ]),
        )
      }
    }
    const userId = String(event.user_id ?? event.sender?.user_id ?? '')

    // 单实例 Social 的所有入站消息统一归属当前配置角色
    const agentId = this.config.defaultAgentId

    // 忽略自己发的消息
    if (userId === selfId) return

    // 缓存 Bot 信息
    if (selfId && !this.botInfos.has(selfId)) {
      this.botInfos.set(selfId, { user_id: selfId })
      logger.info(__t('apps.social.logs', '检测到 Bot: {0} (Agent: {1})', [selfId, agentId]))
    }

    // 解析字段
    const channelId = msgType === 'group' ? String(event.group_id ?? '') : userId

    const senderName = event.sender?.nickname ?? event.sender?.card ?? `User${userId}`

    const segments = event.message ?? []
    const rawContent = segments.length ? segmentsToCQString(segments) : (event.raw_message ?? '')

    // 清洗 CQ 码
    const cleanedContent = cleanCQCodes(rawContent)

    // 提取附件
    const attachments = extractAttachments(segments)

    // 检测 @
    const isMentioned = checkIsMentioned(segments, selfId)
    if (msgType === 'group') {
      logger.info(
        __t('apps.social.logs', '[群聊] channelId={0}, selfId={1}, ', [
          channelId,
          selfId || '(空)',
        ]) +
          __t('apps.social.logs', 'at段数={0}, ', [
            segments.filter((s) => s.type === 'at').length,
          ]) +
          `isMentioned=${isMentioned}`,
      )
    }

    // 识别是否为主人消息（权限控制核心）
    // 将配置的 ownerQq 与发送者 userId 比对，命中则标记 isOwner=true
    const isOwner = Boolean(this.config.ownerQq) && userId === this.config.ownerQq

    // 构建统一 InboundMessage
    this.emitMessage({
      platform: 'qq',
      channelId,
      channelType: msgType === 'group' ? 'group' : 'private',
      senderId: userId,
      senderName,
      content: cleanedContent,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: extractReplyId(segments),
      agentId,
      isOwner,
      isMentioned,
      rawEvent: {
        ...event,
        self_id: selfId,
        _isMentioned: isMentioned,
        _selfId: selfId,
      },
    })
  }

  /**
   * 处理好友请求 (NapCat 特有)
   */
  private async handleAutoFriendRequest(event: OneBotMessageEvent): Promise<void> {
    if (!this.config.autoAcceptFriend) {
      logger.info(__t('apps.social.logs', '收到好友请求 (未启用自动接受), flag={0}', [event.flag]))
      return
    }

    if (!event.flag) return

    try {
      const response = (await this.callApi(
        'set_friend_add_request',
        {
          flag: event.flag,
          approve: true,
        },
        10000,
        String(event.self_id ?? '') || undefined,
      )) as { status?: string; retcode?: number }
      if (response?.status !== 'ok' || response.retcode !== 0)
        throw new Error('QQ 拒绝了好友申请处理')
      logger.info(__t('apps.social.logs', '已自动接受好友请求: flag={0}', [event.flag]))
    } catch (err) {
      logger.warn(__t('apps.social.logs', '接受好友请求失败: {0}', [err]))
    }
  }

  /**
   * 调用 OneBot v11 API
   *
   * 通过 WS 发送 JSON-RPC 请求并等待 echo 响应。
   */
  async callApi(
    action: string,
    params: Record<string, unknown>,
    timeoutMs = 10000,
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const recovery = currentSocialRecovery()
    signal ??= recovery?.signal
    if (recovery) await recovery.save()
    signal?.throwIfAborted()
    const sender = this.getActiveSender(accountId)
    if (!sender) {
      throw Object.assign(new Error('无可用的 NapCat 连接，请求尚未发送'), {
        code: 'DELIVERY_NOT_SENT',
        data: { retryable: true },
      })
    }

    const echoId = uuidv4()
    const payload = JSON.stringify({ action, params, echo: echoId })

    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        this.pendingRequests.delete(echoId)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason ?? new Error('社交请求已取消'))
      }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const timer = setTimeout(() => {
        cleanup()
        this.pendingRequests.delete(echoId)
        reject(new Error(`NapCat API 调用超时: ${action} (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pendingRequests.set(echoId, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timer,
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      const failed = (error: unknown) => {
        clearTimeout(timer)
        cleanup()
        this.pendingRequests.delete(echoId)
        reject(error)
      }
      try {
        Promise.resolve(sender.send(payload)).catch(failed)
      } catch (error) {
        failed(error)
      }
    })
  }

  /** 获取活跃的 WS 发送器 */
  private getActiveSender(accountId?: string): WsSender | null {
    if (accountId)
      return (
        this.connections.get(accountId) ??
        (this.defaultConnection && this.botInfos.size === 1 && this.botInfos.has(accountId)
          ? this.defaultConnection
          : null)
      )
    if (this.defaultConnection) return this.defaultConnection
    if (this.connections.size > 0) {
      return this.connections.values().next().value ?? null
    }
    return null
  }

  // ── Layer 2 新增: 联系人/群组查询 (OneBot v11 API Bridge) ──

  /** 拉取好友列表，并适配为社交工具层统一的联系人结构。 */
  async getContacts(accountId?: string): Promise<import('../../tools').SocialContact[]> {
    const resp = (await this.callApi('get_friend_list', {}, undefined, accountId)) as Record<
      string,
      unknown
    >
    const data = resp?.data as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(data)) return []

    return data.map((f) => ({
      id: String(f.user_id ?? ''),
      name: String(f.nickname ?? ''),
      remark: f.remark ? String(f.remark) : undefined,
      platform: 'qq',
    }))
  }

  /** 拉取群列表，并把 OneBot 字段归一化为社交工具层使用的群结构。 */
  async getGroups(accountId?: string): Promise<import('../../tools').SocialGroup[]> {
    const resp = (await this.callApi('get_group_list', {}, undefined, accountId)) as Record<
      string,
      unknown
    >
    const data = resp?.data as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(data)) return []

    return data.map((g) => ({
      id: String(g.group_id ?? ''),
      name: String(g.group_name ?? ''),
      memberCount: typeof g.member_count === 'number' ? g.member_count : undefined,
      platform: 'qq',
    }))
  }

  /** 查询单个 QQ 用户资料；OneBot 失败时返回 null，让上层工具自行决定降级展示。 */
  async getContactInfo(
    userId: string,
    accountId?: string,
  ): Promise<import('../../tools').SocialContact | null> {
    try {
      const resp = (await this.callApi(
        'get_stranger_info',
        { user_id: Number(userId) },
        undefined,
        accountId,
      )) as Record<string, unknown>
      const data = resp?.data as Record<string, unknown> | undefined
      if (!data) return null

      return {
        id: String(data.user_id ?? userId),
        name: String(data.nickname ?? ''),
        remark: data.remark ? String(data.remark) : undefined,
        platform: 'qq',
      }
    } catch {
      return null
    }
  }

  /** 查询单个群资料；接口不可用或群不存在时返回 null。 */
  async getGroupInfo(
    groupId: string,
    accountId?: string,
  ): Promise<import('../../tools').SocialGroup | null> {
    try {
      const resp = (await this.callApi(
        'get_group_info',
        { group_id: Number(groupId) },
        undefined,
        accountId,
      )) as Record<string, unknown>
      const data = resp?.data as Record<string, unknown> | undefined
      if (!data) return null

      return {
        id: String(data.group_id ?? groupId),
        name: String(data.group_name ?? ''),
        memberCount: typeof data.member_count === 'number' ? data.member_count : undefined,
        platform: 'qq',
      }
    } catch {
      return null
    }
  }

  /** 拉取群成员列表；OneBot 字段 card 优先作为群名片，nickname 作为兜底名称。 */
  async getGroupMembers(
    groupId: string,
    accountId?: string,
  ): Promise<import('../../tools').SocialContact[]> {
    try {
      const resp = (await this.callApi(
        'get_group_member_list',
        {
          group_id: Number(groupId),
        },
        undefined,
        accountId,
      )) as Record<string, unknown>
      const data = resp?.data as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(data)) return []

      return data.map((m) => ({
        id: String(m.user_id ?? ''),
        name: String(m.card || m.nickname || ''),
        remark: m.card ? String(m.card) : undefined,
        platform: 'qq',
      }))
    } catch {
      return []
    }
  }

  /** 手动处理好友请求，供社交工具或管理界面调用。 */
  async handleFriendRequest(
    flag: string,
    approve: boolean,
    remark?: string,
    accountId?: string,
  ): Promise<void> {
    await this.callApi(
      'set_friend_add_request',
      {
        flag,
        approve,
        ...(remark ? { remark } : {}),
      },
      undefined,
      accountId,
    )
  }

  /** 删除 QQ 好友；这里仅做 OneBot API 转发，不维护额外本地联系人缓存。 */
  async removeFriend(userId: string, accountId?: string): Promise<void> {
    await this.callApi('delete_friend', { user_id: Number(userId) }, undefined, accountId)
  }

  /**
   * 读取转发消息（合并转发）的内容
   *
   * 调用 NapCat 的 get_forward_msg API，返回转发节点列表。
   * 每个节点包含发送者信息和消息内容。
   *
   * 嵌套处理：如果转发内容内部还包含 forward 段，不递归展开，
   * 而是标记 hasNestedForward=true，让 AI 决定是否再次调用本方法读取。
   *
   * @param forwardId 转发消息 ID（resId）
   */
  async getForwardMsg(
    forwardId: string,
    accountId?: string,
  ): Promise<
    Array<{
      senderName: string
      senderId: string
      content: string
      hasNestedForward: boolean
    }>
  > {
    const resp = (await this.callApi(
      'get_forward_msg',
      {
        message_id: forwardId,
      },
      undefined,
      accountId,
    )) as Record<string, unknown>

    // resp.data 类型是 unknown，需先断言为对象再访问 .messages
    const data = resp?.data as Record<string, unknown> | undefined
    const messages = (data?.messages ?? resp?.messages ?? []) as Array<{
      sender?: { user_id?: number | string; nickname?: string; card?: string }
      content?: Array<{ type: string; data: Record<string, unknown> }>
      raw_message?: string
    }>

    return messages.map((msg) => {
      const senderName = msg.sender?.card || msg.sender?.nickname || '未知'
      const senderId = String(msg.sender?.user_id ?? '')

      // 用 cleanCQCodes 清洗内容，同时检测是否有嵌套 forward
      const segments = msg.content ?? []
      let hasNestedForward = false
      for (const seg of segments) {
        if (seg.type === 'forward') {
          hasNestedForward = true
          break
        }
      }

      // 优先从结构化消息段安全重建，避免摘要中的括号截断原始 CQ 清洗。
      const rawContent = segments.length ? segmentsToCQString(segments) : (msg.raw_message ?? '')
      const content = cleanCQCodes(rawContent)

      return { senderName, senderId, content, hasNestedForward }
    })
  }
}
