/** 工具执行的高危操作判断（与桌面护栏共用内置名单）。 */

import {
  type DesktopSafetyDraft,
  SAFETY_LISTS,
  type SafetyAction,
  safetyEntries,
} from './desktopSafetyModel'
import { canonicalPath } from './desktopSafetyNormalize'
import { validateDesktopSafetyDraft } from './desktopSafetyValidation'

// ─── 工具执行的高危操作（与桌面护栏共用名单） ─────────────

/** 校验后的内置名单；无效时为 null（调用方按最严格处理）。 */
let builtinDraft: DesktopSafetyDraft | null | undefined

export function builtinSafetyDraft(): DesktopSafetyDraft | null {
  if (builtinDraft === undefined) {
    const result = validateDesktopSafetyDraft(SAFETY_LISTS)
    builtinDraft = result.ok ? result.value : null
  }
  return builtinDraft
}

export interface SafetyPathContext {
  platform: string
  env: Record<string, string | undefined>
  home: string
  /** 宿主已知文件夹；缺失时保留传统目录兜底。 */
  documents?: string
}

/** 环境变量缺失时的默认值（Windows）。 */
const WINDOWS_DEFAULTS: Record<string, string> = {
  systemroot: 'C:\\Windows',
  programfiles: 'C:\\Program Files',
  'programfiles(x86)': 'C:\\Program Files (x86)',
  programdata: 'C:\\ProgramData',
}

/** 展开名单中的 `%变量%` 与 `~`；变量缺失且没有默认值时返回 null（该条忽略）。 */
export function expandSafetyPath(pattern: string, context: SafetyPathContext): string | null {
  const windows = context.platform === 'win32'
  let missing = false
  let result = pattern.replace(/%([^%]+)%/g, (_match, name: string) => {
    const key = Object.keys(context.env).find((item) => item.toLowerCase() === name.toLowerCase())
    const lower = name.toLowerCase()
    const derived =
      lower === 'userprofile'
        ? context.home
        : lower === 'documents'
          ? (context.documents ?? `${context.home}/Documents`)
          : lower === 'localappdata'
            ? `${context.home}/AppData/Local`
            : lower === 'appdata'
              ? `${context.home}/AppData/Roaming`
              : WINDOWS_DEFAULTS[lower]
    const value = (key ? context.env[key] : undefined) ?? derived
    if (!value) missing = true
    return value ?? ''
  })
  if (missing) return null
  if (result === '~' || result.startsWith('~/')) result = context.home + result.slice(1)
  return canonicalPath(result, windows)
}

/** 目标路径是否位于名单中的敏感系统位置；返回命中的类别，未命中为 null。 */
export function sensitivePathCategory(
  target: string,
  context: SafetyPathContext,
  draft: DesktopSafetyDraft | null = builtinSafetyDraft(),
): string | null {
  const windows = context.platform === 'win32'
  const resolved = canonicalPath(target, windows)
  for (const [group, entry] of Object.entries(draft?.sensitiveResources.files ?? {})) {
    for (const pattern of entry.entries.filter((entry) => entry.platform === context.platform)) {
      const root = expandSafetyPath(pattern.path, context)
      if (
        root &&
        (resolved === root || resolved.startsWith(root.endsWith('/') ? root : `${root}/`))
      )
        return group
    }
  }
  return null
}

