/** 桌面操作护栏的分区判断、审批决定与“放宽 / 收紧”判断。 */

import {
  DESKTOP_NORMAL_MODES,
  DESKTOP_SAFETY_LIMITS,
  type DesktopNormalMode,
  type DesktopSafetyDraft,
  type DesktopSafetySettings,
  type DesktopZone,
  type SafetyAction,
  safetyEntries,
  type SafetyHotkeyRule,
  type SafetyTitleRule,
} from './desktopSafetyModel'
import { isProgramEntry, normalizeHotkey, normalizeProgramName } from './desktopSafetyNormalize'
import { type SafetyPathContext, safetyResourceZone } from './desktopSafetyResources'

// ─── 分区判断 ───────────────────────────────────────

export interface DesktopZoneIndex {
  forbidden: Set<string>
  mustConfirm: Set<string>
  trusted: Set<string>
  aliases: Map<string, string>
  launchFiles: Map<string, string>
  fileExtensions: Set<string>
  extensionHosts: Map<string, string>
  titles: SafetyTitleRule[]
  hotkeys: SafetyHotkeyRule[]
  resources: DesktopSafetyDraft['sensitiveResources'] | null
  /** 内置名单无效时为 true：所有目标至少按高危区处理。 */
  failClosed: boolean
}

/** 合并内置名单与用户设置。draft 为 null 表示内置名单无效。 */
export function buildDesktopZoneIndex(
  draft: DesktopSafetyDraft | null,
  settings: DesktopSafetySettings,
  selfPrograms: string[] = [],
): DesktopZoneIndex {
  const names = (items: string[]) => items.map(normalizeProgramName)
  const forbidden = new Set([
    ...names(safetyEntries(draft?.programs.forbidden ?? {})),
    ...names(settings.forbidden),
    // infOS 自己的窗口（含审批弹窗）不能被桌面自动化操作。
    ...names(selfPrograms),
  ])
  const mustConfirm = new Set(
    [
      ...names(safetyEntries(draft?.programs.mustConfirm ?? {})),
      ...names(safetyEntries(draft?.backgroundComponents ?? {})),
      ...names(settings.mustConfirm),
    ].filter((name) => !forbidden.has(name)),
  )
  const index: DesktopZoneIndex = {
    forbidden,
    mustConfirm,
    trusted: new Set(),
    aliases: new Map(
      safetyEntries(draft?.launchAliases ?? {}).map((entry) => [
        normalizeProgramName(entry.name),
        normalizeProgramName(entry.program),
      ]),
    ),
    launchFiles: new Map(
      safetyEntries(draft?.launchFiles ?? {}).map((entry) => [
        entry.name.toLowerCase(),
        normalizeProgramName(entry.host),
      ]),
    ),
    fileExtensions: new Set(safetyEntries(draft?.fileLaunchRules ?? {})),
    extensionHosts: new Map(
      Object.values(draft?.fileLaunchRules ?? {}).flatMap((group) =>
        group.host
          ? group.entries.map(
              (extension) => [extension, normalizeProgramName(group.host!)] as const,
            )
          : [],
      ),
    ),
    titles: safetyEntries(draft?.windowTitles ?? {}),
    hotkeys: safetyEntries(draft?.hotkeys ?? {}),
    resources: draft?.sensitiveResources ?? null,
    failClosed: draft === null,
  }
  index.trusted = new Set(
    names(settings.trusted).filter(
      (program) => classifyDesktopTarget(index, { program }).zone === 'normal',
    ),
  )
  return index
}

/** 桌面动作的目标。 */
export interface DesktopTarget {
  /** 目标窗口所属进程（可带 .exe 与路径）；空表示识别不出。 */
  program: string
  title?: string
  /** 快捷键动作的按键组合。 */
  hotkey?: string
  /** 按路径启动程序（等同双击文件）。 */
  launchPath?: boolean
  /** 原始启动目标及快捷方式解析后的目标，不能由渲染进程替代解析。 */
  launchTarget?: string
  resolvedLaunchTarget?: string
  launchIdentities?: string[]
  windowId?: string
  pid?: number
  /** 有可靠目标信息时按位置收窄快捷键规则；未知时保守询问。 */
  location?: 'desktop' | 'system-folder' | 'ordinary'
  resource?: {
    kind: 'file' | 'registry' | 'certificateStore'
    target: string
    action: SafetyAction
    context: SafetyPathContext
  }
}

