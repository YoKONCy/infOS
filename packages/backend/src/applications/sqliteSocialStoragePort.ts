import { currentKernelExecution } from '../kernel/executionContext'
import type { KernelOutboxRepository } from '../kernel/kernelOutboxRepository'
import type Database from 'better-sqlite3'
import type { SocialStorageScope, SocialTurnRecord } from '@infos/shared'
import { getSocialTurnKind, SOCIAL_DELEGATED_TURN_PREFIX, type SocialTurnKind } from '@infos/shared'
import type {
  SocialContactImpressionRecord,
  SocialMessageRecord,
  SocialStoragePort,
  SocialSyncCursorRecord,
} from '../applications/socialPorts'

/** Kernel侧Social存储Authority；Social Realm只获得收窄Port。 */
export class SqliteSocialStoragePort implements SocialStoragePort {
  constructor(
    private readonly db: Database.Database,
    private readonly outbox?: KernelOutboxRepository,
    private readonly purgeMemory?: (agentId: string) => Promise<void>,
    readonly memoryBackground?: import('@infos/shared').MemoryBackgroundPolicy,
  ) {}

  async getTurn(id: string): Promise<SocialTurnRecord | null> {
    const row = this.db
      .prepare('SELECT platform,record_json FROM social_turns WHERE id=?')
      .get(id) as { platform: string; record_json: string } | undefined
    if (!row) return null
    const record = JSON.parse(row.record_json) as SocialTurnRecord
    return { ...record, platform: record.platform ?? row.platform, kind: getSocialTurnKind(record) }
  }

  async saveTurn(record: SocialTurnRecord): Promise<void> {
    record.platform ??=
      (record.checkpoint.inbound as Array<{ platform?: string }> | undefined)?.[0]?.platform ?? 'qq'
    const fence = this.db
      .prepare(
        "SELECT max(cleared_at) AS value FROM social_data_fences WHERE agent_id=? AND (channel_type='' OR (channel_type=? AND channel_id=?)) AND (platform='' OR platform=?) AND (account_id='' OR account_id=?)",
      )
      .get(
        record.agentId,
        record.channelType,
        record.channelId,
        record.platform,
        record.accountId,
      ) as { value: number | null }
    if (fence.value !== null && Date.parse(record.startedAt) <= fence.value)
      throw new Error('社交数据已清理，已阻止旧任务回写')
    this.db
      .prepare(
        `INSERT INTO social_turns(id,agent_id,account_id,channel_type,channel_id,status,record_json,updated_at,platform)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json,updated_at=excluded.updated_at`,
      )
      .run(
        record.id,
        record.agentId,
        record.accountId,
        record.channelType,
        record.channelId,
        record.status,
        JSON.stringify({ ...record, kind: getSocialTurnKind(record) }),
        record.updatedAt,
        record.platform,
      )
  }

  async listRecoverableTurns(
    agentId: string,
    includeTerminal = false,
    kind?: SocialTurnKind,
  ): Promise<SocialTurnRecord[]> {
    // 在终态数量限制前筛选分类，避免大量聊天回合挤掉真正的任务。
    const kindFilter = kind
      ? ` AND CASE
      WHEN json_extract(record_json,'$.kind') IN ('conversation','task')
        THEN json_extract(record_json,'$.kind')
      WHEN id GLOB ? THEN 'task' ELSE 'conversation' END = ?`
      : ''
    const args = kind ? [agentId, `${SOCIAL_DELEGATED_TURN_PREFIX}*`, kind] : [agentId]
    const rows = this.db
      .prepare(
        `SELECT platform,record_json FROM social_turns WHERE agent_id=? AND status IN ('running','retrying','waiting')${kindFilter} ORDER BY updated_at DESC`,
      )
      .all(...args) as Array<{ platform: string; record_json: string }>
    if (includeTerminal)
      rows.push(
        ...(this.db
          .prepare(
            `SELECT platform,record_json FROM social_turns WHERE agent_id=? AND status NOT IN ('running','retrying','waiting')${kindFilter} ORDER BY updated_at DESC LIMIT 100`,
          )
          .all(...args) as Array<{ platform: string; record_json: string }>),
      )
    return rows.map((row) => {
      const record = JSON.parse(row.record_json) as SocialTurnRecord
      return {
        ...record,
        platform: record.platform ?? row.platform,
        kind: getSocialTurnKind(record),
      }
    })
  }

