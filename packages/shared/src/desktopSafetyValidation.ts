/** 桌面操作护栏的名单校验：内置名单与用户设置。 */

import {
  DESKTOP_NORMAL_MODES,
  DESKTOP_SAFETY_LIMITS,
  type DesktopNormalMode,
  type DesktopSafetyDraft,
  type DesktopSafetyIssue,
  type DesktopSafetySettings,
  type DesktopSafetyValidation,
  safetyEntries,
} from './desktopSafetyModel'
import {
  canonicalPath,
  isProgramEntry,
  normalizeHotkey,
  normalizeProgramName,
} from './desktopSafetyNormalize'

function textList(
  value: unknown,
  field: string,
  issues: DesktopSafetyIssue[],
  entry: (item: unknown) => boolean,
): string[] {
  if (!Array.isArray(value)) {
    issues.push({ code: 'INVALID_LIST', field })
    return []
  }
  if (value.length > DESKTOP_SAFETY_LIMITS.entries)
    issues.push({ code: 'TOO_MANY_ENTRIES', field, value: String(value.length) })
  const result: string[] = []
  for (const item of value) {
    if (!entry(item)) issues.push({ code: 'INVALID_ENTRY', field, value: safetyIssueValue(item) })
    else result.push(item.trim())
  }
  return result
}

const isToolEntry = (item: unknown): item is string =>
  typeof item === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(item)

const isTextEntry = (item: unknown): item is string =>
  typeof item === 'string' && item.trim().length > 0 && item.length <= DESKTOP_SAFETY_LIMITS.text

/** 无效 JSON 值也只能产生校验问题，不能借自定义 toString 使校验器抛错。 */
function safetyIssueValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return typeof value
  }
}

function rejectUnknown(
  item: Record<string, unknown>,
  allowed: string[],
  issues: DesktopSafetyIssue[],
): void {
  for (const key of Object.keys(item))
    if (!allowed.includes(key)) issues.push({ code: 'UNKNOWN_FIELD', field: key })
}

