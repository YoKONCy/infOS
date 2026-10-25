import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { BackupModule, BackupRow, BackupSelection, ImportPolicy } from './backupTypes'

export const MODULE_TABLES: Partial<Record<BackupModule, string[]>> = {
  settings: ['configs', 'provider_connections', 'ai_model_configs', 'mcp_configs'],
  conversations: ['threads', 'thread_messages', 'message_attachments', 'thread_character_state_events', 'social_messages'],
  memory: ['event_notes', 'event_memory_relations', 'event_note_coverages', 'social_contact_impressions'],
  facts: ['fact_objects', 'fact_records'],
  knowledge: ['knowledge_documents', 'knowledge_parts'],
  tasks: ['background_tasks', 'task_plans', 'task_plan_mutations'],
}
export const TABLES = new Set<string>(Object.values(MODULE_TABLES).flatMap((tables) => tables ?? []))
export const SOCIAL_TABLE = 'backup_social_nodes'
export function validateSocialBackup(rows: BackupRow[]): void {
  const groups = new Map<string, Set<number>>()
  for (const row of rows) {
    if (typeof row.agent_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(row.agent_id) || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id < 0 || typeof row.payload_json !== 'string' || typeof row.edges_json !== 'string') throw new Error('BACKUP_RECORD_INVALID')
    const payload = JSON.parse(row.payload_json), edges = JSON.parse(row.edges_json)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(edges) || edges.some((edge) => !Number.isSafeInteger(edge.targetId) || typeof edge.label !== 'string' || edge.label.length > 128 || !Number.isFinite(edge.weight) || edge.weight < 0)) throw new Error('BACKUP_RECORD_INVALID')
    const ids = groups.get(row.agent_id) ?? new Set<number>()
    if (ids.has(row.id)) throw new Error('BACKUP_RECORD_INVALID')
    ids.add(row.id); groups.set(row.agent_id, ids)
  }
  for (const row of rows) if ((JSON.parse(String(row.edges_json)) as { targetId: number }[]).some((edge) => !groups.get(String(row.agent_id))!.has(edge.targetId))) throw new Error('BACKUP_REFERENCE_INVALID')
}
function isSecretKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return /(?:^|[.\-_])(?:api_?key|access_?token|refresh_?token|auth_?token|bot_?token|server_?token|password|passwd|secret|client_secret|cookies?|private_key|authorization|credentials?)(?:$|_(?:ciphertext|encrypted|value|key|ref|id)$)/.test(normalized) || /(?:^|\.)token$/.test(normalized)
}
const localConfig = /^(?:distributed\.|node\.|kernel\.|gateway\.|client[_-]?access)/i
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
export const readTable = (db: Database.Database, name: string): BackupRow[] =>
  db.prepare(`SELECT * FROM ${quote(name)}`).all() as BackupRow[]
export function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

/** 恢复只恢复任务记录，不能重放在途执行、审批或外部投递。 */
export function sanitizeRestoredDatabase(db: Database.Database): void {
  if (hasTable(db, 'threads')) db.exec("UPDATE threads SET execution_mode='manual', auto_execute_tools=0")
  if (hasTable(db, 'background_tasks')) db.exec("UPDATE background_tasks SET status='paused', checkpoint_json=NULL WHERE status NOT IN ('completed','failed','cancelled')")
  if (hasTable(db, 'task_deliveries')) db.exec("UPDATE task_deliveries SET status='cancelled' WHERE status IN ('pending','sending','queued')")
  if (hasTable(db, 'kernel_outbox_events')) db.exec("DELETE FROM kernel_outbox_events WHERE status='pending'")
  for (const table of ['node_capability_registrations', 'app_resource_grants', 'agent_input_requests', 'tool_approval_requests', 'conversation_queue_items', 'conversation_queue_threads']) if (hasTable(db, table)) db.exec(`DELETE FROM "${table}"`)
}