/** 资源规则按动作生效；命中多个类别时取更严格的分区，读取系统目录不升级。 */
export function safetyResourceZone(
  kind: 'file' | 'registry' | 'certificateStore',
  target: string,
  action: SafetyAction,
  context: SafetyPathContext,
  resources: DesktopSafetyDraft['sensitiveResources'] | null = builtinSafetyDraft()
    ?.sensitiveResources ?? null,
): 'forbidden' | 'mustConfirm' | null {
  if (!resources) return action === 'read' ? null : 'mustConfirm'
  const registry = (value: string) =>
    value
      .replace(/\\/g, '/')
      .replace(/^Registry::/i, '')
      .replace(/:\//g, '/')
      .replace(/\/$/, '')
      .replace(/^HKEY_CURRENT_USER/i, 'HKCU')
      .replace(/^HKEY_LOCAL_MACHINE/i, 'HKLM')
      .replace(/^HKEY_CLASSES_ROOT/i, 'HKCR')
      .replace(/^HKEY_USERS/i, 'HKU')
      .replace(/^HKEY_CURRENT_CONFIG/i, 'HKCC')
      .toLowerCase()
  const resolved = kind === 'file' ? expandSafetyPath(target, context) : registry(target)
  if (!resolved) return action === 'read' ? null : 'mustConfirm'
  const within = (value: string, root: string) =>
    value === root ||
    value.startsWith(root.endsWith('/') ? root : `${root}/`) ||
    (kind === 'file' && context.platform === 'win32' && value.startsWith(`${root}:`))
  let result: 'forbidden' | 'mustConfirm' | null = null
  const groups =
    kind === 'file'
      ? resources.files
      : kind === 'registry'
        ? resources.registry
        : resources.certificateStores
  for (const group of Object.values(groups)) {
    if (!group.actions.includes(action)) continue
    const matched = group.entries.some((entry: string | { platform: string; path: string }) => {
      if (typeof entry === 'string') return within(resolved, registry(entry))
      const root =
        entry.platform === context.platform ? expandSafetyPath(entry.path, context) : null
      return root !== null && within(resolved, root)
    })
    if (matched && group.zone === 'forbidden') return 'forbidden'
    if (matched) result = 'mustConfirm'
  }
  return result ?? (kind !== 'file' && action !== 'read' ? 'mustConfirm' : null)
}

export interface HighRiskToolCall {
  toolName: string
  args: Record<string, unknown>
  /** 确定性只读终端查询（宿主读取，不启动 Shell），不算高危。 */
  readOnlyTerminal: boolean
  /** 运行时临时注册的工具（行为未知，按终端级处理）。 */
  runtimeScoped: boolean
  /** 删除目标越出工作区。 */
  deleteOutsideWorkspace: boolean
  /** 写入、修改、删除类工具的目标绝对路径。 */
  fileTarget?: string
  /** 同时检查用户路径与最近存在父目录解析后的路径。 */
  fileTargets?: string[]
  fileAction?: SafetyAction
  pathUnresolved?: boolean
  resource?: { kind: 'registry' | 'certificateStore'; target: string; action: SafetyAction }
}

export type HighRiskReason =
  | 'terminal'
  | 'script'
  | 'delete-outside-workspace'
  | 'sensitive-path'
  | 'path-unresolved'
  | 'draft-invalid'

const toolFileAction = (call: HighRiskToolCall): SafetyAction =>
  call.fileAction ??
  (call.toolName === 'delete_file'
    ? 'delete'
    : ['write_file', 'edit_file'].includes(call.toolName)
      ? 'write'
      : 'read')

/** 凭据库读写拒绝；此检查必须先于高危审批和执行模式放宽。 */
export function isForbiddenToolCall(
  call: HighRiskToolCall,
  context: SafetyPathContext,
  draft: DesktopSafetyDraft | null = builtinSafetyDraft(),
): boolean {
  return (
    [call.fileTarget, ...(call.fileTargets ?? [])].some(
      (target) =>
        target &&
        safetyResourceZone(
          'file',
          target,
          toolFileAction(call),
          context,
          draft?.sensitiveResources ?? null,
        ) === 'forbidden',
    ) ||
    !!(
      call.resource &&
      safetyResourceZone(
        call.resource.kind,
        call.resource.target,
        call.resource.action,
        context,
        draft?.sensitiveResources ?? null,
      ) === 'forbidden'
    )
  )
}

/**
 * 工具调用是否为高危操作；是时返回原因。规则与桌面护栏同源（`safety-lists.draft.json`）：
 * - 终端与脚本执行：`highRiskTools` 中的工具（包括宿主代执行的只读查询）、带代码的 `runtime_debug`、运行时临时工具；
 * - 工作区外删除；
 * - 按资源类型与动作保护 `sensitiveResources` 中的敏感位置。
 * `run_script` 编排本身也逐次审批，内部工具调用继续经过同一审批链。
 * 内置名单无效时本地与远程终端仍要求审批，其余调用也保守确认；不以只读标记跳过用户确认。
 */
export function isHighRiskToolCall(
  call: HighRiskToolCall,
  context: SafetyPathContext,
  draft: DesktopSafetyDraft | null = builtinSafetyDraft(),
): HighRiskReason | null {
  if (call.toolName === 'run_script') return 'script'
  const requiredTerminals = new Set([
    'terminal_execute',
    'terminal_create',
    'terminal_write',
    'remote_terminal_create',
    'remote_terminal_write',
  ])
  if (requiredTerminals.has(call.toolName)) return 'terminal'
  const tools = new Set(draft ? safetyEntries(draft.highRiskTools) : [])
  if (tools.has(call.toolName)) return 'script'
  if (
    call.toolName === 'runtime_debug' &&
    typeof call.args.code === 'string' &&
    call.args.code.trim()
  )
    return 'script'
  if (call.runtimeScoped) return 'script'
  if (call.toolName === 'delete_file' && call.deleteOutsideWorkspace)
    return 'delete-outside-workspace'
  if (call.pathUnresolved) return 'path-unresolved'
  if (
    [call.fileTarget, ...(call.fileTargets ?? [])].some(
      (target) =>
        target &&
        safetyResourceZone(
          'file',
          target,
          toolFileAction(call),
          context,
          draft?.sensitiveResources ?? null,
        ),
    )
  )
    return 'sensitive-path'
  if (
    call.resource &&
    safetyResourceZone(
      call.resource.kind,
      call.resource.target,
      call.resource.action,
      context,
      draft?.sensitiveResources ?? null,
    )
  )
    return 'sensitive-path'
  if (!draft) return 'draft-invalid'
  return null
}