/** 校验内置名单文件。任何错误都使整个名单无效（由调用方按“全部高危”兜底）。 */
export function validateDesktopSafetyDraft(
  value: unknown,
): DesktopSafetyValidation<DesktopSafetyDraft> {
  const issues: DesktopSafetyIssue[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, issues: [{ code: 'NOT_OBJECT', field: '' }] }
  const item = value as Record<string, unknown>
  // 旧格式不做隐式迁移，防止部分加载导致规则被丢弃。
  if (item.schemaVersion !== 2)
    return {
      ok: false,
      issues: [
        {
          code: 'UNSUPPORTED_DRAFT_VERSION',
          field: 'schemaVersion',
          value: safetyIssueValue(item.schemaVersion ?? 'missing'),
        },
      ],
    }
  rejectUnknown(
    item,
    [
      'schemaVersion',
      'status',
      'note',
      'programs',
      'launchAliases',
      'launchFiles',
      'backgroundComponents',
      'fileLaunchRules',
      'windowTitles',
      'hotkeys',
      'highRiskTools',
      'sensitiveResources',
    ],
    issues,
  )
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  const invalid = (field: string, value?: unknown) =>
    issues.push({ code: 'INVALID_ENTRY', field, value: safetyIssueValue(value ?? '') })
  const fields = (value: Record<string, unknown>, allowed: string[], field: string) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) issues.push({ code: 'UNKNOWN_FIELD', field: `${field}.${key}` })
  }
  const exe = (value: unknown): value is string => isProgramEntry(value) && /\.exe$/i.test(value)
  const named = (value: unknown, target: 'host' | 'program') =>
    object(value) &&
    Object.keys(value).every((key) => ['name', target].includes(key)) &&
    isTextEntry(value.name) &&
    !/[\\/]/.test(value.name) &&
    exe(value[target])
  const checkGroups = (
    value: unknown,
    field: string,
    check: (entry: unknown) => boolean,
    key: (entry: any) => string,
    extra: string[] = [],
  ) => {
    if (!object(value)) {
      issues.push({ code: 'INVALID_LIST', field })
      return
    }
    const seen = new Set<string>()
    for (const [name, group] of Object.entries(value)) {
      const location = `${field}.${name}`
      if (!object(group)) {
        invalid(location)
        continue
      }
      fields(group, ['purpose', 'risk', 'entries', 'appliesTo', 'sources', ...extra], location)
      for (const text of ['purpose', 'risk'])
        if (typeof group[text] !== 'string' || !group[text].trim()) invalid(`${location}.${text}`)
      for (const optional of ['appliesTo', 'sources'])
        if (
          group[optional] !== undefined &&
          (!Array.isArray(group[optional]) ||
            !(group[optional] as unknown[]).every(
              (entry) => typeof entry === 'string' && entry.trim(),
            ))
        )
          invalid(`${location}.${optional}`)
      if (!Array.isArray(group.entries)) {
        issues.push({ code: 'INVALID_LIST', field: `${location}.entries` })
        continue
      }
      if (group.entries.length > DESKTOP_SAFETY_LIMITS.entries)
        issues.push({ code: 'TOO_MANY_ENTRIES', field: location })
      for (const entry of group.entries) {
        if (!check(entry)) {
          invalid(`${location}.entries`, JSON.stringify(entry))
          continue
        }
        const normalized = key(entry)
        if (seen.has(normalized))
          issues.push({ code: 'DUPLICATE_ENTRY', field: location, value: normalized })
        seen.add(normalized)
      }
    }
  }
  if (item.status !== 'DRAFT' && item.status !== 'FINAL') invalid('status', item.status)
  if (item.note !== undefined && typeof item.note !== 'string') invalid('note')
  const programs = object(item.programs) ? item.programs : {}
  fields(programs, ['forbidden', 'mustConfirm'], 'programs')
  checkGroups(programs.forbidden, 'programs.forbidden', exe, normalizeProgramName)
  checkGroups(programs.mustConfirm, 'programs.mustConfirm', exe, normalizeProgramName)
  checkGroups(item.backgroundComponents, 'backgroundComponents', exe, normalizeProgramName)
  checkGroups(
    item.launchAliases,
    'launchAliases',
    (entry) => named(entry, 'program'),
    (entry) => normalizeProgramName(entry.name),
  )
  checkGroups(
    item.launchFiles,
    'launchFiles',
    (entry) =>
      named(entry, 'host') &&
      /\.(msc|vbs|vbe|js|jse|wsf|wsh|ps1)$/i.test(String((entry as { name: string }).name)),
    (entry) => entry.name.toLowerCase(),
  )
  checkGroups(
    item.fileLaunchRules,
    'fileLaunchRules',
    (entry) => typeof entry === 'string' && /^\.[a-z0-9]+$/.test(entry),
    (entry) => entry,
    ['host'],
  )
  checkGroups(item.highRiskTools, 'highRiskTools', isToolEntry, (entry) => entry)
  checkGroups(
    item.windowTitles,
    'windowTitles',
    (entry) => {
      if (!object(entry)) return false
      return (
        Object.keys(entry).every((key) => ['match', 'value', 'zone', 'programs'].includes(key)) &&
        (entry.match === 'exact' || entry.match === 'contains') &&
        isTextEntry(entry.value) &&
        (entry.zone === 'forbidden' || entry.zone === 'mustConfirm') &&
        (entry.programs === undefined ||
          (Array.isArray(entry.programs) && entry.programs.length > 0 && entry.programs.every(exe)))
      )
    },
    (entry) =>
      `${entry.match}:${entry.value.toLowerCase()}:${(entry.programs ?? []).map(normalizeProgramName).sort().join(',')}`,
  )
  checkGroups(
    item.hotkeys,
    'hotkeys',
    (entry) =>
      object(entry) &&
      Object.keys(entry).every((key) => ['program', 'key', 'scope'].includes(key)) &&
      (entry.program === '*' || exe(entry.program)) &&
      isTextEntry(entry.key) &&
      (entry.scope === 'any' || entry.scope === 'desktop' || entry.scope === 'system-folder'),
    (entry) => `${normalizeProgramName(entry.program)}:${normalizeHotkey(entry.key)}`,
  )
  const resources = object(item.sensitiveResources) ? item.sensitiveResources : {}
  fields(resources, ['files', 'registry', 'certificateStores'], 'sensitiveResources')
  for (const type of ['files', 'registry', 'certificateStores'] as const) {
    checkGroups(
      resources[type],
      `sensitiveResources.${type}`,
      (entry) =>
        type === 'files'
          ? object(entry) &&
            Object.keys(entry).every((key) => ['platform', 'path'].includes(key)) &&
            (entry.platform === 'win32' ||
              entry.platform === 'linux' ||
              entry.platform === 'darwin') &&
            typeof entry.path === 'string' &&
            !!entry.path.trim() &&
            entry.path.length <= 2048
          : typeof entry === 'string' && !!entry.trim() && entry.length <= 2048,
      (entry) =>
        type === 'files'
          ? `${entry.platform}:${canonicalPath(entry.path, entry.platform === 'win32')}`
          : entry.toLowerCase().replace(/\\/g, '/'),
      ['zone', 'actions'],
    )
    if (object(resources[type]))
      for (const [name, group] of Object.entries(resources[type])) {
        if (!object(group)) continue
        if (group.zone !== 'forbidden' && group.zone !== 'mustConfirm')
          invalid(`sensitiveResources.${type}.${name}.zone`)
        if (
          !Array.isArray(group.actions) ||
          !group.actions.length ||
          !group.actions.every(
            (action) =>
              typeof action === 'string' &&
              ['read', 'write', 'delete', 'configure'].includes(action),
          ) ||
          new Set(group.actions).size !== group.actions.length
        )
          invalid(`sensitiveResources.${type}.${name}.actions`)
      }
  }
  if (issues.length) return { ok: false, issues }
  const draft = item as unknown as DesktopSafetyDraft
  const forbidden = new Set(safetyEntries(draft.programs.forbidden).map(normalizeProgramName))
  const highRisk = new Set(safetyEntries(draft.programs.mustConfirm).map(normalizeProgramName))
  for (const name of highRisk)
    if (forbidden.has(name))
      issues.push({ code: 'CONFLICTING_ENTRY', field: 'programs', value: name })
  const known = new Set([...forbidden, ...highRisk])
  for (const [name, group] of Object.entries(draft.fileLaunchRules))
    if (
      group.host !== undefined &&
      (!exe(group.host) || !known.has(normalizeProgramName(group.host)))
    )
      invalid(`fileLaunchRules.${name}.host`, group.host)
  for (const entry of safetyEntries(draft.launchAliases)) {
    if (
      !known.has(normalizeProgramName(entry.program)) ||
      known.has(normalizeProgramName(entry.name)) ||
      safetyEntries(draft.launchFiles).some(
        (file) => file.name.toLowerCase() === entry.name.toLowerCase(),
      ) ||
      safetyEntries(draft.backgroundComponents).some(
        (name) => normalizeProgramName(name) === normalizeProgramName(entry.name),
      )
    )
      issues.push({ code: 'CONFLICTING_ENTRY', field: 'launchAliases', value: entry.name })
  }
  for (const entry of safetyEntries(draft.launchFiles))
    if (!known.has(normalizeProgramName(entry.host))) invalid('launchFiles.host', entry.host)
  for (const name of safetyEntries(draft.backgroundComponents))
    if (known.has(normalizeProgramName(name)))
      issues.push({ code: 'CONFLICTING_ENTRY', field: 'backgroundComponents', value: name })
  return issues.length ? { ok: false, issues } : { ok: true, value: draft, issues: [] }
}