/** 完整恢复沿用目标节点注册，来源执行状态只作为历史保留。 */
export function prepareRestoredDatabase(incoming: string, previous: string): void {
  const db = new Database(incoming, { fileMustExist: true })
  try {
    sanitizeRestoredDatabase(db)
    const local = new Database(previous, { readonly: true, fileMustExist: true })
    try {
      if (hasTable(local, 'node_capability_registrations') && hasTable(db, 'node_capability_registrations')) {
        for (const row of readTable(local, 'node_capability_registrations')) {
          const names = Object.keys(row)
          db.prepare(`INSERT INTO node_capability_registrations (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((name) => row[name]))
        }
      }
    } finally { local.close() }
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('BACKUP_DATABASE_INVALID')
  } finally { db.close() }
}

/** 只删凭据字段，保留非敏感业务设置；不将占位符写成有效密钥。 */
export function redactBackupValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBackupValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !isSecretKey(key)).map(([key, item]) => [key, redactBackupValue(item)]))
  return value
}

export function redactBackupRow(table: string, row: BackupRow): BackupRow | null {
  const result = { ...row }
  if (table === 'configs' && (localConfig.test(String(row.key)) || isSecretKey(String(row.key)))) return null
  for (const [key, value] of Object.entries(result)) {
    if (isSecretKey(key)) result[key] = ''
    else if (['configs', 'ai_model_configs', 'provider_connections', 'mcp_configs'].includes(table) && typeof value === 'string' && /^[\[{]/.test(value)) {
      try { result[key] = JSON.stringify(redactBackupValue(JSON.parse(value))) } catch { /* 普通正文保留原样。 */ }
    }
  }
  // 命令行凭据难以可靠分离；未携带密钥的包不导出 MCP 执行环境。
  if (table === 'mcp_configs') { result.env = '{}'; result.args = '[]'; result.enabled = 0 }
  return result
}

export function selectBackupRecords(db: Database.Database, selection: BackupSelection): Map<string, BackupRow[]> {
  const output = new Map<string, BackupRow[]>()
  const modules = new Set(selection.modules)
  const agents = new Set(selection.agentIds)
  const agentMatch = (row: BackupRow) => !agents.size || agents.has(String(row.agent_id))
  const get = (table: string) => hasTable(db, table) ? readTable(db, table) : []
  const selectedThreads = get('threads').filter((row) => agentMatch(row) && (!selection.threadIds.length || selection.threadIds.includes(String(row.id))))
  const allTasks = modules.has('tasks') ? get('background_tasks') : []
  const tasks = allTasks.filter((row) => agentMatch(row) && (!selection.taskIds.length || selection.taskIds.includes(String(row.id))))
  const taskIds = new Set(tasks.map((row) => String(row.id)))
  for (let index = 0; index < tasks.length; index++) {
    const parent = allTasks.find((row) => row.id === tasks[index]!.parent_task_id)
    if (parent && !taskIds.has(String(parent.id))) { tasks.push(parent); taskIds.add(String(parent.id)) }
  }
  const threads = new Set([
    ...(modules.has('conversations') ? selectedThreads.map((row) => String(row.id)) : []),
    ...tasks.map((row) => String(row.thread_id)),
    ...tasks.filter((row) => row.target_thread_id).map((row) => String(row.target_thread_id)),
  ])
  if (threads.size) modules.add('conversations')
  const docs = new Set(get('knowledge_documents').filter((row) => !selection.documentIds.length || selection.documentIds.includes(String(row.id))).map((row) => String(row.id)))
  const facts = get('fact_records').filter((row) => !selection.factIds.length || selection.factIds.includes(String(row.id)) || selection.factIds.includes(String(row.object_id)))
  const objects = new Set(facts.map((row) => String(row.object_id)))
  let bytes = 0
  for (const module of modules) for (const table of MODULE_TABLES[module] ?? []) {
    let rows = table === 'background_tasks' ? tasks : get(table)
    if (module === 'conversations') rows = table === 'social_messages'
      ? rows.filter((row) => agentMatch(row) && (!selection.threadIds.length || selectedThreads.some((thread) => thread.agent_id === row.agent_id && thread.platform_identifier === row.channel_id && thread.platform === row.platform)))
      : rows.filter((row) => threads.has(String(table === 'threads' ? row.id : row.thread_id)))
    if (module === 'memory') rows = rows.filter(agentMatch)
    if (table === 'event_note_coverages') rows = rows.filter((row) => threads.has(String(row.thread_id)))
    if (table === 'knowledge_documents') rows = rows.filter((row) => docs.has(String(row.id)))
    if (table === 'knowledge_parts') rows = rows.filter((row) => docs.has(String(row.document_id)))
    if (table === 'fact_records') rows = facts
    if (table === 'fact_objects') rows = rows.filter((row) => objects.has(String(row.id)))
    if (table === 'task_plans' || table === 'task_plan_mutations') rows = rows.filter((row) => tasks.some((task) => task.thread_id === row.thread_id))
    if (module === 'settings') rows = rows.filter((row) => table !== 'configs' || !localConfig.test(String(row.key)))
    if (!selection.includeSecrets) rows = rows.map((row) => redactBackupRow(table, row)).filter((row): row is BackupRow => row !== null)
    bytes += Buffer.byteLength(JSON.stringify(rows))
    // 附件流式处理；逻辑记录单包最多 256 MiB，避免大消息耗尽主进程内存。
    if (bytes > 256 * 1024 ** 2 || rows.length > 500_000) throw new Error('BACKUP_RECORD_LIMIT')
    output.set(table, rows)
  }
  return output
}

interface Column { name: string; type: string; pk: number }
const columns = (db: Database.Database, table: string) => db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Column[]
function naturalKeys(db: Database.Database, table: string): string[][] {
  const indices = db.prepare(`PRAGMA index_list(${quote(table)})`).all() as { name: string; unique: number; partial: number; origin: string }[]
  return indices.filter((index) => index.unique && !index.partial && index.origin !== 'pk').map((index) => (db.prepare(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string | null }[]).map((column) => column.name).filter((name): name is string => name !== null)).filter((names) => names.length > 0)
}
function naturalConflict(db: Database.Database, table: string, row: BackupRow, indices = naturalKeys(db, table)): BackupRow | undefined {
  for (const keys of indices) {
    if (keys.some((key) => row[key] === null || row[key] === undefined)) continue
    const existing = db.prepare(`SELECT * FROM ${quote(table)} WHERE ${keys.map((key) => `${quote(key)} IS ?`).join(' AND ')}`).get(...keys.map((key) => row[key])) as BackupRow | undefined
    if (existing) return existing
  }
}
function sameRecordContext(source: BackupRow, target: BackupRow): boolean {
  return ['thread_id', 'document_id', 'agent_id', 'name', 'ordinal', 'platform', 'account_id', 'channel_id', 'msg_id', 'user_id'].every((key) => !(key in source) || source[key] === target[key])
}
export function recordConflicts(db: Database.Database, table: string, rows: BackupRow[]): number {
  const keys = columns(db, table).filter((column) => column.pk).map((column) => column.name)
  if (!keys.length) throw new Error('BACKUP_TABLE_UNSUPPORTED')
  const query = db.prepare(`SELECT * FROM ${quote(table)} WHERE ${keys.map((key) => `${quote(key)} IS ?`).join(' AND ')}`)
  const indices = naturalKeys(db, table)
  return rows.filter((row) => {
    const primary = query.get(...keys.map((key) => row[key])) as BackupRow | undefined
    return Boolean(naturalConflict(db, table, row, indices) || (primary && sameRecordContext(row, primary)))
  }).length
}

/** 所有修改在离线影子 SQLite 中完成，整批失败不会污染正在使用的数据。 */
export function mergeBackupRecords(db: Database.Database, tables: Map<string, BackupRow[]>, policy: ImportPolicy, namespace: string): void {
  validateSocialBackup(tables.get(SOCIAL_TABLE) ?? [])
  tables = new Map([...tables].filter(([table]) => table !== SOCIAL_TABLE))
  const strings = new Map<string, string>(Object.entries(policy.agentTargets))
  const numbers = new Map<string, Map<number, number>>()
  const primary = new Map<string, Column[]>()
  const tdb = new Map<string, number>()
  const clonedThreads = new Set((tables.get('threads') ?? []).filter((row) => policy.agentTargets[String(row.agent_id)] && policy.agentTargets[String(row.agent_id)] !== row.agent_id).map((row) => String(row.id)))
  const roleTables = new Set([...(MODULE_TABLES.conversations ?? []), ...(MODULE_TABLES.memory ?? []), ...(MODULE_TABLES.tasks ?? [])])
  const cloneRow = (table: string, row: BackupRow) => policy.conflict === 'duplicate' || (roleTables.has(table) && ((typeof row.agent_id === 'string' && Boolean(policy.agentTargets[row.agent_id]) && policy.agentTargets[row.agent_id] !== row.agent_id) || clonedThreads.has(String(row.thread_id))))
  const importedId = (value: string) => {
    const hash = createHash('sha256').update(`${namespace}:${value}`).digest('hex').slice(0, 32)
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`
  }
  for (const [table, rows] of tables) {
    if (!TABLES.has(table) || !hasTable(db, table)) throw new Error('BACKUP_TABLE_UNSUPPORTED')
    const cols = columns(db, table)
    const keys = cols.filter((column) => column.pk)
    primary.set(table, keys)
    for (const row of rows) if (Object.keys(row).some((key) => !cols.some((column) => column.name === key)) || Object.values(row).some((value) => value !== null && typeof value !== 'string' && typeof value !== 'number')) throw new Error('BACKUP_RECORD_INVALID')
    if (keys.length === 1 && keys[0]!.type.toUpperCase() === 'INTEGER') {
      const key = keys[0]!.name
      let next = Number((db.prepare(`SELECT COALESCE(MAX(${quote(key)}),0) AS id FROM ${quote(table)}`).get() as { id: number }).id)
      for (const row of rows) next = Math.max(next, Number(row[key]))
      const map = new Map<number, number>()
      const query = db.prepare(`SELECT * FROM ${quote(table)} WHERE ${quote(key)}=?`)
      const indices = naturalKeys(db, table)
      for (const source of rows) {
        const row = { ...source }
        if (typeof row.agent_id === 'string') row.agent_id = policy.agentTargets[row.agent_id] ?? row.agent_id
        const cloned = cloneRow(table, source)
        const natural = cloned && table !== 'social_contact_impressions' ? undefined : naturalConflict(db, table, row, indices)
        const previous = query.get(source[key]) as BackupRow | undefined
        map.set(Number(source[key]), natural ? Number(natural[key]) : cloned || (previous && !sameRecordContext(row, previous)) ? ++next : Number(source[key]))
      }
      numbers.set(table, map)
    } else if (!['configs', 'fact_objects'].includes(table)) {
      for (const row of rows) if (cloneRow(table, row)) for (const key of keys) if (key.name === 'id' && typeof row.id === 'string') strings.set(row.id, importedId(row.id))
    }
  }
  for (const [table, rows] of tables) for (const row of rows) if (cloneRow(table, row)) for (const key of ['pair_id', 'call_id', 'tool_call_id']) {
    if (typeof row[key] === 'string' && row[key]) strings.set(String(row[key]), importedId(String(row[key])))
  }
  // 事实对象按规范名复用，避免重复导入撞上语义唯一索引。
  for (const row of tables.get('fact_objects') ?? []) {
    const existing = db.prepare('SELECT id FROM fact_objects WHERE normalized_name=?').get(row.normalized_name) as { id: string } | undefined
    if (existing) strings.set(String(row.id), existing.id)
    else if (policy.conflict === 'duplicate') strings.set(String(row.id), importedId(String(row.id)))
  }
  const referenceTable: Record<string, string> = { message_id: 'thread_messages', messageId: 'thread_messages', model_config_id: 'ai_model_configs', modelConfigId: 'ai_model_configs', parent_id: 'thread_messages' }
  function rewrite(value: unknown, key = ''): unknown {
    if (typeof value === 'string') {
      if (strings.has(value) && /^(?:id|.*_id|.*Id|.*Ids|agent|source|target|replaced_by|superseded_by)$/.test(key)) return strings.get(value)
      if (key.endsWith('_json') || key === 'value' || key === 'env' || key === 'args') {
        try { return JSON.stringify(rewrite(JSON.parse(value), key.replace(/_json$/, ''))) } catch { return value }
      }
      return value.replace(/(\/api\/attachments\/|attachment:)([a-f0-9-]{36})/gi, (_match, prefix: string, id: string) => prefix + (strings.get(id) ?? id))
    }
    if (typeof value === 'number') return numbers.get(referenceTable[key] ?? '')?.get(value) ?? value
    if (Array.isArray(value)) {
      const entryKey = /(?:_ids|Ids)$/.test(key) ? key.slice(0, -1) : key
      return value.map((entry) => rewrite(entry, entryKey))
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, rewrite(entry, name)]))
    return value
  }
  db.pragma('foreign_keys = ON')
  db.transaction(() => {
    for (const [table, rows] of tables) {
      const keys = primary.get(table)!
      for (const source of rows) {
        const row = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, rewrite(value, key)])) as BackupRow
        const numberMap = numbers.get(table)
        if (numberMap) row[keys[0]!.name] = numberMap.get(Number(source[keys[0]!.name]))!
        if (table === 'threads') { row.model_config_id = null; row.execution_mode = 'manual'; row.auto_execute_tools = 0 }
        if (table === 'configs') {
          const key = String(row.key)
          if (/^model\.(?:main|task\.|agent\.)/.test(key) && /^\d+$/.test(String(row.value))) row.value = String(numbers.get('ai_model_configs')?.get(Number(row.value)) ?? row.value)
          if (key.startsWith('model.agent.')) {
            const agentId = key.slice('model.agent.'.length)
            row.key = `model.agent.${policy.agentTargets[agentId] ?? agentId}`
          }
        }
        if (table === 'background_tasks' && !['completed', 'failed', 'cancelled'].includes(String(row.status))) { row.status = 'paused'; row.checkpoint_json = null }
        if (table === 'message_attachments') row.deleted_at = source.deleted_at ?? null
        if ('tdb_id' in row) {
          const group = table === 'event_notes' ? 'event' : 'facts'
          if (!tdb.has(group)) tdb.set(group, group === 'event'
            ? Number((db.prepare('SELECT COALESCE(MAX(tdb_id),0) AS id FROM event_notes').get() as { id: number }).id)
            : Math.max(...['fact_objects', 'fact_records'].map((name) => Number((db.prepare(`SELECT COALESCE(MAX(tdb_id),0) AS id FROM ${name}`).get() as { id: number }).id))))
          row.tdb_id = tdb.get(group)! + 1
          tdb.set(group, Number(row.tdb_id))
        }
        // 知识向量附带模型签名，现有索引入口会验证签名和维度，不匹配时仅使用正文。
        if (policy.conflict === 'duplicate' && ['ai_model_configs', 'mcp_configs'].includes(table)) row.name = `${row.name} · ${namespace.slice(0, 8)}`
        const existing = db.prepare(`SELECT * FROM ${quote(table)} WHERE ${keys.map((key) => `${quote(key.name)} IS ?`).join(' AND ')}`).get(...keys.map((key) => row[key.name])) as BackupRow | undefined
        if (existing && (policy.conflict !== 'replace' || table === 'fact_objects')) continue
        if (existing && ['provider_connections', 'ai_model_configs'].includes(table)) for (const key of Object.keys(row)) if (isSecretKey(key) && row[key] === '') row[key] = existing[key] ?? ''
        const names = Object.keys(row)
        const update = names.filter((name) => !keys.some((key) => key.name === name))
        const suffix = existing && update.length ? ` ON CONFLICT (${keys.map((key) => quote(key.name)).join(',')}) DO UPDATE SET ${update.map((name) => `${quote(name)}=excluded.${quote(name)}`).join(',')}` : ''
        db.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})${suffix}`).run(...names.map((name) => row[name]))
      }
    }
  })()
  if (db.pragma('foreign_key_check').length) throw new Error('BACKUP_REFERENCE_INVALID')
}
