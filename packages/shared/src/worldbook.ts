/**
 * 世界书 — 前后端共用的结构、默认值、归一化与酒馆世界书导入
 *
 * 世界书以书库形式集中保存；全局启用的书对所有角色生效，
 * 角色另可绑定一本主要世界书（随角色导出）与若干附加世界书。
 * 激活的条目统一注入末尾的本轮动态上下文，不改动系统提示词与历史，避免破坏提示词缓存。
 * 本文件只包含纯函数，不读写文件，也不依赖运行端。
 *
 * @module packages/shared/src/worldbook
 */

/** 蓝灯常驻，绿灯按关键词触发。 */
export type WorldbookLight = 'constant' | 'keyword'

/** 条目可生效的场景；条目未勾选任何场景时视为全部场景。 */
export type WorldbookChannel = 'desktop' | 'group' | 'social_private' | 'social_group'

export interface WorldbookEntry {
  id: string
  /** 仅供编辑时辨认，不发送给模型。 */
  title: string
  content: string
  /** 关闭的条目不参与激活；重新开启时恢复原来的蓝绿灯。 */
  enabled: boolean
  light: WorldbookLight
  keys: string[]
  /** 数值越小在世界书块中越靠前；Token 不足时数值大的优先保留。 */
  order: number
  /** 满足触发条件后实际注入的概率，0–100。 */
  probability: number
  /** 绿灯触发后额外保持的对话轮数，0 表示只在扫描范围内命中时生效。 */
  sticky: number
  channels: WorldbookChannel[]
}

export interface Worldbook {
  version: 1
  id: string
  name: string
  /** 每次保存递增，用于拒绝覆盖其他窗口的新修改。 */
  revision: number
  updatedAt: string
  entries: WorldbookEntry[]
}

export interface WorldbookSummary {
  id: string
  name: string
  entryCount: number
  revision: number
  updatedAt: string
}

/** 全局激活设置。 */
export interface WorldbookSettings {
  /** 关键词扫描最近多少条消息（含当前输入）。 */
  scanDepth: number
  /** 世界书最多占用的 Token；0 表示不限制。 */
  tokenBudget: number
  /** 对所有角色生效的世界书 ID。 */
  globalBooks: string[]
}

/** 角色绑定：主要世界书随角色导出，附加世界书只在本机关联。 */
export interface WorldbookBinding {
  primary: string | null
  additional: string[]
}

/** 条目命中原因：蓝灯常驻、扫描范围内命中关键词、粘滞轮数内曾命中。 */
export type WorldbookHitReason = 'constant' | 'keyword' | 'sticky'

export interface WorldbookHit {
  bookId: string
  entryId: string
  title: string
  reason: WorldbookHitReason
  /** 命中的关键词；蓝灯为空。 */
  keyword?: string
  tokens: number
}

/** 一次激活的结果；同一结构用于提示词装配与编辑页命中测试。 */
export interface WorldbookActivation {
  /** 实际注入的条目，按注入顺序排列。 */
  hits: WorldbookHit[]
  /** 满足条件但因 Token 预算被舍弃的条目，格式为 `书 ID/条目 ID`。 */
  dropped: string[]
  /** 满足条件但未通过触发概率的条目，格式为 `书 ID/条目 ID`。 */
  skipped: string[]
  /** 按顺序数拼接的条目正文，注入本轮动态上下文。 */
  content: string
  tokens: number
}

/** 编辑页命中测试：使用当前未保存的条目与一段模拟输入，按全局设置激活。 */
export interface WorldbookTestRequest {
  entries: WorldbookEntry[]
  text: string
  channel: WorldbookChannel
}

export const WORLDBOOK_FILE_NAME = 'worldbook.json'
export const WORLDBOOK_CHANNELS: readonly WorldbookChannel[] = [
  'desktop',
  'group',
  'social_private',
  'social_group',
]
export const WORLDBOOK_LIMITS = {
  books: 1000,
  entries: 2000,
  name: 100,
  title: 200,
  content: 20_000,
  keys: 50,
  keyLength: 200,
  order: 100_000,
  sticky: 100,
  scanDepth: 100,
  tokenBudget: 200_000,
  additionalBooks: 50,
} as const

const LIGHTS: readonly WorldbookLight[] = ['constant', 'keyword']

export function createWorldbookSettings(): WorldbookSettings {
  return { scanDepth: 2, tokenBudget: 0, globalBooks: [] }
}

