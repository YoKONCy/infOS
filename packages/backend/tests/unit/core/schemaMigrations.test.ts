import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { afterEach, describe, expect, it } from 'vitest'
import { applySchemaMigrations } from '@infos/backend/database/schemaMigrations'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import * as currentSchema from '@infos/backend/database/schema'

interface MigrationEntry {
  tag: string
  when: number
  sql: string
}

const directories: string[] = []
const databases: Database.Database[] = []
const baseline: MigrationEntry = {
  tag: '0000_baseline',
  when: 100,
  sql: 'CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT);\n',
}
const plan: MigrationEntry = {
  tag: '0001_task_plans',
  when: 200,
  sql: 'CREATE TABLE task_plans (id TEXT PRIMARY KEY, title TEXT NOT NULL);\n--> statement-breakpoint\n' +
    "INSERT INTO task_plans VALUES ('plan-1', '保留已有计划');\n",
}
const following: MigrationEntry = {
  tag: '0002_following',
  when: 300,
  sql: 'CREATE TABLE completion_markers (value TEXT NOT NULL);\n',
}
const pending: MigrationEntry = {
  tag: '0003_plan_status',
  when: 400,
  sql: "ALTER TABLE task_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'active';\n",
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createFixture(entries: MigrationEntry[]) {
  const tempRoot = fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))
  mkdirSync(tempRoot, { recursive: true })
  const migrationsDir = mkdtempSync(join(tempRoot, 'schema-migrations-'))
  directories.push(migrationsDir)
  mkdirSync(join(migrationsDir, 'meta'))
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  const db = drizzle(sqlite)
  const writeJournal = (nextEntries: MigrationEntry[]) => {
    for (const entry of nextEntries) {
      writeFileSync(join(migrationsDir, `${entry.tag}.sql`), entry.sql)
    }
    writeFileSync(join(migrationsDir, 'meta', '_journal.json'), JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: nextEntries.map((entry, idx) => ({
        idx, version: '6', tag: entry.tag, when: entry.when, breakpoints: true,
      })),
    }))
  }
  writeJournal(entries)
  applySchemaMigrations(sqlite, db, migrationsDir, false)
  return { sqlite, db, migrationsDir, writeJournal }
}

