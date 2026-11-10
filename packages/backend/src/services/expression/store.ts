import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  ExpressionLearningStatus,
  ExpressionMark,
  ExpressionMarkLearning,
} from '@infos/shared'
import { normalizeExpressionQuote } from '@infos/shared'
import { AppError } from '../../lib/appError'
import { HandbookStore } from './handbook'
import { ThinkingStreamFilter } from '../../nit/streamFilter'
import { splitSpokenReply } from '../../nit/spokenReplyFilter'

export const RULE_VERSION = 'expression-v1'
const validSource = `EXISTS (
 SELECT 1 FROM thread_messages source JOIN threads owner ON owner.id=source.thread_id
 WHERE source.id=expression_marks.message_id AND source.thread_id=expression_marks.thread_id
 AND COALESCE(source.agent_id,owner.agent_id)=expression_marks.agent_id
 AND source.role='assistant' AND COALESCE(source.status,'active')='active'
 AND source.deleted_at IS NULL AND COALESCE(source.revision,1)=expression_marks.source_revision
)`
const fields = `id, agent_id AS agentId, thread_id AS threadId, CAST(message_id AS TEXT) AS messageId,
 COALESCE((SELECT NULLIF(title,'') FROM threads WHERE threads.id=expression_marks.thread_id),thread_id) AS threadTitle,
 (SELECT thread_kind FROM threads WHERE threads.id=expression_marks.thread_id) AS threadKind,
 kind, quote, note, rule_version AS ruleVersion, created_at AS createdAt, updated_at AS updatedAt,
 source_revision AS sourceRevision, ${validSource} AS sourceAvailable`
