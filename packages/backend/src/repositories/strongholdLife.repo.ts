import { and, eq } from 'drizzle-orm'
import type { DrizzleDb } from '../database'
import { strongholdLifeRecords } from '../database/schema'
import { AppError } from '../lib/appError'

export type LifeKind = 'participation' | 'exchange' | 'activity' | 'invitation' | 'watch' | 'presence' | 'receipt'
export interface LifeRecord<T = Record<string, unknown>> {
  id: string
  kind: LifeKind
  roomId: string
  agentId: string | null
  threadId: string | null
  generation: number | null
  revision: number
  sourceMessageId: number | null
  sourcePairId: string | null
  data: T
}

/** 事务由领域入口持有，修订校验同时覆盖客户端与 Agent 的并发操作。 */
export class StrongholdLifeRepository {
  constructor(readonly db: DrizzleDb) {}

  get<T>(id: string): LifeRecord<T> | undefined {
    const row = this.db.select().from(strongholdLifeRecords).where(eq(strongholdLifeRecords.id, id)).get()
    return row ? this.decode<T>(row) : undefined
  }

  list<T>(kind: LifeKind, roomId?: string): LifeRecord<T>[] {
    return this.db.select().from(strongholdLifeRecords).where(and(
      eq(strongholdLifeRecords.kind, kind),
      roomId === undefined ? undefined : eq(strongholdLifeRecords.roomId, roomId),
    )).all().map((row) => this.decode<T>(row))
  }

  save<T>(record: Omit<LifeRecord<T>, 'revision'>, expectedRevision?: number): LifeRecord<T> {
    const current = this.get(record.id)
    if (current && expectedRevision !== current.revision)
      throw new AppError('CONFLICT', { message: 'STRONGHOLD_LIFE_REVISION_CONFLICT' })
    if (!current && expectedRevision !== undefined && expectedRevision !== 0)
      throw new AppError('CONFLICT', { message: 'STRONGHOLD_LIFE_REVISION_CONFLICT' })
    const revision = (current?.revision ?? 0) + 1
    const { data, ...fields } = record
    const now = Date.now()
    this.db.insert(strongholdLifeRecords).values({
      ...fields, revision, dataJson: JSON.stringify(data), createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({ target: strongholdLifeRecords.id, set: {
      ...fields, revision, dataJson: JSON.stringify(data), updatedAt: now,
    } }).run()
    return { ...record, revision }
  }

  update<T>(record: LifeRecord<T>, data: T): LifeRecord<T> {
    return this.save({ ...record, data }, record.revision)
  }

  private decode<T>(row: typeof strongholdLifeRecords.$inferSelect): LifeRecord<T> {
    return { id: row.id, kind: row.kind as LifeKind, roomId: row.roomId, agentId: row.agentId,
      threadId: row.threadId, generation: row.generation, revision: row.revision,
      sourceMessageId: row.sourceMessageId, sourcePairId: row.sourcePairId,
      data: JSON.parse(row.dataJson) as T }
  }
}