  async deleteTurns(
    agentId: string,
    channelType?: string,
    channelId?: string,
    scope?: SocialStorageScope,
  ): Promise<void> {
    this.clearTurnRows(agentId, channelType, channelId, scope)
  }
  private clearTurnRows(
    agentId: string,
    channelType?: string,
    channelId?: string,
    scope?: SocialStorageScope,
  ): void {
    this.db.transaction(() => {
      const id = JSON.stringify([
        agentId,
        scope?.platform ?? '',
        scope?.accountId ?? '',
        channelType ?? '',
        channelId ?? '',
      ])
      this.db
        .prepare(
          `INSERT INTO social_data_fences(id,agent_id,platform,account_id,channel_type,channel_id,version,cleared_at)
        VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET version=version+1,cleared_at=excluded.cleared_at`,
        )
        .run(
          id,
          agentId,
          scope?.platform ?? '',
          scope?.accountId ?? '',
          channelType ?? '',
          channelId ?? '',
          Date.now(),
        )
      const filter = this.scopeFilter(scope)
      const channel = channelType && channelId ? ' AND channel_type=? AND channel_id=?' : ''
      const args = [agentId, ...(channel ? [channelType, channelId] : []), ...filter.args]
      this.db
        .prepare(`DELETE FROM social_inbox WHERE agent_id=?${channel}${filter.sql}`)
        .run(...args)
      this.db
        .prepare(`DELETE FROM social_turns WHERE agent_id=?${channel}${filter.sql}`)
        .run(...args)
    })()
  }
  async getDataVersion(
    agentId: string,
    channelType?: string,
    channelId?: string,
    scope?: SocialStorageScope,
  ): Promise<number> {
    const channel =
      channelType && channelId ? " AND (channel_type='' OR (channel_type=? AND channel_id=?))" : ''
    const filter = this.fenceFilter(scope)
    const row = this.db
      .prepare(
        `SELECT coalesce(sum(version),0) AS value FROM social_data_fences WHERE agent_id=?${channel}${filter.sql}`,
      )
      .get(agentId, ...(channel ? [channelType, channelId] : []), ...filter.args) as {
      value: number
    }
    return row.value
  }
  async queuedMessages(agentId: string): Promise<SocialMessageRecord[]> {
    return this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM social_messages WHERE agent_id=?
      AND EXISTS(SELECT 1 FROM social_inbox i WHERE i.agent_id=social_messages.agent_id AND i.account_id=social_messages.account_id AND i.platform=social_messages.platform AND i.channel_type=social_messages.channel_type AND i.channel_id=social_messages.channel_id AND i.msg_id=social_messages.msg_id)
      AND NOT EXISTS(SELECT 1 FROM social_turns t,json_each(t.record_json,'$.sourceMessageIds') refs
        WHERE t.agent_id=social_messages.agent_id AND t.account_id=social_messages.account_id AND t.platform=social_messages.platform AND t.channel_type=social_messages.channel_type AND t.channel_id=social_messages.channel_id
        AND refs.value=social_messages.msg_id)
      ORDER BY id LIMIT 1000`,
      )
      .all(agentId) as SocialMessageRecord[]
  }
  async completeQueuedMessages(
    agentId: string,
    accountId: string,
    msgIds: string[],
    scope?: SocialStorageScope,
  ): Promise<void> {
    const filter = this.scopeFilter(scope)
    this.db
      .prepare(
        `DELETE FROM social_inbox WHERE agent_id=? AND account_id=? AND msg_id IN (SELECT value FROM json_each(?))${filter.sql}`,
      )
      .run(agentId, accountId, JSON.stringify(msgIds), ...filter.args)
  }
  async forgetLongMemory(agentId: string): Promise<void> {
    this.db.transaction(() => {
      this.clearTurnRows(agentId)
      this.db.prepare('UPDATE social_messages SET is_summarized=1 WHERE agent_id=?').run(agentId)
    })()
  }
  async deleteLongMemory(agentId: string): Promise<void> {
    if (!this.purgeMemory) throw new Error('社交记忆清理服务尚未就绪')
    await this.purgeMemory(agentId)
  }
  async memoryAvailable(agentId: string): Promise<boolean> {
    return !this.db
      .prepare(
        `SELECT 1 FROM privacy_deletions p,json_each(p.metadata_json,'$.agents') agents
      WHERE p.status!='completed' AND (p.kind='social-memory' OR (p.kind='reset-memory' AND json_extract(p.metadata_json,'$.includeSocial')=1))
      AND agents.value=? LIMIT 1`,
      )
      .get(agentId)
  }

  async insert(message: Parameters<SocialStoragePort['insert']>[0]): Promise<void> {
    const transaction = this.db.transaction(() => {
      if (message.confirmedDeliveryKey) this.assertConfirmedDelivery(message)
      else this.assertTurnWritable(message.turnId, message.agentId)
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO social_messages
        (msg_id, platform, account_id, channel_id, channel_type, sender_id, sender_name, content, agent_id, raw_event_json, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')))`,
        )
        .run(
          message.msgId,
          message.platform,
          message.accountId ?? '',
          message.channelId,
          message.channelType,
          message.senderId,
          message.senderName,
          message.content,
          message.agentId,
          message.rawEventJson ?? '{}',
          message.timestamp ?? null,
        )
      const execution = currentKernelExecution()
      if (inserted.changes && message.queueForReply)
        this.db
          .prepare(
            'INSERT OR IGNORE INTO social_inbox(agent_id,platform,account_id,channel_type,channel_id,msg_id) VALUES(?,?,?,?,?,?)',
          )
          .run(
            message.agentId,
            message.platform,
            message.accountId ?? '',
            message.channelType,
            message.channelId,
            message.msgId,
          )
      if (!inserted.changes || !execution || !this.outbox) return
      const event = this.outbox.createEvent({
        protocolVersion: 1,
        type: 'social.message.committed',
        durability: 'durable',
        principalId: execution.principalId,
        processId: execution.processId,
        executionId: execution.executionId,
        correlationId: execution.executionId,
        payload: {
          msgId: message.msgId,
          platform: message.platform,
          channelId: message.channelId,
          channelType: message.channelType,
          agentId: message.agentId,
        },
      })
      const row = this.outbox.toRow(event)
      this.db
        .prepare(
          `INSERT INTO kernel_outbox_events
          (event_id,event_type,durability,principal_id,process_id,execution_id,correlation_id,causation_id,
           object_type,object_id,object_generation,payload_json,occurred_at,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          row.eventId,
          row.eventType,
          row.durability,
          row.principalId,
          row.processId,
          row.executionId,
          row.correlationId,
          row.causationId,
          row.objectType,
          row.objectId,
          row.objectGeneration,
          row.payloadJson,
          row.occurredAt,
          row.status,
        )
    })
    transaction()
  }

  async getRecent(
    agentId: string,
    channelId: string,
    channelType: string,
    limit = 20,
    scope?: SocialStorageScope,
  ) {
    return this.messages(
      `agent_id=? AND channel_id=? AND channel_type=?`,
      [agentId, channelId, channelType],
      limit,
      scope,
    )
  }
  async getRecentPrivateBySender(
    agentId: string,
    senderId: string,
    limit = 10,
    scope?: SocialStorageScope,
  ) {
    return this.messages(
      `agent_id=? AND channel_type='private' AND channel_id IN (SELECT channel_id FROM social_messages WHERE agent_id=? AND channel_type='private' AND sender_id=?${this.scopeFilter(scope).sql})`,
      [agentId, agentId, senderId, ...this.scopeFilter(scope).args],
      limit,
      scope,
    )
  }
  async getRecentBySender(
    agentId: string,
    senderId: string,
    limit = 20,
    scope?: SocialStorageScope,
  ) {
    return this.messages(`agent_id=? AND sender_id=?`, [agentId, senderId], limit, scope)
  }
  async getRecentSelfGroupMessages(
    agentId: string,
    groupId: string,
    limit = 5,
    scope?: SocialStorageScope,
  ) {
    return this.messages(
      `agent_id=? AND channel_type='group' AND channel_id=? AND sender_id='self'`,
      [agentId, groupId],
      limit,
      scope,
    )
  }
  async getContactGroupMessages(
    agentId: string,
    senderId: string,
    groupId: string,
    limit = 30,
    scope?: SocialStorageScope,
  ) {
    return this.messages(
      `agent_id=? AND channel_type='group' AND channel_id=? AND sender_id=?`,
      [agentId, groupId, senderId],
      limit,
      scope,
    )
  }
  async getByMsgId(
    agentId: string,
    msgId: string,
    accountId?: string,
    scope?: SocialStorageScope,
  ): Promise<SocialMessageRecord | null> {
    const filter = this.scopeFilter(scope)
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM social_messages WHERE agent_id=? AND msg_id=?${accountId === undefined ? '' : ' AND account_id=?'}${filter.sql} LIMIT 2`,
      )
      .all(
        agentId,
        msgId,
        ...(accountId === undefined ? [] : [accountId]),
        ...filter.args,
      ) as SocialMessageRecord[]
    if (rows.length > 1) throw new Error('SOCIAL_MESSAGE_SCOPE_REQUIRED')
    return rows[0] ?? null
  }
  async getRecentChannels(agentId: string, limit = 10) {
    return this.db
      .prepare(
        `SELECT platform,account_id AS accountId,channel_id AS channelId,channel_type AS channelType,MAX(timestamp) AS lastTimestamp
      FROM social_messages WHERE agent_id=? GROUP BY platform,account_id,channel_type,channel_id ORDER BY MAX(id) DESC LIMIT ?`,
      )
      .all(agentId, limit) as Array<{
      platform: string
      accountId: string
      channelId: string
      channelType: string
      lastTimestamp: string | null
    }>
  }
  async getRecentGroupsByContact(
    agentId: string,
    userId: string,
    groupLimit = 5,
    scope?: SocialStorageScope,
  ) {
    const filter = this.scopeFilter(scope)
    const rows = this.db
      .prepare(
        `SELECT channel_id AS channelId FROM social_messages
      WHERE agent_id=? AND channel_type='group' AND sender_id=?${filter.sql} ORDER BY id DESC LIMIT ?`,
      )
      .all(agentId, userId, ...filter.args, groupLimit * 20) as Array<{ channelId: string }>
    return [...new Set(rows.map((row) => row.channelId))].slice(0, groupLimit)
  }

  async getContactImpression(agentId: string, platform: string, userId: string) {
    return (
      (this.db
        .prepare(
          `SELECT id, agent_id AS agentId, platform, user_id AS userId, display_name AS displayName,
      identity, impression, source_channel_id AS sourceChannelId, updated_at AS updatedAt
      FROM social_contact_impressions WHERE agent_id=? AND platform=? AND user_id=? LIMIT 1`,
        )
        .get(agentId, platform, userId) as SocialContactImpressionRecord | undefined) ?? null
    )
  }
  async upsertContactImpression(
    input: Parameters<SocialStoragePort['upsertContactImpression']>[0],
  ) {
    const startedAt = this.assertTurnWritable(input.turnId, input.agentId)
    const target = JSON.stringify([input.agentId, input.platform, input.userId])
    const fence = this.db
      .prepare(
        "SELECT json_extract(metadata_json,'$.clearedAt') AS value FROM privacy_deletions WHERE kind='social-contact' AND target_id=?",
      )
      .get(target) as { value: number } | undefined
    if (startedAt !== undefined && fence && startedAt <= fence.value)
      throw new Error('联系人印象已被删除，已阻止旧任务重新写入')
    this.db
      .prepare(
        `INSERT INTO social_contact_impressions
      (agent_id,platform,user_id,display_name,identity,impression,source_channel_id)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent_id,platform,user_id) DO UPDATE SET
      display_name=excluded.display_name, identity=CASE WHEN excluded.identity='' THEN identity ELSE excluded.identity END,
      impression=excluded.impression, source_channel_id=excluded.source_channel_id, updated_at=datetime('now','localtime')`,
      )
      .run(
        input.agentId,
        input.platform,
        input.userId,
        input.displayName ?? '',
        input.identity ?? '',
        input.impression,
        input.sourceChannelId ?? null,
      )
  }
  async listContactImpressions(agentId: string) {
    return this.db
      .prepare(
        `SELECT id, agent_id AS agentId, platform, user_id AS userId, display_name AS displayName,
      identity, impression, source_channel_id AS sourceChannelId, updated_at AS updatedAt
      FROM social_contact_impressions WHERE agent_id=? ORDER BY updated_at DESC`,
      )
      .all(agentId) as SocialContactImpressionRecord[]
  }
  async deleteContactImpression(agentId: string, platform: string, userId: string) {
    this.db.transaction(() => {
      const target = JSON.stringify([agentId, platform, userId])
      this.db
        .prepare(
          `INSERT INTO privacy_deletions(id,kind,target_id,agent_id,metadata_json,status,created_at)
        VALUES(?,'social-contact',?,?,?,'completed',?) ON CONFLICT(kind,target_id) DO UPDATE SET metadata_json=excluded.metadata_json`,
        )
        .run(
          `social-contact:${target}`,
          target,
          agentId,
          JSON.stringify({ clearedAt: Date.now() }),
          new Date().toISOString(),
        )
      this.db
        .prepare(
          `DELETE FROM social_contact_impressions WHERE agent_id=? AND platform=? AND user_id=?`,
        )
        .run(agentId, platform, userId)
    })()
  }
  async deleteAllContactImpressions(agentId: string) {
    return this.db.prepare(`DELETE FROM social_contact_impressions WHERE agent_id=?`).run(agentId)
      .changes
  }

  async countChannelMessages(
    agentId: string,
    channelType: string,
    channelId: string,
    scope?: SocialStorageScope,
  ) {
    const filter = this.scopeFilter(scope)
    return Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS total FROM social_messages WHERE agent_id=? AND channel_type=? AND channel_id=?${filter.sql}`,
          )
          .get(agentId, channelType, channelId, ...filter.args) as { total: number }
      ).total,
    )
  }
  async deleteChannelMessages(
    agentId: string,
    channelType: string,
    channelId: string,
    scope?: SocialStorageScope,
  ) {
    const filter = this.scopeFilter(scope)
    return this.db
      .prepare(
        `DELETE FROM social_messages WHERE agent_id=? AND channel_type=? AND channel_id=?${filter.sql}`,
      )
      .run(agentId, channelType, channelId, ...filter.args).changes
  }
  async deleteAllMessages(agentId: string) {
    return this.db.prepare(`DELETE FROM social_messages WHERE agent_id=?`).run(agentId).changes
  }

  async isDeletedByTombstone(input: Parameters<SocialStoragePort['isDeletedByTombstone']>[0]) {
    const rows = this.db
      .prepare(
        `SELECT account_id AS accountId, channel_type AS channelType, channel_id AS channelId,
      deleted_before AS deletedBefore FROM social_history_tombstones WHERE agent_id=? AND (platform=? OR platform='*')`,
      )
      .all(input.agentId, input.platform) as Array<{
      accountId: string
      channelType: string
      channelId: string
      deletedBefore: number
    }>
    return rows.some(
      (row) =>
        (row.accountId === '' || row.accountId === input.accountId) &&
        (row.channelType === '*' || row.channelType === input.channelType) &&
        (row.channelId === '*' || row.channelId === input.channelId) &&
        input.timestamp <= row.deletedBefore,
    )
  }
  async upsertTombstone(input: Parameters<SocialStoragePort['upsertTombstone']>[0]) {
    this.db
      .prepare(
        `INSERT INTO social_history_tombstones(agent_id,platform,account_id,channel_type,channel_id,deleted_before)
      VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id,platform,account_id,channel_type,channel_id) DO UPDATE SET
      deleted_before=excluded.deleted_before, created_at=datetime('now','localtime')`,
      )
      .run(
        input.agentId,
        input.platform,
        input.accountId ?? '',
        input.channelType ?? '*',
        input.channelId ?? '*',
        input.deletedBefore,
      )
  }

  async getSyncCursor(agentId: string, platform: string, accountId: string) {
    return (
      (this.db
        .prepare(
          `SELECT agent_id AS agentId, platform, account_id AS accountId,
      last_successful_sync_at AS lastSuccessfulSyncAt, sync_started_at AS syncStartedAt, status, last_error AS lastError
      FROM social_sync_cursors WHERE agent_id=? AND platform=? AND account_id=? LIMIT 1`,
        )
        .get(agentId, platform, accountId) as SocialSyncCursorRecord | undefined) ?? null
    )
  }
  async markSyncStarted(agentId: string, platform: string, accountId: string, startedAt: number) {
    this.db
      .prepare(
        `INSERT INTO social_sync_cursors(agent_id,platform,account_id,sync_started_at,status,last_error)
      VALUES(?,?,?,?,'running',NULL) ON CONFLICT(agent_id,platform,account_id) DO UPDATE SET
      sync_started_at=excluded.sync_started_at,status='running',last_error=NULL,updated_at=datetime('now','localtime')`,
      )
      .run(agentId, platform, accountId, startedAt)
  }
  async markSyncCompleted(
    agentId: string,
    platform: string,
    accountId: string,
    completedThrough: number,
  ) {
    this.db
      .prepare(
        `INSERT INTO social_sync_cursors(agent_id,platform,account_id,last_successful_sync_at,status,last_error)
      VALUES(?,?,?,?,'idle',NULL) ON CONFLICT(agent_id,platform,account_id) DO UPDATE SET
      last_successful_sync_at=excluded.last_successful_sync_at,sync_started_at=NULL,status='idle',last_error=NULL,updated_at=datetime('now','localtime')`,
      )
      .run(agentId, platform, accountId, completedThrough)
  }
  async markSyncFailed(agentId: string, platform: string, accountId: string, error: string) {
    this.db
      .prepare(
        `UPDATE social_sync_cursors SET status='failed',last_error=?,updated_at=datetime('now','localtime')
      WHERE agent_id=? AND platform=? AND account_id=?`,
      )
      .run(error, agentId, platform, accountId)
  }
  async getRecentChannelsForPlatform(
    platform: string,
    limit = 100,
    scope?: { agentId: string; accountId: string },
  ) {
    return this.db
      .prepare(
        `SELECT agent_id AS agentId,account_id AS accountId,channel_id AS channelId,channel_type AS channelType
      FROM social_messages WHERE platform=?${scope ? ' AND agent_id=? AND account_id=?' : ''} GROUP BY agent_id,account_id,channel_id,channel_type ORDER BY MAX(timestamp) DESC LIMIT ?`,
      )
      .all(platform, ...(scope ? [scope.agentId, scope.accountId] : []), limit) as Array<{
      agentId: string
      accountId: string
      channelId: string
      channelType: string
    }>
  }

  async getUnsummarizedStats(agentId: string) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(content)),0) AS totalChars FROM social_messages WHERE agent_id=? AND is_summarized=0`,
      )
      .get(agentId) as { count: number; totalChars: number }
    return { count: Number(row.count), totalChars: Number(row.totalChars) }
  }
  async getUnsummarized(agentId: string, limit = 200) {
    return this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM social_messages WHERE agent_id=? AND is_summarized=0 ORDER BY id LIMIT ?`,
      )
      .all(agentId, limit) as SocialMessageRecord[]
  }
  async markSummarized(messageIds: number[]) {
    if (!messageIds.length) return
    const update = this.db.prepare(`UPDATE social_messages SET is_summarized=1 WHERE id=?`)
    this.db.transaction((ids: number[]) => {
      for (const id of ids) update.run(id)
    })(messageIds)
  }

  private scopeFilter(scope?: SocialStorageScope) {
    const fields = [
      ['platform', scope?.platform],
      ['account_id', scope?.accountId],
      ['channel_type', scope?.channelType],
      ['channel_id', scope?.channelId],
    ] as const
    const values = fields.filter((entry) => entry[1] !== undefined)
    return {
      sql: values.map(([field]) => ` AND ${field}=?`).join(''),
      args: values.map(([, value]) => value!),
    }
  }
  private fenceFilter(scope?: SocialStorageScope) {
    const values = [
      ['platform', scope?.platform],
      ['account_id', scope?.accountId],
    ].filter((entry) => entry[1] !== undefined)
    return {
      sql: values.map(([field]) => ` AND (${field}='' OR ${field}=?)`).join(''),
      args: values.map(([, value]) => value!),
    }
  }
  private async messages(
    where: string,
    args: unknown[],
    limit: number,
    scope?: SocialStorageScope,
  ): Promise<SocialMessageRecord[]> {
    const filter = this.scopeFilter(scope)
    return (
      this.db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM social_messages WHERE ${where}${filter.sql} ORDER BY id DESC LIMIT ?`,
        )
        .all(...args, ...filter.args, limit) as SocialMessageRecord[]
    ).reverse()
  }
  private assertConfirmedDelivery(message: Parameters<SocialStoragePort['insert']>[0]): void {
    const row = this.db
      .prepare('SELECT record_json FROM social_turns WHERE id=? AND agent_id=?')
      .get(message.turnId, message.agentId) as { record_json: string } | undefined
    if (!row) throw new Error('原社交任务已清理，不能恢复已删除的发送记录')
    const record = JSON.parse(row.record_json) as SocialTurnRecord
    const pending = record.checkpoint.pendingHistory as
      | Record<string, Parameters<SocialStoragePort['insert']>[0]>
      | undefined
    const confirmed = pending?.[message.confirmedDeliveryKey!]
    if (!confirmed) throw new Error('没有找到已确认的原发送记录')
    const fields: Array<keyof typeof message> = [
      'msgId',
      'platform',
      'accountId',
      'channelId',
      'channelType',
      'senderId',
      'senderName',
      'content',
      'agentId',
      'timestamp',
      'rawEventJson',
    ]
    if (fields.some((field) => confirmed[field] !== message[field]))
      throw new Error('补存消息与已确认的发送记录不一致')
    const version = this.db
      .prepare(
        "SELECT coalesce(sum(version),0) AS value FROM social_data_fences WHERE agent_id=? AND (channel_type='' OR (channel_type=? AND channel_id=?)) AND (platform='' OR platform=?) AND (account_id='' OR account_id=?)",
      )
      .get(
        record.agentId,
        record.channelType,
        record.channelId,
        record.platform,
        record.accountId,
      ) as { value: number }
    if (version.value !== record.checkpoint.deliveryDataVersion)
      throw new Error('社交数据已清理，不能重新写入旧发送记录')
  }

  private assertTurnWritable(id?: string, agentId?: string): number | undefined {
    if (!id) return
    const row = this.db
      .prepare(
        "SELECT json_extract(record_json,'$.startedAt') AS startedAt FROM social_turns WHERE id=? AND agent_id=? AND status IN ('running','retrying')",
      )
      .get(id, agentId ?? '') as { startedAt: string } | undefined
    if (!row) throw new Error('社交任务已经取消或数据已经清理，已阻止旧结果回写')
    return Date.parse(row.startedAt)
  }
}

const MESSAGE_COLUMNS = `id,msg_id AS msgId,platform,account_id AS accountId,channel_id AS channelId,
channel_type AS channelType,sender_id AS senderId,sender_name AS senderName,content,agent_id AS agentId,
raw_event_json AS rawEventJson,is_summarized AS isSummarized,timestamp`
