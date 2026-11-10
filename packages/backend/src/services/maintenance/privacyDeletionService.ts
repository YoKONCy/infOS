import { t as __t } from '../../lib/i18n'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EventNoteOrigin } from '@infos/shared'
import type { EventMemoryService } from '../memory/eventMemoryService'
import type { FactsRepository } from '../../repositories/facts.repo'
import type { KnowledgeService } from '../knowledge/knowledgeService'
import type { MemoryStoreRegistry } from '../../repositories/storeRegistry'
import type { PrivacyPolicy } from './privacyPolicy'
import { createLogger } from '../../lib/logger'
import { invalidatePromptReplay } from '../llm/promptCache'

const logger = createLogger('PrivacyDeletion')
type Kind = 'memory' | 'fact' | 'knowledge' | 'reset-memory' | 'social-memory'
interface Job {
  id: string
  kind: Kind
  target_id: string
  agent_id: string | null
  metadata_json: string
  attempts: number
  status: string
}
interface MemoryRow {
  id: string
  agent_id: string
  event_at: string
  origin_json: string
}
interface Metadata {
  ids?: string[]
  agents?: string[]
  maxMessageId?: number
  maxExperienceId?: number
  includeSocial?: boolean
  dates?: Array<{ agentId: string; date: string }>
  files?: Array<{ agentId: string; name: string }>
  deleteSource?: boolean
  sources?: Array<Pick<EventNoteOrigin, 'threadId' | 'pairIds' | 'experienceIds'>>
  scenes?: Array<{ roomId: string; pairId: string; sourceMessageId: number }>
  attachments?: Array<{ id: string; storageKey: string }>
}

/** SQLite 中登记无正文的清理任务；中断后按相同标识继续跨存储删除。 */
export class PrivacyDeletionService {
  private queue: Promise<unknown> = Promise.resolve()
  private retryTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private removeAttachment?: (id: string, storageKey: string) => Promise<void>
  setAttachmentCleaner(cleaner: (id: string, storageKey: string) => Promise<void>): void {
    this.removeAttachment = cleaner
  }
  constructor(
    private readonly deps: {
      db: Database.Database
      policy: PrivacyPolicy
      memory: EventMemoryService
      facts: FactsRepository
      knowledge: KnowledgeService
      stores: MemoryStoreRegistry
      invalidateMemory(): void | Promise<void>
      removeDiary(agentId: string, name: string): Promise<void>
      listAgentIds(): string[]
      resetSqlite(): Promise<unknown>
      forgetSocial(agentId: string): Promise<void>
      retractCharacterState?(threadId: string, pairIds: string[]): Promise<void>
      retractSceneState?(roomId: string, pairId: string): Promise<void>
    },
  ) {}

