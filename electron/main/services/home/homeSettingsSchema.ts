/**
 * @file `desktop-home.json` 的字段定义与校验（纯函数）。
 *
 * 每个用户选项都在 HOME_SCHEMA 里登记类型、范围和默认值；读文件和设置页写入都经过同一套校验：
 * - 文件不是对象、版本比当前新、体积过大：整份按默认值处理；
 * - 某个字段类型不对：这个字段用默认值；数值超出范围：截到边界；
 * - 未登记的字段一律丢弃。
 *
 * @platform ELECTRON
 * @see homeSettings.ts
 */

import type { DesktopHomeSection, DesktopHomeSettings } from '@infos/shared'
import { t } from '../../utils/i18n'

/** 版本号；升级时登记迁移链。v2 新增 environment，v3 新增默认关闭的 perception，v4 放宽陪看插话间隔。 */
export const HOME_SETTINGS_VERSION = 4
/** 文件体积上限（字节）；超过视为损坏。 */
export const HOME_SETTINGS_MAX_BYTES = 256 * 1024

type FieldRule =
  | { type: 'strings'; maxItems: number; fallback: readonly string[] }
  | { type: 'number'; min: number; max: number; fallback: number; integer?: boolean }
  | { type: 'boolean'; fallback: boolean }
  | { type: 'enum'; values: readonly string[]; fallback: string }
  | { type: 'string'; maxLength: number; pattern?: RegExp; fallback: string }

export const HOME_SCHEMA = {
  perception: {
    enabled: { type: 'boolean', fallback: false },
    hardStopped: { type: 'boolean', fallback: false },
    pausedUntil: { type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0, integer: true },
    windowTitles: { type: 'boolean', fallback: true },
    // 只决定开了常驻后带不带图，真正带图还要预设里打开，所以默认开不会多花额度。
    screenImages: { type: 'boolean', fallback: true },
    sound: { type: 'boolean', fallback: false },
    proactive: { type: 'boolean', fallback: false },
    // 只是允许陪看，不会自己开始；默认关会让升级后「陪我看」直接失败。
    watchAlong: { type: 'boolean', fallback: true },
    proactiveLevel: { type: 'enum', values: ['low', 'medium', 'high'], fallback: 'medium' },
    redactedApps: { type: 'strings', maxItems: 100, fallback: ['1password', 'bitwarden', 'keepass', 'lastpass', '银行', 'bank', 'alipay', '支付宝', '支付'] },
    unrecordedApps: { type: 'strings', maxItems: 100, fallback: ['wechat', 'weixin', 'qq', 'discord', 'teams', 'zoom', 'skype'] },
  },
  vision: {
    imageQuality: { type: 'number', min: 50, max: 95, fallback: 80, integer: true },
    // 原来固定 120 秒；高清截图加长时间思考容易超时，默认放宽到 10 分钟。
    observationTtlSec: { type: 'number', min: 60, max: 1800, fallback: 600, integer: true },
    ocrLanguage: { type: 'string', maxLength: 35, pattern: /^[A-Za-z0-9-]*$/, fallback: '' },
  },
  ears: {
    enabled: { type: 'boolean', fallback: false },
    language: {
      type: 'enum',
      values: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
      fallback: 'auto',
    },
    silenceThreshold: { type: 'number', min: 0.001, max: 0.1, fallback: 0.008 },
    petIndicator: { type: 'boolean', fallback: true },
    // 她自己的声音怎么排除：process 按进程排除（不支持时自动退回），drop 她出声时整段丢弃。
    selfExclusion: { type: 'enum', values: ['process', 'drop'], fallback: 'process' },
  },
  companion: {
    interject: { type: 'boolean', fallback: true },
    minIntervalSec: { type: 'number', min: 60, max: 3600, fallback: 120, integer: true },
    maxPerHour: { type: 'number', min: 1, max: 60, fallback: 30, integer: true },
    pauseAfterSec: { type: 'number', min: 5, max: 300, fallback: 20, integer: true },
  },
  // 环境事件：总开关默认关闭；打开后三种事件各自可关。事件只在用户下次说话时附带给她，不会叫醒模型。
  environment: {
    enabled: { type: 'boolean', fallback: false },
    idle: { type: 'boolean', fallback: true },
    idleMinutes: { type: 'number', min: 1, max: 120, fallback: 5, integer: true },
    fullscreen: { type: 'boolean', fallback: true },
    taskCompleted: { type: 'boolean', fallback: true },
  },
} as const satisfies Record<DesktopHomeSection, Record<string, FieldRule>>

