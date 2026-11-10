/**
 * @file 收纳框项目能不能拖出去：隐藏文件和受保护文件不允许，其余和资源管理器一样。
 *       页面只传项目 ID，路径由 DesktopFences 反查，这里只回答「这个路径能不能交给系统拖拽」。
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import { fenceBaseName } from '../../../../packages/shared/src/desktopFence'
import type { FenceFileSystem } from './fenceEntries'

/** 文件夹里不显示的系统文件。 */
const HIDDEN_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

/**
 * infOS 的凭据与访问控制文件，和后端 `protectedFiles.ts` 同一份清单（有测试核对），另加 config.env。
 * 主进程不知道后端数据目录在哪，所以名字太普通的那几个（如 `kernel/trust.json`）连上级目录一起比。
 */
export const FENCE_PROTECTED_NAMES = [
  'config.env',
  'client-access.json',
  'gateway_token.json',
  'jwt_secret.key',
  'server-credentials.key',
  'node-identity.json',
  'capability-device-tokens.json',
  'capability-device-credential.json',
  'client-connection.json',
  'infos-settings.key',
  'desktop-safety.json',
  'desktop-safety.accepted.json',
  'desktop-control.json',
  'electron-node-id.txt',
] as const
export const FENCE_PROTECTED_SUFFIXES = [
  'kernel/nodes.json',
  'kernel/trust.json',
  'distributed/servers.json',
  'distributed/last-sync.json',
] as const

/** 按名称算隐藏：系统文件、Office 临时文件、点开头的文件。 */
export function isFenceHiddenName(name: string): boolean {
  return HIDDEN_NAMES.has(name.toLowerCase()) || name.startsWith('~$') || name.startsWith('.')
}

/** 名字或它的原子写入临时文件（`名字.tmp`、`名字.<随机>.tmp`）是否命中。 */
const matches = (value: string, item: string) =>
  value === item || (value.startsWith(`${item}.`) && value.endsWith('.tmp'))

/** 这个路径是不是 infOS 的凭据或访问控制文件。 */
export function isFenceProtectedPath(target: string): boolean {
  const lower = target.replace(/\\/g, '/').toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (FENCE_PROTECTED_NAMES.some((item) => matches(base, item))) return true
  return FENCE_PROTECTED_SUFFIXES.some((item) => {
    const at = lower.lastIndexOf(`/${item}`)
    return at >= 0 && matches(lower.slice(at + 1), item)
  })
}

/** 不允许拖出：隐藏文件（名称或属性）、系统文件、受保护文件。 */
export function isFenceDragBlocked(
  target: string,
  files: Pick<FenceFileSystem, 'isHidden' | 'isSystem'>,
): boolean {
  return (
    isFenceHiddenName(fenceBaseName(target)) ||
    isFenceProtectedPath(target) ||
    !!files.isHidden?.(target) ||
    !!files.isSystem?.(target)
  )
}
