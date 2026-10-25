import type Database from 'better-sqlite3'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadRepository } from '@infos/backend/repositories/thread.repo'
import { AttachmentRepository } from '@infos/backend/repositories/attachment.repo'

let sqlite: Database.Database
let db: ReturnType<typeof createDrizzleConnection>

describe('ThreadRepository 最近会话用途隔离', () => {
  beforeEach(() => {
    db = createDrizzleConnection(':memory:')
    sqlite = (db as unknown as { $client: Database.Database }).$client
  })

  afterEach(() => closeDrizzleConnection(db))

  it('历史时间索引从会话起点读取，仅返回用户时间且遵守会话、删除状态和追加边界', async () => {
    sqlite.exec(`
      INSERT INTO threads (id, agent_id, channel) VALUES
        ('time-thread', 'pero', 'desktop'), ('other-time-thread', 'pero', 'desktop');
      INSERT INTO thread_messages (id, thread_id, role, content, timestamp, status) VALUES
        (1, 'time-thread', 'user', '历史正文', '2026-10-22 11:04:00', 'active'),
        (2, 'time-thread', 'assistant', '助手回复', '2026-10-22 11:05:00', 'active'),
        (3, 'other-time-thread', 'user', '其他会话', '2026-10-25 06:00:00', 'active'),
        (4, 'time-thread', 'user', '已删除', '2026-10-25 06:01:00', 'deleted'),
        (5, 'time-thread', 'user', '恢复聊天', '2026-10-25 07:02:00', 'active'),
        (6, 'time-thread', 'user', '稍后消息', '2026-10-25 09:02:00', 'active');
    `)
    const repo = new ThreadRepository(db)
    expect(await repo.queryConversationUserTimes('time-thread', 5)).toEqual([
      { id: 1, timestamp: '2026-10-22 11:04:00' },
      { id: 5, timestamp: '2026-10-25 07:02:00' },
    ])
    expect(await repo.queryConversationUserTimes('time-thread', 0)).toEqual([])
  })

  it('工作历史分页包含失败和中断回合，排除删除记录，普通窗口维持原行为', async () => {
    sqlite.exec(`
      INSERT INTO threads (id, agent_id, channel) VALUES ('work', 'pero', 'desktop');
      INSERT INTO thread_messages (thread_id, role, content, pair_id, status) VALUES
        ('work','user','旧任务','p1','active'),
        ('work','assistant','中断','p1','interrupted'),
        ('work','user','新任务','p2','active'),
        ('work','assistant','失败','p2','failed'),
        ('work','assistant','已删','p2','deleted');
    `)
    const repo = new ThreadRepository(db)
    const latest = await repo.queryActiveMessagePairs('work', 1, { recoverable: true })
    expect(latest.map((message) => message.content)).toEqual(['新任务', '失败'])
    const previous = await repo.queryActiveMessagePairs('work', 1, {
      recoverable: true,
      beforeMessageId: Math.min(...latest.map((message) => message.id)),
    })
    expect(previous.map((message) => message.content)).toEqual(['旧任务', '中断'])
    expect(
      (await repo.queryActiveMessagePairs('work', 1)).map((message) => message.content),
    ).toEqual(['新任务'])
  })

  it('编辑同步正文块，旧 revision 与已删除消息不能被覆盖', async () => {
    sqlite
      .prepare("INSERT INTO threads (id, agent_id, channel) VALUES ('edit', 'pero', 'desktop')")
      .run()
    const inserted = sqlite
      .prepare(
        "INSERT INTO thread_messages (thread_id, role, content, revision, metadata_json, raw_content) VALUES ('edit', 'assistant', '旧正文', 1, ?, '原始审计')",
      )
      .run(
        JSON.stringify({
          contentBlocks: [{ kind: 'narration', blockId: 'body', content: '旧正文' }],
        }),
      )
    const id = Number(inserted.lastInsertRowid),
      repo = new ThreadRepository(db)
    expect(await repo.editMessage(id, '新正文', 1)).toBe(true)
    expect(await repo.editMessage(id, '过期编辑', 1)).toBe(false)
    const row = sqlite.prepare('SELECT * FROM thread_messages WHERE id = ?').get(id) as {
      content: string
      raw_content: string
      metadata_json: string
    }
    expect(row.content).toBe('新正文')
    expect(row.raw_content).toBe('原始审计')
    expect(JSON.parse(row.metadata_json).contentBlocks[0].content).toBe('新正文')
    await repo.softDeleteMessage(id, 'user')
    expect(await repo.editMessage(id, '不得复活', 2)).toBe(false)
  })

  it('重新生成保留用户 PDF 附件及解析结果，其他输出附件正常删除', async () => {
    sqlite
      .prepare(
        "INSERT INTO threads (id, agent_id, channel) VALUES ('attachment', 'pero', 'desktop')",
      )
      .run()
    const input = Number(
      sqlite
        .prepare(
          "INSERT INTO thread_messages (thread_id, role, content) VALUES ('attachment', 'user', '问题')",
        )
        .run().lastInsertRowid,
    )
    const reply = Number(
      sqlite
        .prepare(
          "INSERT INTO thread_messages (thread_id, role, content) VALUES ('attachment', 'assistant', '回复')",
        )
        .run().lastInsertRowid,
    )
    const repo = new AttachmentRepository(db)
    for (const [id, messageId] of [
      ['input-pdf', input],
      ['output', reply],
    ] as const) {
      await repo.create({
        id,
        threadId: 'attachment',
        kind: 'pdf',
        originalName: `${id}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 1,
        sha256: id,
        storageKey: id,
        extractedText: '解析后的内容',
        status: 'uploaded',
      })
      await repo.bind([id], 'attachment', messageId)
    }
    await repo.softDeleteByMessageIds([input, reply], { threadId: 'attachment', messageId: input })
    expect(await repo.findById('input-pdf')).toMatchObject({
      messageId: null,
      status: 'uploaded',
      extractedText: '解析后的内容',
    })
    expect(await repo.findById('output')).toMatchObject({ status: 'deleted' })
  })

  it('普通聊天必须忽略更新更晚的后台任务 Thread', async () => {
    sqlite.exec(`
      INSERT INTO threads (id, agent_id, channel, purpose, last_message_at)
      VALUES
        ('conversation-old', 'nana', 'desktop', 'conversation', '2026-01-01 10:00:00'),
        ('task-new', 'nana', 'desktop', 'background_task', '2026-01-02 10:00:00');
    `)
    const repo = new ThreadRepository(db)

    const latest = await repo.getOrCreateLatestThread('nana', 'desktop', 'conversation')

    expect(latest.id).toBe('conversation-old')
    expect(latest.purpose).toBe('conversation')
  })

  it('Continuity 查询应只返回同 Agent 其他 conversation Thread 的活跃对话消息', async () => {
    sqlite.exec(`
      INSERT INTO threads (id, agent_id, channel, purpose, status, title) VALUES
        ('current', 'pero', 'desktop', 'conversation', 'active', '当前'),
        ('desktop-other', 'pero', 'desktop', 'conversation', 'active', '其他私聊'),
        ('other', 'pero', 'group', 'conversation', 'active', '其他'),
        ('task', 'pero', 'desktop', 'background_task', 'active', '任务'),
        ('nana', 'nana', 'desktop', 'conversation', 'active', '娜娜');
      INSERT INTO thread_messages (thread_id, role, content, status, revision, timestamp) VALUES
        ('current', 'user', '当前消息', 'active', 1, '2026-08-18T09:00:00.000Z'),
        ('desktop-other', 'user', '不应串入的其他私聊', 'active', 1, '2026-08-18T09:30:00.000Z'),
        ('other', 'user', '跨线程用户', 'active', 2, '2026-08-18T10:00:00.000Z'),
        ('other', 'system', '系统消息', 'active', 1, '2026-08-18T10:01:00.000Z'),
        ('other', 'assistant', '跨线程回复', 'active', 1, '2026-08-18T10:02:00.000Z'),
        ('other', 'user', '已删除', 'deleted', 1, '2026-08-18T10:03:00.000Z'),
        ('task', 'assistant', '任务消息', 'active', 1, '2026-08-18T10:04:00.000Z'),
        ('nana', 'user', '其他角色', 'active', 1, '2026-08-18T10:05:00.000Z');
    `)
    const repo = new ThreadRepository(db)
    const result = await repo.queryContinuityMessages({
      agentId: 'pero',
      excludeThreadId: 'current',
      sourceChannel: 'group',
      limit: 10,
      since: '2026-08-18T00:00:00.000Z',
    })
    expect(result.map((message) => message.content)).toEqual(['跨线程用户', '跨线程回复'])
    expect(result[0]).toMatchObject({
      threadId: 'other',
      threadAgentId: 'pero',
      threadChannel: 'group',
      threadTitle: '其他',
      revision: 2,
    })
    const count = sqlite.prepare('SELECT count(*) AS count FROM thread_messages').get() as {
      count: number
    }
    expect(count.count).toBe(8)
  })

  it('据点Continuity应只读取同角色最近活跃Desktop Thread的完整回合', async () => {
    sqlite.exec(`
      INSERT INTO threads (id, agent_id, channel, purpose, status, last_message_at) VALUES
        ('pero-old', 'pero', 'desktop', 'conversation', 'active', '2026-08-18T09:00:00.000Z'),
        ('pero-latest', 'pero', 'desktop', 'conversation', 'active', '2026-08-18T11:00:00.000Z'),
        ('nana-latest', 'nana', 'desktop', 'conversation', 'active', '2026-08-18T12:00:00.000Z');
      INSERT INTO thread_messages (thread_id, role, content, status, pair_id, agent_id, timestamp) VALUES
        ('pero-old', 'user', 'Pero旧会话', 'active', 'old-pair', NULL, '2026-08-18T09:00:00.000Z'),
        ('pero-latest', 'user', 'Pero当前问题', 'active', 'latest-pair', NULL, '2026-08-18T11:00:00.000Z'),
        ('pero-latest', 'assistant', 'Pero当前回复', 'active', 'latest-pair', 'pero', '2026-08-18T11:01:00.000Z'),
        ('nana-latest', 'user', 'Nana私聊', 'active', 'nana-pair', NULL, '2026-08-18T12:00:00.000Z');
    `)
    const repo = new ThreadRepository(db)

    const result = await repo.queryLatestChannelContinuityPairs({
      agentId: 'pero',
      sourceChannel: 'desktop',
      pairLimit: 3,
    })

    expect(result.map((message) => message.content)).toEqual(['Pero当前问题', 'Pero当前回复'])
    expect(result.every((message) => message.threadId === 'pero-latest')).toBe(true)
  })

  it('历史消息游标必须稳定返回更早记录且不受新消息插入影响', async () => {
    sqlite.exec(`
      INSERT INTO threads (id, agent_id, channel, purpose, status)
      VALUES ('history', 'pero', 'desktop', 'conversation', 'active');
      INSERT INTO thread_messages (id, thread_id, role, content, status, timestamp) VALUES
        (1, 'history', 'user', '消息1', 'active', '2026-08-18T10:00:00.000Z'),
        (2, 'history', 'assistant', '消息2', 'active', '2026-08-18T10:01:00.000Z'),
        (3, 'history', 'user', '消息3', 'active', '2026-08-18T10:02:00.000Z'),
        (4, 'history', 'assistant', '消息4', 'active', '2026-08-18T10:03:00.000Z'),
        (5, 'history', 'user', '消息5', 'active', '2026-08-18T10:04:00.000Z');
    `)
    const repo = new ThreadRepository(db)

    const latest = await repo.listActiveMessages({ threadId: 'history', pageSize: 2 })
    expect(latest.items.map((message) => message.id)).toEqual([5, 4])
    expect(latest.hasMoreBefore).toBe(true)

    sqlite.exec(`
      INSERT INTO thread_messages (id, thread_id, role, content, status, timestamp)
      VALUES (6, 'history', 'assistant', '新消息', 'active', '2026-08-18T10:05:00.000Z');
    `)
    const older = await repo.listActiveMessages({
      threadId: 'history',
      beforeMessageId: 4,
      pageSize: 2,
    })
    expect(older.items.map((message) => message.id)).toEqual([3, 2])
    expect(older.hasMoreBefore).toBe(true)
  })

  it('只有后台任务 Thread 时必须新建普通 conversation Thread', async () => {
    sqlite.exec(`
      INSERT INTO threads (id, agent_id, channel, purpose, last_message_at)
      VALUES ('task-only', 'nana', 'desktop', 'background_task', '2026-01-02 10:00:00');
    `)
    const repo = new ThreadRepository(db)

    const latest = await repo.getOrCreateLatestThread('nana', 'desktop', 'conversation')

    expect(latest.id).not.toBe('task-only')
    expect(latest.agentId).toBe('nana')
    expect(latest.channel).toBe('desktop')
    expect(latest.purpose).toBe('conversation')
  })
})