  async initialize(): Promise<void> {
    // 重启后继续已获授权但失败的记忆清理，每轮仍保留五次重试上限。
    this.deps.db
      .prepare(
        "UPDATE privacy_deletions SET status='pending',attempts=0,last_error=NULL WHERE kind='memory' AND status='failed'",
      )
      .run()
    await this.recover()
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    await this.queue.catch(() => {})
  }
  list() {
    return this.deps.db
      .prepare(
        "SELECT id,kind,target_id AS targetId,status,attempts,last_error AS lastError,created_at AS createdAt,completed_at AS completedAt FROM privacy_deletions WHERE kind IN ('memory','fact','knowledge','reset-memory','social-memory') ORDER BY (status='completed'),created_at DESC LIMIT 100",
      )
      .all()
  }
  async retry(id: string): Promise<void> {
    return this.serialize(async () => {
      const job = this.deps.db
        .prepare(
          "SELECT * FROM privacy_deletions WHERE id=? AND kind IN ('memory','fact','knowledge','reset-memory','social-memory')",
        )
        .get(id) as Job | undefined
      if (!job || job.status === 'completed') return
      this.deps.db
        .prepare(
          "UPDATE privacy_deletions SET attempts=0,status='pending',last_error=NULL WHERE id=?",
        )
        .run(id)
      await this.execute({ ...job, attempts: 0 })
    })
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('数据清理服务已停止'))
    const pending = this.queue.then(run, run)
    this.queue = pending.catch(() => {})
    return pending
  }
  async deleteMemory(id: string, deleteSource = false): Promise<void> {
    return this.serialize(async () => {
      const { db, policy } = this.deps
      const rows = db
        .prepare(
          `WITH RECURSIVE versions AS (
        SELECT * FROM event_notes WHERE id=? UNION
        SELECT e.* FROM event_notes e JOIN versions v ON e.replaced_by=v.id OR e.id=v.replaced_by
      ) SELECT * FROM versions`,
        )
        .all(id) as MemoryRow[]
      const old = this.job('memory', id)
      if (!rows.length && !old) return
      const agents = [...new Set(rows.map((row) => row.agent_id))]
      const sources = rows.flatMap((row) => {
        const origin = JSON.parse(row.origin_json) as EventNoteOrigin
        return [origin, ...(origin.sources ?? [])]
      })
      const scenes = sources.flatMap((source) => (source.experienceIds ?? []).flatMap((id) =>
        db.prepare('SELECT m.room_id AS roomId,m.pair_id AS pairId,m.id AS sourceMessageId FROM agent_experiences e JOIN group_chat_messages m ON m.id=e.source_message_id WHERE e.id=? AND e.thread_id=?')
          .all(Number(id), source.threadId) as Array<{ roomId: string; pairId: string; sourceMessageId: number }>,
      ))
      const attachments = deleteSource
        ? sources.flatMap(
            (source) =>
              db
                .prepare(
                  `SELECT a.id,a.storage_key AS storageKey FROM message_attachments a
        JOIN thread_messages m ON a.message_id=m.id WHERE m.thread_id=? AND
          (m.pair_id IN (SELECT value FROM json_each(?)) OR m.id IN (SELECT value FROM json_each(?)))`,
                )
                .all(source.threadId, JSON.stringify(source.pairIds), JSON.stringify(source.messageIds)) as Array<{
                id: string
                storageKey: string
              }>,
          )
        : []
      const dates = new Set(
        rows.map((row) => {
          const date = new Date(row.event_at)
          return `${row.agent_id}:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        }),
      )
      const diaries = db
        .prepare('SELECT agent_id,date,written_files_json FROM event_memory_daily_note_tasks')
        .all() as Array<{ agent_id: string; date: string; written_files_json: string }>
      const files = diaries
        .filter((row) => dates.has(`${row.agent_id}:${row.date}`))
        .flatMap((row) =>
          (JSON.parse(row.written_files_json) as string[]).map((name) => ({
            agentId: row.agent_id,
            name,
          })),
        )
      const affectedDates = diaries
        .filter((row) => dates.has(`${row.agent_id}:${row.date}`))
        .map((row) => ({ agentId: row.agent_id, date: row.date }))
      db.transaction(() => {
        if (deleteSource) for (const scene of scenes) {
          db.prepare("UPDATE group_chat_messages SET status='deleted' WHERE id=?").run(scene.sourceMessageId)
          db.prepare('UPDATE agent_experiences SET withdrawn=1 WHERE source_message_id=?').run(scene.sourceMessageId)
        }
        for (const row of rows) {
          this.mark('memory-block', row.id, row.agent_id, {}, 'completed')
          const origin = JSON.parse(row.origin_json) as EventNoteOrigin
          for (const source of [origin, ...(origin.sources ?? [])]) for (const pairId of source.pairIds)
            this.mark(
              'memory-source',
              policy.sourceKey(row.agent_id, source.threadId, pairId),
              row.agent_id,
              {},
              'completed',
            )
        }
        if (!old)
          this.mark('memory', id, agents[0] ?? null, {
            ids: rows.map((row) => row.id),
            agents,
            dates: affectedDates,
            files,
            sources,
            scenes,
            deleteSource,
            attachments,
          })
        db.prepare(
          "UPDATE event_notes SET status='archived' WHERE id IN (SELECT value FROM json_each(?))",
        ).run(JSON.stringify(rows.map((row) => row.id)))
      })()
      policy.reload()
      await this.execute(this.job('memory', id)!)
    })
  }
  async deleteFact(id: string, assertCurrent?: () => void): Promise<void> {
    return this.serialize(async () => {
      assertCurrent?.()
      const row = this.deps.db
        .prepare('SELECT id,object_id FROM fact_records WHERE id=?')
        .get(id) as { id: string; object_id: string } | undefined
      if (!row && !this.job('fact', id)) return
      this.mark('fact', id, null, {})
      if (
        row &&
        !this.deps.db
          .prepare('SELECT 1 FROM fact_records WHERE object_id=? AND id!=? LIMIT 1')
          .get(row.object_id, id)
      )
        this.mark('fact-block', row.object_id, null, {}, 'completed')
      this.deps.policy.reload()
      await this.execute(this.job('fact', id)!)
    })
  }
  async deleteKnowledge(id: string): Promise<void> {
    return this.serialize(async () => {
      if (
        !this.deps.db.prepare('SELECT id FROM knowledge_documents WHERE id=?').get(id) &&
        !this.job('knowledge', id)
      )
        return
      this.mark('knowledge', id, null, {})
      this.deps.policy.reload()
      await this.execute(this.job('knowledge', id)!)
    })
  }
  async resetMemories(includeSocial = true): Promise<void> {
    return this.serialize(async () => {
      const { db, policy } = this.deps
      const rows = db
        .prepare('SELECT id,agent_id,origin_json FROM event_notes')
        .all() as MemoryRow[]
      const socialAgents = db
        .prepare('SELECT DISTINCT agent_id FROM social_messages')
        .all() as Array<{ agent_id: string }>
      const agents = [
        ...new Set([
          ...this.deps.listAgentIds(),
          ...this.deps.stores.listStoredAgentIds(),
          ...rows.map((row) => row.agent_id),
          ...socialAgents.map((row) => row.agent_id),
        ]),
      ]
      const diaries = db
        .prepare('SELECT agent_id,written_files_json FROM event_memory_daily_note_tasks')
        .all() as Array<{ agent_id: string; written_files_json: string }>
      const files = diaries.flatMap((row) =>
        (JSON.parse(row.written_files_json) as string[]).map((name) => ({
          agentId: row.agent_id,
          name,
        })),
      )
      const target = randomUUID()
      db.transaction(() => {
        for (const row of rows) this.mark('memory-block', row.id, row.agent_id, {}, 'completed')
        for (const row of db.prepare('SELECT id FROM fact_records').all() as Array<{ id: string }>)
          this.mark('fact', row.id, null, {}, 'completed')
        // 来源对话仍保留；标记旧 Pair 已遗忘，防止兜底任务再次炼化。
        const cutoff = (
          db.prepare('SELECT coalesce(max(id),0) AS value FROM thread_messages').get() as {
            value: number
          }
        ).value
        const experienceCutoff = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_experiences'").get()
          ? (db.prepare('SELECT coalesce(max(id),0) AS value FROM agent_experiences').get() as { value: number }).value : 0
        for (const agentId of agents) {
          this.mark('memory-cutoff', agentId, agentId, { maxMessageId: cutoff, maxExperienceId: experienceCutoff }, 'completed')
          db.prepare(
            "UPDATE privacy_deletions SET metadata_json=? WHERE kind='memory-cutoff' AND target_id=?",
          ).run(JSON.stringify({ maxMessageId: cutoff, maxExperienceId: experienceCutoff }), agentId)
        }
        this.mark('reset-memory', target, null, { agents, files, includeSocial })
      })()
      policy.reload()
      await this.execute(this.job('reset-memory', target)!)
    })
  }
  async deleteSocialMemory(agentId: string): Promise<void> {
    return this.serialize(async () => {
      const target = randomUUID()
      const diaries = this.deps.db
        .prepare('SELECT written_files_json FROM event_memory_daily_note_tasks WHERE agent_id=?')
        .all(agentId) as Array<{ written_files_json: string }>
      const files = diaries.flatMap((row) =>
        (JSON.parse(row.written_files_json) as string[]).map((name) => ({ agentId, name })),
      )
      this.mark('social-memory', target, agentId, { agents: [agentId], files })
      await this.execute(this.job('social-memory', target)!)
    })
  }
  private job(kind: Kind, id: string): Job | undefined {
    return this.deps.db
      .prepare('SELECT * FROM privacy_deletions WHERE kind=? AND target_id=?')
      .get(kind, id) as Job | undefined
  }
  private mark(
    kind: string,
    target: string,
    agent: string | null,
    metadata: Metadata,
    status = 'pending',
  ): void {
    this.deps.db
      .prepare(
        'INSERT OR IGNORE INTO privacy_deletions(id,kind,target_id,agent_id,metadata_json,status,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        kind,
        target,
        agent,
        JSON.stringify(metadata),
        status,
        new Date().toISOString(),
      )
  }
  private scrubOperations(
    table: 'event_memory_operations' | 'fact_memory_operations',
    ids: string[],
  ): void {
    const { db } = this.deps
    const rows = db.prepare(`SELECT operation_id,payload_json FROM ${table}`).all() as Array<{
      operation_id: string
      payload_json: string
    }>
    const remove = db.prepare(`DELETE FROM ${table} WHERE operation_id=?`)
    for (const row of rows)
      if (ids.some((id) => row.payload_json.includes(id))) remove.run(row.operation_id)
  }
  private async execute(job: Job): Promise<void> {
    const { db, policy, memory, facts, knowledge, stores } = this.deps
    const current = db.prepare('SELECT * FROM privacy_deletions WHERE id=?').get(job.id) as
      | Job
      | undefined
    if (!current || current.status === 'completed') return
    job = current
    const metadata = JSON.parse(job.metadata_json) as Metadata
    const lock = job.kind === 'reset-memory' || job.kind === 'social-memory' ? 'memory' : job.kind
    policy.lock(lock)
    if (job.kind === 'reset-memory') policy.lock('fact')
    try {
      // 升级备份也可能含待遗忘正文，不能通过恢复旧版本重新带回已删除记忆。
      if (job.kind === 'knowledge')
        stores.discardUpgradeBackup(stores.resolveSharedStorePath('knowledge'))
      else if (job.kind === 'fact')
        stores.discardUpgradeBackup(stores.resolveSharedStorePath('facts'))
      else {
        for (const agentId of metadata.agents ?? (job.agent_id ? [job.agent_id] : [])) {
          if (job.kind !== 'social-memory')
            stores.discardUpgradeBackup(stores.resolveAgentStorePath(agentId, 'main'))
          if (
            job.kind === 'social-memory' ||
            (job.kind === 'reset-memory' && metadata.includeSocial)
          )
            stores.discardUpgradeBackup(stores.resolveAgentStorePath(agentId, 'social'))
        }
      }
      db.prepare(
        "UPDATE privacy_deletions SET attempts=attempts+1,status='pending' WHERE id=?",
      ).run(job.id)
      // 详细执行副本可能含检索正文，遗忘后不得通过旧工具链重新注入；正常重启不清理这些副本。
      invalidatePromptReplay(undefined, true)
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_executions'").get())
        db.prepare(`UPDATE conversation_executions SET metadata_json=json_set(
          json_remove(metadata_json,'$.executionMessages'),'$.workContextRevoked',json('true'))
          WHERE json_valid(metadata_json)`).run()
      const columns = db.prepare('PRAGMA table_info(thread_messages)').all() as Array<{
        name: string
      }>
      if (columns.some((column) => column.name === 'metadata_json'))
        db.prepare(
          `
        UPDATE thread_messages SET metadata_json=json_set(
          json_remove(metadata_json,'$.workContext'),'$.workContextRevoked',json('true'))
        WHERE CASE WHEN json_valid(metadata_json) THEN (
          json_type(metadata_json,'$.workContext') IS NOT NULL OR json_type(metadata_json,'$.toolCalls')='array') ELSE 0 END
      `,
        ).run()
      if (job.kind === 'memory' || job.kind === 'reset-memory' || job.kind === 'social-memory')
        await this.deps.invalidateMemory()
      if (job.kind === 'memory') {
        const ids = metadata.ids ?? [job.target_id]
        if (metadata.deleteSource) {
          for (const source of metadata.sources ?? [])
            await this.deps.retractCharacterState?.(source.threadId, source.pairIds)
          for (const scene of metadata.scenes ?? []) await this.deps.retractSceneState?.(scene.roomId, scene.pairId)
        }
        db.transaction(() => {
          this.scrubOperations('event_memory_operations', ids)
          const serialized = JSON.stringify(ids)
          db.prepare(
            'DELETE FROM event_memory_relations WHERE source_id IN (SELECT value FROM json_each(?)) OR target_id IN (SELECT value FROM json_each(?))',
          ).run(serialized, serialized)
          db.prepare(
            'DELETE FROM event_memory_reflection_tasks WHERE event_id IN (SELECT value FROM json_each(?))',
          ).run(serialized)
          db.prepare('DELETE FROM event_notes WHERE id IN (SELECT value FROM json_each(?))').run(
            serialized,
          )
          // 覆盖记录只留下来源标识，移除被删除记忆的引用。
          const coverages = db
            .prepare('SELECT id,event_note_ids_json FROM event_note_coverages')
            .all() as Array<{ id: string; event_note_ids_json: string }>
          for (const row of coverages) {
            const remaining = (JSON.parse(row.event_note_ids_json) as string[]).filter(
              (id) => !ids.includes(id),
            )
            db.prepare('UPDATE event_note_coverages SET event_note_ids_json=? WHERE id=?').run(
              JSON.stringify(remaining),
              row.id,
            )
          }
          for (const agentId of metadata.agents ?? []) {
            db.prepare('DELETE FROM event_memory_query_audits WHERE agent_id=?').run(agentId)
          }
          for (const date of metadata.dates ?? [])
            db.prepare('DELETE FROM event_memory_daily_note_tasks WHERE agent_id=? AND date=?').run(
              date.agentId,
              date.date,
            )
          if (metadata.deleteSource)
            for (const source of metadata.sources ?? []) {
              const messageIds = source.pairIds.flatMap((key) => {
                const match = /^message:(\d+)@\d+$/.exec(key)
                return match ? [Number(match[1])] : []
              })
              if (messageIds.length) {
                const ids = JSON.stringify(messageIds)
                const executions = db.prepare(`SELECT id FROM conversation_executions WHERE thread_id=? AND
                  (EXISTS (SELECT 1 FROM json_each(input_sources_json) WHERE json_extract(value,'$.messageId') IN (SELECT value FROM json_each(?)))
                   OR id IN (SELECT execution_id FROM thread_messages WHERE id IN (SELECT value FROM json_each(?)))
                   OR json_extract(metadata_json,'$.regeneration.messageId') IN (SELECT value FROM json_each(?))
                   OR EXISTS (SELECT 1 FROM json_each(metadata_json,'$.historyRevisions') WHERE json_extract(value,'$[0]') IN (SELECT value FROM json_each(?))))`)
                  .all(source.threadId, ids, ids, ids, ids) as Array<{ id: string }>
                const runIds = JSON.stringify(executions.map((run) => run.id))
                db.prepare("UPDATE conversation_executions SET status='revoked',metadata_json='{}',input_sources_json='[]' WHERE id IN (SELECT value FROM json_each(?))").run(runIds)
                db.prepare("DELETE FROM conversation_expectations WHERE execution_id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(response_sources_json) WHERE json_extract(value,'$.messageId') IN (SELECT value FROM json_each(?)))").run(runIds, ids)
                db.prepare('DELETE FROM agent_character_state_events WHERE thread_id=? AND pair_id IN (SELECT value FROM json_each(?))').run(source.threadId, runIds)
                db.prepare('DELETE FROM file_change_snapshots WHERE thread_id=? AND pair_id IN (SELECT value FROM json_each(?))').run(source.threadId, runIds)
                db.prepare("UPDATE message_attachments SET status='deleted',extracted_text=NULL,metadata_json='{}' WHERE message_id IN (SELECT value FROM json_each(?))").run(ids)
                db.prepare('DELETE FROM conversation_message_sources WHERE message_id IN (SELECT value FROM json_each(?)) OR source_message_id IN (SELECT value FROM json_each(?))').run(ids, ids)
                db.prepare('DELETE FROM thread_messages WHERE thread_id=? AND id IN (SELECT value FROM json_each(?))').run(source.threadId, ids)
                db.prepare("UPDATE conversation_queue_items SET state='cancelled',input_json=json_set(input_json,'$.content','') WHERE thread_id=? AND json_extract(input_json,'$.regeneration.messageId') IN (SELECT value FROM json_each(?))")
                  .run(source.threadId, ids)
              }
              db.prepare(
                "UPDATE message_attachments SET status='deleted',extracted_text=NULL,metadata_json='{}' WHERE message_id IN (SELECT id FROM thread_messages WHERE thread_id=? AND pair_id IN (SELECT value FROM json_each(?)))",
              ).run(source.threadId, JSON.stringify(source.pairIds))
              db.prepare(
                'DELETE FROM file_change_snapshots WHERE thread_id=? AND pair_id IN (SELECT value FROM json_each(?))',
              ).run(source.threadId, JSON.stringify(source.pairIds))
              db.prepare(
                'DELETE FROM thread_messages WHERE thread_id=? AND pair_id IN (SELECT value FROM json_each(?))',
              ).run(source.threadId, JSON.stringify(source.pairIds))
              db.prepare('DELETE FROM thread_summaries WHERE thread_id=?').run(source.threadId)
              // 旧对话日志通过 session_id 记录会话标识，并没有 thread_id 列。
              db.prepare('DELETE FROM conversation_logs WHERE session_id=?').run(source.threadId)
              db.prepare('DELETE FROM task_plan_mutations WHERE thread_id=?').run(source.threadId)
              db.prepare('DELETE FROM task_plans WHERE thread_id=?').run(source.threadId)
              db.prepare('DELETE FROM flow_state_revisions WHERE thread_id=?').run(source.threadId)
              db.prepare('DELETE FROM flow_states WHERE thread_id=?').run(source.threadId)
              db.prepare(
                "DELETE FROM thread_character_state_events WHERE kind='update' AND thread_id=? AND pair_id IN (SELECT value FROM json_each(?))",
              ).run(source.threadId, JSON.stringify(source.pairIds))
              if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_character_state_events'").get())
                db.prepare("DELETE FROM agent_character_state_events WHERE kind='update' AND thread_id=? AND pair_id IN (SELECT value FROM json_each(?))").run(source.threadId, JSON.stringify(source.pairIds))
              db.prepare(
                `UPDATE threads SET title='',message_count=(SELECT count(*) FROM thread_messages WHERE thread_id=?),
              pair_count=(SELECT count(DISTINCT pair_id) FROM thread_messages WHERE thread_id=?),
              last_message_at=(SELECT max(timestamp) FROM thread_messages WHERE thread_id=?) WHERE id=?`,
              ).run(source.threadId, source.threadId, source.threadId, source.threadId)
            }
          if (metadata.deleteSource) for (const scene of metadata.scenes ?? []) {
            db.prepare("DELETE FROM agent_character_state_events WHERE kind='update' AND pair_id=? AND thread_id IN (SELECT thread_id FROM agent_experiences WHERE source_message_id=?)").run(scene.pairId, scene.sourceMessageId)
            db.prepare('DELETE FROM agent_experiences WHERE source_message_id=?').run(scene.sourceMessageId)
            db.prepare('DELETE FROM group_chat_messages WHERE id=?').run(scene.sourceMessageId)
          }
        })()
        for (const attachment of metadata.attachments ?? []) {
          if (!this.removeAttachment) throw new Error('附件清理服务尚未就绪')
          await this.removeAttachment(attachment.id, attachment.storageKey)
          db.prepare('DELETE FROM message_attachments WHERE id=?').run(attachment.id)
        }
        for (const agentId of metadata.agents ?? []) await memory.rebuildAgentStore(agentId, true)
      } else if (job.kind === 'fact') {
        db.transaction(() => {
          this.scrubOperations('fact_memory_operations', [job.target_id])
          db.prepare('DELETE FROM fact_records WHERE id=?').run(job.target_id)
          db.prepare('UPDATE fact_records SET superseded_by=NULL WHERE superseded_by=?').run(
            job.target_id,
          )
          const unused = db
            .prepare(
              'SELECT id FROM fact_objects WHERE NOT EXISTS(SELECT 1 FROM fact_records WHERE fact_records.object_id=fact_objects.id)',
            )
            .all() as Array<{ id: string }>
          for (const object of unused) this.mark('fact-block', object.id, null, {}, 'completed')
          this.scrubOperations(
            'fact_memory_operations',
            unused.map((row) => row.id),
          )
          db.prepare(
            'DELETE FROM fact_objects WHERE NOT EXISTS(SELECT 1 FROM fact_records WHERE fact_records.object_id=fact_objects.id)',
          ).run()
        })()
        policy.reload()
        await facts.rebuildStore()
        stores.getSharedStore('facts').flush()
      } else if (job.kind === 'knowledge') {
        await knowledge.purge(job.target_id)
      } else if (job.kind === 'social-memory') {
        for (const agentId of metadata.agents ?? []) {
          await this.deps.forgetSocial(agentId)
          stores.resetAgentStore(agentId, 'social')
          db.prepare('DELETE FROM event_memory_daily_note_tasks WHERE agent_id=?').run(agentId)
        }
      } else {
        await this.deps.resetSqlite()
        for (const agentId of metadata.agents ?? []) stores.resetAgentStore(agentId, 'main')
        stores.resetSharedStore('facts')
        if (metadata.includeSocial)
          for (const agentId of metadata.agents ?? []) {
            await this.deps.forgetSocial(agentId)
            stores.resetAgentStore(agentId, 'social')
          }
      }
      for (const file of metadata.files ?? []) await this.deps.removeDiary(file.agentId, file.name)
      // 回收由删除释放的正文页；完整 VACUUM 留给显式维护，避免逐条删除阻塞界面。
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
      if (checkpoint.some((row) => row.busy !== 0))
        throw new Error('数据库仍有读取事务，稍后继续清理 WAL')
      db.prepare(
        "UPDATE privacy_deletions SET status='completed',completed_at=?,metadata_json='{}',last_error=NULL WHERE id=?",
      ).run(new Date().toISOString(), job.id)
    } catch (error) {
      const attempts = (
        db.prepare('SELECT attempts FROM privacy_deletions WHERE id=?').get(job.id) as {
          attempts: number
        }
      ).attempts
      db.prepare('UPDATE privacy_deletions SET status=?,last_error=? WHERE id=?').run(
        attempts >= 5 ? 'failed' : 'pending',
        String(error).slice(0, 500),
        job.id,
      )
      logger.error(__t('logs.maintenance', '永久删除尚未完成，清理记录已保留'), {
        id: job.id,
        kind: job.kind,
        error: String(error),
      })
      if (attempts < 5) this.scheduleRecovery()
      throw error
    } finally {
      policy.reload()
      policy.unlock(lock)
      if (job.kind === 'reset-memory') policy.unlock('fact')
    }
  }
  private scheduleRecovery(): void {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.recover().catch((error) =>
        logger.error(__t('logs.maintenance', '恢复数据清理失败: {0}', [String(error)])),
      )
    }, 30_000)
    this.retryTimer.unref?.()
  }
  private async recover(): Promise<void> {
    if (this.stopped) return
    const jobs = this.deps.db
      .prepare(
        "SELECT * FROM privacy_deletions WHERE status='pending' AND kind IN ('memory','fact','knowledge','reset-memory','social-memory') ORDER BY created_at",
      )
      .all() as Job[]
    for (const job of jobs) {
      if (this.stopped) break
      try {
        await this.serialize(() => this.execute(job))
      } catch {
        /* 保留无正文的清理任务，稍后或重启后继续。 */
      }
    }
  }
}