describe('迁移执行记录对齐', () => {
  it('早期主侧会话库补齐交流执行结构后完成整个迁移链，保留消息且表达触发器可写', async () => {
    const sourceDir = fileURLToPath(new URL('../../../src/database/migrations/', import.meta.url))
    const journal = JSON.parse(readFileSync(join(sourceDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string; when: number }>
    }
    const currentEntries = journal.entries.map((entry) => ({
      ...entry, sql: readFileSync(join(sourceDir, `${entry.tag}.sql`), 'utf8'),
    }))
    const legacyEntries = currentEntries.filter((entry) => entry.tag <= '0025_main_side_threads')
      .map((entry) => entry.tag === '0025_main_side_threads'
        ? { ...entry, sql: readFileSync(new URL('../../fixtures/legacy_main_side_threads.sql', import.meta.url), 'utf8') }
        : entry)
    const f = createFixture(legacyEntries)
    f.sqlite.pragma('foreign_keys = ON')
    f.sqlite.exec(`
      INSERT INTO threads (id, agent_id, thread_kind) VALUES ('legacy-main', 'pero', 'main');
      INSERT INTO thread_messages (id, thread_id, agent_id, role, content)
      VALUES (7, 'legacy-main', 'pero', 'assistant', '保留早期主会话消息');
    `)
    f.writeJournal(currentEntries)
    const databasePath = join(f.migrationsDir, 'legacy.db')
    await f.sqlite.backup(databasePath)

    const db = createDrizzleConnection(databasePath)
    const sqlite = (db as unknown as { $client: Database.Database }).$client
    try {
      applySchemaMigrations(sqlite, db, f.migrationsDir, true)
      const tables = Object.values(currentSchema).filter(
        (value): value is typeof currentSchema.threads =>
          typeof value === 'object' && value !== null && Symbol.for('drizzle:Name') in value,
      )
      for (const table of tables) {
        const config = getTableConfig(table)
        const columns = sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(config.name) as Array<{ name: string }>
        expect(new Set(columns.map((column) => column.name)), config.name)
          .toEqual(new Set(config.columns.map((column) => column.name)))
      }
      expect(sqlite.prepare('SELECT content FROM thread_messages WHERE id = 7').get())
        .toEqual({ content: '保留早期主会话消息' })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get())
        .toEqual({ count: currentEntries.length })
      sqlite.exec(`
        INSERT INTO thread_messages (id, thread_id, agent_id, role, content, publication_id, execution_id)
        VALUES (8, 'legacy-main', 'pero', 'assistant', '升级后的独立发言', 'publication-8', 'execution-8');
      `)
      expect(sqlite.prepare('SELECT rule_version FROM expression_replies WHERE message_id = 8').get())
        .toEqual({ rule_version: 'expression-v1' })
      expect(sqlite.pragma('foreign_key_check')).toEqual([])
    } finally {
      closeDrizzleConnection(db)
    }
  })

  it('旧迁移摘要变化时沿用时间记录，保留数据并执行后续迁移', () => {
    const f = createFixture([baseline, plan, following])
    const oldHash = createHash('sha256').update(plan.sql).digest('hex')
    f.writeJournal([
      baseline,
      { ...plan, sql: `-- 计划数据迁移\n${plan.sql}` },
      following,
      pending,
    ])

    applySchemaMigrations(f.sqlite, f.db, f.migrationsDir, true)
    applySchemaMigrations(f.sqlite, f.db, f.migrationsDir, true)

    expect(f.sqlite.prepare('SELECT id, title, status FROM task_plans').all()).toEqual([
      { id: 'plan-1', title: '保留已有计划', status: 'active' },
    ])
    expect(f.sqlite.prepare('SELECT hash FROM __drizzle_migrations WHERE created_at = 200').get())
      .toEqual({ hash: oldHash })
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get())
      .toEqual({ count: 4 })
  })

  it.each(['\n', '\r\n'])('摘要优先识别换行为 %j 的重排项，补执行占用旧时间的真实缺口', (newline) => {
    const oldPlan = { ...plan, sql: plan.sql.replace(/\n/g, newline) }
    const f = createFixture([baseline, oldPlan])
    const oldHash = createHash('sha256').update(oldPlan.sql).digest('hex')
    f.writeJournal([
      baseline,
      {
        tag: '0001_upstream',
        when: 200,
        sql: 'CREATE TABLE upstream_state (value TEXT NOT NULL);\n--> statement-breakpoint\n' +
          "INSERT INTO upstream_state VALUES ('已补齐上游迁移');\n",
      },
      { ...plan, tag: '0002_task_plans', when: 300 },
      pending,
    ])

    applySchemaMigrations(f.sqlite, f.db, f.migrationsDir, true)
    applySchemaMigrations(f.sqlite, f.db, f.migrationsDir, true)

    expect(f.sqlite.prepare('SELECT id, title, status FROM task_plans').all()).toEqual([
      { id: 'plan-1', title: '保留已有计划', status: 'active' },
    ])
    expect(f.sqlite.prepare('SELECT value FROM upstream_state').all())
      .toEqual([{ value: '已补齐上游迁移' }])
    expect(f.sqlite.prepare('SELECT created_at FROM __drizzle_migrations WHERE hash = ?').get(oldHash))
      .toEqual({ created_at: 300 })
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get())
      .toEqual({ count: 4 })
  })

  it('缺口执行失败时回滚建表与执行时间调整', () => {
    const f = createFixture([baseline, plan, following])
    const before = f.sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid').all()
    f.writeJournal([
      baseline,
      { ...plan, when: 150 },
      {
        tag: '0002_broken_gap',
        when: 200,
        sql: 'CREATE TABLE gap_state (value TEXT);\n--> statement-breakpoint\n' +
          "INSERT INTO missing_table VALUES ('缺失依赖');\n",
      },
      { ...following, tag: '0003_following', when: 400 },
    ])

    expect(() => applySchemaMigrations(f.sqlite, f.db, f.migrationsDir, true)).toThrow()

    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'gap_state'").get())
      .toBeUndefined()
    expect(f.sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid').all())
      .toEqual(before)
    expect(f.sqlite.prepare('SELECT id, title FROM task_plans').all())
      .toEqual([{ id: 'plan-1', title: '保留已有计划' }])
  })
})
