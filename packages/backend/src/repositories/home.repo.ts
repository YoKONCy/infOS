import { and, asc, eq, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../database'
import { homeRecords } from '../database/homeSchema'

export type HomeRecordKind =
  | 'checkpoint'
  | 'grant'
  | 'confirmation'
  | 'declaration'
  | 'activity'
  | 'owned'
  | 'shelf'
  | 'map'
  | 'card'
  | 'card-message'
  | 'state'
  | 'recycle'
  | 'mutation'
/** 同步事务避免授权消费与状态更新之间插入另一项本机操作。 */
export class HomeRepository {
  constructor(private db: DrizzleDb) {}
  get<T>(kind: HomeRecordKind, id: string): T | undefined {
    return this.db
      .select()
      .from(homeRecords)
      .where(and(eq(homeRecords.kind, kind), eq(homeRecords.id, id)))
      .get()?.payload as T | undefined
  }
  list<T>(kind: HomeRecordKind, agentId?: string, sessionId?: string): T[] {
    const predicates = [eq(homeRecords.kind, kind)]
    if (agentId !== undefined) predicates.push(eq(homeRecords.agentId, agentId))
    if (sessionId !== undefined) predicates.push(eq(homeRecords.sessionId, sessionId))
    return this.db
      .select()
      .from(homeRecords)
      .where(and(...predicates))
      .orderBy(asc(homeRecords.createdAt), sql`rowid`)
      .all()
      .map((row) => row.payload as T)
  }
  put<T extends { id: string; agentId: string; sessionId?: string }>(
    kind: HomeRecordKind,
    value: T,
    createdAt = Date.now(),
  ): void {
    this.db
      .insert(homeRecords)
      .values({ ...value, kind, sessionId: value.sessionId ?? '', createdAt, payload: value })
      .onConflictDoUpdate({ target: [homeRecords.kind, homeRecords.id], set: { payload: value } })
      .run()
  }
  remove(kind: HomeRecordKind, id: string): void {
    this.db
      .delete(homeRecords)
      .where(and(eq(homeRecords.kind, kind), eq(homeRecords.id, id)))
      .run()
  }
  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)
  }
}
