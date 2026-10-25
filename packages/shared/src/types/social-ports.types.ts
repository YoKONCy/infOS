/**
 * social-ports.types — 跨包共享协议层
 *
 * 负责定义该模块的稳定入口、数据边界与错误语义。
 * 调用方通过这里访问领域能力，避免绕过校验直接耦合内部状态。
 */
/** 平台账号决定数据分区，会话标识由适配器保证包含主题等子会话范围。 */
export interface SocialStorageScope {
  platform?: string
  accountId?: string
  channelType?: string
  channelId?: string
}

export interface SocialMessageRecord {
  id: number
  msgId: string
  platform: string
  accountId: string
  channelId: string
  channelType: string
  senderId: string
  senderName: string
  content: string
  agentId: string
  rawEventJson: string
  isSummarized: boolean
  timestamp: string | null
}

export interface SocialContactImpressionRecord {
  id: number
  agentId: string
  platform: string
  userId: string
  displayName: string
  identity: string
  impression: string
  sourceChannelId: string | null
  updatedAt: string
}

export interface SocialSyncCursorRecord {
  agentId: string
  platform: string
  accountId: string
  lastSuccessfulSyncAt: number
  syncStartedAt: number | null
  status: string
  lastError: string | null
}

/** 恢复记录归 Social Realm 所有；终态只保留标识与结果，不保留上下文正文。 */
export interface SocialTurnRecord {
  platform?: string
  id: string
  /** 普通社交聊天保留恢复记录，只有明确委派的工作才进入任务中心。 */
  kind?: import('../socialTurnClassification').SocialTurnKind
  agentId: string
  accountId: string
  channelType: 'private' | 'group'
  channelId: string
  status:
    | 'running'
    | 'retrying'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'delivery_unknown'
  startedAt: string
  deadline: string
  attempts: number
  error?: string
  /** 只保留轮次与工具名、动作、状态，不保存参数、正文或图片。 */
  generationSummary?: {
    modelResponses: number
    toolRounds: number
    continuations: number
    closingReason?: string
    toolCalls: number
    tools: Array<{
      round: number
      name: string
      action?: string
      status: 'completed' | 'error' | 'unknown' | 'blocked'
      durationMs: number
    }>
  }
  updatedAt: string
  checkpoint: Record<string, unknown>
  sourceMessageIds?: string[]
  /** 保留触发消息标识，终态清空检查点后仍能准确定位回合来源。 */
  triggerMessageId?: string
  outcome?: 'reply' | 'pass' | 'wait' | 'defer' | 'orchestration'
  /** 主体委派的交付摘要保留到终态，供原任务读取；不复制推理上下文。 */
  commandResult?: { sent: boolean; content?: string }
  /** 不包含正文的编排进度，供前端显示托管与部分失败状态。 */
  orchestrationSummary?: {
    plans: number
    stepsCompleted: number
    stepsFailed: number
    stepsUncertain: number
    stepsSkipped: number
    businessCalls: number
    sends: number
    waitingFor?: string
    wakeAt?: number
    expiresAt?: number
  }
  acknowledgedAt?: string
}

/** 展示摘要按原消息读取，不把聊天正文复制到恢复记录中。 */
export type SocialTurnListItem = Omit<SocialTurnRecord, 'checkpoint'> & {
  sourcePreview?: { senderName: string; content: string }
  sourceCount: number
  /** 仅控制终态记录的默认展示，不影响恢复期限和聊天记录。 */
  displayExpiresAt?: string
}