export type DesktopZoneReason =
  | 'program'
  | 'unknown'
  | 'title'
  | 'hotkey'
  | 'launch-path'
  | 'draft-invalid'
  | 'launch-file'
  | 'resource'

export interface DesktopZoneResult {
  zone: DesktopZone
  /** 判断依据（用于弹窗说明）。 */
  reason: DesktopZoneReason
  program: string
}

/** 判断目标所属区域。识别不出的目标、按路径启动、敏感标题与快捷键一律至少为高危区。 */
export function classifyDesktopTarget(
  index: DesktopZoneIndex,
  target: DesktopTarget,
): DesktopZoneResult {
  const original = normalizeProgramName(target.program)
  const name = (value: string) => value.trim().split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const resolveHost = (value: string) =>
    index.launchFiles.get(name(value)) ??
    index.extensionHosts.get(name(value).match(/\.[^.]+$/)?.[0] ?? '') ??
    index.aliases.get(normalizeProgramName(value)) ??
    normalizeProgramName(value)
  const program = resolveHost(target.resolvedLaunchTarget ?? target.launchTarget ?? target.program)
  const identities = [
    original,
    program,
    target.launchTarget,
    target.resolvedLaunchTarget,
    ...(target.launchIdentities ?? []),
  ].filter((value): value is string => !!value)
  if (
    identities.some(
      (entry) =>
        index.forbidden.has(normalizeProgramName(entry)) || index.forbidden.has(resolveHost(entry)),
    )
  )
    return { zone: 'forbidden', reason: 'program', program }
  const title = target.title?.trim().toLowerCase() ?? ''
  const matchingTitles = index.titles.filter(
    (rule) =>
      (!rule.programs || rule.programs.some((entry) => normalizeProgramName(entry) === program)) &&
      (rule.match === 'exact'
        ? title === rule.value.toLowerCase()
        : title.includes(rule.value.toLowerCase())),
  )
  if (matchingTitles.some((rule) => rule.zone === 'forbidden'))
    return { zone: 'forbidden', reason: 'title', program }
  // 资源上下文由宿主提供，不能依赖窗口标题推断。
  const resource =
    target.resource &&
    safetyResourceZone(
      target.resource.kind,
      target.resource.target,
      target.resource.action,
      target.resource.context,
      index.resources,
    )
  if (resource === 'forbidden') return { zone: 'forbidden', reason: 'resource', program }
  if (!program || !isProgramEntry(program))
    return { zone: 'mustConfirm', reason: 'unknown', program }
  if (resource === 'mustConfirm') return { zone: 'mustConfirm', reason: 'resource', program }
  if (index.mustConfirm.has(program)) return { zone: 'mustConfirm', reason: 'program', program }
  if (
    index.launchFiles.has(name(target.program)) ||
    [...index.fileExtensions].some(
      (extension) =>
        (target.launchTarget !== undefined || extension !== '.exe') &&
        name(target.launchTarget ?? target.program).endsWith(extension),
    )
  )
    return { zone: 'mustConfirm', reason: 'launch-file', program }
  if (target.launchPath) return { zone: 'mustConfirm', reason: 'launch-path', program }
  if (title && matchingTitles.length) return { zone: 'mustConfirm', reason: 'title', program }
  if (target.hotkey) {
    const key = normalizeHotkey(target.hotkey)
    if (
      index.hotkeys.some(
        (rule) =>
          (rule.program === '*' || normalizeProgramName(rule.program) === program) &&
          normalizeHotkey(rule.key) === key &&
          (rule.scope === 'any' || !target.location || target.location === rule.scope),
      )
    )
      return { zone: 'mustConfirm', reason: 'hotkey', program }
  }
  if (index.failClosed) return { zone: 'mustConfirm', reason: 'draft-invalid', program }
  return { zone: 'normal', reason: 'program', program }
}

