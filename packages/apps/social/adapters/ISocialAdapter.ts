/**
 * ISocialAdapter — 跨平台社交适配器抽象接口 (Layer 2)
 *
 * 所有平台适配器（NapCat, Discord, Telegram...）都实现此接口。
 * SocialScheduler / SocialBridge 只依赖此接口，不知道具体平台。
 *
 * @module packages/apps/social/adapters/ISocialAdapter
 */

import { EventEmitter } from 'node:events'
import { readFile, stat } from 'node:fs/promises'
import type {
  InboundMessage,
  OutboundMessage,
  InboundEvent,
  AdapterStatus,
  SocialHistoryMessageRecord,
  SocialDeliveryReceipt,
} from '../runtime/types'
import type { SocialContact, SocialGroup } from '../tools'
import type { SocialMessageRecord, SocialStoragePort } from '@infos/shared'
import type {
  SocialOperationDependencies,
  SocialOperationProvider,
} from '../runtime/socialOperations'
import type { StickerService } from '../runtime/stickerService'
import type { NativeEmojiProvider } from '../runtime/nativeEmoji'

// ─────────────────────────────────────────────
// 事件类型映射
// ─────────────────────────────────────────────

/** 适配器事件映射 (类型安全 EventEmitter) */
export interface SocialAdapterEvents {
  /** 收到入站消息 */
  message: [msg: InboundMessage]
  /** 收到平台事件 (好友请求/群变动等) */
  event: [evt: InboundEvent]
  /** 连接成功 */
  connected: []
  /** 连接断开 */
  disconnected: [reason?: string]
  /** 发生错误 */
  error: [err: Error]
}

// ─────────────────────────────────────────────
// 抽象接口
// ─────────────────────────────────────────────

/**
 * 社交平台适配器抽象基类
 *
 * 使用 EventEmitter 实现事件驱动通信。
 * 适配器负责:
 * 1. 管理与平台的连接
 * 2. 将平台特有格式转换为 InboundMessage
 * 3. 将 OutboundMessage 转换为平台特有格式发出
 * 4. 提供联系人/群组查询能力 (供 SocialMessagingProvider 桥接)
 */