type StoredMark = Omit<ExpressionMark, 'sourceAvailable'> & { sourceAvailable: number }
type MarkInput = Pick<ExpressionMark, 'agentId' | 'threadId' | 'messageId' | 'kind' | 'quote'> & {
  note?: string
}
const markFrom = (row: StoredMark): ExpressionMark => ({
  ...row,
  sourceAvailable: Boolean(row.sourceAvailable),
})
export class ExpressionStore {
  onMark?: (mark: ExpressionMark) => void
  onRelearn?: (mark: ExpressionMark) => void
  onLearnNow?: (agentId: string) => void
  learningStatus?: (agentId: string) => ExpressionLearningStatus
  readonly handbook: HandbookStore
  constructor(readonly db: Database.Database) {
    this.handbook = new HandbookStore(db)
  }
  list(input: {
    agentId: string
    threadId?: string
    messageId?: string
    kind?: string
    learning?: ExpressionMarkLearning['state']
    page?: number
    pageSize?: number
  }) {
    const clauses = ['agent_id = ?'],
      args: (string | number)[] = [input.agentId]
    for (const [key, value] of [
      ['thread_id', input.threadId],
      ['message_id', input.messageId],
      ['kind', input.kind],
    ])
      if (value) {
        clauses.push(`${key} = ?`)
        args.push(value)
      }
    const where = clauses.join(' AND ')
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM expression_marks WHERE ${where}`).get(...args) as {
        n: number
      }
    ).n
    const size = input.pageSize ?? 20
    const start = ((input.page ?? 1) - 1) * size
    // 学习结果要算：规则可能后来被删了，存不进表，这里全部算一遍再分页。
    if (input.learning) {
      const matched = (
        this.db
          .prepare(`SELECT ${fields} FROM expression_marks WHERE ${where} ORDER BY created_at DESC,id`)
          .all(...args) as StoredMark[]
      )
        .map(markFrom)
        .map((m) => ({ ...m, learning: this.learningOf(m) }))
        .filter((m) => m.learning.state === input.learning)
      return { items: matched.slice(start, start + size), total: matched.length }
    }
    const items = this.db
      .prepare(
        `SELECT ${fields} FROM expression_marks WHERE ${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(
        ...args,
        size,
        start,
      ) as StoredMark[]
    return { items: items.map(markFrom).map((m) => ({ ...m, learning: this.learningOf(m) })), total }
  }
  /** 这条批注学得怎么样，给管理页看。 */
  private learningOf(mark: ExpressionMark): ExpressionMarkLearning {
    // 只看最新修订：只改类型时，旧修订学到的规则不算这次学到的。
    const job = this.db
      .prepare(
        "SELECT status,rule_ids AS ruleIds FROM expression_learning WHERE kind='mark' AND source_id=? AND status<>'superseded' ORDER BY revision DESC LIMIT 1",
      )
      .get(mark.id) as { status: string; ruleIds: string | null } | undefined
    if (!job) return { state: 'none' }
    if (job.status === 'pending') return { state: 'pending' }
    if (job.status === 'failed') return { state: 'failed' }
    const ids: string[] = job.ruleIds ? JSON.parse(job.ruleIds) : []
    const rule = this.handbook.rules(mark.agentId).find((r) => ids.includes(r.id))
    return rule ? { state: 'learned', ruleText: rule.text } : { state: 'skipped' }
  }
  /** 原始素材限定来源会话及原文修订，管理列表保留失效记录。 */
  candidates(agentId: string, threadId: string): ExpressionMark[] {
    const rows = this.db
      .prepare(
        `SELECT ${fields} FROM expression_marks WHERE agent_id=? AND thread_id=?
      AND ${validSource} ORDER BY updated_at DESC,created_at DESC,id LIMIT 100`,
      )
      .all(agentId, threadId) as StoredMark[]
    const seen = new Set<string>()
    return rows.map(markFrom).filter((mark) => {
      const quote = `${mark.messageId}:${normalizeExpressionQuote(mark.quote)}`
      if (seen.has(quote)) return false
      seen.add(quote)
      return true
    })
  }
  visibleQuote(mark: ExpressionMark): string {
    if (mark.quote || mark.kind !== 'good') return mark.quote
    const row = this.db
      .prepare(
        "SELECT content FROM thread_messages WHERE id=? AND role='assistant' AND deleted_at IS NULL",
      )
      .get(mark.messageId) as { content: string } | undefined
    if (!row) return ''
    const filter = new ThinkingStreamFilter()
    const visible = splitSpokenReply(filter.filter(row.content) + filter.flush()).content.trim()
    return [...visible].length <= 70 ? visible : ''
  }
  get(id: string) {
    const row = this.db.prepare(`SELECT ${fields} FROM expression_marks WHERE id=?`).get(id) as
      | StoredMark
      | undefined
    if (!row) throw new AppError('NOT_FOUND')
    return markFrom(row)
  }
  create(
    input: MarkInput,
  ) {
    return this.db.transaction(() => this.createMark(input)).immediate()
  }
  private messageFor(input: Pick<ExpressionMark, 'agentId' | 'threadId' | 'messageId' | 'quote'>) {
    const message = this.db
      .prepare(
        `SELECT m.content,COALESCE(m.revision,1) AS revision,r.rule_version AS version
      FROM thread_messages m JOIN threads t ON t.id=m.thread_id
      LEFT JOIN expression_replies r ON r.message_id=m.id
      WHERE m.id=? AND m.thread_id=? AND COALESCE(m.agent_id,t.agent_id)=?
      AND m.role='assistant' AND COALESCE(m.status,'active')='active' AND m.deleted_at IS NULL`,
      )
      .get(input.messageId, input.threadId, input.agentId) as
      | { content: string; revision: number; version?: string }
      | undefined
    const quote = normalizeExpressionQuote(input.quote)
    if (!message || (input.quote && (!quote || !normalizeExpressionQuote(message.content).includes(quote))))
      throw new AppError('INVALID_PARAMETER')
    return message
  }
  private createMark(
    input: MarkInput,
  ) {
    const message = this.messageFor(input)
    const existing = (this.db
      .prepare(
        `SELECT ${fields} FROM expression_marks WHERE agent_id=? AND thread_id=? AND message_id=?
      ORDER BY updated_at DESC,created_at DESC,id`,
      )
      .all(input.agentId, input.threadId, input.messageId) as StoredMark[])
      .find((mark) => normalizeExpressionQuote(mark.quote) === normalizeExpressionQuote(input.quote))
    if (existing) return this.updateMark(existing.id, { kind: input.kind, note: input.note })
    const now = Date.now(),
      id = randomUUID()
    this.db
      .prepare(`INSERT INTO expression_marks
      (id,agent_id,thread_id,message_id,kind,quote,note,rule_version,created_at,updated_at,source_revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        input.agentId,
        input.threadId,
        input.messageId,
        input.kind,
        input.quote,
        input.note ?? '',
        message.version ?? 'legacy',
        now,
        now,
        message.revision,
      )
    const mark = this.get(id)
    this.invalidateSelection(mark.agentId, mark.threadId)
    this.onMark?.(mark)
    return mark
  }
  update(id: string, patch: Partial<Pick<ExpressionMark, 'kind' | 'note'>>) {
    return this.db.transaction(() => this.updateMark(id, patch)).immediate()
  }
  private updateMark(id: string, patch: Partial<Pick<ExpressionMark, 'kind' | 'note'>>) {
    const old = this.get(id)
    const message = this.messageFor(old)
    const kind = patch.kind ?? old.kind
    const note = patch.note ?? old.note
    if (kind === old.kind && note === old.note && old.sourceRevision === message.revision)
      return old
    this.db
      .prepare('UPDATE expression_marks SET kind=?,note=?,source_revision=?,rule_version=?,updated_at=? WHERE id=?')
      .run(kind, note, message.revision, message.version ?? 'legacy', Date.now(), id)
    this.db.prepare('DELETE FROM expression_mark_rules WHERE mark_id=?').run(id)
    const mark = this.get(id)
    this.invalidateSelection(mark.agentId, mark.threadId)
    this.onMark?.(mark)
    return mark
  }
  remove(id: string) {
    return this.db.transaction(() => {
      const mark = this.get(id)
      this.db.prepare('DELETE FROM expression_marks WHERE id=?').run(id)
      this.db.prepare("UPDATE expression_learning SET status='superseded' WHERE kind='mark' AND source_id=? AND status='pending'").run(id)
      this.invalidateSelection(mark.agentId, mark.threadId)
      return { ok: true }
    }).immediate()
  }
  recordTurn(agentId: string, threadId: string, pairId: string, promptRevision?: string) {
    const version = promptRevision ? `${RULE_VERSION}:${promptRevision}` : RULE_VERSION
    this.db
      .prepare('INSERT OR IGNORE INTO expression_turn_versions VALUES (?,?,?,?,?)')
      .run(threadId, agentId, pairId, version, Date.now())
  }
  status(agentId: string) {
    const rows = this.db
      .prepare('SELECT kind,count(*) AS n FROM expression_marks WHERE agent_id=? GROUP BY kind')
      .all(agentId) as { kind: 'good' | 'robotic'; n: number }[]
    const counts = { good: 0, robotic: 0 }
    for (const row of rows) counts[row.kind] = row.n
    const latest = this.db
      .prepare(
        'SELECT rule_version AS version FROM expression_turn_versions WHERE agent_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT 1',
      )
      .get(agentId) as { version: string } | undefined
    return {
      ruleVersion: latest?.version ?? RULE_VERSION,
      enabled: process.env.INFOS_EXPRESSION_ENABLED !== '0',
      counts,
    }
  }
  versions(agentId: string) {
    return this.db
      .prepare(
        `SELECT rule_version AS ruleVersion, SUM(kind='good') AS good, SUM(kind='robotic') AS robotic
      FROM expression_marks WHERE agent_id=? GROUP BY rule_version ORDER BY rule_version`,
      )
      .all(agentId)
  }
  readState<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM expression_state WHERE key=?').get(key) as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as T) : fallback
  }
  writeState(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO expression_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value))
  }
  /** 删除记忆后清除含正文的派生素材，下一轮从有效来源重新选择。 */
  invalidateMaterials(): void {
    this.db.prepare("DELETE FROM expression_state WHERE key LIKE 'glows:%' OR key LIKE 'selection:%'").run()
  }
  private invalidateSelection(agentId: string, threadId: string): void {
    const prefix = `selection:${agentId}:${threadId}:`
    this.db.prepare('DELETE FROM expression_state WHERE substr(key,1,length(?))=?').run(prefix, prefix)
  }
}