function normalizeField(rule: FieldRule, value: unknown): unknown {
  switch (rule.type) {
    case 'strings':
      return Array.isArray(value) && value.length <= rule.maxItems && value.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 100)
        ? [...new Set(value.map(item => item.trim().toLowerCase()))] : [...rule.fallback]
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return rule.fallback
      const clamped = Math.max(rule.min, Math.min(rule.max, value))
      return rule.integer ? Math.round(clamped) : clamped
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : rule.fallback
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value) ? value : rule.fallback
    case 'string':
      return typeof value === 'string' &&
        value.length <= rule.maxLength &&
        (!rule.pattern || rule.pattern.test(value))
        ? value
        : rule.fallback
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** 规整一个分区：缺失或非法的字段用默认值，未登记的字段丢弃。 */
export function normalizeSection<S extends DesktopHomeSection>(
  section: S,
  value: unknown,
): DesktopHomeSettings[S] {
  const raw = isRecord(value) ? value : {}
  const rules = HOME_SCHEMA[section] as Record<string, FieldRule>
  return Object.fromEntries(
    Object.entries(rules).map(([key, rule]) => [key, normalizeField(rule, raw[key])]),
  ) as unknown as DesktopHomeSettings[S]
}

export function normalizeHomeSettings(value: unknown): DesktopHomeSettings {
  const raw = isRecord(value) ? value : {}
  return {
    perception: normalizeSection('perception', raw.perception),
    vision: normalizeSection('vision', raw.vision),
    ears: normalizeSection('ears', raw.ears),
    companion: normalizeSection('companion', raw.companion),
    environment: normalizeSection('environment', raw.environment),
  }
}

/**
 * 设置页提交的修改：只能改已登记的分区与字段，类型不对直接拒绝（不悄悄改成默认值），
 * 数值超出范围截到边界。返回规整后的局部值。
 */
export function validatePatch(
  section: unknown,
  patch: unknown,
): { section: DesktopHomeSection; values: Record<string, unknown> } {
  if (typeof section !== 'string' || !Object.hasOwn(HOME_SCHEMA, section) || !isRecord(patch))
    throw new Error(
      `DESKTOP_HOME_SETTINGS_INVALID: ${t('electron.ui.desktopControl', '设置分区或格式不正确')}`,
    )
  const rules = HOME_SCHEMA[section as DesktopHomeSection] as Record<string, FieldRule>
  const values: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined
    if (!rule)
      throw new Error(
        `DESKTOP_HOME_SETTINGS_INVALID: ${t('electron.ui.desktopControl', '未知的设置项：{0}', [`${section}.${key}`])}`,
      )
    const kind = rule.type === 'enum' ? 'string' : rule.type
    if ((kind === 'strings' ? !Array.isArray(value) || value.length > (rule as Extract<FieldRule, {type: 'strings'}>).maxItems || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 100) : typeof value !== kind) || (kind === 'number' && !Number.isFinite(value)))
      throw new Error(
        `DESKTOP_HOME_SETTINGS_INVALID: ${t('electron.ui.desktopControl', '设置项 {0} 的类型不正确', [`${section}.${key}`])}`,
      )
    if ((rule.type === 'enum' || rule.type === 'string') && normalizeField(rule, value) !== value)
      throw new Error(
        `DESKTOP_HOME_SETTINGS_INVALID: ${t('electron.ui.desktopControl', '设置项 {0} 的取值不正确', [`${section}.${key}`])}`,
      )
    values[key] = normalizeField(rule, value)
  }
  return { section: section as DesktopHomeSection, values }
}

/** 内部状态：耳朵模型文件的校验记录、编译缓存 DLL 的哈希。不出现在设置页。 */
export interface HomeInternalState {
  /** 已校验过的模型文件：文件名 → 校验时的大小与修改时间（不变就不再重算 240 MB 的哈希）。 */
  earsModel: Record<string, { size: number; mtimeMs: number; sha256: string }>
  /** 编译缓存 DLL：文件名 → SHA-256。 */
  assemblies: Record<string, string>
  /** assemblies 的 HMAC 签名（系统加密可用时）。 */
  assembliesSignature?: string
}

const HEX64 = /^[a-f0-9]{64}$/
const FILE_NAME = /^[\w.-]{1,120}$/

/** 规整内部状态：文件名和哈希格式不对的条目丢弃。 */
export function normalizeInternal(value: unknown): HomeInternalState {
  const raw = isRecord(value) ? value : {}
  const earsModel: HomeInternalState['earsModel'] = {}
  if (isRecord(raw.earsModel))
    for (const [name, item] of Object.entries(raw.earsModel)) {
      if (
        FILE_NAME.test(name) &&
        isRecord(item) &&
        typeof item.size === 'number' &&
        typeof item.mtimeMs === 'number' &&
        typeof item.sha256 === 'string' &&
        HEX64.test(item.sha256)
      )
        earsModel[name] = { size: item.size, mtimeMs: item.mtimeMs, sha256: item.sha256 }
    }
  const assemblies: Record<string, string> = {}
  if (isRecord(raw.assemblies))
    for (const [name, hash] of Object.entries(raw.assemblies))
      if (FILE_NAME.test(name) && typeof hash === 'string' && HEX64.test(hash))
        assemblies[name] = hash
  return {
    earsModel,
    assemblies,
    ...(typeof raw.assembliesSignature === 'string'
      ? { assembliesSignature: raw.assembliesSignature }
      : {}),
  }
}
