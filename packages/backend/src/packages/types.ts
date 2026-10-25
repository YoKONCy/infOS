import type { PackageContribution, PackageManifest } from '@infos/shared'

export type PackageState = 'installed' | 'activating' | 'active' | 'failed' | 'inactive'

export interface InstalledPackage {
  manifest: PackageManifest
  rootDir?: string
  state: PackageState
  installedAt: string
  activatedAt?: string
  error?: string
}

export interface PackageActivationContext {
  host?: import('@infos/shared').PackageHostContext
  manifest: PackageManifest
  rootDir?: string
  contribution: PackageContribution
}

export type ContributionActivator = (
  context: PackageActivationContext,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
