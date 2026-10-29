/**
 * 配置 Repository
 *
 * SQLite configs 表 (全局键值对) 的数据访问层。
 *
 * @module packages/backend/src/repositories/config.repo
 */

import { eq, like } from 'drizzle-orm'
import { configs } from '../database/schema'
import type { DrizzleDb } from '../database'

// Drizzle 推导行类型
type ConfigRow = typeof configs.$inferSelect

// ─────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────

export class ConfigRepository {
  constructor(private db: DrizzleDb) {}

  /** 获取单个配置值 */
  async get(key: string): Promise<string | undefined> {
    const row = await this.db.select().from(configs).where(eq(configs.key, key)).get()
    return row?.value
  }

  /** 获取配置值并解析为 JSON */
  async getJson<T = unknown>(key: string): Promise<T | undefined> {
    const value = await this.get(key)
    if (value === undefined) return undefined
    try {
      return JSON.parse(value) as T
    } catch {
      return undefined
    }
  }

  /** 设置配置值 (upsert) */
  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(configs)
      .values({ key, value })
      .onConflictDoUpdate({
        target: configs.key,
        set: {
          value,
          updatedAt: new Date().toISOString(),
        },
      })
  }

  /** 设置 JSON 配置值 */
  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value))
  }

  /** 一组关联配置同时提交；undefined 用于恢复此前不存在的键。 */
  async replaceMany(items: ReadonlyArray<readonly [string, string | undefined]>): Promise<void> {
    this.db.transaction((transaction) => {
      for (const [key, value] of items) {
        if (value === undefined) transaction.delete(configs).where(eq(configs.key, key)).run()
        else
          transaction
            .insert(configs)
            .values({ key, value })
            .onConflictDoUpdate({
              target: configs.key,
              set: { value, updatedAt: new Date().toISOString() },
            })
            .run()
      }
    })
  }

  /** 删除配置 */
  async delete(key: string): Promise<void> {
    await this.db.delete(configs).where(eq(configs.key, key))
  }

  /** 获取所有配置 */
  async getAll(): Promise<ConfigRow[]> {
    return this.db.select().from(configs).all()
  }

  /** 批量获取 */
  async getMany(keys: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    // SQLite 无 IN 批量查询限制问题，逐个查询足够高效
    for (const key of keys) {
      const value = await this.get(key)
      if (value !== undefined) result.set(key, value)
    }
    return result
  }

  /** 按前缀列出配置 (B6-3) */
  async listAll(prefix: string): Promise<Array<{ key: string; value: string }>> {
    if (prefix) {
      const rows = await this.db
        .select()
        .from(configs)
        .where(like(configs.key, `${prefix}%`))
        .all()
      return rows.map((r) => ({ key: r.key, value: r.value }))
    }
    const rows = await this.db.select().from(configs).all()
    return rows.map((r) => ({ key: r.key, value: r.value }))
  }
}
