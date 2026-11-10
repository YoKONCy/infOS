import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import { WorkContextClearRepository } from '@infos/backend/repositories/workContextClear.repo'
import { ThreadRepository } from '@infos/backend/repositories/thread.repo'
import { mergeBackupRecords } from '@infos/backend/services/backup/backupRecords'
import type { BackupRow } from '@infos/shared'

let db: ReturnType<typeof createDrizzleConnection>
let sqlite: Database.Database
let repository: WorkContextClearRepository
const input = { threadId: 'main', agentId: 'pero', generation: 1, pairId: 'current', toolCallId: 'clear-one' }

beforeEach(() => {
  db = createDrizzleConnection(':memory:')
  sqlite = (db as unknown as { $client: Database.Database }).$client
  repository = new WorkContextClearRepository(db)
  sqlite.exec(`
    INSERT INTO threads(id,agent_id,thread_kind,channel,purpose) VALUES
      ('main','pero','main','desktop','conversation'), ('other','nana','side','desktop','conversation');
    INSERT INTO thread_messages(id,thread_id,role,content,pair_id) VALUES
      (17,'main','assistant','旧工作回复','old'), (21,'main','user','当前输入','current'),
      (99,'other','user','其他角色的消息','other-pair');
    INSERT INTO conversation_executions(id,thread_id,agent_id,generation,started_at,metadata_json) VALUES
      ('old','main','pero',1,'2026-11-09T01:00:00.000Z','{"executionMessages":[{"role":"tool","content":"旧工具原件"}]}'),
      ('current','main','pero',1,'2026-11-09T02:00:00.000Z','{}');
  `)
})

afterEach(() => closeDrizzleConnection(db))

describe('工作上下文持久清理', () => {
  it('清理只覆盖当时所属会话的来源，保留原始记录和之后追加的材料', () => {
    const boundary = repository.clear(input)
    sqlite.exec("INSERT INTO thread_messages(id,thread_id,role,content,pair_id) VALUES(22,'main','assistant','新阶段回复','next')")
    expect(boundary.messageIds).toEqual([17, 21])
    expect([...boundary.executionIds].sort()).toEqual(['current', 'old'])
    expect(boundary.applied).toBe(true)
    expect(repository.latest('main', 1)?.messageIds).toEqual([17, 21])
    expect(sqlite.prepare("SELECT content FROM thread_messages WHERE thread_id='main' ORDER BY id").all()).toEqual([
      { content: '旧工作回复' }, { content: '当前输入' }, { content: '新阶段回复' },
    ])
    expect(sqlite.prepare("SELECT metadata_json FROM conversation_executions WHERE id='old'").get()).toEqual({
      metadata_json: '{"executionMessages":[{"role":"tool","content":"旧工具原件"}]}',
    })
  })

  it('旧回执重试沿用原结果，最新清理边界继续有效', () => {
    const first = repository.clear(input)
    sqlite.exec("INSERT INTO thread_messages(id,thread_id,role,content,pair_id) VALUES(22,'main','assistant','中间进展','next')")
    const second = repository.clear({ ...input, toolCallId: 'clear-two' })
    sqlite.exec("INSERT INTO thread_messages(id,thread_id,role,content,pair_id) VALUES(23,'main','assistant','后续进展','last')")
    const retried = repository.clear(input)
    expect(retried).toMatchObject({ id: first.id, applied: false })
    expect(repository.latest('main', 1)).toMatchObject({ id: second.id, messageIds: [17, 21, 22] })
    expect(sqlite.prepare('SELECT content FROM thread_messages WHERE id=23').get()).toEqual({ content: '后续进展' })
  })

  it.each([
    { agentId: 'nana' },
    { generation: 2 },
    { threadId: 'missing' },
  ])('拒绝失效身份并保持既有边界 %j', (change) => {
    const first = repository.clear(input)
    expect(() => repository.clear({ ...input, ...change, toolCallId: 'invalid' })).toThrow()
    expect(repository.latest('main', 1)?.id).toBe(first.id)
  })

  it('主线重置清理旧代次边界，新代次从空现场开始', async () => {
    repository.clear(input)
    expect(await new ThreadRepository(db).resetMainThread('main')).toBe(2)
    expect(repository.latest('main', 1)).toBeUndefined()
    expect(repository.latest('main', 2)).toBeUndefined()
  })

  it('复制导入重写清理边界的消息、执行、轮次和调用身份', () => {
    repository.clear(input)
    const tables = new Map<string, BackupRow[]>([
      ['threads', sqlite.prepare("SELECT * FROM threads WHERE id='main'").all() as BackupRow[]],
      ['thread_messages', sqlite.prepare("SELECT * FROM thread_messages WHERE thread_id='main'").all() as BackupRow[]],
      ['conversation_executions', sqlite.prepare('SELECT * FROM conversation_executions').all() as BackupRow[]],
      ['work_context_clears', sqlite.prepare('SELECT * FROM work_context_clears').all() as BackupRow[]],
    ])
    mergeBackupRecords(sqlite, tables, { conflict: 'duplicate', agentTargets: { pero: 'penora' } }, 'memory-clear-import')
    const imported = sqlite.prepare("SELECT id,generation FROM threads WHERE agent_id='penora'").get() as { id: string; generation: number }
    const boundary = repository.latest(imported.id, imported.generation)!
    const messages = sqlite.prepare('SELECT id,content FROM thread_messages WHERE thread_id=? ORDER BY id').all(imported.id) as Array<{ id: number; content: string }>
    const executions = sqlite.prepare('SELECT id FROM conversation_executions WHERE thread_id=? ORDER BY id').all(imported.id) as Array<{ id: string }>
    expect(messages.map((message) => message.content)).toEqual(['旧工作回复', '当前输入'])
    expect(boundary.messageIds).toEqual(messages.map((message) => message.id))
    expect([...boundary.executionIds].sort()).toEqual(executions.map((execution) => execution.id).sort())
    expect(boundary.executionIds).toContain(boundary.pairId)
    expect(boundary.toolCallId).not.toBe('clear-one')
  })
})
