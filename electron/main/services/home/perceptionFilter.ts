import type { DesktopWindowInfo, PerceptionSettings } from '@infos/shared'

/** 所有采集共用同一组规则；不要把未过滤值保存在事件或错误里。 */
const secrets = [
  /\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /((?:password|passwd|pwd|secret|token|api[_ -]?key|密码|密碼|口令)\s*[:=：]\s*)[^\s,;，；]+/gi,
  /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g,
  /(?<!\d)\d{17}[\dXx](?!\d)/g,
  /(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g,
  /(?<!\d)\+?\d{1,3}[- ]\d{2,4}[- ]\d{3,4}[- ]\d{3,4}(?!\d)/g,
]
export function filterPerceptionText(text: string): string {
  return secrets.reduce((value, rule) => value.replace(rule, '***'), text.slice(0, 20_000))
}
export function sensitiveWindow(window: Pick<DesktopWindowInfo, 'title' | 'processName'>, settings: PerceptionSettings): boolean {
  const identity = `${window.processName}\n${window.title}`.toLowerCase()
  return settings.redactedApps.some(item => identity.includes(item.toLowerCase()))
}
export function unrecordedProcess(name: string, settings: PerceptionSettings): boolean {
  return settings.unrecordedApps.some(item => name.toLowerCase().includes(item.toLowerCase()))
}
/** 浏览器里的视频和网页通话分不开：平时不转写，只有陪看目标正是它时才录。 */
export function browserProcess(name: string): boolean {
  return chromiumBrowser(name) || /chrome|firefox|floorp|librewolf|waterfox/i.test(name)
}
/** 系统媒体信息报的来源是 AppUserModelId（如 Thorium.XXXX、MSEdge），不一定等于进程名。 */
export function mediaFrom(source: string, processName: string): boolean {
  const name = processName.toLowerCase().replace(/\.exe$/, '')
  const from = source.toLowerCase().replace(/\.exe$/, '')
  return !!name && (from === name || from.startsWith(`${name}.`) || (name === 'msedge' && from.includes('edge')))
}
/** Chromium 系浏览器：能装扩展、能连本机消息。名单和 nativeVideoHostSource 里的保持一致。 */
export function chromiumBrowser(name: string): boolean {
  return /^(chrome|msedge|thorium|chromium|brave|vivaldi|opera|cent|yandex|360se|360chrome|360chromex|qqbrowser|sogouexplorer|maxthon|liebao|twinkstar)(\.exe)?$/i.test(name)
}
export function filterWindow<T extends DesktopWindowInfo>(window: T, settings: PerceptionSettings): T {
  const sensitive = sensitiveWindow(window, settings)
  return { ...window, title: sensitive ? '敏感窗口' : filterPerceptionText(window.title), processName: sensitive ? '***' : filterPerceptionText(window.processName) }
}

/** 旧观察、台词查询同样经过出口；协议坐标和编号保留，内容字段统一过滤。 */
export function filterObservationOutput(value: unknown, settings: PerceptionSettings, key = ''): unknown {
  if (typeof value === 'string') return /(?:id|uri|url|data|hash|code|path)$/i.test(key) ? value : filterPerceptionText(value)
  if (Array.isArray(value)) return value.map(item => filterObservationOutput(item, settings, key))
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (typeof record.processName === 'string' && typeof record.title === 'string' && sensitiveWindow(record as unknown as DesktopWindowInfo, settings))
    return { windowId: record.windowId, pid: record.pid, bounds: record.bounds, title: '敏感窗口', processName: '***' }
  return Object.fromEntries(Object.entries(record).map(([name, item]) => [name, filterObservationOutput(item, settings, name)]))
}
