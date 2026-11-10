import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { shell } from 'electron'
import { activateWindow, listWindows } from './desktopAutomation'

export interface InstalledApplication {
  name: string
  appId: string
}

export interface ApplicationLaunchResult {
  success: true
  application: string
  mode: 'activated' | 'launched'
  targetType: 'window' | 'path' | 'aumid'
}

export interface ApplicationLauncherDeps {
  platform: NodeJS.Platform
  discoverApplications(): Promise<InstalledApplication[]>
  listWindows(): Promise<
    Array<{ processName: string; title: string; windowId?: string; pid?: number }>
  >
  activateWindow(target: string, signal?: AbortSignal): Promise<string>
  openPath(target: string): Promise<string>
  launchAumid(appId: string): Promise<void>
  readShortcut?(file: string): { target: string; args?: string }
}

function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s._-]+/g, '')
}

export function rankApplications(
  query: string,
  applications: InstalledApplication[],
): InstalledApplication[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return []
  return applications
    .map((application) => {
      const name = normalize(application.name)
      const appId = normalize(application.appId)
      const score =
        name === normalizedQuery
          ? 100
          : appId === normalizedQuery
            ? 95
            : name.startsWith(normalizedQuery)
              ? 80
              : name.includes(normalizedQuery)
                ? 60
                : appId.includes(normalizedQuery)
                  ? 40
                  : 0
      return { application, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.application.name.localeCompare(b.application.name))
    .map((item) => item.application)
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
}

const APPLICATION_CACHE_TTL_MS = 5 * 60_000
let windowsApplicationCache: { expiresAt: number; applications: InstalledApplication[] } | undefined

export async function discoverWindowsApplications(): Promise<InstalledApplication[]> {
  if (windowsApplicationCache && windowsApplicationCache.expiresAt > Date.now()) {
    return windowsApplicationCache.applications
  }
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
    'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress',
  ].join('; ')
  const output = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  const parsed = JSON.parse(output || '[]') as
    | { Name?: unknown; AppID?: unknown }
    | Array<{ Name?: unknown; AppID?: unknown }>
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const applications = entries
    .filter(
      (entry): entry is { Name: string; AppID: string } =>
        typeof entry.Name === 'string' && typeof entry.AppID === 'string',
    )
    .map((entry) => ({ name: entry.Name.trim(), appId: entry.AppID.trim() }))
    .filter((entry) => entry.name && entry.appId)
  windowsApplicationCache = {
    expiresAt: Date.now() + APPLICATION_CACHE_TTL_MS,
    applications,
  }
  return applications
}

const defaultDeps: ApplicationLauncherDeps = {
  platform: process.platform,
  discoverApplications: () =>
    process.platform === 'win32' ? discoverWindowsApplications() : Promise.resolve([]),
  listWindows,
  activateWindow,
  openPath: (target) => shell.openPath(target),
  launchAumid: async (appId) => {
    const explorer = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')
    await execFileAsync(explorer, [`shell:AppsFolder\\${appId}`])
  },
}

function isExplicitPath(value: string, platform: NodeJS.Platform): boolean {
  return path.isAbsolute(value) || (platform === 'win32' && /^[a-z]:[\\/]/i.test(value))
}

export interface ApplicationLaunchPlan {
  targetType: 'window' | 'path' | 'aumid'
  target: string
  title?: string
  program?: string
  windowId?: string
  pid?: number
  identities?: string[]
}

/** 先解析唯一目标，再审批同一计划；执行阶段不重新搜索。 */
export async function resolveApplicationLaunch(
  appName: string,
  deps: ApplicationLauncherDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<ApplicationLaunchPlan> {
  signal?.throwIfAborted()
  const query = appName.trim()
  if (!query) throw new Error('APPLICATION_NAME_REQUIRED: 请提供应用名称')
  if (isExplicitPath(query, deps.platform)) {
    if (!fs.existsSync(query)) throw new Error(`APPLICATION_PATH_NOT_FOUND: ${query}`)
    const identities = [query]
    let target = fs.realpathSync.native(query)
    for (let depth = 0; /\.lnk$/i.test(target); depth++) {
      if (depth >= 8 || (identities.includes(target) && depth > 0))
        throw new Error('APPLICATION_SHORTCUT_UNRESOLVED')
      identities.push(target)
      const shortcut = (deps.readShortcut ?? ((file) => shell.readShortcutLink(file)))(target)
      // openPath 不能忠实执行带额外参数的计划；无法绑定参数时拒绝启动。
      if (!shortcut.target || shortcut.args?.trim())
        throw new Error('APPLICATION_SHORTCUT_UNRESOLVED')
      target = fs.realpathSync.native(path.resolve(path.dirname(target), shortcut.target))
    }
    identities.push(target)
    return { targetType: 'path', target, identities: [...new Set(identities)] }
  }
  const windows = await deps.listWindows().catch(() => [])
  const matching = windows.filter(
    (window) =>
      normalize(window.title).includes(normalize(query)) ||
      normalize(window.processName).includes(normalize(query)),
  )
  if (matching.length > 1) throw new Error('APPLICATION_AMBIGUOUS: WINDOW_AMBIGUOUS')
  const existing = matching[0]
  if (existing)
    return {
      targetType: 'window',
      target: existing.windowId ?? existing.title,
      program: existing.processName,
      title: existing.title,
      windowId: existing.windowId,
      pid: existing.pid,
    }
  if (deps.platform !== 'win32')
    throw new Error('APPLICATION_DISCOVERY_UNSUPPORTED: 当前平台暂不支持按名称发现应用')
  const matches = rankApplications(query, await deps.discoverApplications())
  const first = matches[0]
  if (!first) throw new Error(`APPLICATION_NOT_FOUND: ${query}`)
  const exact =
    normalize(first.name) === normalize(query) || normalize(first.appId) === normalize(query)
  if (!exact && matches[1])
    throw new Error(
      `APPLICATION_AMBIGUOUS: ${matches
        .slice(0, 5)
        .map((item) => item.name)
        .join('、')}`,
    )
  return { targetType: 'aumid', target: first.appId, title: first.name }
}

export async function executeApplicationLaunch(
  plan: ApplicationLaunchPlan,
  deps: ApplicationLauncherDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<ApplicationLaunchResult> {
  signal?.throwIfAborted()
  if (plan.targetType === 'window') {
    // 审批后重新核对窗口身份，禁止按旧标题匹配到替换窗口。
    const windows = await deps.listWindows()
    const current = windows.filter((window) =>
      plan.windowId ? window.windowId === plan.windowId : window.title === plan.target,
    )
    if (
      current.length !== 1 ||
      current[0]!.pid !== plan.pid ||
      current[0]!.processName !== plan.program
    )
      throw new Error('DESKTOP_OBSERVATION_STALE')
    const title = signal
      ? await deps.activateWindow(plan.target, signal)
      : await deps.activateWindow(plan.target)
    return { success: true, application: title, mode: 'activated', targetType: 'window' }
  }
  if (plan.targetType === 'path') {
    if (fs.realpathSync.native(plan.target) !== plan.target)
      throw new Error('APPLICATION_TARGET_CHANGED')
    const error = await deps.openPath(plan.target)
    if (error) throw new Error(`APPLICATION_LAUNCH_FAILED: ${error}`)
  } else await deps.launchAumid(plan.target)
  return {
    success: true,
    application: plan.title ?? plan.target,
    mode: 'launched',
    targetType: plan.targetType,
  }
}

export async function launchApplication(
  appName: string,
  deps: ApplicationLauncherDeps = defaultDeps,
  signal?: AbortSignal,
  approve?: (plan: ApplicationLaunchPlan) => Promise<void>,
): Promise<ApplicationLaunchResult> {
  const plan = await resolveApplicationLaunch(appName, deps, signal)
  await approve?.(Object.freeze(plan))
  return executeApplicationLaunch(plan, deps, signal)
}