export abstract class AbstractSocialAdapter extends EventEmitter {
  private inboundReceiver?: (message: InboundMessage) => Promise<void>
  bindInboundReceiver(receiver?: (message: InboundMessage) => Promise<void>): void {
    this.inboundReceiver = receiver
  }
  /** 返回时已持久化或被激活策略明确忽略，不等待模型生成。 */
  protected async deliverMessage(message: InboundMessage, signal?: AbortSignal): Promise<void> {
    if (!this.inboundReceiver) throw new Error('SOCIAL_INBOUND_UNAVAILABLE')
    signal?.throwIfAborted()
    const receiving = this.inboundReceiver(this.normalizeInbound(message))
    if (!signal) return receiving
    let abort: (() => void) | undefined
    try {
      await Promise.race([
        receiving,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }),
      ])
    } finally {
      if (abort) signal.removeEventListener('abort', abort)
    }
  }
  serializeInbound(message: InboundMessage): Record<string, unknown> {
    const raw = message.rawEvent
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  }
  canObserveGroup(_accountId: string, _channelId: string): boolean {
    return true
  }
  /** 平台在拆分混合媒体之前校验完整正文，拒绝不能直接发送的内部标记。 */
  validateOutbound(_message: OutboundMessage): void {}
  async getSendReadiness(message: OutboundMessage): Promise<{ ready: boolean; reason?: string }> {
    const accounts = this.getConnectedAccountIds()
    return {
      ready:
        (await this.getStatus()).connected &&
        !!message.accountId &&
        (!accounts.length || accounts.includes(message.accountId)),
      reason: 'SOCIAL_ACCOUNT_NOT_CONNECTED',
    }
  }
  async managementSnapshot(): Promise<Record<string, unknown>> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }
  async manage(_action: string, _input: Record<string, unknown>): Promise<Record<string, unknown>> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }
  /** 平台标识 (如 'qq', 'discord') */
  abstract readonly platform: string

  /** 连接实例标识；同一平台的多个实现必须使用不同标识。 */
  get legacyConfiguration(): boolean {
    return false
  }
  get connectionId(): string {
    return this.platform
  }
  get displayName(): string {
    return this.platform
  }
  get adapterType(): string {
    return this.platform
  }
  validateOwnerId(ownerId: string): boolean {
    // eslint-disable-next-line no-control-regex -- 显式拦截控制字符，防止标识或路径混入不可见内容。
    return ownerId.length <= 200 && !/[\u0000-\u001f]/.test(ownerId)
  }
  get capabilities(): readonly string[] {
    return []
  }
  mediaHeaders(_url: string, _accountId?: string): Record<string, string> | undefined {
    return undefined
  }
  normalizeInbound(message: InboundMessage): InboundMessage {
    return {
      ...message,
      platform: this.platform,
      connectionId: this.connectionId,
      isOwner: !!this.getOwnerId() && message.senderId === this.getOwnerId(),
    }
  }
  promptVariables(): Record<string, unknown> {
    return {}
  }
  getOwnerId(): string | undefined {
    return undefined
  }
  async getOwnerDestination(
    _accountId: string,
  ): Promise<{ channelId: string; channelType: 'private' }> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }
  setOwnerId(_ownerId: string | undefined): void {}
  configure(config: Record<string, unknown>): void {
    this.setOwnerId(typeof config.ownerId === 'string' ? config.ownerId : undefined)
  }
  setAgentId(_agentId: string): void {}
  async prepareImage(filePath: string): Promise<string> {
    if ((await stat(filePath)).size > 12 * 1024 * 1024) throw new Error('SOCIAL_IMAGE_TOO_LARGE')
    const bytes = await readFile(filePath)
    if (bytes.length > 12 * 1024 * 1024) throw new Error('SOCIAL_IMAGE_TOO_LARGE')
    return `data:application/octet-stream;base64,${bytes.toString('base64')}`
  }
  getStickerService(): StickerService | undefined {
    return undefined
  }
  createOperations(_deps: SocialOperationDependencies): SocialOperationProvider | undefined {
    return undefined
  }
  createNativeEmojiProvider(
    _storage: SocialStoragePort,
    _config: SocialOperationDependencies['config'],
  ): NativeEmojiProvider | undefined {
    return undefined
  }
  getWebSocketTransport():
    | {
        registerConnection(
          id: string | undefined,
          sender: { send(data: string): void | Promise<void>; close(): void },
        ): void
        unregisterConnection(
          id: string | undefined,
          sender?: { send(data: string): void | Promise<void>; close(): void },
        ): void
        handleRawEvent(data: string): Promise<void>
        accountHeader?: string
      }
    | undefined {
    return undefined
  }

  /** 存量消息的协议解释仍由原平台完成，核心不读取原始协议字段。 */
  restoreMessage(row: SocialMessageRecord): InboundMessage {
    let raw: Record<string, unknown> = {}
    try {
      const value: unknown = JSON.parse(row.rawEventJson || '{}')
      if (value && typeof value === 'object' && !Array.isArray(value))
        raw = value as Record<string, unknown>
    } catch {
      /* 历史原始事件损坏时仍保留规范化文本与身份。 */
    }
    const normalized = raw._infosInbound as Partial<InboundMessage> | undefined
    return {
      ...normalized,
      platform: row.platform,
      connectionId: this.connectionId,
      messageId: row.msgId,
      accountId: row.accountId,
      agentId: row.agentId,
      channelId: row.channelId,
      channelType: row.channelType as 'private' | 'group',
      senderId: row.senderId,
      senderName: row.senderName,
      content: row.content,
      timestampMs: row.timestamp ? Date.parse(row.timestamp) : undefined,
      rawEvent: raw,
    }
  }

  // ━━ 生命周期 ━━

  /** 连接到平台；取消时必须终止握手与重连等待。 */
  abstract connect(signal?: AbortSignal): Promise<void>

  /** 断开连接 */
  abstract disconnect(): Promise<void>

  // ━━ 消息 ━━

  /** 发送消息到指定会话 */
  abstract sendMessage(
    msg: OutboundMessage,
    signal?: AbortSignal,
  ): Promise<SocialDeliveryReceipt | void>

  /** 获取当前连接状态 */
  abstract getStatus(): Promise<AdapterStatus>

  /** 按 ID 读取当前账号、当前会话中的引用消息；不支持的平台返回空。 */
  async getMessage(
    _messageId: string,
    _channelId: string,
    _channelType: 'private' | 'group',
    _accountId: string,
    _signal?: AbortSignal,
  ): Promise<InboundMessage | null> {
    return null
  }

  /** 分页游标由平台解释，核心仅负责检测游标推进与同步时间窗。 */
  async getHistoryPage(_input: {
    channelId: string
    channelType: 'private' | 'group'
    accountId: string
    limit: number
    cursor?: string
  }): Promise<{ messages: SocialHistoryMessageRecord[]; nextCursor?: string }> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  /** 获取已连接的平台账号 ID。 */
  getConnectedAccountIds(): string[] {
    return []
  }

  /** 将平台账号解析为绑定 Agent；未知时返回空。 */
  resolveAgentId(_accountId: string): string | undefined {
    return undefined
  }

  // ━━ 联系人 & 群组查询 (社交工具层使用) ━━

  /** 获取联系人列表 */
  async getContacts(_accountId?: string): Promise<SocialContact[]> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  /** 获取群组列表 */
  async getGroups(_accountId?: string): Promise<SocialGroup[]> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  /** 查询指定用户信息 */
  async getContactInfo(_userId: string, _accountId?: string): Promise<SocialContact | null> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  /** 查询指定群组信息 */
  async getGroupInfo(_groupId: string, _accountId?: string): Promise<SocialGroup | null> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  /** 查询群组成员列表 */
  async getGroupMembers(_groupId: string, _accountId?: string): Promise<SocialContact[]> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  // ━━ 关系管理 ━━

  /** 处理好友请求 */
  async handleFriendRequest(
    _flag: string,
    _approve: boolean,
    _remark?: string,
    _accountId?: string,
  ): Promise<void> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  /** 删除好友 */
  async removeFriend(_userId: string, _accountId?: string): Promise<void> {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  // ━━ 转发消息 ━━

  /**
   * 读取转发消息（合并转发）的内容
   *
   * @param forwardId 平台提供的不透明转发标识
   * @returns 转发消息内容列表，每条含发送者、内容、是否含嵌套转发
   */
  async getForwardMsg(
    _forwardId: string,
    _accountId?: string,
  ): Promise<
    Array<{ senderName: string; senderId: string; content: string; hasNestedForward: boolean }>
  > {
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }

  // ── 类型安全的 emit 辅助 ──

  protected emitMessage(msg: InboundMessage): void {
    this.emit('message', this.normalizeInbound(msg))
  }

  protected emitEvent(evt: InboundEvent): void {
    this.emit('event', evt)
  }

  protected emitError(err: Error): void {
    this.emit('error', err)
  }

  protected emitConnected(): void {
    this.emit('connected')
  }

  protected emitDisconnected(reason?: string): void {
    this.emit('disconnected', reason)
  }
}

export type { InboundMessage, OutboundMessage, InboundEvent, AdapterStatus }
