import type { PackageManifest, PackagePermission } from './package.types'

export type PackageUiSlot = 'dashboard.overview' | 'chat.header' | 'chat.footer' | 'integrations'
/** 声明式 UI 不接收 HTML、脚本或任意 CSS。 */
export interface PackagePanel {
  id: string
  packageId: string
  slot: PackageUiSlot
  title: string
  text?: string
  fields?: Array<{ label: string; value: string }>
  actions?: Array<{ id: string; label: string }>
}
export interface ManagedPackageInfo {
  manifest: PackageManifest
  state: string
  enabled: boolean
  authorized: boolean
  digest: string
  sourceDirectory: string
  error?: string
  previousVersion?: string
  requestedPermissions: PackagePermission[]
}