export interface SocialStoragePort {
  /** 只控制后台炼化，不影响已有社交记忆的读取。 */
  readonly memoryBackground?: import('../memorySettings').MemoryBackgroundPolicy
  getTurn(id: string): Promise<SocialTurnRecord | null>
  saveTurn(record: SocialTurnRecord): Promise<void>
  listRecoverableTurns(
    agentId: string,
    includeTerminal?: boolean,
    kind?: import('../socialTurnClassification').SocialTurnKind,
  ): Promise<SocialTurnRecord[]>
  deleteTurns(
    agentId: string,
    channelType?: string,
    channelId?: string,
    scope?: SocialStorageScope,
  ): Promise<void>
  getDataVersion(
    agentId: string,
    channelType?: string,
    channelId?: string,
    scope?: SocialStorageScope,
  ): Promise<number>
  forgetLongMemory(agentId: string): Promise<void>
  deleteLongMemory(agentId: string): Promise<void>
  memoryAvailable(agentId: string): Promise<boolean>
  queuedMessages(agentId: string): Promise<SocialMessageRecord[]>
  completeQueuedMessages(
    agentId: string,
    accountId: string,
    msgIds: string[],
    scope?: SocialStorageScope,
  ): Promise<void>
  insert(msg: {
    msgId: string
    platform: string
    accountId?: string
    channelId: string
    channelType: string
    senderId: string
    senderName: string
    content: string
    agentId: string
    rawEventJson?: string
    timestamp?: string
    queueForReply?: boolean
    turnId?: string
    /** 仅补存检查点中已确认送达的原消息，存储层须在事务内核验。 */
    confirmedDeliveryKey?: string
  }): Promise<void>
  getRecent(
    agentId: string,
    channelId: string,
    channelType: string,
    limit?: number,
    scope?: SocialStorageScope,
  ): Promise<SocialMessageRecord[]>
  getRecentChannels(
    agentId: string,
    limit?: number,
  ): Promise<
    Array<{
      platform: string
      accountId: string
      channelId: string
      channelType: string
      lastTimestamp: string | null
    }>
  >
  getRecentPrivateBySender(
    agentId: string,
    senderId: string,
    limit?: number,
    scope?: SocialStorageScope,
  ): Promise<SocialMessageRecord[]>
  getRecentBySender(
    agentId: string,
    senderId: string,
    limit?: number,
    scope?: SocialStorageScope,
  ): Promise<SocialMessageRecord[]>
  getByMsgId(
    agentId: string,
    msgId: string,
    accountId?: string,
    scope?: SocialStorageScope,
  ): Promise<SocialMessageRecord | null>
  getRecentGroupsByContact(
    agentId: string,
    userId: string,
    groupLimit?: number,
    scope?: SocialStorageScope,
  ): Promise<string[]>
  getRecentSelfGroupMessages(
    agentId: string,
    groupId: string,
    limit?: number,
    scope?: SocialStorageScope,
  ): Promise<SocialMessageRecord[]>
  getContactGroupMessages(
    agentId: string,
    senderId: string,
    groupId: string,
    limit?: number,
    scope?: SocialStorageScope,
  ): Promise<SocialMessageRecord[]>
  getContactImpression(
    agentId: string,
    platform: string,
    userId: string,
  ): Promise<SocialContactImpressionRecord | null>
  upsertContactImpression(input: {
    turnId?: string
    agentId: string
    platform: string
    userId: string
    displayName?: string
    identity?: string
    impression: string
    sourceChannelId?: string
  }): Promise<void>
  listContactImpressions(agentId: string): Promise<SocialContactImpressionRecord[]>
  countChannelMessages(
    agentId: string,
    channelType: string,
    channelId: string,
    scope?: SocialStorageScope,
  ): Promise<number>
  deleteChannelMessages(
    agentId: string,
    channelType: string,
    channelId: string,
    scope?: SocialStorageScope,
  ): Promise<number>
  deleteAllMessages(agentId: string): Promise<number>
  deleteContactImpression(agentId: string, platform: string, userId: string): Promise<void>
  deleteAllContactImpressions(agentId: string): Promise<number>
  isDeletedByTombstone(input: {
    agentId: string
    platform: string
    accountId: string
    channelType: string
    channelId: string
    timestamp: number
  }): Promise<boolean>
  upsertTombstone(input: {
    agentId: string
    platform: string
    accountId?: string
    channelType?: string
    channelId?: string
    deletedBefore: number
  }): Promise<void>
  getSyncCursor(
    agentId: string,
    platform: string,
    accountId: string,
  ): Promise<SocialSyncCursorRecord | null>
  markSyncStarted(
    agentId: string,
    platform: string,
    accountId: string,
    startedAt: number,
  ): Promise<void>
  markSyncCompleted(
    agentId: string,
    platform: string,
    accountId: string,
    completedThrough: number,
  ): Promise<void>
  markSyncFailed(agentId: string, platform: string, accountId: string, error: string): Promise<void>
  getRecentChannelsForPlatform(
    platform: string,
    limit?: number,
    scope?: { agentId: string; accountId: string },
  ): Promise<Array<{ agentId: string; accountId: string; channelId: string; channelType: string }>>
  getUnsummarizedStats(agentId: string): Promise<{ count: number; totalChars: number }>
  getUnsummarized(agentId: string, limit?: number): Promise<SocialMessageRecord[]>
  markSummarized(messageIds: number[]): Promise<void>
}

export interface SocialExecutionPort {
  run<T>(input: {
    taskId: string
    class: 'background' | 'resident'
    priority?: number
    resourceKey?: string
    maxDurationMs: number
    signal?: AbortSignal
    run(context: {
      signal: AbortSignal
      executionId: string
      processId: string
      consume(usage: Record<string, number>): void
      beginIo(): () => void
    }): Promise<T>
  }): Promise<T>
}

export interface SocialEventPort {
  publish(action: string, data: Record<string, unknown>): Promise<void>
}
