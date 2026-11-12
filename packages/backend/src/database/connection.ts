import { t as __t } from '../lib/i18n'
/**
 * SQLite 连接管理
 *
 * 使用 better-sqlite3 + Drizzle ORM 创建 SQLite 连接。
 * 自动设置 WAL 模式和性能优化 PRAGMA。
 * 首次启动按 Drizzle journal 执行完整基线及后续结构迁移；旧库由薄层登记基线。
 *
 * @module packages/backend/src/database/connection
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { createLogger } from '../lib/logger'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { applySchemaMigrations } from './schemaMigrations'
import { storeDiagnostic } from '../lib/storeDiagnostics'

const logger = createLogger('Database')
const sqliteConnections = new WeakMap<object, Database.Database>()

function removeLegacyMemorySchema(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    for (const table of [
      'memory_nodes',
      'canonical_memories',
      'memory_candidates',
      'entity_cooccurrences',
      'maintenance_records',
      'trivium_sync_tasks',
    ]) {
      sqlite.exec(`DROP TABLE IF EXISTS ${table}`)
    }
  })()
}

/** 为既有数据库幂等补齐 Kernel 基础表；新库仍由完整基线创建。 */
function ensureKernelResourceSchema(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS kernel_outbox_events (
        event_id TEXT PRIMARY KEY NOT NULL,
        event_type TEXT NOT NULL,
        durability TEXT DEFAULT 'durable' NOT NULL,
        principal_id TEXT NOT NULL,
        process_id TEXT,
        execution_id TEXT,
        correlation_id TEXT,
        causation_id TEXT,
        object_type TEXT,
        object_id TEXT,
        object_generation INTEGER,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        attempts INTEGER DEFAULT 0 NOT NULL,
        last_error TEXT,
        next_attempt_at TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')) NOT NULL,
        published_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kernel_outbox_status_created
        ON kernel_outbox_events (status, created_at);
      CREATE INDEX IF NOT EXISTS idx_kernel_outbox_execution
        ON kernel_outbox_events (execution_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_kernel_outbox_correlation
        ON kernel_outbox_events (correlation_id);

      CREATE TABLE IF NOT EXISTS observer_processed_events (
        event_id TEXT PRIMARY KEY NOT NULL,
        processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_state_measurements (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        confidence REAL NOT NULL,
        source_event_id TEXT NOT NULL,
        source_event_type TEXT NOT NULL,
        explanation TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE(source_event_id, metric)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_state_agent_observed
        ON agent_state_measurements (agent_id, observed_at);
      CREATE TABLE IF NOT EXISTS observer_policies (
        agent_id TEXT PRIMARY KEY NOT NULL,
        enabled INTEGER DEFAULT 1 NOT NULL,
        inject_context INTEGER DEFAULT 0 NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kernel_assets (
        asset_id TEXT PRIMARY KEY NOT NULL,
        object_type TEXT DEFAULT 'asset' NOT NULL,
        object_generation INTEGER DEFAULT 1 NOT NULL,
        owner_principal_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        storage_ref TEXT NOT NULL,
        retention TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kernel_assets_owner
        ON kernel_assets (owner_principal_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_kernel_assets_sha256 ON kernel_assets (sha256);

      CREATE TABLE IF NOT EXISTS kernel_transfers (
        transfer_id TEXT PRIMARY KEY NOT NULL,
        object_generation INTEGER DEFAULT 1 NOT NULL,
        direction TEXT NOT NULL,
        state TEXT NOT NULL,
        source_ref_json TEXT,
        destination_ref_json TEXT,
        bytes_total INTEGER,
        bytes_transferred INTEGER DEFAULT 0 NOT NULL,
        checksum TEXT,
        result_asset_ref_json TEXT,
        principal_id TEXT NOT NULL,
        process_id TEXT,
        execution_id TEXT,
        correlation_id TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kernel_transfers_principal
        ON kernel_transfers (principal_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_kernel_transfers_state
        ON kernel_transfers (state, created_at);
      CREATE INDEX IF NOT EXISTS idx_kernel_transfers_execution
        ON kernel_transfers (execution_id, created_at);

      CREATE TABLE IF NOT EXISTS durable_notifications (
        notification_id TEXT PRIMARY KEY NOT NULL,
        principal_id TEXT NOT NULL,
        audience_json TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        level TEXT DEFAULT 'info' NOT NULL,
        status TEXT DEFAULT 'unread' NOT NULL,
        revision INTEGER DEFAULT 1 NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        metadata_json TEXT DEFAULT '{}' NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_durable_notifications_principal_status
        ON durable_notifications (principal_id, status, created_at);

      CREATE TABLE IF NOT EXISTS notification_feed (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        notification_id TEXT NOT NULL UNIQUE REFERENCES durable_notifications(notification_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS notification_device_receipts (
        device_id TEXT NOT NULL,
        notification_id TEXT NOT NULL REFERENCES durable_notifications(notification_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        presented_at TEXT,
        read_at TEXT,
        PRIMARY KEY (device_id, notification_id)
      );

      CREATE TABLE IF NOT EXISTS subscription_cursors (
        stream_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        sequence INTEGER DEFAULT 0 NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stream_id, consumer_id)
      );

      CREATE TABLE IF NOT EXISTS stronghold_agent_pair_visibility (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        observed_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(agent_id, pair_id)
      );
      CREATE INDEX IF NOT EXISTS idx_stronghold_visibility_agent_observed
        ON stronghold_agent_pair_visibility (agent_id, observed_at);
      CREATE INDEX IF NOT EXISTS idx_stronghold_visibility_pair
        ON stronghold_agent_pair_visibility (pair_id);

      CREATE TABLE IF NOT EXISTS event_notes (
        id TEXT PRIMARY KEY NOT NULL,
        tdb_id INTEGER NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        narrative TEXT NOT NULL,
        event_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        importance INTEGER NOT NULL,
        affect_json TEXT NOT NULL,
        participants_json TEXT DEFAULT '[]' NOT NULL,
        places_json TEXT DEFAULT '[]' NOT NULL,
        objects_json TEXT DEFAULT '[]' NOT NULL,
        topics_json TEXT DEFAULT '[]' NOT NULL,
        origin_json TEXT NOT NULL,
        status TEXT DEFAULT 'active' NOT NULL,
        replaced_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_event_notes_agent_event ON event_notes(agent_id, event_at);
      CREATE INDEX IF NOT EXISTS idx_event_notes_agent_status ON event_notes(agent_id, status);
      CREATE TABLE IF NOT EXISTS event_note_coverages (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        pair_ids_json TEXT NOT NULL,
        message_ids_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        event_note_ids_json TEXT DEFAULT '[]' NOT NULL,
        mode TEXT NOT NULL,
        covered_at TEXT NOT NULL,
        invalidated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_event_coverages_agent_thread ON event_note_coverages(agent_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_event_coverages_thread_active ON event_note_coverages(thread_id, invalidated_at);
      CREATE TABLE IF NOT EXISTS event_memory_coverage_claims (
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY(agent_id, thread_id, pair_id)
      );
      CREATE INDEX IF NOT EXISTS idx_event_coverage_claim_owner ON event_memory_coverage_claims(owner_id);
      CREATE TABLE IF NOT EXISTS event_memory_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        attempts INTEGER DEFAULT 0 NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        committed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_event_operations_status ON event_memory_operations(status, created_at);
      CREATE TABLE IF NOT EXISTS event_memory_relations (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1 NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_id, target_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_event_relations_agent ON event_memory_relations(agent_id, relation);
      CREATE TABLE IF NOT EXISTS event_memory_daily_note_tasks (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        date TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        attempts INTEGER DEFAULT 0 NOT NULL,
        next_attempt_at TEXT,
        source_incomplete INTEGER DEFAULT false NOT NULL,
        written_files_json TEXT DEFAULT '[]' NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_event_daily_note_due ON event_memory_daily_note_tasks(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS event_memory_reflection_tasks (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        attempts INTEGER DEFAULT 0 NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_event_reflection_task_status ON event_memory_reflection_tasks(status, updated_at);
      CREATE TABLE IF NOT EXISTS event_memory_query_audits (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        query_json TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        returned_tokens INTEGER NOT NULL,
        truncated INTEGER DEFAULT false NOT NULL,
        queried_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_query_audits_agent_time ON event_memory_query_audits(agent_id, queried_at);
      CREATE TABLE IF NOT EXISTS event_memory_timers (
        key TEXT PRIMARY KEY NOT NULL,
        elapsed_seconds INTEGER DEFAULT 0 NOT NULL,
        checkpoint_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fact_memory_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        attempts INTEGER DEFAULT 0 NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        committed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fact_operations_status ON fact_memory_operations(status, created_at);
      CREATE TABLE IF NOT EXISTS fact_objects (
        id TEXT PRIMARY KEY NOT NULL,
        tdb_id INTEGER NOT NULL UNIQUE,
        standard_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        aliases_json TEXT DEFAULT '[]' NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fact_records (
        id TEXT PRIMARY KEY NOT NULL,
        tdb_id INTEGER NOT NULL UNIQUE,
        object_id TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT DEFAULT 'active' NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT,
        confidence REAL,
        created_by_agent_id TEXT NOT NULL,
        superseded_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fact_records_object_status ON fact_records(object_id, status);
    `)
    const columns = sqlite.prepare('PRAGMA table_info(kernel_outbox_events)').all() as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'next_attempt_at')) {
      sqlite.exec('ALTER TABLE kernel_outbox_events ADD COLUMN next_attempt_at TEXT')
    }
    const modelColumns = sqlite.prepare('PRAGMA table_info(ai_model_configs)').all() as Array<{
      name: string
    }>
    const modelAdditions = [
      ['context_window_tokens', 'INTEGER'],
      ['max_react_turns', 'INTEGER'],
      ['return_native_reasoning', 'INTEGER DEFAULT false'],
      ['wire_api', "TEXT DEFAULT 'chat_completions'"],
      ['reasoning_dialect', "TEXT DEFAULT 'auto'"],
    ] as const
    for (const [name, definition] of modelAdditions) {
      if (!modelColumns.some((column) => column.name === name)) {
        sqlite.exec(`ALTER TABLE ai_model_configs ADD COLUMN ${name} ${definition}`)
      }
    }
  })()
}

/** 为既有数据库补齐 Thread 执行模式及会话技能选择字段。 */
function ensureThreadExecutionModeSchema(sqlite: Database.Database): void {
  const columns = new Set(
    sqlite
      .prepare('PRAGMA table_info(threads)')
      .all()
      .map((row) => (row as { name: string }).name),
  )
  if (!columns.has('enabled_skills_json')) {
    sqlite.exec("ALTER TABLE threads ADD COLUMN enabled_skills_json TEXT DEFAULT '[]' NOT NULL")
  }
  if (!columns.has('auto_execute_tools')) {
    sqlite.exec('ALTER TABLE threads ADD COLUMN auto_execute_tools INTEGER DEFAULT false NOT NULL')
  }
  if (!columns.has('execution_mode')) {
    sqlite.transaction(() => {
      sqlite.exec("ALTER TABLE threads ADD COLUMN execution_mode TEXT DEFAULT 'manual' NOT NULL")
      sqlite.exec(
        "UPDATE threads SET execution_mode = CASE WHEN auto_execute_tools = 1 THEN 'auto' ELSE 'manual' END",
      )
    })()
  }
}

/** 为既有数据库补齐Agent求助请求表。 */
function ensureAgentInputSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_input_requests (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      task_id TEXT,
      question TEXT NOT NULL,
      context TEXT,
      options_json TEXT DEFAULT '[]' NOT NULL,
      allow_free_text INTEGER DEFAULT true NOT NULL,
      required INTEGER DEFAULT false NOT NULL,
      status TEXT NOT NULL,
      selected_option_ids_json TEXT DEFAULT '[]' NOT NULL,
      response_message TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_input_status
      ON agent_input_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_input_thread
      ON agent_input_requests(thread_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_input_session
      ON agent_input_requests(session_id, status);
  `)
}

/** 为既有数据库补齐审批提醒等级字段。 */
function ensureApprovalRiskSchema(sqlite: Database.Database): void {
  const columns = new Set(
    sqlite
      .prepare('PRAGMA table_info(tool_approval_requests)')
      .all()
      .map((row) => (row as { name: string }).name),
  )
  if (!columns.has('risk_level')) {
    sqlite.exec(
      "ALTER TABLE tool_approval_requests ADD COLUMN risk_level TEXT DEFAULT 'low' NOT NULL",
    )
  }
}

/** Drizzle 数据库实例类型 */
export type DrizzleDb = ReturnType<typeof createDrizzleConnection>

/**
 * 创建并配置 Drizzle + SQLite 连接
 * @param databasePath - SQLite 文件路径
 */
export function createDrizzleConnection(databasePath: string) {
  logger.info(__t('logs.database', '正在连接数据库 → {0}', [databasePath]))

  // Steam Cloud 下载不能覆盖正在打开的 SQLite。Electron 将云端快照写为
  // infos.db.cloud-pending，Daemon 下次启动在建连前原子替换主库。
  const pendingRestorePath = `${databasePath}.cloud-pending`
  if (existsSync(pendingRestorePath)) {
    const backupPath = `${databasePath}.before-cloud-restore`
    try {
      rmSync(backupPath, { force: true })
      if (existsSync(databasePath)) renameSync(databasePath, backupPath)
      renameSync(pendingRestorePath, databasePath)
      rmSync(`${databasePath}-wal`, { force: true })
      rmSync(`${databasePath}-shm`, { force: true })
      logger.info(
        __t('logs.database', '已在启动前恢复 Steam Cloud 数据库快照，旧库备份: {0}', [backupPath]),
      )
    } catch (error) {
      logger.error(__t('logs.database', '恢复 Steam Cloud 数据库快照失败: {0}', [error]))
      if (!existsSync(databasePath) && existsSync(backupPath)) renameSync(backupPath, databasePath)
    }
  }

  const sqlite = new Database(databasePath)

  sqlite.pragma('journal_mode = WAL')
  // 全局采用 WAL + NORMAL 分级刷盘基线，避免普通写操作在容器挂载卷上触发同步 fsync 阻塞主线程；
  // 用户输入接收确认边界仍通过 durableQueueWrite 单事务临时提升至 synchronous = FULL。
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('journal_size_limit = 67108864')
  sqlite.pragma('temp_store = MEMORY')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('cache_size = -20000')
  sqlite.pragma('foreign_keys = ON')
  // 删除时覆盖 SQLite 释放页中的正文；WAL 在清理任务完成后收口。
  sqlite.pragma('secure_delete = ON')

  const tableCheck = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='configs'")
    .get()

  const appRoot = process.env.PERO_APP_ROOT
  const migrationsDir = appRoot
    ? resolve(appRoot, 'backend', 'src', 'database', 'migrations')
    : resolve(dirname(fileURLToPath(import.meta.url)), 'migrations')
  const db = drizzle(sqlite, { schema })
  try {
    if (!tableCheck) logger.info(__t('logs.database', '检测到首次启动，正在执行数据库迁移...'))
    applySchemaMigrations(sqlite, db, migrationsDir, Boolean(tableCheck))
    logger.success(__t('logs.database', '数据库结构迁移完成'))
  } catch (error) {
    sqlite.close()
    logger.error(__t('logs.database', '数据库结构迁移失败: {0}', [error]), {
      diagnostic: storeDiagnostic(error, 'schema-migration'),
    })
    throw error
  }

  ensureKernelResourceSchema(sqlite)
  ensureThreadExecutionModeSchema(sqlite)
  ensureAgentInputSchema(sqlite)
  ensureApprovalRiskSchema(sqlite)
  removeLegacyMemorySchema(sqlite)

  sqliteConnections.set(db, sqlite)
  logger.success(__t('logs.database', '数据库连接成功'))
  return db
}

/** 完成 WAL Checkpoint并关闭对应 SQLite连接。 */
export function closeDrizzleConnection(db: DrizzleDb): void {
  const sqlite = sqliteConnections.get(db)
  if (!sqlite?.open) return
  sqlite.pragma('wal_checkpoint(TRUNCATE)')
  sqlite.close()
  sqliteConnections.delete(db)
  logger.info(__t('logs.database', '数据库 WAL已收口，连接已关闭'))
}

/** 队列提交必须先完成 WAL 同步，再向客户端确认已接收。 */
export function durableQueueWrite<T>(db: DrizzleDb, operation: () => T): T {
  const sqlite = sqliteConnections.get(db)
  if (!sqlite) throw new Error('消息队列无法取得数据库持久连接')
  const previous = sqlite.pragma('synchronous', { simple: true }) as number
  sqlite.pragma('synchronous = FULL')
  try {
    return db.transaction(operation)
  } finally {
    sqlite.pragma(`synchronous = ${previous}`)
  }
}
