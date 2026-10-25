import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import type { PackageManifest } from '@infos/shared'
import {
  legacyPackageManifestToPackage,
  type LegacyPackageManifestInput,
  validatePackageManifest,
} from './packageManifest'
import type { PackageSecurityAuthority } from './packageSecurityAuthority'
import type { PackageRegistry } from './packageRegistry'

/** Package 文件系统发现与安装边界；Legacy 清单仅在这里投影一次。 */
export class PackageInstaller {
  constructor(
    private readonly registry: PackageRegistry,
    private readonly security?: PackageSecurityAuthority,
  ) {}

  installManifest(manifest: PackageManifest, rootDir?: string): void {
    validatePackageManifest(manifest)
    if (manifest.trust !== 'official' && !this.security) {
      throw new Error(`PACKAGE_TRUST_UNSUPPORTED: ${manifest.packageId} 缺少Package安全权威`)
    }
    this.security?.assertInstallAllowed(manifest, rootDir)
    if (manifest.platforms?.length) {
      const platform =
        process.platform === 'win32'
          ? 'windows'
          : process.platform === 'darwin'
            ? 'darwin'
            : process.platform === 'linux'
              ? 'linux'
              : 'docker'
      if (!manifest.platforms.includes(platform)) {
        throw new Error(`PACKAGE_PLATFORM_UNSUPPORTED: ${manifest.packageId}/${platform}`)
      }
    }
    if (rootDir) {
      for (const contribution of manifest.contributions) {
        if (!contribution.entry) continue
        const resolved = path.resolve(rootDir, contribution.entry)
        const relative = path.relative(path.resolve(rootDir), resolved)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`PACKAGE_ENTRY_OUTSIDE_ROOT: ${contribution.id}`)
        }
      }
    }
    this.registry.install(manifest, rootDir)
  }

  upgradeManifest(manifest: PackageManifest, rootDir?: string): void {
    validatePackageManifest(manifest)
    const current = this.registry.get(manifest.packageId)
    if (!current) throw new Error(`Package未安装: ${manifest.packageId}`)
    if (manifest.trust !== 'official' && !this.security) {
      throw new Error(`PACKAGE_TRUST_UNSUPPORTED: ${manifest.packageId} 缺少Package安全权威`)
    }
    this.security?.assertUpgradeAllowed(current.manifest, manifest)
    this.security?.assertInstallAllowed(manifest, rootDir)
    this.registry.replace(manifest, rootDir)
  }

  installFromDirectory(rootDir: string): PackageManifest {
    const manifestPath = path.join(rootDir, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error(`Package 清单不存在: ${manifestPath}`)
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as
      | PackageManifest
      | LegacyPackageManifestInput
    const manifest =
      'manifestVersion' in parsed && parsed.manifestVersion === 2
        ? parsed
        : legacyPackageManifestToPackage(parsed as LegacyPackageManifestInput)
    this.installManifest(manifest, rootDir)
    return manifest
  }

  migrateInstallDirectory(previousDir: string, packagesDir: string): void {
    if (!existsSync(previousDir)) return
    if (!existsSync(packagesDir)) {
      mkdirSync(path.dirname(packagesDir), { recursive: true })
      renameSync(previousDir, packagesDir)
      return
    }
    for (const entry of readdirSync(previousDir)) {
      const source = path.join(previousDir, entry)
      const destination = path.join(packagesDir, entry)
      if (existsSync(destination)) continue
      renameSync(source, destination)
    }
    if (readdirSync(previousDir).length === 0) rmSync(previousDir, { recursive: true, force: true })
  }

  discover(
    rootDir: string,
  ): Array<{ manifest?: PackageManifest; rootDir: string; error?: string }> {
    if (!existsSync(rootDir)) return []
    return readdirSync(rootDir)
      .filter((entry) => !entry.startsWith('.'))
      .map((entry) => path.join(rootDir, entry))
      .filter((entry) => statSync(entry).isDirectory())
      .map((packageDir) => {
        try {
          return { manifest: this.installFromDirectory(packageDir), rootDir: packageDir }
        } catch (error) {
          return {
            rootDir: packageDir,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      })
  }
}
