import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../database'
import { llmUsageRecords as records, threads } from '../database/schema'
import type { TokenUsageFilters, TokenUsageTotals } from '@infos/shared'
import type { LlmUsageAttempt } from '../services/llm/usage'
import { tokenCount } from '../services/llm/usage'

export class TokenUsageRepository {
  constructor(private db: DrizzleDb) {}

  record(attempt: LlmUsageAttempt): void {
    const { usage, ...attributes } = attempt
    this.db
      .insert(records)
      .values({
        ...attributes,
        inputTokens:
          usage?.inputReported === false ? null : (tokenCount(usage?.promptTokens) ?? null),
        outputTokens:
          usage?.outputReported === false ? null : (tokenCount(usage?.completionTokens) ?? null),
        totalTokens: tokenCount(usage?.totalTokens) ?? null,
        cachedReadTokens: tokenCount(usage?.cachedReadTokens) ?? null,
        cachedWriteTokens: tokenCount(usage?.cachedWriteTokens) ?? null,
        reasoningTokens: tokenCount(usage?.reasoningTokens) ?? null,
      })
      .onConflictDoNothing()
      .run()
  }

  /** 先在数据库聚合到分钟，保留非整点时区和夏令时的正确归属。 */
  aggregate(from: number, to: number, agentId?: string, filters: TokenUsageFilters = {}) {
    const minute = sql<number>`cast(${records.startedAt} / 60000 as integer) * 60000`
    // 未上报不能当作零命中；异常缓存计数也不进入命中率分子、分母。
    const cacheReported = sql`${records.inputTokens} is not null
      and ${records.cachedReadTokens} is not null
      and ${records.cachedReadTokens} >= 0
      and ${records.cachedReadTokens} <= ${records.inputTokens}`
    return this.db
      .select({
        at: minute,
        provider: records.provider,
        modelId: records.modelId,
        purpose: records.purpose,
        channel: records.channel,
        inputTokens: sql<number>`coalesce(sum(${records.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${records.outputTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${records.totalTokens}), 0)`,
        cachedReadTokens: sql<number>`coalesce(sum(${records.cachedReadTokens}), 0)`,
        cachedWriteTokens: sql<number>`coalesce(sum(${records.cachedWriteTokens}), 0)`,
        cacheHitTokens: sql<number>`sum(case when ${cacheReported} then ${records.cachedReadTokens} else 0 end)`,
        cacheMissTokens: sql<number>`sum(case when ${cacheReported} then ${records.inputTokens} - ${records.cachedReadTokens} else 0 end)`,
        cacheReportedRequests: sql<number>`sum(case when ${cacheReported} then 1 else 0 end)`,
        cacheHitRequests: sql<number>`sum(case when ${cacheReported} and ${records.cachedReadTokens} > 0 then 1 else 0 end)`,
        reasoningTokens: sql<number>`coalesce(sum(${records.reasoningTokens}), 0)`,
        requests: sql<number>`count(*)`,
        reportedRequests: sql<number>`sum(case when ${records.totalTokens} is not null then 1 else 0 end)`,
        inputReportedRequests: sql<number>`sum(case when ${records.inputTokens} is not null then 1 else 0 end)`,
        outputReportedRequests: sql<number>`sum(case when ${records.outputTokens} is not null then 1 else 0 end)`,
        incompleteRequests: sql<number>`sum(case when ${records.totalTokens} is not null and (${records.inputTokens} is null or ${records.outputTokens} is null) then 1 else 0 end)`,
        unreportedRequests: sql<number>`sum(case when ${records.totalTokens} is null then 1 else 0 end)`,
        failedRequests: sql<number>`sum(case when ${records.status} <> 'completed' then 1 else 0 end)`,
      })
      .from(records)
      .where(
        and(
          gte(records.startedAt, from),
          lt(records.startedAt, to),
          agentId ? eq(records.agentId, agentId) : undefined,
          this.filter(filters),
        ),
      )
      .groupBy(minute, records.provider, records.modelId, records.purpose, records.channel)
      .all()
  }

  private filter(filters: TokenUsageFilters) {
    return and(
      filters.threadId ? eq(records.threadId, filters.threadId) : undefined,
      filters.provider ? eq(records.provider, filters.provider) : undefined,
      filters.modelId ? eq(records.modelId, filters.modelId) : undefined,
    )
  }

  filterOptions(agentId?: string) {
    return {
      threads: this.db
        .select({ id: records.threadId, title: threads.title, threadKind: threads.threadKind })
        .from(records)
        .leftJoin(threads, eq(records.threadId, threads.id))
        .where(
          and(
            sql`${records.threadId} is not null`,
            agentId ? eq(records.agentId, agentId) : undefined,
          ),
        )
        .groupBy(records.threadId, threads.title, threads.threadKind)
        .orderBy(desc(sql`max(${records.startedAt})`))
        .all()
        .filter((row): row is { id: string; title: string | null; threadKind: 'main' | 'side' | null } => row.id !== null),
      models: this.db
        .select({ provider: records.provider, modelId: records.modelId })
        .from(records)
        .where(agentId ? eq(records.agentId, agentId) : undefined)
        .groupBy(records.provider, records.modelId)
        .orderBy(records.provider, records.modelId)
        .all(),
    }
  }

  firstRecordedAt(agentId?: string, filters: TokenUsageFilters = {}): number | null {
    return (
      this.db
        .select({ at: sql<number | null>`min(${records.startedAt})` })
        .from(records)
        .where(and(agentId ? eq(records.agentId, agentId) : undefined, this.filter(filters)))
        .get()?.at ?? null
    )
  }
}

export type TokenUsageAggregate = TokenUsageTotals & {
  at: number
  provider: string
  modelId: string
  purpose: string
  channel: string | null
}
