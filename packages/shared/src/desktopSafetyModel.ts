/** 桌面操作护栏的内置名单与用户设置：常量、结构与默认值。 */

import safetyLists from './safety-lists.draft.json'

/** 随应用发布的内置名单（未校验的原始数据，使用前经 validateDesktopSafetyDraft）。 */
export const SAFETY_LISTS: unknown = safetyLists

/** 区域，从宽到严。 */
export const DESKTOP_ZONES = ['normal', 'mustConfirm', 'forbidden'] as const
export type DesktopZone = (typeof DESKTOP_ZONES)[number]

/** 普通区的审批方式，从宽到严：只提醒 / 每个程序问一次（默认）/ 每次都问。 */
export const DESKTOP_NORMAL_MODES = ['notify', 'once', 'always'] as const
export type DesktopNormalMode = (typeof DESKTOP_NORMAL_MODES)[number]

export const DESKTOP_SAFETY_FILE = 'desktop-safety.json'

export const DESKTOP_SAFETY_LIMITS = {
  /** 每个名单最多条目数。 */
  entries: 300,
  /** 程序名、标题关键词、快捷键的最大长度。 */
  text: 120,
  /** 任务预批覆盖的程序数。 */
  planPrograms: 20,
  /** 任务预批的有效期：没有“本次运行结束”的信号，以时间兜底。 */
  planTtlMs: 60 * 60_000,
  /** 高危区“允许这一次”的有效期：批准后角色重新观察并执行同一程序的一次动作。 */
  onceTtlMs: 2 * 60_000,
} as const

/** 内置名单（草案文件）的结构。 */
export interface SafetyCategory<T = string> {
  purpose: string
  risk: string
  entries: T[]
  appliesTo?: string[]
  sources?: string[]
}
export type SafetyGroups<T = string> = Record<string, SafetyCategory<T>>
export type SafetyAction = 'read' | 'write' | 'delete' | 'configure'
export interface SafetyResourceCategory<T> extends SafetyCategory<T> {
  zone: 'forbidden' | 'mustConfirm'
  actions: SafetyAction[]
}
export interface SafetyTitleRule {
  match: 'exact' | 'contains'
  value: string
  zone: 'forbidden' | 'mustConfirm'
  programs?: string[]
}
export interface SafetyHotkeyRule {
  program: string
  key: string
  scope: 'any' | 'desktop' | 'system-folder'
}
export interface DesktopSafetyDraft {
  schemaVersion: 2
  status: 'DRAFT' | 'FINAL'
  note?: string
  programs: { forbidden: SafetyGroups; mustConfirm: SafetyGroups }
  launchAliases: SafetyGroups<{ name: string; program: string }>
  launchFiles: SafetyGroups<{ name: string; host: string }>
  backgroundComponents: SafetyGroups
  fileLaunchRules: Record<string, SafetyCategory & { host?: string }>
  windowTitles: SafetyGroups<SafetyTitleRule>
  hotkeys: SafetyGroups<SafetyHotkeyRule>
  highRiskTools: SafetyGroups
  sensitiveResources: {
    files: Record<
      string,
      SafetyResourceCategory<{ platform: 'win32' | 'darwin' | 'linux'; path: string }>
    >
    registry: Record<string, SafetyResourceCategory<string>>
    certificateStores: Record<string, SafetyResourceCategory<string>>
  }
}

/** 设置页只显示程序分区；类别说明仍保存在权威名单中。 */
export interface DesktopProgramLists {
  forbidden: Record<string, string[]>
  mustConfirm: Record<string, string[]>
}

export const safetyEntries = <T>(groups: SafetyGroups<T>): T[] =>
  Object.values(groups).flatMap((category) => category.entries)

export function desktopProgramLists(draft: DesktopSafetyDraft): DesktopProgramLists {
  const groups = (value: SafetyGroups) =>
    Object.fromEntries(Object.entries(value).map(([name, category]) => [name, category.entries]))
  return {
    forbidden: groups(draft.programs.forbidden),
    mustConfirm: groups(draft.programs.mustConfirm),
  }
}

/** 用户设置（可在文件中手动编辑）。 */
export interface DesktopSafetySettings {
  version: 1
  normalMode: DesktopNormalMode
  /** 追加到禁区的程序。 */
  forbidden: string[]
  /** 追加到高危区的程序。 */
  mustConfirm: string[]
  /** 信任名单：只对普通区的程序生效。 */
  trusted: string[]
}

export function createDefaultDesktopSafetySettings(): DesktopSafetySettings {
  return { version: 1, normalMode: 'once', forbidden: [], mustConfirm: [], trusted: [] }
}

/** 名单校验错误：稳定错误码 + 出错的值，在界面本地化。 */
export interface DesktopSafetyIssue {
  code:
    | 'SIGNATURE_INVALID'
    | 'BASELINE_INVALID'
    | 'NOT_OBJECT'
    | 'UNSUPPORTED_VERSION'
    | 'UNKNOWN_FIELD'
    | 'INVALID_MODE'
    | 'INVALID_LIST'
    | 'INVALID_ENTRY'
    | 'TOO_MANY_ENTRIES'
    | 'TRUST_NOT_ALLOWED'
    | 'UNSUPPORTED_DRAFT_VERSION'
    | 'DUPLICATE_ENTRY'
    | 'CONFLICTING_ENTRY'
  field: string
  value?: string
}

export type DesktopSafetyValidation<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: DesktopSafetyIssue[] }
