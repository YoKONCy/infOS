import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { TransactionOperation } from 'triviumdb'
import type { FactObjectCandidate, FactQueryPath, FactQueryResult, FactRecord } from '@infos/shared'
import type { FactManualEditInput } from '@infos/shared'
import type { DrizzleDb } from '../database'
import { factMemoryOperations, factObjects, factRecords } from '../database/schema'
import type { MemoryStoreRegistry } from './storeRegistry'
import type { PrivacyPolicy } from '../services/maintenance/privacyPolicy'

interface FactObjectPayload {
  kind: 'fact_object'
  id: string
  standardName: string
  normalizedName: string
  aliases: string[]
}

interface FactPayload extends FactRecord {
  kind: 'fact'
}

type FactObjectRow = typeof factObjects.$inferSelect
type FactRow = typeof factRecords.$inferSelect

interface FactWriteOperationPayload {
  object: FactObjectRow
  record: FactRecord
  factTdbId: number
}

interface FactSupersedeOperationPayload {
  object: FactObjectRow
  oldRecord: FactRecord
  oldTdbId: number
  replacement: FactRecord
  replacementTdbId: number
  manualEdit?: { actor: 'user'; previousId: string; editedAt: string }
}

interface FactDeleteOperationPayload {
  record: FactRecord
  factTdbId: number
}

interface FactAliasOperationPayload {
  object: FactObjectRow
}

type FactOperationPayload =
  | FactWriteOperationPayload
  | FactSupersedeOperationPayload
  | FactDeleteOperationPayload
  | FactAliasOperationPayload

type FactOperationKind = 'write' | 'supersede' | 'delete' | 'retract' | 'restore' | 'alias'

export class FactsRepository {
  private manualEdits = new Map<string, Promise<FactRecord>>()
  private privacy?: PrivacyPolicy
  private purge?: (id: string) => Promise<void>
  setPrivacyPolicy(policy: PrivacyPolicy, purge: (id: string) => Promise<void>): void {
    this.privacy = policy
    this.purge = purge
  }
  private nextTdbId?: number

  constructor(
    private db: DrizzleDb,
    private stores: MemoryStoreRegistry,
  ) {}

  hasActiveFacts(): boolean {
    return Boolean(
      this.db
        .select({ id: factRecords.id })
        .from(factRecords)
        .where(
          and(
            eq(factRecords.status, 'active'),
            sql`${factRecords.id} NOT IN
        (SELECT target_id FROM privacy_deletions WHERE kind='fact')`,
            sql`${factRecords.objectId} NOT IN
        (SELECT target_id FROM privacy_deletions WHERE kind='fact')`,
          ),
        )
        .limit(1)
        .get(),
    )
  }