/**
 * 校验用户设置文件。任何错误都使整个文件无效，不部分生效；
 * 信任名单不能包含内置或追加的禁区、高危区程序。
 */
export function validateDesktopSafetySettings(
  value: unknown,
  draft?: DesktopSafetyDraft,
): DesktopSafetyValidation<DesktopSafetySettings> {
  const issues: DesktopSafetyIssue[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, issues: [{ code: 'NOT_OBJECT', field: '' }] }
  const item = value as Record<string, unknown>
  rejectUnknown(
    item,
    [
      'version',
      'note',
      'normalMode',
      'forbidden',
      'mustConfirm',
      'trusted',
      'signature',
      'revision',
    ],
    issues,
  )
  if (item.version !== 1)
    issues.push({
      code: 'UNSUPPORTED_VERSION',
      field: 'version',
      value: safetyIssueValue(item.version),
    })
  const mode = item.normalMode ?? 'once'
  if (!(DESKTOP_NORMAL_MODES as readonly unknown[]).includes(mode))
    issues.push({ code: 'INVALID_MODE', field: 'normalMode', value: safetyIssueValue(mode) })
  const settings: DesktopSafetySettings = {
    version: 1,
    normalMode: mode as DesktopNormalMode,
    forbidden: textList(item.forbidden ?? [], 'forbidden', issues, isProgramEntry),
    mustConfirm: textList(item.mustConfirm ?? [], 'mustConfirm', issues, isProgramEntry),
    trusted: textList(item.trusted ?? [], 'trusted', issues, isProgramEntry),
  }
  const strict = new Set(
    [
      ...settings.forbidden,
      ...settings.mustConfirm,
      ...safetyEntries(draft?.programs.forbidden ?? {}),
      ...safetyEntries(draft?.programs.mustConfirm ?? {}),
      ...safetyEntries(draft?.backgroundComponents ?? {}),
      ...safetyEntries(draft?.launchAliases ?? {}).map((entry) => entry.name),
      ...safetyEntries(draft?.launchFiles ?? {}).map((entry) => entry.name),
    ].map(normalizeProgramName),
  )
  for (const program of settings.trusted)
    if (
      strict.has(normalizeProgramName(program)) ||
      safetyEntries(draft?.fileLaunchRules ?? {}).some(
        (extension) => extension !== '.exe' && program.toLowerCase().endsWith(extension),
      )
    )
      issues.push({ code: 'TRUST_NOT_ALLOWED', field: 'trusted', value: program })
  return issues.length ? { ok: false, issues } : { ok: true, value: settings, issues: [] }
}
