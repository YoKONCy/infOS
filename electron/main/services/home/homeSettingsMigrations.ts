/**
 * @file `desktop-home.json` 的版本迁移链（纯函数）。
 *
 * 每一步只负责把第 N 版的记录改成第 N+1 版，读取时从文件版本逐级执行到当前版本。
 * 新增版本时：先在 homeSettingsSchema 里把 HOME_SETTINGS_VERSION 加一，再在这里登记上一版到新版的一步，
 * 测试会检查链条是否连续。
 *
 * @platform ELECTRON
 * @see homeSettings.ts
 */

type HomeRecord = Record<string, unknown>

/** 键：起始版本；值：把这一版的记录改成下一版。 */
export const HOME_MIGRATIONS: Readonly<Record<number, (record: HomeRecord) => HomeRecord>> = {
  // v3 → v4：旧版 180 秒是下限、每小时 20 次是上限，存着这两个值不代表用户选过，换成新默认。
  3: (record) => {
    const companion = record.companion
    if (!companion || typeof companion !== 'object') return record
    const { minIntervalSec, maxPerHour } = companion as Record<string, unknown>
    return { ...record, companion: { ...companion, ...(minIntervalSec === 180 ? { minIntervalSec: 120 } : {}), ...(maxPerHour === 20 ? { maxPerHour: 30 } : {}) } }
  },
  // v2 没有常驻采集授权；不能由旧耳朵或环境开关推断授权。
  2: (record) => {
    const { perception: _ignored, ...rest } = record
    return rest
  },
  // v1 → v2：新增 environment 分区（环境事件，默认关闭）。
  // v1 从未声明这个分区，旧文件里碰巧有的同名字段不能当成用户开启过，整块丢弃后按默认值补齐。
  1: (record) => {
    const { environment: _ignored, ...rest } = record
    return rest
  },
}

/** 从 from 版逐级迁移到 to 版；缺少某一步时抛错（说明链条断了，属于开发错误）。 */
export function migrateHomeRecord(record: HomeRecord, from: number, to: number): HomeRecord {
  let current = record
  for (let version = from; version < to; version++) {
    const step = HOME_MIGRATIONS[version]
    if (!step) throw new Error(`DESKTOP_HOME_MIGRATION_MISSING: v${version}`)
    current = step(current)
  }
  return current
}
