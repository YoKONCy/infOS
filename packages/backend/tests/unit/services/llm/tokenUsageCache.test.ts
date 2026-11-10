import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DrizzleDb } from '@infos/backend/database'
import { TokenUsageRepository } from '@infos/backend/repositories/tokenUsage.repo'
import { TokenUsageService } from '@infos/backend/services/llm/tokenUsageService'
import type { LlmUsageAttempt } from '@infos/backend/services/llm/usage'

let sqlite: Database.Database
let repository: TokenUsageRepository
let service: TokenUsageService
let sequence = 0
const now = Date.parse('2026-10-18T12:00:00+08:00')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  sqlite = new Database(':memory:')
  sqlite.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, thread_kind TEXT NOT NULL DEFAULT 'side')")
  sqlite.exec(
    readFileSync(
      new URL('../../../../src/database/migrations/0010_llm_usage.sql', import.meta.url),
      'utf8',
    ),
  )
  repository = new TokenUsageRepository(drizzle(sqlite) as DrizzleDb)
  sqlite.exec(
    readFileSync(
      new URL(
        '../../../../src/database/migrations/0015_prompt_cache_diagnostics.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  service = new TokenUsageService(repository)
  sequence = 0
})
afterEach(() => {
  sqlite.close()
  vi.useRealTimers()
})
function record(input: number, cached?: number, options: Partial<LlmUsageAttempt> = {}) {
  repository.record({
    id: `usage-${++sequence}`,
    startedAt: now,
    finishedAt: now + 100,
    provider: 'deepseek',
    modelId: 'deepseek-flash',
    agentId: 'pero',
    purpose: 'conversation',
    status: 'completed',
    usage: {
      promptTokens: input,
      completionTokens: 20,
      totalTokens: input + 20,
      cachedReadTokens: cached,
    },
    ...options,
  })
}

describe('缓存用量的同口径聚合', () => {
  it('Thread、供应商模型与角色筛选可组合，并同时约束用量和最早记录时间', () => {
    record(1000, 900, { threadId: 't1' })
    record(500, 100, { threadId: 't2' })
    record(200, 50, { threadId: 't1', modelId: 'other-model' })
    record(300, 0, { threadId: 't1', provider: 'relay' })
    record(400, 100, { threadId: 't1', agentId: 'nana', startedAt: now - 86400000 })
    const filtered = service.statistics('7d', 'Asia/Shanghai', 'pero', {
      threadId: 't1',
      provider: 'deepseek',
      modelId: 'deepseek-flash',
    })
    expect(filtered.totals).toMatchObject({
      requests: 1,
      inputTokens: 1000,
      cacheHitTokens: 900,
      cacheMissTokens: 100,
    })
    expect(filtered.firstRecordedAt).toBe(new Date(now).toISOString())
    expect(
      service.statistics('7d', 'Asia/Shanghai', undefined, { threadId: 't1' }).totals.requests,
    ).toBe(4)
    expect(
      service.statistics('today', 'Asia/Shanghai', undefined, { threadId: '不存在' }).totals
        .requests,
    ).toBe(0)
  })

  it('筛选选项保留已删除 Thread 和社交通道，按实际使用模型去重并支持角色隔离', () => {
    sqlite.prepare('INSERT INTO threads (id, title, thread_kind) VALUES (?, ?, ?)').run('t1', '制作网页', 'main')
    record(100, 10, { threadId: 't1' })
    record(100, 10, { threadId: 't1' })
    record(100, 10, { threadId: 'social:qq:private:123456' })
    record(100, 10, { threadId: 'nana-only', modelId: 'other-model', agentId: 'nana' })
    expect(service.filterOptions('pero')).toEqual({
      threads: expect.arrayContaining([
        { id: 't1', title: '制作网页', threadKind: 'main' },
        { id: 'social:qq:private:123456', title: null, threadKind: null },
      ]),
      models: [{ provider: 'deepseek', modelId: 'deepseek-flash' }],
    })
    expect(service.filterOptions('pero').threads).toHaveLength(2)
  })

  it('按通道聚合，历史无归属记录单列，合计仍保持一致', () => {
    record(1000, 900, { channel: 'desktop', threadId: 't1', applicationId: 'infos', step: 1 })
    record(500, 100, { channel: 'social', threadId: 'qq:t1', applicationId: 'social', step: 2 })
    record(100, 0)
    const result = service.statistics('today', 'Asia/Shanghai')
    expect(result.totals.cacheHitTokens).toBe(1000)
    expect(result.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'desktop', cacheHitTokens: 900, requests: 1 }),
        expect.objectContaining({ key: 'social', cacheHitTokens: 100, requests: 1 }),
        expect.objectContaining({ key: 'unknown', cacheHitTokens: 0, requests: 1 }),
      ]),
    )
  })
  it('按 Token 加权，未上报请求不进入缓存分母，缓存写入不算命中', () => {
    record(1000, 900)
    record(100, 0, {
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedReadTokens: 0,
        cachedWriteTokens: 100,
      },
    })
    record(9000)
    const result = service.statistics('today', 'Asia/Shanghai')
    const expected = {
      requests: 3,
      inputTokens: 10100,
      cachedWriteTokens: 100,
      cacheHitTokens: 900,
      cacheMissTokens: 200,
      cacheReportedRequests: 2,
      cacheHitRequests: 1,
    }
    expect(result.totals).toMatchObject(expected)
    expect(result.models[0]).toMatchObject(expected)
    expect(result.purposes[0]).toMatchObject(expected)
    expect(result.buckets.find((bucket) => bucket.requests > 0)).toMatchObject(expected)
  })

  it('缓存量缺失、输入量缺失或计数越界时，保留原始用量但不计算命中率', () => {
    record(1000)
    record(0, 50, {
      usage: {
        promptTokens: 0,
        completionTokens: 20,
        totalTokens: 20,
        cachedReadTokens: 50,
        inputReported: false,
      },
    })
    record(100, 101)
    const { totals } = service.statistics('today', 'Asia/Shanghai')
    expect(totals).toMatchObject({
      requests: 3,
      inputTokens: 1100,
      cachedReadTokens: 151,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      cacheReportedRequests: 0,
      cacheHitRequests: 0,
    })
  })

  it('供应商明确上报零命中与没有缓存数据是不同状态', () => {
    record(100, 0)
    expect(service.statistics('today', 'Asia/Shanghai').totals).toMatchObject({
      cacheHitTokens: 0,
      cacheMissTokens: 100,
      cacheReportedRequests: 1,
      cacheHitRequests: 0,
    })
  })

  it('按角色与时间范围筛选，并保持不同模型、用途的缓存统计独立', () => {
    record(1000, 900)
    record(100, 0, { agentId: 'nana', purpose: 'memory' })
    record(200, 100, {
      startedAt: now - 2 * 86400000,
      purpose: 'memory',
      modelId: 'other-model',
    })
    record(300, 200, { startedAt: now - 31 * 86400000 })
    const today = service.statistics('today', 'Asia/Shanghai', 'pero')
    expect(today.totals.cacheReportedRequests).toBe(1)
    const week = service.statistics('7d', 'Asia/Shanghai', 'pero')
    expect(week.totals).toMatchObject({
      cacheHitTokens: 1000,
      cacheMissTokens: 200,
      cacheReportedRequests: 2,
      cacheHitRequests: 2,
    })
    expect(week.models).toHaveLength(2)
    expect(week.purposes).toHaveLength(2)
    expect(service.statistics('30d', 'Asia/Shanghai', 'pero').totals).toEqual(week.totals)
  })
})
