import type { HomeSettings } from '@infos/shared'
import { t as __t } from '../../../i18n/index'

/**
 * 「桌面与家」里后端保险设置（/api/home/settings）的 11 项：分组、说明与友好单位。
 * 界面按显示单位编辑整数，保存时换算回后端的毫秒 / 字节；范围与后端校验一致。
 */
export type HomeNumberKey = Exclude<keyof HomeSettings, 'mapBlockedTerms'>
export type HomeUnit = 'count' | 'seconds' | 'minutes' | 'days' | 'mib'

export interface HomeSettingField {
  key: HomeNumberKey
  unit: HomeUnit
  /** 后端允许的范围（原始单位）。 */
  min: number
  max: number
  readonly label: string
  readonly hint: string
}

const tr = (source: string) => __t('ui.desktop', source)

export const HOME_UNIT_FACTOR: Record<HomeUnit, number> = {
  count: 1,
  seconds: 1000,
  minutes: 60_000,
  days: 86_400_000,
  mib: 1024 * 1024,
}

export function homeUnitLabel(unit: HomeUnit): string {
  switch (unit) {
    case 'count':
      return tr('个')
    case 'seconds':
      return tr('秒')
    case 'minutes':
      return tr('分钟')
    case 'days':
      return tr('天')
    case 'mib':
      return tr('MB')
  }
}

/** 原始值 → 显示值（保留两位小数，便于看出不是整倍数的历史值）。 */
export function toDisplay(field: HomeSettingField, raw: number): number {
  return Math.round((raw / HOME_UNIT_FACTOR[field.unit]) * 100) / 100
}

/** 显示值 → 原始整数，并夹到后端允许的范围内。 */
export function fromDisplay(field: HomeSettingField, display: number): number {
  const raw = Math.round(display * HOME_UNIT_FACTOR[field.unit])
  return Math.min(field.max, Math.max(field.min, raw))
}

/** 显示范围：下限至少为 1 个显示单位，避免出现「0 天」这类没有意义的值。 */
export function displayRange(field: HomeSettingField): { min: number; max: number } {
  const factor = HOME_UNIT_FACTOR[field.unit]
  return { min: Math.max(1, Math.ceil(field.min / factor)), max: Math.floor(field.max / factor) }
}

function field(
  key: HomeNumberKey,
  unit: HomeUnit,
  min: number,
  max: number,
  label: string,
  hint: string,
): HomeSettingField {
  return {
    key,
    unit,
    min,
    max,
    get label() {
      return tr(label)
    },
    get hint() {
      return tr(hint)
    },
  }
}

export interface HomeSettingGroup {
  readonly title: string
  fields: HomeSettingField[]
}

function group(title: string, fields: HomeSettingField[]): HomeSettingGroup {
  return {
    get title() {
      return tr(title)
    },
    fields,
  }
}

export const HOME_SETTING_GROUPS: HomeSettingGroup[] = [
  group('批量修改保护', [
    field(
      'massChangeThreshold',
      'count',
      1,
      10_000,
      '单次批量修改上限',
      '时间窗口内修改文件数超过此上限时，转为逐个询问确认。',
    ),
    field(
      'massChangeWindowMs',
      'seconds',
      1,
      3_600_000,
      '批量统计时间窗口',
      '此时间窗口内的所有文件改动合并计入同一次操作。',
    ),
  ]),
  group('备份与撤回', [
    field(
      'checkpointRetentionMs',
      'days',
      1,
      31_536_000_000,
      '修改备份保留时长',
      '修改文件前自动备份的可撤回保留天数。',
    ),
    field(
      'snapshotMaxBytes',
      'mib',
      1,
      68_719_476_736,
      '备份与回收区容量上限',
      '空间占满后将拒绝新改动，不会自动清理旧备份。',
    ),
    field(
      'fileMaxBytes',
      'mib',
      1,
      268_435_456,
      '单文件大小上限',
      '允许读取、修改与备份的单个文件最大体积。',
    ),
  ]),
  group('确认与记录', [
    field(
      'confirmationTimeoutMs',
      'seconds',
      1000,
      600_000,
      '确认通知超时',
      '右下角授权询问的最大等待时长，超时自动作废。',
    ),
    field(
      'activityRetentionMs',
      'days',
      1,
      31_536_000_000,
      '活动记录保留时长',
      '操作历史保留天数（不可短于批量统计时间窗口）。',
    ),
  ]),
  group('共享空间限额', [
    field(
      'shelfMaxBytes',
      'mib',
      1,
      68_719_476_736,
      '置物架容量上限',
      '单个伙伴置物架的最大占用空间（含待恢复项）。',
    ),
    field(
      'shelfMaxItems',
      'count',
      1,
      10_000,
      '置物架数量上限',
      '单个伙伴置物架可存放的最大条目数（含待恢复项）。',
    ),
    field(
      'mapMaxItems',
      'count',
      1,
      10_000,
      '地点记忆数量上限',
      '最多记住的软件、文件夹与窗口用途条数。',
    ),
  ]),
]

/** 额外隐私禁存词：一行一个，最多 100 个，每个 1–128 字。 */
export function parseBlockedTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ]
}
export const BLOCKED_TERMS_LIMIT = { items: 100, length: 128 }
