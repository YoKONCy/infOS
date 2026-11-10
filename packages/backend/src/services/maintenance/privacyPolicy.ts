import { createHash } from 'node:crypto'
import { invalidatePromptReplay } from '../llm/promptCache'
import type Database from 'better-sqlite3'
import type { EventNote } from '@infos/shared'

/** 永久遗忘属于确定性拒绝，后台任务不能按临时故障重试。 */
export class MemoryForgottenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryForgottenError'
  }
}

/** 删除标记只保存标识，不保存被遗忘的正文；写入与重放统一核验。 */
export class PrivacyPolicy {
  private blocked = new Set<string>()
  private sources = new Set<string>()
  private cutoffs = new Map<string, { maxMessageId: number; maxExperienceId: number }>()
  private busy = new Set<'memory' | 'fact' | 'knowledge'>()
  private pending = new Set<string>()
  generation = 0
  constructor(private db: Database.Database) {
    this.reload()
  }
  reload(): void {
    const rows = this.db
      .prepare('SELECT kind,target_id,metadata_json,status FROM privacy_deletions')
      .all() as Array<{ kind: string; target_id: string; metadata_json: string; status: string }>
    this.pending = new Set(
      rows
        .filter((row) => row.status !== 'completed')
        .flatMap((row) => (row.kind === 'reset-memory' ? ['memory', 'fact'] : [row.kind])),
    )
    this.blocked = new Set(
      rows
        .filter((row) => row.kind !== 'memory-source')
        .map((row) => `${row.kind}:${row.target_id}`),
    )
    this.sources = new Set(
      rows.filter((row) => row.kind === 'memory-source').map((row) => row.target_id),
    )
    this.cutoffs = new Map(
      rows
        .filter((row) => row.kind === 'memory-cutoff')
        .map((row) => [
          row.target_id,
          { maxMessageId: Number(JSON.parse(row.metadata_json).maxMessageId), maxExperienceId: Number(JSON.parse(row.metadata_json).maxExperienceId ?? 0) },
        ]),
    )
    this.generation++
    invalidatePromptReplay()
  }
  lock(kind: 'memory' | 'fact' | 'knowledge'): void {
    this.busy.add(kind)
    this.generation++
    invalidatePromptReplay()
  }
  unlock(kind: 'memory' | 'fact' | 'knowledge'): void {
    this.busy.delete(kind)
  }
  isBusy(kind: 'memory' | 'fact' | 'knowledge'): boolean {
    return this.busy.has(kind) || this.pending.has(kind)
  }
  deleted(kind: string, id: string): boolean {
    return this.blocked.has(`${kind}:${id}`) || this.blocked.has(`${kind}-block:${id}`)
  }
  sourceKey(agentId: string, threadId: string, pairId: string): string {
    const stableSource = pairId.replace(/^(message:\d+)@\d+$/, '$1')
    return createHash('sha256')
      .update(JSON.stringify([agentId, threadId, stableSource]))
      .digest('hex')
  }
  sourceForgotten(agentId: string, threadId: string, pairId: string): boolean {
    if (this.sources.has(this.sourceKey(agentId, threadId, pairId))) return true
    const cutoff = this.cutoffs.get(agentId)
    if (cutoff === undefined) return false
    const messageSource = /^message:(\d+)@\d+$/.exec(pairId)
    if (messageSource) return Number(messageSource[1]) <= cutoff.maxMessageId
    if (pairId.startsWith('experience:')) return Number(pairId.slice('experience:'.length)) <= cutoff.maxExperienceId
    const row = this.db
      .prepare('SELECT min(id) AS value FROM thread_messages WHERE thread_id=? AND pair_id=?')
      .get(threadId, pairId) as { value: number | null }
    return row.value !== null && row.value <= cutoff.maxMessageId
  }
  forgottenPairIds(agentId: string, threadId: string): string[] {
    const pairs = this.db
      .prepare(
        'SELECT DISTINCT pair_id AS id FROM thread_messages WHERE thread_id=? AND pair_id IS NOT NULL',
      )
      .all(threadId) as Array<{ id: string }>
    const messages = this.db.prepare("SELECT m.id,m.revision FROM thread_messages m JOIN threads t ON t.id=m.thread_id WHERE m.thread_id=? AND t.thread_kind='main'")
      .all(threadId) as Array<{ id: number; revision: number }>
    pairs.push(...messages.map((message) => ({ id: `message:${message.id}@${message.revision ?? 1}` })))
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_experiences'").get()) {
      const experiences = this.db.prepare('SELECT id FROM agent_experiences WHERE thread_id=? AND agent_id=?').all(threadId, agentId) as Array<{ id: number }>
      pairs.push(...experiences.map((item) => ({ id: `experience:${item.id}` })))
    }
    return pairs
      .filter((pair) => this.sourceForgotten(agentId, threadId, pair.id))
      .map((pair) => pair.id)
  }
  memoryForgotten(note: Pick<EventNote, 'id' | 'agentId' | 'origin'>): boolean {
    return this.memoryForgetReason(note) !== undefined
  }
  private memoryForgetReason(
    note: Pick<EventNote, 'id' | 'agentId' | 'origin'>,
  ): string | undefined {
    const cutoff = this.cutoffs.get(note.agentId)
    for (const source of [note.origin, ...(note.origin.sources ?? [])]) {
      if (cutoff !== undefined) {
        const ids = source.messageIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
        const previous = ids.length
          ? Math.min(...ids)
          : (
              this.db.prepare(
                'SELECT max(id) AS value FROM thread_messages WHERE thread_id=? AND pair_id IN (SELECT value FROM json_each(?))',
              ).get(source.threadId, JSON.stringify(source.pairIds)) as { value: number | null }
            ).value
        if (previous !== null && previous <= cutoff.maxMessageId) {
          return '该来源已在重置时遗忘，已阻止再次炼化'
        }
        if (source.experienceIds?.some((id) => Number(id) <= cutoff.maxExperienceId)) {
          return '该来源已在重置时遗忘，已阻止再次炼化'
        }
      }
      if (
        this.deleted('memory', note.id) ||
        source.pairIds.some((pairId) =>
          this.sources.has(this.sourceKey(note.agentId, source.threadId, pairId)),
        )
      )
        return '该记忆或来源已被永久删除，已阻止后台重新写入'
    }
    return undefined
  }
  assertMemory(note: Pick<EventNote, 'id' | 'agentId' | 'origin'>): void {
    const reason = this.memoryForgetReason(note)
    if (reason) throw new MemoryForgottenError(reason)
    if (this.isBusy('memory')) throw new Error('数据正在清理，请完成清理后再写入')
  }
  assertPayload(kind: 'memory' | 'fact', payload: unknown): void {
    if (this.isBusy(kind)) throw new Error('数据正在清理，请完成清理后再写入')
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        value.forEach(walk)
        return
      }
      const item = value as Record<string, unknown>
      for (const key of ['id', 'eventId', 'sourceId', 'targetId'])
        if (typeof item[key] === 'string' && this.deleted(kind, item[key] as string))
          throw new MemoryForgottenError('记录已被永久删除，已阻止旧事务重放')
      if (kind === 'memory' && typeof item.agentId === 'string' && item.origin)
        this.assertMemory(item as unknown as EventNote)
      Object.values(item).forEach(walk)
    }
    walk(payload)
  }
}