export function createWorldbookEntry(id: string, order = 100): WorldbookEntry {
  return {
    id,
    title: '',
    content: '',
    enabled: true,
    light: 'keyword',
    keys: [],
    order,
    probability: 100,
    sticky: 0,
    channels: [],
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (value === null || value === '' || !Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** 世界书 ID 只允许安全文件名字符。 */
export function isWorldbookId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
}

/** 去除空白与重复关键词，保持原顺序。 */
export function normalizeWorldbookKeys(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const keys: string[] = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const key = item.trim().slice(0, WORLDBOOK_LIMITS.keyLength)
    if (key && !keys.includes(key)) keys.push(key)
    if (keys.length >= WORLDBOOK_LIMITS.keys) break
  }
  return keys
}

/** 把任意条目数组收敛为合法条目；重复或空 ID 重新编号。 */
export function normalizeWorldbookEntries(value: unknown): WorldbookEntry[] {
  const entries: WorldbookEntry[] = []
  const ids = new Set<string>()
  const rawEntries = Array.isArray(value) ? value : []
  for (const [index, raw] of rawEntries.entries()) {
    if (entries.length >= WORLDBOOK_LIMITS.entries) break
    const item = record(raw)
    let id = text(item.id, 100).trim()
    if (!id || ids.has(id)) {
      let next = index + 1
      while (ids.has(`entry-${next}`)) next++
      id = `entry-${next}`
    }
    ids.add(id)
    const base = createWorldbookEntry(id)
    const channels = Array.isArray(item.channels)
      ? WORLDBOOK_CHANNELS.filter((channel) => (item.channels as unknown[]).includes(channel))
      : []
    entries.push({
      id,
      title: text(item.title, WORLDBOOK_LIMITS.title),
      content: text(item.content, WORLDBOOK_LIMITS.content),
      enabled: typeof item.enabled === 'boolean' ? item.enabled : base.enabled,
      light: pick(item.light, LIGHTS, base.light),
      keys: normalizeWorldbookKeys(item.keys),
      order: integer(item.order, base.order, -WORLDBOOK_LIMITS.order, WORLDBOOK_LIMITS.order),
      probability: integer(item.probability, base.probability, 0, 100),
      sticky: integer(item.sticky, base.sticky, 0, WORLDBOOK_LIMITS.sticky),
      channels,
    })
  }
  return entries
}

/** 归一化世界书名称：去除首尾空白并限制长度；空名称返回空字符串由调用方报错。 */
export function normalizeWorldbookName(value: unknown): string {
  return text(value, WORLDBOOK_LIMITS.name * 4)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, WORLDBOOK_LIMITS.name)
}

export function normalizeWorldbookSettings(value: unknown): WorldbookSettings {
  const source = record(value)
  const defaults = createWorldbookSettings()
  return {
    scanDepth: integer(source.scanDepth, defaults.scanDepth, 1, WORLDBOOK_LIMITS.scanDepth),
    tokenBudget: integer(source.tokenBudget, defaults.tokenBudget, 0, WORLDBOOK_LIMITS.tokenBudget),
    globalBooks: uniqueIds(source.globalBooks, WORLDBOOK_LIMITS.books),
  }
}

export function normalizeWorldbookBinding(value: unknown): WorldbookBinding {
  const source = record(value)
  const primary = isWorldbookId(source.primary) ? source.primary : null
  return {
    primary,
    additional: uniqueIds(source.additional, WORLDBOOK_LIMITS.additionalBooks).filter(
      (id) => id !== primary,
    ),
  }
}

function uniqueIds(value: unknown, limit: number): string[] {
  const ids: string[] = []
  for (const item of Array.isArray(value) ? value : []) {
    if (isWorldbookId(item) && !ids.includes(item)) ids.push(item)
    if (ids.length >= limit) break
  }
  return ids
}

/** 酒馆世界书导入时被降级处理的设定，用于向用户说明。 */
export type WorldbookImportWarning =
  | 'position_unified'
  | 'secondary_keys_ignored'
  | 'regex_keys_literal'
  | 'entries_truncated'
  | 'content_truncated'

export interface WorldbookImportResult {
  /** 酒馆文件自带的名称（角色卡内嵌世界书的 `name`），可能为空。 */
  name: string
  entries: WorldbookEntry[]
  /** 每类警告涉及的条目数量。 */
  warnings: Partial<Record<WorldbookImportWarning, number>>
}

/**
 * 解析酒馆世界书 JSON（独立世界书、角色卡或角色卡内嵌的 `character_book`），
 * 本应用导出的文件也是酒馆格式。
 *
 * 转换蓝绿灯、关键词、顺序、启停、概率与粘滞。插入位置统一为本轮动态上下文，
 * 原本不在“角色定义后”的条目与次关键词等暂不支持的设定按警告统计。
 */
