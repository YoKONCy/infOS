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
  group('一次改太多时', [
    field(
      'massChangeThreshold',
      'count',
      1,
      10_000,
      '一次改多少个文件要停下来问',
      '短时间里改的文件超过这个数，她必须停下来一个个问你，不管之前给过多大的授权。',
    ),
    field(
      'massChangeWindowMs',
      'seconds',
      1,
      3_600_000,
      '「一次」按多长时间算',
      '这段时间里的改动都算在同一次里，不同对话的改动也一起算。',
    ),
  ]),
  group('备份与撤回', [
    field(
      'checkpointRetentionMs',
      'days',
      1,
      31_536_000_000,
      '改动备份留多久',
      '她改文件前会自动留一份备份。过了这个时间，这条改动就只能看、不能撤回了；删掉的地点也只能在这段时间里找回。',
    ),
    field(
      'snapshotMaxBytes',
      'mib',
      1,
      68_719_476_736,
      '备份和回收区最多占多大',
      '备份和回收区加起来最多用这么多空间。满了以后新的改动会直接失败，不会偷偷删掉旧备份。',
    ),
    field(
      'fileMaxBytes',
      'mib',
      1,
      268_435_456,
      '单个文件最大',
      '她能读、能改、能备份的单个文件最大多少。',
    ),
  ]),
  group('确认和记录', [
    field(
      'confirmationTimeoutMs',
      'seconds',
      1000,
      600_000,
      '确认通知等你多久',
      '右下角的确认通知最多等你这么久。没回答就自动作废，她要再问一次。',
    ),
    field(
      'activityRetentionMs',
      'days',
      1,
      31_536_000_000,
      '活动记录留多久',
      '「她做过什么」的记录留多久。不能比「一次」的时长还短。',
    ),
  ]),
  group('置物架与地图', [
    field(
      'shelfMaxBytes',
      'mib',
      1,
      68_719_476_736,
      '置物架最多占多大',
      '每个角色的置物架最多用这么多空间，删掉但还能恢复的东西也算在内。',
    ),
    field(
      'shelfMaxItems',
      'count',
      1,
      10_000,
      '置物架最多放几件',
      '每个角色的置物架最多放这么多件，删掉但还能恢复的东西也算在内。',
    ),
    field(
      'mapMaxItems',
      'count',
      1,
      10_000,
      '地图最多记几条',
      '她最多记住多少条「哪个软件、文件夹、窗口是做什么的」。',
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
