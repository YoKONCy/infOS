import { and, eq, sql, desc, getTableColumns, type SQL } from 'drizzle-orm'
import type { PrivacyPolicy } from '../services/maintenance/privacyPolicy'
import { createHash } from 'node:crypto'
import type { DrizzleDb } from '../database'
import { knowledgeDocuments, knowledgeParts } from '../database/schema'
import type { KnowledgeDocumentInfo, KnowledgePartInfo, KnowledgeDocumentList } from '@infos/shared'

export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect
export type KnowledgePartRow = typeof knowledgeParts.$inferSelect
export type KnowledgePartInsert = Omit<typeof knowledgeParts.$inferInsert, 'id' | 'documentId'>
type KnowledgeDocumentMetadata = Omit<KnowledgeDocumentRow, 'content'>
const { content: _contentColumn, ...metadataColumns } = getTableColumns(knowledgeDocuments)

export class KnowledgeRepository {
  private visible?: SQL
  setPrivacyPolicy(_policy: PrivacyPolicy): void {
    this.visible = sql`${knowledgeDocuments.id} NOT IN (SELECT target_id FROM privacy_deletions WHERE kind='knowledge')`
  }
  constructor(private readonly db: DrizzleDb) {}

  hasReadyParts(): boolean {
    return Boolean(
      this.db
        .select({ id: knowledgeParts.id })
        .from(knowledgeParts)
        .innerJoin(knowledgeDocuments, eq(knowledgeParts.documentId, knowledgeDocuments.id))
        .where(and(eq(knowledgeDocuments.status, 'ready'), this.visible))
        .limit(1)
        .get(),
    )
  }

