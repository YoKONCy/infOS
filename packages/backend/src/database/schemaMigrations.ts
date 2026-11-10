import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

interface MigrationJournal {
  entries: Array<{ tag: string; when: number }>
}

/** 旧版启动器直接执行基线，先登记该事实，再交给 Drizzle 运行后续标准迁移。 */
export function applySchemaMigrations(
  sqlite: Database.Database,
  db: Parameters<typeof migrate>[0],
  migrationsDir: string,
  existingDatabase: boolean,
): void {
  if (existingDatabase) {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as MigrationJournal
    const baseline = journal.entries[0]
    if (baseline?.tag !== '0000_baseline' || !Number.isFinite(baseline.when)) {
      throw new Error('数据库迁移日志缺少有效的 0000_baseline')
    }
    const baselineSql = readFileSync(path.join(migrationsDir, `${baseline.tag}.sql`), 'utf8')
    const baselineHash = createHash('sha256').update(baselineSql).digest('hex')
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS __drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric
        )
      `)
      const recorded = sqlite.prepare('SELECT 1 FROM __drizzle_migrations LIMIT 1').get()
      if (!recorded) {
        sqlite
          .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
          .run(baselineHash, baseline.when)
      }
      reconcileReorderedMigrations(sqlite, migrationsDir, journal)
    })()
  }

  migrate(db, { migrationsFolder: migrationsDir })
}

/**
 * 合入上游时私有迁移会被重新编号并排到上游新迁移之后。Drizzle 只按最大
 * created_at 判断待执行项：已执行过的私有迁移会被重跑，插在中间的上游迁移
 * 又会被跳过。先按 SQL 摘要识别重排项，兼容 LF 与 CRLF，再用尚未认领的
 * 时间记录识别旧迁移。已有执行记录保留原摘要，只对齐时间，真正的缺口补执行。
 */
function reconcileReorderedMigrations(
  sqlite: Database.Database,
  migrationsDir: string,
  journal: MigrationJournal,
): void {
  const rows = sqlite
    .prepare('SELECT rowid AS rowId, hash, created_at AS createdAt FROM __drizzle_migrations')
    .all() as Array<{ rowId: number; hash: string; createdAt: number | string | null }>
  if (rows.length === 0) return
  const claimedRows = new Set<number>()
  const entries = journal.entries.map((entry) => {
    const sql = readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf8')
    const lfSql = sql.replace(/\r\n/g, '\n')
    const hashes = new Set(
      [sql, lfSql, lfSql.replace(/\n/g, '\r\n')].map((content) =>
        createHash('sha256').update(content).digest('hex'),
      ),
    )
    const row = rows.find((row) => !claimedRows.has(row.rowId) && hashes.has(row.hash))
    if (row) claimedRows.add(row.rowId)
    return { ...entry, sql, hash: createHash('sha256').update(sql).digest('hex'), row }
  })
  let lastRecordedIndex = -1
  entries.forEach((entry, index) => {
    // 先为全部摘要认领记录，避免新插入的迁移占用重排项的旧时间。
    if (!entry.row) {
      entry.row = rows.find((row) =>
        !claimedRows.has(row.rowId) && Number(row.createdAt) === entry.when,
      )
      if (entry.row) claimedRows.add(entry.row.rowId)
    }
    if (entry.row) lastRecordedIndex = index
  })
  const updateTime = sqlite.prepare(
    'UPDATE __drizzle_migrations SET created_at = ? WHERE rowid = ?',
  )
  const insert = sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
  entries.forEach((entry, index) => {
    const row = entry.row
    if (row) {
      if (entry.tag === '0025_main_side_threads') {
        completeLegacyMainThreadMigration(sqlite, entry.sql)
      }
      if (Number(row.createdAt) !== entry.when) updateTime.run(entry.when, row.rowId)
      return
    }
    // 位于最后一个已执行迁移之后的交给 Drizzle；之前的缺口在这里补执行。
    if (index > lastRecordedIndex) return
    for (const statement of entry.sql.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement)
    }
    insert.run(entry.hash, entry.when)
  })
}

/** 早期 0025 只有主侧线结构，后续同名版本补入交流执行结构，按实际 DDL 补齐。 */
function completeLegacyMainThreadMigration(sqlite: Database.Database, sql: string): void {
  const columnExists = sqlite.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
  const objectExists = sqlite.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
  for (const statement of sql.split('--> statement-breakpoint')) {
    const query = statement.trim()
    if (!query) continue
    const addition = /^ALTER TABLE (\w+) ADD COLUMN (\w+)\b/i.exec(query)
    if (addition) {
      if (!columnExists.get(addition[1], addition[2])) sqlite.exec(query)
      continue
    }
    const creation = /^CREATE (?:UNIQUE )?(TABLE|INDEX) (\w+)\b/i.exec(query)
    // 兼容范围限定为该历史迁移的建表、加列和索引，其他变更应追加标准迁移。
    if (!creation) throw new Error('LEGACY_MAIN_THREAD_MIGRATION_UNSUPPORTED_STATEMENT')
    if (!objectExists.get(creation[1]!.toLowerCase(), creation[2])) sqlite.exec(query)
  }
}