  /** 自动召回只采纳对象明确出现或正文检索命中的有效事实，不复用零分候选。 */
  recall(input: string, limit = 4): FactRecord[] {
    const query = input.normalize('NFKC').toLocaleLowerCase().trim().slice(0, 800)
    if (!query) return []
    const store = this.stores.getSharedStore('facts')
    const scores = new Map<number, number>()
    store.buildTextIndex()
    for (const hit of store.searchHybrid(this.zeroVector(), query, 30, 0, -1, 0)) {
      if (hit.score > 0) scores.set(hit.id, hit.score)
    }
    const candidates: Array<{ record: FactRecord; score: number }> = []
    for (const id of store.allNodeIds()) {
      const object = store.get<FactObjectPayload | FactPayload>(id)?.payload
      if (object?.kind !== 'fact_object' || this.privacy?.deleted('fact', object.id)) continue
      const mentioned = [object.standardName, ...object.aliases].some((name) => {
        const value = name.normalize('NFKC').toLocaleLowerCase().trim()
        if (value.length < 2) return query === value
        if (!/^[\p{Script=Latin}\d _-]+$/u.test(value)) return query.includes(value)
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(query)
      })
      for (const edge of store.getEdges(id).filter((item) => item.label === 'has_fact')) {
        const fact = store.get<FactPayload>(edge.targetId)?.payload
        if (
          fact?.kind !== 'fact' ||
          fact.status !== 'active' ||
          this.privacy?.deleted('fact', fact.id)
        )
          continue
        const score =
          (mentioned ? 100 : 0) + (scores.get(id) ?? 0) + (scores.get(edge.targetId) ?? 0)
        if (score > 0) {
          const { kind: _kind, ...record } = fact
          candidates.push({ record, score })
        }
      }
    }
    return candidates
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.record.observedAt.localeCompare(a.record.observedAt) ||
          a.record.id.localeCompare(b.record.id),
      )
      .slice(0, limit)
      .map((item) => item.record)
  }

  async query(name: string): Promise<FactQueryResult> {
    const normalized = this.normalize(name)
    const store = this.stores.getSharedStore('facts')
    const objects = store
      .allNodeIds()
      .map((id) => ({
        tdbId: id,
        payload: store.get<FactObjectPayload | FactPayload>(id)?.payload,
      }))
      .filter(
        (node): node is { tdbId: number; payload: FactObjectPayload } =>
          node.payload?.kind === 'fact_object' && !this.privacy?.deleted('fact', node.payload.id),
      )

    const exactRows = objects.filter(
      ({ payload }) =>
        payload.normalizedName === normalized ||
        payload.aliases.some((alias) => this.normalize(alias) === normalized),
    )
    if (exactRows.length === 1) {
      const node = exactRows[0]!
      const exactMatch = this.candidateFromStore(
        node.tdbId,
        node.payload,
        node.payload.normalizedName === normalized ? 'exact' : 'alias',
        1,
      )
      return {
        exactMatch,
        candidates: [],
        requiresSelection: false,
        paths: this.pathsForObject(node.tdbId),
      }
    }

    const bm25Scores = new Map<number, number>()
    if (normalized) {
      store.buildTextIndex()
      for (const hit of store.searchHybrid(this.zeroVector(), name, 20, 0, -1, 0)) {
        const payload = hit.payload as FactObjectPayload | FactPayload
        if (payload.kind === 'fact_object') bm25Scores.set(hit.id, hit.score)
        if (payload.kind === 'fact') {
          for (const edge of store.getEdges(hit.id).filter((item) => item.label === 'fact_of')) {
            bm25Scores.set(edge.targetId, Math.max(bm25Scores.get(edge.targetId) ?? 0, hit.score))
          }
        }
      }
    }

    const candidates = objects.map(({ tdbId, payload }) => {
      const names = [payload.standardName, ...payload.aliases]
      const deterministicScore = Math.max(
        ...names.map((candidate) => this.textScore(normalized, this.normalize(candidate))),
      )
      return this.candidateFromStore(
        tdbId,
        payload,
        'text',
        Math.max(deterministicScore, bm25Scores.get(tdbId) ?? 0),
      )
    })
    candidates.sort((a, b) => b.score - a.score || a.standardName.localeCompare(b.standardName))
    const top = candidates.slice(0, 5)
    return {
      candidates: top,
      requiresSelection: top.length > 0,
      paths: top.flatMap((candidate) => {
        const object = objects.find((node) => node.payload.id === candidate.objectId)
        return object ? this.pathsForObject(object.tdbId) : []
      }),
    }
  }

  async archive(query = ''): Promise<import('@infos/shared').FactArchiveResult> {
    const needle = query.normalize('NFKC').trim().toLocaleLowerCase()
    const objects = await this.db.select().from(factObjects)
    const facts = (await this.db.select().from(factRecords)).filter(
      (fact) => !this.privacy?.deleted('fact', fact.id),
    )
    const factsByObject = new Map<string, FactRow[]>()
    for (const fact of facts) {
      if (this.privacy?.deleted('fact', fact.id)) continue
      const values = factsByObject.get(fact.objectId) ?? []
      values.push(fact)
      factsByObject.set(fact.objectId, values)
    }

    const items = objects
      .map((object) => {
        const objectFacts = factsByObject.get(object.id) ?? []
        const aliases = this.aliases(object.aliasesJson)
        return {
          objectId: object.id,
          standardName: object.standardName,
          aliases,
          activeFacts: objectFacts
            .filter((fact) => fact.status === 'active')
            .map((fact) => ({
              ...this.toFact(fact, object.standardName),
              supersededBy: fact.supersededBy ?? undefined,
            })),
          historicalFacts: objectFacts
            .filter((fact) => fact.status === 'superseded')
            .map((fact) => ({
              ...this.toFact(fact, object.standardName),
              supersededBy: fact.supersededBy ?? undefined,
            })),
          retractedFacts: objectFacts
            .filter((fact) => fact.status === 'retracted')
            .map((fact) => ({
              ...this.toFact(fact, object.standardName),
              supersededBy: fact.supersededBy ?? undefined,
            })),
        }
      })
      .filter((object) => {
        if (
          this.privacy?.deleted('fact', object.objectId) ||
          (!object.activeFacts.length &&
            !object.historicalFacts.length &&
            !object.retractedFacts.length)
        )
          return false
        if (!needle) return true
        return [
          object.standardName,
          ...object.aliases,
          ...object.activeFacts.map((fact) => fact.statement),
          ...object.historicalFacts.map((fact) => fact.statement),
          ...object.retractedFacts.map((fact) => fact.statement),
        ].some((value) => value.toLocaleLowerCase().includes(needle))
      })
      .sort(
        (left, right) =>
          right.activeFacts.length - left.activeFacts.length ||
          left.standardName.localeCompare(right.standardName),
      )

    return {
      items,
      total: items.length,
      stats: {
        objectCount: items.length,
        activeFactCount: facts.filter((fact) => fact.status === 'active').length,
        historicalFactCount: facts.filter((fact) => fact.status === 'superseded').length,
        retractedFactCount: facts.filter((fact) => fact.status === 'retracted').length,
      },
    }
  }

  async write(input: {
    objectId?: string
    standardName?: string
    aliases?: string[]
    statement: string
    observedAt: string
    source?: string
    confidence?: number
    createdByAgentId: string
    operationId?: string
  }): Promise<FactRecord> {
    const generation = this.privacy?.generation
    const operationId = input.operationId ?? randomUUID()
    const existing = await this.findOperation(operationId)
    if (existing) {
      if (existing.operation !== 'write') throw new Error('operationId 已用于其他事实操作')
      await this.applyOperation(operationId, existing.operation, existing.payload)
      return (existing.payload as FactWriteOperationPayload).record
    }

    let object = input.objectId ? await this.findObject(input.objectId) : undefined
    let newObject = false
    if (!object) {
      if (!input.standardName?.trim()) throw new Error('新事实对象必须显式提交标准名')
      const existingObject = await this.query(input.standardName)
      if (existingObject.exactMatch || existingObject.candidates.length) {
        throw new Error('存在对象候选，请先选择现有对象')
      }
      object = {
        id: randomUUID(),
        tdbId: await this.allocateTdbId(),
        standardName: input.standardName.trim(),
        normalizedName: this.normalize(input.standardName),
        aliasesJson: JSON.stringify(input.aliases ?? []),
        createdAt: new Date().toISOString(),
      }
      newObject = true
    }

    const record: FactRecord = {
      id: randomUUID(),
      objectId: object.id,
      objectName: object.standardName,
      statement: input.statement.trim(),
      status: 'active',
      observedAt: input.observedAt,
      createdAt: new Date().toISOString(),
      source: input.source,
      confidence: input.confidence,
      createdByAgentId: input.createdByAgentId,
    }
    if (!record.statement) throw new Error('事实内容不能为空')
    const factTdbId = await this.allocateTdbId()
    const payload: FactWriteOperationPayload = { object, record, factTdbId }
    if (generation !== this.privacy?.generation) throw new Error('事实数据已变化，已阻止旧任务写入')
    this.privacy?.assertPayload('fact', payload)

    this.db.transaction((tx) => {
      tx.insert(factMemoryOperations)
        .values({
          operationId,
          operation: 'write',
          payloadJson: JSON.stringify(payload),
          status: 'pending',
          createdAt: new Date().toISOString(),
        })
        .run()
      if (newObject) tx.insert(factObjects).values(object).run()
      tx.insert(factRecords)
        .values({ ...record, tdbId: factTdbId })
        .run()
    })
    await this.applyOperation(operationId, 'write', payload)
    return record
  }

  /** 人工纠错保留原始记录者和观察时间，修改者单独写入事务审计。 */
  editFact(id: string, input: FactManualEditInput): Promise<FactRecord> {
    const key = `${id}:${input.operationId}`
    const running = this.manualEdits.get(key)
    if (running) return running
    const pending = this.editFactOnce(id, input).finally(() => this.manualEdits.delete(key))
    this.manualEdits.set(key, pending)
    return pending
  }

  private async editFactOnce(id: string, input: FactManualEditInput): Promise<FactRecord> {
    const existing = await this.findOperation(input.operationId)
    if (existing) {
      const payload = existing.payload as FactSupersedeOperationPayload
      if (existing.operation !== 'supersede' || !payload.manualEdit || payload.oldRecord.id !== id)
        throw new Error('ARCHIVE_EDIT_CONFLICT')
      const latest = await this.factRow(payload.replacement.id)
      if (!latest || latest.status !== 'active') throw new Error('ARCHIVE_EDIT_CONFLICT')
      if (existing.status !== 'committed')
        await this.applyOperation(input.operationId, existing.operation, payload)
      return payload.replacement
    }
    const row = await this.factRow(id)
    if (!row || row.status !== 'active') throw new Error('ARCHIVE_EDIT_CONFLICT')
    return this.supersede(row.objectId, id, {
      statement: input.statement,
      source: input.source?.trim() || undefined,
      confidence: input.confidence,
      observedAt: row.observedAt,
      createdByAgentId: row.createdByAgentId,
      operationId: input.operationId,
      manualEdit: { actor: 'user', previousId: id, editedAt: new Date().toISOString() },
    })
  }

  async supersede(
    objectId: string,
    oldFactId: string,
    input: Omit<
      Parameters<FactsRepository['write']>[0],
      'objectId' | 'standardName' | 'aliases'
    > & {
      manualEdit?: FactSupersedeOperationPayload['manualEdit']
    },
  ): Promise<FactRecord> {
    const generation = this.privacy?.generation
    const operationId = input.operationId ?? randomUUID()
    const existing = await this.findOperation(operationId)
    if (existing) {
      if (existing.operation !== 'supersede') throw new Error('operationId 已用于其他事实操作')
      await this.applyOperation(operationId, existing.operation, existing.payload)
      return (existing.payload as FactSupersedeOperationPayload).replacement
    }

    const object = await this.findObject(objectId)
    const oldRow = await this.factRow(oldFactId)
    if (!object || !oldRow || oldRow.objectId !== objectId || oldRow.status !== 'active') {
      throw new Error('ARCHIVE_EDIT_CONFLICT')
    }
    const replacement: FactRecord = {
      id: randomUUID(),
      objectId,
      objectName: object.standardName,
      statement: input.statement.trim(),
      status: 'active',
      observedAt: input.observedAt,
      createdAt: new Date().toISOString(),
      source: input.source,
      confidence: input.confidence,
      createdByAgentId: input.createdByAgentId,
    }
    if (!replacement.statement) throw new Error('事实内容不能为空')
    const replacementTdbId = await this.allocateTdbId()
    const oldRecord = this.toFact(oldRow, object.standardName)
    oldRecord.status = 'superseded'
    const payload: FactSupersedeOperationPayload = {
      object,
      oldRecord,
      oldTdbId: oldRow.tdbId,
      replacement,
      replacementTdbId,
      manualEdit: input.manualEdit,
    }
    this.privacy?.assertPayload('fact', payload)
    if (generation !== this.privacy?.generation) throw new Error('事实数据已变化，已阻止旧任务写入')

    this.db.transaction((tx) => {
      tx.insert(factMemoryOperations)
        .values({
          operationId,
          operation: 'supersede',
          payloadJson: JSON.stringify(payload),
          status: 'pending',
          createdAt: new Date().toISOString(),
        })
        .run()
      tx.insert(factRecords)
        .values({ ...replacement, tdbId: replacementTdbId })
        .run()
      const changed = tx
        .update(factRecords)
        .set({ status: 'superseded', supersededBy: replacement.id })
        .where(
          and(
            eq(factRecords.id, oldFactId),
            eq(factRecords.status, 'active'),
            isNull(factRecords.supersededBy),
          ),
        )
        .run()
      if (changed.changes !== 1) throw new Error('ARCHIVE_EDIT_CONFLICT')
    })
    await this.applyOperation(operationId, 'supersede', payload)
    return replacement
  }

  async retractFact(id: string, operationId: string = randomUUID()): Promise<void> {
    const existing = await this.findOperation(operationId)
    if (existing) {
      if (existing.operation !== 'retract') throw new Error('operationId 已用于其他事实操作')
      await this.applyOperation(operationId, existing.operation, existing.payload)
      return
    }
    const row = await this.factRow(id)
    if (!row) throw new Error('事实不存在')
    if (row.status === 'retracted') return
    const object = await this.findObject(row.objectId)
    if (!object) throw new Error('事实对象不存在')
    const record = this.toFact(row, object.standardName)
    record.status = 'retracted'
    const payload: FactDeleteOperationPayload = {
      record,
      factTdbId: row.tdbId,
    }
    this.privacy?.assertPayload('fact', payload)
    this.db.transaction((tx) => {
      tx.insert(factMemoryOperations)
        .values({
          operationId,
          operation: 'retract',
          payloadJson: JSON.stringify(payload),
          status: 'pending',
          createdAt: new Date().toISOString(),
        })
        .run()
      tx.update(factRecords).set({ status: 'retracted' }).where(eq(factRecords.id, id)).run()
    })
    await this.applyOperation(operationId, 'retract', payload)
  }

  /** 仅还原撤回且未被替代的事实，永久删除与版本替代不能被此入口逆转。 */
  async restoreFact(id: string, operationId: string = randomUUID()): Promise<void> {
    const existing = await this.findOperation(operationId)
    if (existing) {
      if (
        existing.operation !== 'restore' ||
        (existing.payload as FactWriteOperationPayload).record.id !== id
      )
        throw new Error('ARCHIVE_RESTORE_CONFLICT')
      await this.applyOperation(operationId, existing.operation, existing.payload)
      return
    }
    if (this.privacy?.deleted('fact', id)) throw new Error('ARCHIVE_RESTORE_NOT_FOUND')
    const row = await this.factRow(id)
    if (!row) throw new Error('ARCHIVE_RESTORE_NOT_FOUND')
    // SQL 已提交而索引写入失败时，新的 HTTP 重试也必须能修补索引。
    if (!['active', 'retracted'].includes(row.status) || row.supersededBy)
      throw new Error('ARCHIVE_RESTORE_CONFLICT')
    const object = await this.findObject(row.objectId)
    if (!object || this.privacy?.deleted('fact', object.id))
      throw new Error('ARCHIVE_RESTORE_NOT_FOUND')
    const payload: FactWriteOperationPayload = {
      object,
      record: { ...this.toFact(row, object.standardName), status: 'active' },
      factTdbId: row.tdbId,
    }
    this.privacy?.assertPayload('fact', payload)
    this.db.transaction((tx) => {
      tx.insert(factMemoryOperations)
        .values({
          operationId,
          operation: 'restore',
          payloadJson: JSON.stringify(payload),
          status: 'pending',
          createdAt: new Date().toISOString(),
        })
        .run()
      const changed = tx
        .update(factRecords)
        .set({ status: 'active' })
        .where(
          and(
            eq(factRecords.id, id),
            inArray(factRecords.status, ['active', 'retracted']),
            isNull(factRecords.supersededBy),
          ),
        )
        .run()
      if (changed.changes !== 1) throw new Error('ARCHIVE_RESTORE_CONFLICT')
    })
    await this.applyOperation(operationId, 'restore', payload)
  }

  async deleteFact(id: string, operationId: string = randomUUID()): Promise<void> {
    if (this.purge) return this.purge(id)
    const existing = await this.findOperation(operationId)
    if (existing) {
      if (existing.operation !== 'delete') throw new Error('operationId 已用于其他事实操作')
      await this.applyOperation(operationId, existing.operation, existing.payload)
      return
    }
    const row = await this.factRow(id)
    if (!row) return
    const object = await this.findObject(row.objectId)
    if (!object) throw new Error('事实对象不存在')
    const payload: FactDeleteOperationPayload = {
      record: this.toFact(row, object.standardName),
      factTdbId: row.tdbId,
    }
    this.db.transaction((tx) => {
      tx.insert(factMemoryOperations)
        .values({
          operationId,
          operation: 'delete',
          payloadJson: JSON.stringify(payload),
          status: 'pending',
          createdAt: new Date().toISOString(),
        })
        .run()
      tx.delete(factRecords).where(eq(factRecords.id, id)).run()
    })
    await this.applyOperation(operationId, 'delete', payload)
  }

  async addAlias(
    objectId: string,
    alias: string,
    operationId: string = randomUUID(),
  ): Promise<void> {
    await this.changeAlias(objectId, alias, true, operationId)
  }

  async removeAlias(
    objectId: string,
    alias: string,
    operationId: string = randomUUID(),
  ): Promise<void> {
    await this.changeAlias(objectId, alias, false, operationId)
  }

  async replayPending(): Promise<void> {
    const rows = await this.db
      .select()
      .from(factMemoryOperations)
      .where(inArray(factMemoryOperations.status, ['pending', 'failed']))
    for (const row of rows) {
      try {
        await this.applyOperation(
          row.operationId,
          row.operation as FactOperationKind,
          JSON.parse(row.payloadJson) as FactOperationPayload,
        )
      } catch {
        // applyOperation 已持久化失败状态，启动恢复继续处理其他操作。
      }
    }
  }

  async rebuildStore(signal?: AbortSignal): Promise<void> {
    await this.stores.withMaintenance(
      this.stores.resolveSharedStorePath('facts'),
      () => {
        const objects = this.db.select().from(factObjects).all()
        const facts = this.db.select().from(factRecords).all()
        this.stores.resetSharedStore('facts')
        const store = this.stores.getSharedStore('facts')
        const operations: TransactionOperation[] = []
        for (const object of objects)
          operations.push({
            type: 'insertWithId',
            id: object.tdbId,
            vector: this.zeroVector(),
            payload: this.objectPayload(object),
          })
        for (const row of facts)
          operations.push({
            type: 'insertWithId',
            id: row.tdbId,
            vector: this.zeroVector(),
            payload: this.factPayload(
              row,
              objects.find((object) => object.id === row.objectId)?.standardName ?? '',
            ),
          })
        for (const row of facts) {
          const object = objects.find((item) => item.id === row.objectId)
          if (!object) continue
          operations.push(
            { type: 'upsertEdge', src: object.tdbId, dst: row.tdbId, label: 'has_fact', weight: 1 },
            { type: 'upsertEdge', src: row.tdbId, dst: object.tdbId, label: 'fact_of', weight: 1 },
          )
          if (row.supersededBy) {
            const replacement = facts.find((item) => item.id === row.supersededBy)
            if (replacement)
              operations.push(
                {
                  type: 'upsertEdge',
                  src: row.tdbId,
                  dst: replacement.tdbId,
                  label: 'superseded_by',
                  weight: 1,
                },
                {
                  type: 'upsertEdge',
                  src: replacement.tdbId,
                  dst: row.tdbId,
                  label: 'supersedes',
                  weight: 1,
                },
              )
          }
        }
        if (operations.length) store.commitTransaction(operations)
        for (const object of objects) {
          store.indexText(
            object.tdbId,
            [object.standardName, ...this.aliases(object.aliasesJson)].join(' '),
          )
        }
        for (const row of facts) store.indexText(row.tdbId, row.statement)
        store.buildTextIndex()
        store.flush()
      },
      signal,
    )
  }

  private async changeAlias(
    objectId: string,
    alias: string,
    add: boolean,
    operationId: string,
  ): Promise<void> {
    const existing = await this.findOperation(operationId)
    if (existing) {
      if (existing.operation !== 'alias') throw new Error('operationId 已用于其他事实操作')
      await this.applyOperation(operationId, existing.operation, existing.payload)
      return
    }
    const object = await this.findObject(objectId)
    if (!object) throw new Error('事实对象不存在')
    const normalizedAlias = this.normalize(alias)
    if (!normalizedAlias) throw new Error('事实对象别名不能为空')
    const aliases = add
      ? [...new Set([...this.aliases(object.aliasesJson), alias.trim()])]
      : this.aliases(object.aliasesJson).filter(
          (value) => this.normalize(value) !== normalizedAlias,
        )
    const updated = { ...object, aliasesJson: JSON.stringify(aliases) }
    const payload: FactAliasOperationPayload = { object: updated }
    this.privacy?.assertPayload('fact', payload)
    this.db.transaction((tx) => {
      tx.insert(factMemoryOperations)
        .values({
          operationId,
          operation: 'alias',
          payloadJson: JSON.stringify(payload),
          status: 'pending',
          createdAt: new Date().toISOString(),
        })
        .run()
      tx.update(factObjects)
        .set({ aliasesJson: updated.aliasesJson })
        .where(eq(factObjects.id, objectId))
        .run()
    })
    await this.applyOperation(operationId, 'alias', payload)
  }

  private async applyOperation(
    operationId: string,
    operation: FactOperationKind,
    payload: FactOperationPayload,
  ): Promise<void> {
    this.privacy?.assertPayload('fact', payload)
    try {
      const store = this.stores.getSharedStore('facts')
      if (operation === 'write') this.applyWrite(store, payload as FactWriteOperationPayload)
      else if (operation === 'supersede') {
        const revision = payload as FactSupersedeOperationPayload
        // 当前状态读取和图写入之间不让出执行权，防止并发取代插入旧状态。
        const latest = this.db
          .select()
          .from(factRecords)
          .where(eq(factRecords.id, revision.replacement.id))
          .get()
        const old = this.db
          .select()
          .from(factRecords)
          .where(eq(factRecords.id, revision.oldRecord.id))
          .get()
        this.privacy?.assertPayload('fact', payload)
        // 用数据库的当前状态补齐历史边，不能因重放复活已经取代或撤回的版本。
        if (latest && old)
          this.applySupersede(store, {
            ...revision,
            oldRecord: this.toFact(old, revision.object.standardName),
            replacement: this.toFact(latest, revision.object.standardName),
          })
      } else if (operation === 'delete') {
        const deletion = payload as FactDeleteOperationPayload
        if (store.contains(deletion.factTdbId)) store.delete(deletion.factTdbId)
      } else if (operation === 'restore') {
        const restored = payload as FactWriteOperationPayload
        const latest = await this.factRow(restored.record.id)
        if (!latest) throw new Error('ARCHIVE_RESTORE_NOT_FOUND')
        this.privacy?.assertPayload('fact', payload)
        const record = this.toFact(latest, restored.object.standardName)
        this.applyWrite(store, { ...restored, record })
        store.updatePayload(restored.factTdbId, { ...record, kind: 'fact' } satisfies FactPayload)
        store.indexText(restored.factTdbId, record.statement)
        store.flush()
      } else if (operation === 'retract') {
        const retraction = payload as FactDeleteOperationPayload
        if (!store.contains(retraction.factTdbId)) throw new Error('待撤回事实的TDB节点不存在')
        const node = store.get<FactPayload>(retraction.factTdbId)
        if (!node) throw new Error('待撤回事实的TDB节点不存在')
        store.updatePayload(retraction.factTdbId, {
          ...node.payload,
          status: (await this.factRow(retraction.record.id))?.status ?? 'retracted',
        })
      } else {
        const alias = payload as FactAliasOperationPayload
        if (store.contains(alias.object.tdbId)) {
          store.updatePayload(alias.object.tdbId, this.objectPayload(alias.object))
        } else {
          store.insertWithId(
            alias.object.tdbId,
            this.zeroVector(),
            this.objectPayload(alias.object),
          )
        }
        store.indexText(
          alias.object.tdbId,
          [alias.object.standardName, ...this.aliases(alias.object.aliasesJson)].join(' '),
        )
      }
      await this.db
        .update(factMemoryOperations)
        .set({
          status: 'committed',
          committedAt: new Date().toISOString(),
          lastError: null,
        })
        .where(eq(factMemoryOperations.operationId, operationId))
    } catch (error) {
      await this.db
        .update(factMemoryOperations)
        .set({
          status: 'failed',
          attempts: sql`${factMemoryOperations.attempts} + 1`,
          lastError: String(error),
        })
        .where(eq(factMemoryOperations.operationId, operationId))
      throw error
    }
  }

  private applyWrite(
    store: ReturnType<MemoryStoreRegistry['getSharedStore']>,
    payload: FactWriteOperationPayload,
  ): void {
    if (!store.contains(payload.object.tdbId)) {
      store.insertWithId(
        payload.object.tdbId,
        this.zeroVector(),
        this.objectPayload(payload.object),
      )
      store.indexText(
        payload.object.tdbId,
        [payload.object.standardName, ...this.aliases(payload.object.aliasesJson)].join(' '),
      )
    }
    if (!store.contains(payload.factTdbId)) {
      store.commitTransaction([
        {
          type: 'insertWithId',
          id: payload.factTdbId,
          vector: this.zeroVector(),
          payload: { ...payload.record, kind: 'fact' } satisfies FactPayload,
        },
        {
          type: 'upsertEdge',
          src: payload.object.tdbId,
          dst: payload.factTdbId,
          label: 'has_fact',
          weight: 1,
        },
        {
          type: 'upsertEdge',
          src: payload.factTdbId,
          dst: payload.object.tdbId,
          label: 'fact_of',
          weight: 1,
        },
      ])
      store.indexText(payload.factTdbId, payload.record.statement)
    }
  }

  private applySupersede(
    store: ReturnType<MemoryStoreRegistry['getSharedStore']>,
    payload: FactSupersedeOperationPayload,
  ): void {
    if (!store.contains(payload.object.tdbId)) {
      store.insertWithId(
        payload.object.tdbId,
        this.zeroVector(),
        this.objectPayload(payload.object),
      )
    }
    if (!store.contains(payload.replacementTdbId)) {
      store.commitTransaction([
        {
          type: 'insertWithId',
          id: payload.replacementTdbId,
          vector: this.zeroVector(),
          payload: { ...payload.replacement, kind: 'fact' } satisfies FactPayload,
        },
        {
          type: 'upsertEdge',
          src: payload.object.tdbId,
          dst: payload.replacementTdbId,
          label: 'has_fact',
          weight: 1,
        },
        {
          type: 'upsertEdge',
          src: payload.replacementTdbId,
          dst: payload.object.tdbId,
          label: 'fact_of',
          weight: 1,
        },
      ])
    }
    store.indexText(payload.replacementTdbId, payload.replacement.statement)
    store.updatePayload(payload.replacementTdbId, {
      ...payload.replacement,
      kind: 'fact',
    } satisfies FactPayload)
    if (store.contains(payload.oldTdbId)) {
      store.updatePayload(payload.oldTdbId, {
        ...payload.oldRecord,
        kind: 'fact',
      } satisfies FactPayload)
    } else {
      store.insertWithId(payload.oldTdbId, this.zeroVector(), {
        ...payload.oldRecord,
        kind: 'fact',
      } satisfies FactPayload)
    }
    store.upsertEdge(payload.oldTdbId, payload.replacementTdbId, 'superseded_by', 1)
    store.upsertEdge(payload.replacementTdbId, payload.oldTdbId, 'supersedes', 1)
  }

  private candidateFromStore(
    objectTdbId: number,
    object: FactObjectPayload,
    matchType: FactObjectCandidate['matchType'],
    score: number,
  ): FactObjectCandidate {
    const store = this.stores.getSharedStore('facts')
    const activeFacts = store
      .getEdges(objectTdbId)
      .filter((edge) => edge.label === 'has_fact')
      .map((edge) => store.get<FactPayload>(edge.targetId)?.payload)
      .filter(
        (fact): fact is FactPayload =>
          fact?.kind === 'fact' &&
          fact.status === 'active' &&
          !this.privacy?.deleted('fact', fact.id),
      )
      .map(({ kind: _kind, ...fact }) => fact)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
    return {
      objectId: object.id,
      standardName: object.standardName,
      aliases: object.aliases,
      matchType,
      score,
      activeFacts,
    }
  }

  private pathsForObject(objectTdbId: number): FactQueryPath[] {
    const store = this.stores.getSharedStore('facts')
    const object = store.get<FactObjectPayload>(objectTdbId)?.payload
    if (object?.kind !== 'fact_object') return []
    const paths: FactQueryPath[] = []
    for (const edge of store
      .getEdges(objectTdbId)
      .filter((item) => item.label === 'has_fact')
      .sort((a, b) => a.targetId - b.targetId)) {
      const fact = store.get<FactPayload>(edge.targetId)?.payload
      if (
        fact?.kind !== 'fact' ||
        fact.status === 'retracted' ||
        this.privacy?.deleted('fact', fact.id)
      )
        continue
      const nodes: FactQueryPath['nodes'] = [
        { id: object.id, kind: 'fact_object', name: object.standardName },
        { id: fact.id, kind: 'fact', name: fact.statement },
      ]
      const edges: FactQueryPath['edges'] = [
        { fromId: object.id, toId: fact.id, label: 'has_fact', weight: edge.weight },
      ]
      const replacementEdge = store
        .getEdges(edge.targetId)
        .filter((item) => item.label === 'superseded_by')
        .sort((a, b) => a.targetId - b.targetId)[0]
      if (replacementEdge) {
        const replacement = store.get<FactPayload>(replacementEdge.targetId)?.payload
        if (replacement?.kind === 'fact') {
          nodes.push({ id: replacement.id, kind: 'fact', name: replacement.statement })
          edges.push({
            fromId: fact.id,
            toId: replacement.id,
            label: 'superseded_by',
            weight: replacementEdge.weight,
          })
        }
      }
      paths.push({ nodes, edges })
    }
    return paths
  }

  private async findOperation(operationId: string): Promise<
    | {
        operation: FactOperationKind
        status: string
        payload: FactOperationPayload
      }
    | undefined
  > {
    const [row] = await this.db
      .select()
      .from(factMemoryOperations)
      .where(eq(factMemoryOperations.operationId, operationId))
      .limit(1)
    return row
      ? {
          operation: row.operation as FactOperationKind,
          status: row.status,
          payload: JSON.parse(row.payloadJson) as FactOperationPayload,
        }
      : undefined
  }

  private objectPayload(object: FactObjectRow): FactObjectPayload {
    return {
      kind: 'fact_object',
      id: object.id,
      standardName: object.standardName,
      normalizedName: object.normalizedName,
      aliases: this.aliases(object.aliasesJson),
    }
  }

  private factPayload(row: FactRow, objectName: string): FactPayload {
    return { ...this.toFact(row, objectName), kind: 'fact' }
  }

  private async findObject(id: string) {
    return (await this.db.select().from(factObjects).where(eq(factObjects.id, id)).limit(1))[0]
  }

  private async factRow(id: string) {
    return (await this.db.select().from(factRecords).where(eq(factRecords.id, id)).limit(1))[0]
  }

  private toFact(row: FactRow, objectName: string): FactRecord {
    return {
      id: row.id,
      objectId: row.objectId,
      objectName,
      statement: row.statement,
      status: row.status as FactRecord['status'],
      observedAt: row.observedAt,
      createdAt: row.createdAt,
      source: row.source ?? undefined,
      confidence: row.confidence ?? undefined,
      createdByAgentId: row.createdByAgentId,
    }
  }

  private aliases(value: string): string[] {
    return JSON.parse(value) as string[]
  }

  private normalize(value: string): string {
    return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, '')
  }

  private textScore(query: string, candidate: string): number {
    if (!query || !candidate) return 0
    if (candidate.startsWith(query) || candidate.includes(query) || query.includes(candidate))
      return 1
    return 1 / (1 + this.editDistance(query, candidate))
  }

  private editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index)
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]!
      row[0] = i
      for (let j = 1; j <= b.length; j++) {
        const old = row[j]!
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
        previous = old
      }
    }
    return row[b.length]!
  }

  private zeroVector(): number[] {
    return new Array(this.stores.getDimension()).fill(0)
  }

  private async allocateTdbId(): Promise<number> {
    if (this.nextTdbId === undefined) {
      const [objects, facts] = await Promise.all([
        this.db
          .select({ max: sql<number>`coalesce(max(${factObjects.tdbId}), 0)` })
          .from(factObjects),
        this.db
          .select({ max: sql<number>`coalesce(max(${factRecords.tdbId}), 0)` })
          .from(factRecords),
      ])
      this.nextTdbId = Math.max(Number(objects[0]?.max ?? 0), Number(facts[0]?.max ?? 0)) + 1
    }
    return this.nextTdbId++
  }
}
