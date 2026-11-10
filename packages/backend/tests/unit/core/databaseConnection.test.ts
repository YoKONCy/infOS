/**
 * 数据库结构迁移回归测试
 *
 * 验证标准 SQL 迁移链能够初始化新库并接管旧版单基线数据库。
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import * as currentSchema from '@infos/backend/database/schema'
import { backgroundTasks } from '@infos/backend/database/schema'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { AgentInputRepository } from '@infos/backend/repositories/agentInput.repo'

let databasePath = ''
const tempRoot = process.env.INFOS_TEST_TEMP_ROOT ?? fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))

afterEach(() => {
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
})

describe('数据库结构迁移', () => {
  it('从零执行标准迁移链并支持 Drizzle 查询', () => {
    databasePath = join(tempRoot, `infos-baseline-${Date.now()}-${Math.random()}.db`)

    const db = createDrizzleConnection(databasePath)
    const sqlite = (db as unknown as { $client: Database.Database }).$client
    try {
      const columnNames = (
        sqlite.prepare('PRAGMA table_info(background_tasks)').all() as Array<{ name: string }>
      ).map((column) => column.name)

      const schemaTables = Object.values(currentSchema).filter(
        (value): value is typeof backgroundTasks =>
          typeof value === 'object' && value !== null && Symbol.for('drizzle:Name') in value,
      )
      expect(schemaTables.length).toBeGreaterThan(0)

      for (const table of schemaTables) {
        const config = getTableConfig(table)
        const actualColumns = (
          sqlite.prepare(`PRAGMA table_info("${config.name}")`).all() as Array<{ name: string }>
        ).map((column) => column.name)
        const expectedColumns = config.columns.map((column) => column.name)
        expect(new Set(actualColumns), `${config.name} 迁移后的列与 Drizzle Schema 不一致`).toEqual(
          new Set(expectedColumns),
        )
      }

      expect(columnNames).toEqual(
        expect.arrayContaining([
          'id',
          'agent_id',
          'thread_id',
          'target_thread_id',
          'category',
          'input_question',
          'input_context_json',
          'checkpoint_json',
          'read_at',
        ]),
      )
      expect(db.select().from(backgroundTasks).all()).toEqual([])
    } finally {
      closeDrizzleConnection(db)
    }
  })

  // 本用例含落盘建表、整条迁移链和重开验证，保留独立集成预算，不放宽全局单测时限。
  it('旧单基线库升级时保留私有心流，并移除工作正文与旧工具摘录表', () => {
    databasePath = join(tempRoot, `infos-legacy-${Date.now()}-${Math.random()}.db`)
    const legacy = new Database(databasePath)
    const baselinePath = fileURLToPath(
      new URL('../../../src/database/migrations/0000_baseline.sql', import.meta.url),
    )
    legacy.exec(readFileSync(baselinePath, 'utf8'))
    legacy
      .prepare(
        `
      INSERT INTO flow_states
        (thread_id, agent_id, current_goal, private_facts, work_context,
         work_context_updated_at_pair_count, revision)
      VALUES ('thread-1', 'pero', '持续目标', '私有事实', '旧工作正文', 3, 2)
    `,
      )
      .run()
    legacy
      .prepare(
        `
      INSERT INTO flow_state_revisions
        (thread_id, agent_id, pair_id, before_current_goal, after_current_goal,
         before_work_context, after_work_context)
      VALUES ('thread-1', 'pero', 'pair-1', '旧目标', '持续目标', '旧片段', '旧工作正文')
    `,
      )
      .run()
    legacy
      .prepare(
        `
      INSERT INTO work_context_entries (thread_id, agent_id, pair_id, pair_count, content)
      VALUES ('thread-1', 'pero', 'pair-1', 3, '逐轮旧正文')
    `,
      )
      .run()
    legacy
      .prepare('INSERT INTO configs (key, value) VALUES (?, ?)')
      .run('memory.runtime', JSON.stringify({ workContextExpirationPairs: 5, channels: {} }))
    legacy.exec(`
      CREATE TABLE tool_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        version TEXT,
        range_start INTEGER,
        range_end INTEGER,
        excerpt TEXT NOT NULL,
        truncated INTEGER DEFAULT false NOT NULL,
        observed_at TEXT DEFAULT (datetime('now', 'localtime')) NOT NULL
      );
      INSERT INTO tool_observations
        (thread_id, agent_id, pair_id, call_id, kind, source_ref, excerpt)
      VALUES ('thread-1', 'pero', 'pair-1', 'call-1', 'file', 'notes/a.md', '有限摘录');
    `)
    legacy.exec(`
      INSERT INTO scheduled_tasks (type, time, content, is_triggered, agent_id)
      VALUES ('reminder', '2020-01-01', '已经触发', 1, 'pero'),
             ('reminder', '2099-01-01', '尚未触发', 0, 'nana');
    `)
    legacy
      .prepare(
        `INSERT INTO agent_input_requests
      (id, agent_id, channel, session_id, thread_id, question, options_json, allow_free_text,
       required, status, selected_option_ids_json, response_message, created_at)
      VALUES (?, 'nana', 'desktop', 'legacy-thread', 'legacy-thread', ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-pending',
        '选择方案',
        JSON.stringify([{ id: 'safe', label: '保留原件' }]),
        1,
        'pending',
        '[]',
        null,
        '2026-01-01T00:00:00Z',
      )
    legacy
      .prepare(
        `INSERT INTO agent_input_requests
      (id, agent_id, channel, session_id, thread_id, question, options_json, allow_free_text,
       required, status, selected_option_ids_json, response_message, created_at)
      VALUES (?, 'nana', 'desktop', 'legacy-answered', 'legacy-answered', ?, ?, 1, 0, 'answered', ?, ?, ?)`,
      )
      .run(
        'legacy-answered',
        '选择方案',
        JSON.stringify([{ id: 'safe', label: '保留原件' }]),
        '["safe"]',
        '另存副本',
        '2026-01-01T00:00:00Z',
      )
    legacy.close()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const db = createDrizzleConnection(databasePath)
      const sqlite = (db as unknown as { $client: Database.Database }).$client
      try {
        const columns = (table: string) =>
          (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
          )
        const inputs = new AgentInputRepository(db)
        expect(inputs.get('legacy-pending')).toMatchObject({
          required: true,
          status: 'pending',
          answers: [],
          questions: [
            {
              id: 'question',
              question: '选择方案',
              multiple: true,
              allowFreeText: false,
              options: [{ id: 'safe', label: '保留原件' }],
            },
          ],
        })
        expect(inputs.get('legacy-answered')).toMatchObject({
          status: 'answered',
          questions: [{ allowFreeText: true }],
          answers: [{ questionId: 'question', selectedOptionIds: ['safe'], message: '另存副本' }],
        })
        expect(columns('flow_states')).not.toContain('work_context')
        expect(columns('flow_state_revisions')).not.toContain('before_work_context')
        expect(
          sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='work_context_entries'").get(),
        ).toBeUndefined()
        expect(sqlite.prepare('SELECT current_goal, private_facts FROM flow_states').get()).toEqual(
          {
            current_goal: '持续目标',
            private_facts: '私有事实',
          },
        )
        expect(
          sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='tool_observations'").get(),
        ).toBeUndefined()
        const config = sqlite
          .prepare("SELECT value FROM configs WHERE key='memory.runtime'")
          .get() as { value: string }
        expect(JSON.parse(config.value)).not.toHaveProperty('workContextExpirationPairs')
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({
          count: JSON.parse(
            readFileSync(
              fileURLToPath(
                new URL('../../../src/database/migrations/meta/_journal.json', import.meta.url),
              ),
              'utf8',
            ),
          ).entries.length,
        })
        expect(sqlite.prepare('SELECT status FROM scheduled_tasks ORDER BY id').all()).toEqual([
          { status: 'completed' },
          { status: 'pending' },
        ])
      } finally {
        closeDrizzleConnection(db)
      }
    }
  }, 30_000)
})