/** 当前已有的批准（由 Electron 主进程按对话、任务维护）。 */
export interface DesktopGrants {
  /** 本次对话已允许的普通区程序。 */
  thread: ReadonlySet<string>
  /** 任务预批覆盖的普通区程序（未过期）。 */
  plan: ReadonlySet<string>
  /** 用户刚批准的“允许这一次”（未过期，未使用）。 */
  once: ReadonlySet<string>
}

export type DesktopDecision =
  | { verdict: 'allow'; via: 'trusted' | 'notify' | 'plan' | 'thread' | 'once' }
  | { verdict: 'deny' }
  /** every：只能“允许这一次”；once：可选本次对话都允许或信任。 */
  | { verdict: 'ask'; kind: 'every' | 'once' }

/**
 * 审批决定：
 * - 禁区：拒绝。
 * - 高危区：每次询问；只认“允许这一次”，信任名单、任务预批与对话授权都不能代替。
 * - 普通区：信任名单放行；“只提醒”放行；任务预批覆盖放行；
 *   “每个程序问一次”在本次对话允许过时放行；其余询问。
 */
export function decideDesktopAction(
  zone: DesktopZoneResult,
  mode: DesktopNormalMode,
  index: DesktopZoneIndex,
  grants: DesktopGrants,
): DesktopDecision {
  if (zone.zone === 'forbidden') return { verdict: 'deny' }
  if (zone.zone === 'mustConfirm')
    return grants.once.has(zone.program)
      ? { verdict: 'allow', via: 'once' }
      : { verdict: 'ask', kind: 'every' }
  if (index.trusted.has(zone.program)) return { verdict: 'allow', via: 'trusted' }
  if (mode === 'notify') return { verdict: 'allow', via: 'notify' }
  if (grants.plan.has(zone.program)) return { verdict: 'allow', via: 'plan' }
  if (grants.once.has(zone.program)) return { verdict: 'allow', via: 'once' }
  if (mode === 'once') {
    if (grants.thread.has(zone.program)) return { verdict: 'allow', via: 'thread' }
    return { verdict: 'ask', kind: 'once' }
  }
  return { verdict: 'ask', kind: 'every' }
}

// ─── 放宽与收紧 ─────────────────────────────────────

const modeRank = (mode: DesktopNormalMode) => DESKTOP_NORMAL_MODES.indexOf(mode)

function unique(names: string[]): string[] {
  const seen = new Map<string, string>()
  for (const name of names) {
    const key = normalizeProgramName(name)
    if (key && !seen.has(key)) seen.set(key, name.trim())
  }
  return [...seen.values()]
}

/** 两份设置中更严格的组合：模式取更严的一档，禁区与高危区取并集，信任名单取交集。 */
export function stricterDesktopSafety(
  left: DesktopSafetySettings,
  right: DesktopSafetySettings,
): DesktopSafetySettings {
  const forbidden = unique([...left.forbidden, ...right.forbidden])
  const forbiddenKeys = new Set(forbidden.map(normalizeProgramName))
  const mustConfirm = unique([...left.mustConfirm, ...right.mustConfirm]).filter(
    (name) => !forbiddenKeys.has(normalizeProgramName(name)),
  )
  const strictKeys = new Set([...forbiddenKeys, ...mustConfirm.map(normalizeProgramName)])
  const rightTrusted = new Set(right.trusted.map(normalizeProgramName))
  return {
    version: 1,
    normalMode:
      modeRank(left.normalMode) >= modeRank(right.normalMode) ? left.normalMode : right.normalMode,
    forbidden,
    mustConfirm,
    trusted: unique(left.trusted).filter((name) => {
      const key = normalizeProgramName(name)
      return rightTrusted.has(key) && !strictKeys.has(key)
    }),
  }
}

export type DesktopSafetyLoosening =
  | { kind: 'normal-mode'; from: DesktopNormalMode; to: DesktopNormalMode }
  | { kind: 'trust'; program: string }
  | { kind: 'unforbid'; program: string }
  | { kind: 'unconfirm'; program: string }

