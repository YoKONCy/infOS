import type { PackagePanel } from '@infos/shared'
import { z } from 'zod'

const toolId = z.string().min(1).max(250)
const settingsSnapshot = z.object({
  revision: z.number().int().nonnegative(),
  values: z.record(z.string(), z.string()),
  fields: z.array(z.object({
    id: toolId,
    label: z.string(),
    placeholder: z.string().optional(),
    checkable: z.boolean().optional(),
  })),
  groups: z.array(z.object({
    id: toolId,
    name: z.string(),
    description: z.string(),
    state: z.enum(['pinned', 'ondemand', 'off']),
    tools: z.array(toolId),
  })),
  ungroupedState: z.enum(['pinned', 'ondemand', 'off']),
  disabledTools: z.array(toolId),
  tools: z.array(z.object({
    id: toolId,
    title: z.string(),
    description: z.string(),
    params: z.record(z.string(), z.object({
      required: z.boolean(),
      description: z.string(),
    })).optional(),
  })),
  fresh: z.array(toolId),
  notice: z.object({ message: z.string(), parameters: z.array(z.string()).optional() }).optional(),
})

/** 宿主绘制入口的种类；只能放在插件管理的 integrations 插槽。 */
const SETTINGS_KINDS = ['tool-groups', 'local-page']
/** 各入口种类允许分派给插件的动作。 */
const SETTINGS_ACTIONS: Record<string, string[]> = {
  'tool-groups': ['settings.load', 'settings.save', 'settings.check'],
  'local-page': ['page.url'],
}

/** 插件本机页面地址：只接受回环地址上的 http(s)，防止借入口打开外部网站或本机文件。 */
export function readLocalPageUrl(value: unknown): string {
  const raw = value && typeof value === 'object' ? (value as { url?: unknown }).url : undefined
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('PACKAGE_PAGE_INVALID')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('PACKAGE_PAGE_INVALID')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('PACKAGE_PAGE_INVALID')
  return url.href
}

/** 设置入口声明不合法：种类未知，或不在插件管理的 integrations 插槽。 */
export function invalidSettingsEntry(panel: PackagePanel): boolean {
  return (
    panel.settings !== undefined &&
    (!SETTINGS_KINDS.includes(panel.settings?.kind) || panel.slot !== 'integrations')
  )
}

/** 该动作是否属于面板设置入口允许分派的动作。 */
export function isSettingsAction(panel: PackagePanel | undefined, actionId: string): boolean {
  return !!panel?.settings && (SETTINGS_ACTIONS[panel.settings.kind] ?? []).includes(actionId)
}

/** 插件动作返回值的宿主侧校验：本机页面地址只放行回环地址。 */
export function settingsActionResult(actionId: string, result: unknown): unknown {
  if (actionId === 'page.url') return { url: readLocalPageUrl(result) }
  if (actionId === 'settings.check') {
    const parsed = z.object({ ok: z.boolean() }).safeParse(result)
    if (!parsed.success) throw new Error('PACKAGE_SETTINGS_INVALID')
    return parsed.data
  }
  const parsed = settingsSnapshot.safeParse(result)
  if (!parsed.success) throw new Error('PACKAGE_SETTINGS_INVALID')
  const data = parsed.data
  const assigned = data.groups.flatMap((group) => group.tools)
  if (
    new Set(data.tools.map((tool) => tool.id)).size !== data.tools.length ||
    new Set(data.fields.map((field) => field.id)).size !== data.fields.length ||
    new Set(data.groups.map((group) => group.id)).size !== data.groups.length ||
    data.groups.some((group) => group.id === '__ungrouped') ||
    new Set(assigned).size !== assigned.length
  ) throw new Error('PACKAGE_SETTINGS_INVALID')
  return data
}