  get(id: string): KnowledgeDocumentRow | undefined {
    return this.db
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, id), this.visible))
      .get()
  }

  version(id: string): { status: string; revision: number } | undefined {
    return this.db
      .select({ status: knowledgeDocuments.status, revision: knowledgeDocuments.revision })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, id), this.visible))
      .get()
  }

  generation(): string {
    const versions = this.db
      .select({
        id: knowledgeDocuments.id,
        revision: knowledgeDocuments.revision,
        status: knowledgeDocuments.status,
      })
      .from(knowledgeDocuments)
      .orderBy(knowledgeDocuments.id)
      .all()
    return createHash('sha256').update(JSON.stringify(versions)).digest('hex')
  }

  parts(documentId: string): KnowledgePartRow[] {
    return this.db
      .select()
      .from(knowledgeParts)
      .where(eq(knowledgeParts.documentId, documentId))
      .orderBy(knowledgeParts.ordinal)
      .all()
  }

  readyParts(): Array<{ part: KnowledgePartRow; document: KnowledgeDocumentRow }> {
    const documents = this.db
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.status, 'ready'), this.visible))
      .all()
    // 同一文档的各部分共享原文对象，避免 JOIN 为每段复制一次全文。
    return documents.flatMap((document) =>
      this.parts(document.id).map((part) => ({ part, document })),
    )
  }

  list(query: string, page: number, pageSize: number): KnowledgeDocumentList {
    const where = and(
      this.visible,
      query
        ? sql`(instr(lower(${knowledgeDocuments.title}), lower(${query})) > 0
      OR instr(lower(${knowledgeDocuments.source}), lower(${query})) > 0)`
        : undefined,
    )
    const items = this.db
      .select(metadataColumns)
      .from(knowledgeDocuments)
      .where(where)
      .orderBy(desc(knowledgeDocuments.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all()
    const total = this.db
      .select({ count: sql<number>`count(*)` })
      .from(knowledgeDocuments)
      .where(where)
      .get()!.count
    const rows = this.db
      .select({ status: knowledgeDocuments.status, count: sql<number>`count(*)` })
      .from(knowledgeDocuments)
      .where(this.visible)
      .groupBy(knowledgeDocuments.status)
      .all()
    const countFor = (status: string) => rows.find((row) => row.status === status)?.count ?? 0
    return {
      items: items.map((row) => this.info(row)),
      total,
      page,
      pageSize,
      stats: {
        documentCount: rows.reduce((sum, row) => sum + row.count, 0),
        readyCount: countFor('ready'),
        pendingCount: countFor('queued') + countFor('processing'),
        indexingCount: this.db
          .select({ count: sql<number>`count(*)` })
          .from(knowledgeDocuments)
          .where(
            and(
              this.visible,
              eq(knowledgeDocuments.status, 'ready'),
              eq(knowledgeDocuments.vectorStatus, 'pending'),
            ),
          )
          .get()!.count,
        partCount: this.db
          .select({ count: sql<number>`count(*)` })
          .from(knowledgeParts)
          .innerJoin(knowledgeDocuments, eq(knowledgeParts.documentId, knowledgeDocuments.id))
          .where(and(eq(knowledgeDocuments.status, 'ready'), this.visible))
          .get()!.count,
      },
    }
  }

  info(row: KnowledgeDocumentMetadata): KnowledgeDocumentInfo {
    return {
      id: row.id,
      title: row.title,
      sourceKind: row.sourceKind as KnowledgeDocumentInfo['sourceKind'],
      source: row.source,
      tokenCount: row.tokenCount,
      revision: row.revision,
      status: row.status as KnowledgeDocumentInfo['status'],
      vectorStatus: row.vectorStatus as KnowledgeDocumentInfo['vectorStatus'],
      partCount: this.db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeParts)
        .where(eq(knowledgeParts.documentId, row.id))
        .get()!.count,
      modelName: row.modelName,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  partInfo(row: KnowledgePartRow): KnowledgePartInfo {
    return {
      id: String(row.id),
      documentId: row.documentId,
      ordinal: row.ordinal,
      title: row.title,
      summary: row.summary,
      keywords: JSON.parse(row.keywordsJson) as string[],
      tokenCount: row.tokenCount,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
    }
  }

  create(row: typeof knowledgeDocuments.$inferInsert): KnowledgeDocumentRow {
    return this.db.insert(knowledgeDocuments).values(row).returning().get()
  }

  update(
    id: string,
    revision: number,
    patch: Partial<Omit<KnowledgeDocumentRow, 'id' | 'revision'>>,
  ): boolean {
    return (
      this.db
        .update(knowledgeDocuments)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.revision, revision)))
        .run().changes > 0
    )
  }

  replace(
    id: string,
    patch: Pick<
      KnowledgeDocumentRow,
      'title' | 'sourceKind' | 'source' | 'content' | 'contentHash' | 'tokenCount'
    >,
  ): KnowledgeDocumentRow {
    return this.db
      .update(knowledgeDocuments)
      .set({
        ...patch,
        revision: sql`${knowledgeDocuments.revision} + 1`,
        status: 'queued',
        error: null,
        vectorStatus: 'skipped',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(knowledgeDocuments.id, id))
      .returning()
      .get()
  }

  /** 切片、摘要与可检索状态一起提交；失败或旧任务不能留下半份文档。 */
  publish(
    id: string,
    revision: number,
    parts: KnowledgePartInsert[],
    vectorStatus: string,
  ): boolean {
    return this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, id))
        .get()
      if (!current || current.revision !== revision || current.status !== 'processing') return false
      tx.delete(knowledgeParts).where(eq(knowledgeParts.documentId, id)).run()
      for (const part of parts)
        tx.insert(knowledgeParts)
          .values({ ...part, documentId: id })
          .run()
      tx.update(knowledgeDocuments)
        .set({ status: 'ready', vectorStatus, error: null, updatedAt: new Date().toISOString() })
        .where(eq(knowledgeDocuments.id, id))
        .run()
      return true
    })
  }

  saveVector(partId: number, embedding: number[], key: string): void {
    this.db
      .update(knowledgeParts)
      .set({ embeddingJson: JSON.stringify(embedding), embeddingKey: key })
      .where(eq(knowledgeParts.id, partId))
      .run()
  }

  pending(): KnowledgeDocumentRow[] {
    return this.db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.status, 'queued'))
      .all()
  }

  readyDocuments(): KnowledgeDocumentMetadata[] {
    return this.db
      .select(metadataColumns)
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.status, 'ready'))
      .all()
  }

  failPendingVectors(message: string): void {
    this.db
      .update(knowledgeDocuments)
      .set({ vectorStatus: 'failed', error: message, updatedAt: new Date().toISOString() })
      .where(
        and(eq(knowledgeDocuments.status, 'ready'), eq(knowledgeDocuments.vectorStatus, 'pending')),
      )
      .run()
  }

  recover(): void {
    this.db
      .update(knowledgeDocuments)
      .set({
        status: 'failed',
        error: '整理被服务重启打断，请重试',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(knowledgeDocuments.status, 'processing'))
      .run()
  }

  delete(id: string): void {
    this.db.transaction((tx) => {
      tx.delete(knowledgeParts).where(eq(knowledgeParts.documentId, id)).run()
      tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)).run()
    })
  }

  clear(): { documentCount: number; partCount: number } {
    return this.db.transaction((tx) => {
      const partCount = tx.delete(knowledgeParts).run().changes
      const documentCount = tx.delete(knowledgeDocuments).run().changes
      return { documentCount, partCount }
    })
  }
}
