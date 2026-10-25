import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { SqliteSocialStoragePort } from '@infos/backend/applications/sqliteSocialStoragePort'
import { KernelOutboxRepository, runWithKernelExecution } from '@infos/backend/kernel'
import type { SocialStoragePort, SocialTurnRecord } from '@infos/shared'

let db: Database.Database
let port: SqliteSocialStoragePort

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE social_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,msg_id TEXT NOT NULL,platform TEXT NOT NULL,account_id TEXT NOT NULL DEFAULT '',channel_id TEXT NOT NULL,channel_type TEXT NOT NULL,sender_id TEXT NOT NULL,sender_name TEXT NOT NULL DEFAULT '',content TEXT NOT NULL,agent_id TEXT NOT NULL,raw_event_json TEXT NOT NULL DEFAULT '{}',timestamp TEXT,is_summarized INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX idx_social_messages_platform_message ON social_messages(agent_id,platform,account_id,msg_id);
    CREATE TABLE social_contact_impressions(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,platform TEXT NOT NULL,user_id TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',identity TEXT NOT NULL DEFAULT '',impression TEXT NOT NULL,source_channel_id TEXT,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(agent_id,platform,user_id));
    CREATE TABLE social_history_tombstones(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,platform TEXT NOT NULL,account_id TEXT NOT NULL DEFAULT '',channel_type TEXT NOT NULL DEFAULT '*',channel_id TEXT NOT NULL DEFAULT '*',deleted_before INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(agent_id,platform,account_id,channel_type,channel_id));
    CREATE TABLE social_sync_cursors(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,platform TEXT NOT NULL,account_id TEXT NOT NULL,last_successful_sync_at INTEGER NOT NULL DEFAULT 0,sync_started_at INTEGER,status TEXT NOT NULL DEFAULT 'idle',last_error TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(agent_id,platform,account_id));
    CREATE TABLE kernel_outbox_events(event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,durability TEXT NOT NULL,principal_id TEXT NOT NULL,process_id TEXT,execution_id TEXT,correlation_id TEXT,causation_id TEXT,object_type TEXT,object_id TEXT,object_generation INTEGER,payload_json TEXT NOT NULL,occurred_at TEXT NOT NULL,status TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,last_error TEXT,next_attempt_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,published_at TEXT);
  `)
  port = new SqliteSocialStoragePort(db)
  db.exec(
    readFileSync(
      new URL('../../../src/database/migrations/0013_social_recovery_privacy.sql', import.meta.url),
      'utf8',
    ),
  )
  db.exec(
    readFileSync(
      new URL('../../../src/database/migrations/0023_social_platform_scope.sql', import.meta.url),
      'utf8',
    ),
  )
})
afterEach(() => db.close())

describe('SqliteSocialStoragePort', () => {
  it('同号消息按平台、账号和会话去重，查询和队列结算不会跨分区', async () => {
    const base = {
      agentId: 'pero',
      msgId: '1',
      accountId: 'account-A',
      channelType: 'group',
      senderId: 'user-A',
      senderName: '联系人',
      content: '测试',
      queueForReply: true,
    }
    for (const [platform, channelId] of [
      ['first', 'room-1'],
      ['second', 'room-1'],
      ['first', 'room-2'],
    ])
      await port.insert({ ...base, platform: platform!, channelId: channelId! })
    expect(await port.queuedMessages('pero')).toHaveLength(3)
    await expect(port.getByMsgId('pero', '1', 'account-A')).rejects.toThrow(
      'SOCIAL_MESSAGE_SCOPE_REQUIRED',
    )
    const address = {
      platform: 'first',
      accountId: 'account-A',
      channelType: 'group',
      channelId: 'room-1',
    }
    expect(await port.getByMsgId('pero', '1', 'account-A', address)).toMatchObject(address)
    await port.completeQueuedMessages('pero', 'account-A', ['1'], address)
    expect(await port.queuedMessages('pero')).toHaveLength(2)
    expect(await port.deleteChannelMessages('pero', 'group', 'room-1', address)).toBe(1)
    expect(
      await port.getRecent('pero', 'room-1', 'group', 1, {
        platform: 'second',
        accountId: 'account-A',
      }),
    ).toHaveLength(1)
  })

  it('指定会话的清理围栏不会作废其他平台的回合，全量删除墓碑覆盖未来接入平台', async () => {
    const address = {
      platform: 'first',
      accountId: 'account-A',
      channelType: 'group',
      channelId: 'room-1',
    }
    await port.deleteTurns('pero', 'group', 'room-1', address)
    expect(await port.getDataVersion('pero', 'group', 'room-1', address)).toBe(1)
    expect(
      await port.getDataVersion('pero', 'group', 'room-1', { ...address, platform: 'second' }),
    ).toBe(0)
    await port.upsertTombstone({ agentId: 'pero', platform: '*', deletedBefore: 100 })
    expect(
      await port.isDeletedByTombstone({
        agentId: 'pero',
        ...address,
        platform: 'future',
        timestamp: 99,
      }),
    ).toBe(true)
  })

  it('大量普通聊天不会挤掉真正任务，旧记录按委派标识兼容分类', async () => {
    const base: SocialTurnRecord = {
      id: 'social:command:older',
      agentId: 'pero',
      accountId: '123456789',
      channelType: 'group',
      channelId: '987654321',
      status: 'completed',
      attempts: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deadline: '2026-01-01T01:00:00.000Z',
      checkpoint: {},
      outcome: 'reply',
    }
    await port.saveTurn(base)
    // 模拟升级前没有分类字段的持久记录，不依赖清库或重建迁移。
    db.prepare('UPDATE social_turns SET record_json=? WHERE id=?').run(
      JSON.stringify(base),
      base.id,
    )
    for (let index = 1; index <= 130; index++) {
      const conversation = {
        ...base,
        id: `social:chat:${index}`,
        updatedAt: new Date(Date.parse(base.updatedAt) + index * 1000).toISOString(),
      }
      await port.saveTurn(conversation)
      if (index === 130)
        db.prepare('UPDATE social_turns SET record_json=? WHERE id=?').run(
          JSON.stringify(conversation),
          conversation.id,
        )
    }
    expect(await port.listRecoverableTurns('pero', true, 'task')).toMatchObject([
      { id: 'social:command:older', kind: 'task' },
    ])
    const conversations = await port.listRecoverableTurns('pero', true, 'conversation')
    expect(conversations).toHaveLength(100)
    expect(conversations.every((record) => record.kind === 'conversation')).toBe(true)
    expect(await port.getTurn('social:chat:130')).toMatchObject({ kind: 'conversation' })
  })

  it('聊天里有工具失败、等待或复杂步骤，也不会自动被归类为任务', async () => {
    const record: SocialTurnRecord = {
      id: 'social:conversation',
      kind: 'conversation',
      agentId: 'pero',
      accountId: '123456789',
      channelType: 'private',
      channelId: '987654321',
      status: 'waiting',
      attempts: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
      checkpoint: {},
      orchestrationSummary: {
        plans: 3,
        stepsCompleted: 6,
        stepsFailed: 3,
        stepsUncertain: 1,
        stepsSkipped: 0,
        businessCalls: 9,
        sends: 1,
      },
    }
    await port.saveTurn(record)
    expect(await port.listRecoverableTurns('pero', true, 'task')).toEqual([])
    expect(await port.listRecoverableTurns('pero', false, 'conversation')).toMatchObject([
      { id: record.id, kind: 'conversation', status: 'waiting' },
    ])
  })

  it('终态只允许补存检查点中已确认的原发送消息，历史清理后不能复活', async () => {
    const message: Parameters<SocialStoragePort['insert']>[0] = {
      turnId: 'confirmed',
      msgId: 'qq-confirmed',
      platform: 'qq',
      accountId: '123456789',
      channelId: '987654321',
      channelType: 'group',
      senderId: 'self',
      senderName: 'keromi',
      agentId: 'keromi',
      content: '平台已经送达',
      timestamp: new Date().toISOString(),
    }
    const record: SocialTurnRecord = {
      id: 'confirmed',
      agentId: 'keromi',
      accountId: '123456789',
      channelId: '987654321',
      channelType: 'group',
      status: 'completed',
      attempts: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60000).toISOString(),
      checkpoint: { deliveryDataVersion: 0, pendingHistory: { receipt: message } },
    }
    await port.saveTurn(record)
    await expect(port.insert(message)).rejects.toThrow('已经取消或数据已经清理')
    await expect(
      port.insert({ ...message, content: '伪造内容', confirmedDeliveryKey: 'receipt' }),
    ).rejects.toThrow('不一致')
    await port.insert({ ...message, confirmedDeliveryKey: 'receipt' })
    await port.insert({ ...message, confirmedDeliveryKey: 'receipt' })
    expect(await port.getRecent('keromi', '987654321', 'group')).toHaveLength(1)
    await port.deleteTurns('keromi', 'group', '987654321')
    await port.deleteChannelMessages('keromi', 'group', '987654321')
    await expect(port.insert({ ...message, confirmedDeliveryKey: 'receipt' })).rejects.toThrow(
      '不能恢复已删除',
    )
    expect(await port.getRecent('keromi', '987654321', 'group')).toHaveLength(0)
  })

  it('Execution内消息与Durable Event应同事务提交并继承因果身份', async () => {
    const outbox = new KernelOutboxRepository(drizzle(db) as never)
    const transactional = new SqliteSocialStoragePort(db, outbox)
    await runWithKernelExecution(
      {
        executionId: 'execution-social',
        processId: 'process-social',
        principalId: 'pero',
        class: 'background',
        priority: 4,
        budget: {},
      } as never,
      () =>
        transactional.insert({
          msgId: 'event-1',
          platform: 'qq',
          channelId: 'g1',
          channelType: 'group',
          senderId: 'self',
          senderName: 'Pero',
          content: '回复',
          agentId: 'pero',
        }),
    )
    const event = db
      .prepare(
        `SELECT event_type AS eventType,execution_id AS executionId,correlation_id AS correlationId,payload_json AS payloadJson FROM kernel_outbox_events`,
      )
      .get() as {
      eventType: string
      executionId: string
      correlationId: string
      payloadJson: string
    }
    expect(event).toMatchObject({
      eventType: 'social.message.committed',
      executionId: 'execution-social',
      correlationId: 'execution-social',
    })
    expect(JSON.parse(event.payloadJson)).toMatchObject({ msgId: 'event-1', channelId: 'g1' })
  })

  it('Outbox 写入失败时必须回滚社交消息', async () => {
    const transactional = new SqliteSocialStoragePort(
      db,
      new KernelOutboxRepository(drizzle(db) as never),
    )
    db.exec(
      "CREATE TRIGGER reject_outbox BEFORE INSERT ON kernel_outbox_events BEGIN SELECT RAISE(ABORT, '拒绝测试事件'); END;",
    )
    await expect(
      runWithKernelExecution(
        {
          executionId: 'failed',
          processId: 'social',
          principalId: 'pero',
          class: 'background',
          priority: 4,
          budget: {},
        } as never,
        () =>
          transactional.insert({
            msgId: 'rollback',
            platform: 'qq',
            channelId: 'g1',
            channelType: 'group',
            senderId: 'self',
            senderName: 'Pero',
            content: '不应留下',
            agentId: 'pero',
          }),
      ),
    ).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_messages').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM kernel_outbox_events').get()).toEqual({
      count: 0,
    })
  })

  it('应完整支持消息写入、去重、查询、总结和删除', async () => {
    const message = {
      msgId: 'm1',
      platform: 'qq',
      accountId: 'a1',
      channelId: 'g1',
      channelType: 'group',
      senderId: 'u1',
      senderName: '用户',
      content: '你好',
      agentId: 'pero',
      rawEventJson: '{}',
      timestamp: '2026-01-01 00:00:00',
    }
    await port.insert(message)
    await port.insert(message)
    expect(await port.countChannelMessages('pero', 'group', 'g1')).toBe(1)
    expect(await port.getRecent('pero', 'g1', 'group')).toMatchObject([
      { msgId: 'm1', content: '你好' },
    ])
    expect(await port.getRecentBySender('pero', 'u1')).toHaveLength(1)
    expect(await port.getRecentGroupsByContact('pero', 'u1')).toEqual(['g1'])
    expect(await port.getUnsummarizedStats('pero')).toEqual({ count: 1, totalChars: 2 })
    const unsummarized = await port.getUnsummarized('pero')
    await port.markSummarized(unsummarized.map((item) => item.id))
    expect((await port.getUnsummarizedStats('pero')).count).toBe(0)
    expect(await port.deleteChannelMessages('pero', 'group', 'g1')).toBe(1)
  })

  it('应支持联系人印象、删除墓碑和离线同步游标', async () => {
    await port.upsertContactImpression({
      agentId: 'pero',
      platform: 'qq',
      userId: 'u1',
      identity: '朋友',
      impression: '友好',
    })
    await port.upsertContactImpression({
      agentId: 'pero',
      platform: 'qq',
      userId: 'u1',
      impression: '可靠',
    })
    expect(await port.getContactImpression('pero', 'qq', 'u1')).toMatchObject({
      identity: '朋友',
      impression: '可靠',
    })
    await port.upsertTombstone({
      agentId: 'pero',
      platform: 'qq',
      channelType: 'group',
      channelId: 'g1',
      deletedBefore: 100,
    })
    expect(
      await port.isDeletedByTombstone({
        agentId: 'pero',
        platform: 'qq',
        accountId: '',
        channelType: 'group',
        channelId: 'g1',
        timestamp: 99,
      }),
    ).toBe(true)
    await port.markSyncStarted('pero', 'qq', 'a1', 10)
    expect(await port.getSyncCursor('pero', 'qq', 'a1')).toMatchObject({
      status: 'running',
      syncStartedAt: 10,
    })
    await port.markSyncCompleted('pero', 'qq', 'a1', 20)
    expect(await port.getSyncCursor('pero', 'qq', 'a1')).toMatchObject({
      status: 'idle',
      lastSuccessfulSyncAt: 20,
    })
    await port.deleteContactImpression('pero', 'qq', 'u1')
    expect(await port.getContactImpression('pero', 'qq', 'u1')).toBeNull()
  })
})