export function importSillyTavernWorldbook(value: unknown): WorldbookImportResult {
  const source = record(value)
  const data = record(source.data)
  const container =
    data.character_book !== undefined
      ? record(data.character_book)
      : source.character_book !== undefined
        ? record(source.character_book)
        : source
  const entriesField = container.entries
  if (!entriesField || typeof entriesField !== 'object') throw new Error('WORLDBOOK_IMPORT_INVALID')
  const rawEntries = Array.isArray(entriesField) ? entriesField : Object.values(entriesField)
  const warnings: WorldbookImportResult['warnings'] = {}
  const warn = (key: WorldbookImportWarning) => {
    warnings[key] = (warnings[key] ?? 0) + 1
  }
  const converted: Array<Record<string, unknown>> = []
  for (const [index, raw] of rawEntries.entries()) {
    if (converted.length >= WORLDBOOK_LIMITS.entries) {
      warn('entries_truncated')
      continue
    }
    const item = record(raw)
    const extensions = record(item.extensions)
    const rawKeys = item.key ?? item.keys
    const keys = normalizeWorldbookKeys(rawKeys)
    const title = item.comment ?? item.name
    const keyList = Array.isArray(rawKeys)
      ? rawKeys
      : typeof rawKeys === 'string'
        ? rawKeys.split(',')
        : []
    if (
      (typeof item.content === 'string' && item.content.length > WORLDBOOK_LIMITS.content) ||
      (typeof title === 'string' && title.length > WORLDBOOK_LIMITS.title) ||
      keyList.length > WORLDBOOK_LIMITS.keys ||
      keyList.some(
        (key) => typeof key === 'string' && key.trim().length > WORLDBOOK_LIMITS.keyLength,
      )
    )
      warn('content_truncated')
    const secondary = normalizeWorldbookKeys(item.keysecondary ?? item.secondary_keys)
    if (secondary.length && (item.selective ?? true)) warn('secondary_keys_ignored')
    if (keys.some((key) => /^\/.+\/[a-z]*$/i.test(key))) warn('regex_keys_literal')
    // 独立世界书使用数字位置；角色卡内嵌条目使用 before_char/after_char 并在扩展中保存数字位置。
    // 本应用导出的条目带 infosChannels，位置本就统一，不计入警告。
    const rawPosition = item.position
    const numeric =
      typeof extensions.position === 'number'
        ? extensions.position
        : typeof rawPosition === 'number'
          ? rawPosition
          : rawPosition === 'before_char'
            ? 0
            : 1
    if (numeric !== 1 && !Array.isArray(item.infosChannels)) warn('position_unified')
    const useProbability = item.useProbability ?? extensions.useProbability ?? true
    converted.push({
      id: `st-${index + 1}`,
      title,
      content: item.content,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : item.disable !== true,
      light: item.constant === true ? 'constant' : 'keyword',
      keys,
      order: item.order ?? item.insertion_order,
      probability: useProbability ? (item.probability ?? extensions.probability ?? 100) : 100,
      // 酒馆按消息数计算粘滞，本应用按对话轮数（用户与角色各一条）。
      sticky: Math.ceil(Number(item.sticky ?? extensions.sticky ?? 0) / 2),
      channels: item.infosChannels,
    })
  }
  return {
    name: normalizeWorldbookName(container.name ?? source.name),
    entries: normalizeWorldbookEntries(converted),
    warnings,
  }
}

/**
 * 导出为酒馆独立世界书格式，可直接导入酒馆。
 *
 * 位置导出为酒馆的 @D1（系统角色，紧挨最新消息），最接近本应用的本轮动态上下文；
 * 酒馆没有的设定（生效场景）写入 `infosChannels`，再次导入本应用时恢复；酒馆会忽略该字段。
 */
export function exportWorldbookFile(book: Worldbook): {
  name: string
  entries: Record<string, Record<string, unknown>>
} {
  const entries: Record<string, Record<string, unknown>> = {}
  for (const [uid, entry] of book.entries.entries()) {
    entries[String(uid)] = {
      uid,
      key: entry.keys,
      keysecondary: [],
      comment: entry.title,
      content: entry.content,
      constant: entry.light === 'constant',
      selective: false,
      order: entry.order,
      position: 4,
      disable: !entry.enabled,
      depth: 1,
      role: 0,
      probability: entry.probability,
      useProbability: entry.probability < 100,
      sticky: entry.sticky * 2,
      infosChannels: entry.channels,
    }
  }
  return { name: book.name, entries }
}