/** 从 current 改成 next 时，往宽松方向的改动；为空表示只收紧或不变，可以立即生效。 */
export function desktopSafetyLoosenings(
  current: DesktopSafetySettings,
  next: DesktopSafetySettings,
): DesktopSafetyLoosening[] {
  const result: DesktopSafetyLoosening[] = []
  if (modeRank(next.normalMode) < modeRank(current.normalMode))
    result.push({ kind: 'normal-mode', from: current.normalMode, to: next.normalMode })
  const keys = (items: string[]) => new Set(items.map(normalizeProgramName))
  const trusted = keys(current.trusted)
  for (const program of unique(next.trusted))
    if (!trusted.has(normalizeProgramName(program))) result.push({ kind: 'trust', program })
  const nextForbidden = keys(next.forbidden)
  const nextConfirm = keys(next.mustConfirm)
  for (const program of unique(current.forbidden))
    if (!nextForbidden.has(normalizeProgramName(program)))
      result.push({ kind: 'unforbid', program })
  for (const program of unique(current.mustConfirm)) {
    const key = normalizeProgramName(program)
    if (!nextConfirm.has(key) && !nextForbidden.has(key))
      result.push({ kind: 'unconfirm', program })
  }
  return result
}

/** 角色或设置页提出的修改。 */
export interface DesktopSafetyChange {
  normalMode?: DesktopNormalMode
  trust?: string[]
  untrust?: string[]
  forbid?: string[]
  unforbid?: string[]
  confirm?: string[]
  unconfirm?: string[]
}

/** 把修改应用到设置上（不判断宽严）；名单项先去重。 */
export function applyDesktopSafetyChange(
  settings: DesktopSafetySettings,
  change: DesktopSafetyChange,
): DesktopSafetySettings {
  const without = (items: string[], removed: string[] = []) => {
    const keys = new Set(removed.map(normalizeProgramName))
    return items.filter((item) => !keys.has(normalizeProgramName(item)))
  }
  const forbidden = unique([
    ...without(settings.forbidden, change.unforbid),
    ...(change.forbid ?? []),
  ])
  const mustConfirm = unique([
    ...without(settings.mustConfirm, change.unconfirm),
    ...(change.confirm ?? []),
  ])
  const strict = new Set([...forbidden, ...mustConfirm].map(normalizeProgramName))
  return {
    version: 1,
    normalMode: change.normalMode ?? settings.normalMode,
    forbidden,
    mustConfirm,
    trusted: unique([...without(settings.trusted, change.untrust), ...(change.trust ?? [])]).filter(
      (item) => !strict.has(normalizeProgramName(item)),
    ),
  }
}

/** 角色修改的参数校验：名单项必须是合法程序名，模式必须在枚举内。 */
export function normalizeDesktopSafetyChange(value: unknown): DesktopSafetyChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const change: DesktopSafetyChange = {}
  if (item.normalMode !== undefined) {
    if (!(DESKTOP_NORMAL_MODES as readonly unknown[]).includes(item.normalMode)) return null
    change.normalMode = item.normalMode as DesktopNormalMode
  }
  for (const key of ['trust', 'untrust', 'forbid', 'unforbid', 'confirm', 'unconfirm'] as const) {
    const list = item[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.length > DESKTOP_SAFETY_LIMITS.planPrograms) return null
    if (!list.every(isProgramEntry)) return null
    change[key] = list.map((entry) => entry.trim())
  }
  return change
}

// ─── 总开关的范围 ───────────────────────────────────

/**
 * 「桌面操作」总开关关闭时仍可使用的 desktop.environment 操作：只读诊断、状态卡与控制
 * （控制只能查询状态、关闭总开关、继续已暂停的操作，不能打开总开关）。
 * desktop.shell（外壳、主题、卡片）是另一类能力，不受总开关约束。
 */
export const DESKTOP_SWITCH_EXEMPT_OPERATIONS = [
  'runtimeDiagnostics',
  'statusCard',
  'control',
  'mousePosition',
  // 她删除用户文件放进系统回收站：文件操作，由家的确认把关，不属于操作电脑。
  'homeRecycle',
] as const

export function desktopOperationNeedsSwitch(capability: string, operation: string): boolean {
  if (capability !== 'desktop.environment') return false
  return !(DESKTOP_SWITCH_EXEMPT_OPERATIONS as readonly string[]).includes(operation)
}

/** 不改变任何东西的动作不审批（等待、移动鼠标、切换窗口）。 */
export const DESKTOP_UNGUARDED_ACTIONS = ['wait', 'move'] as const
