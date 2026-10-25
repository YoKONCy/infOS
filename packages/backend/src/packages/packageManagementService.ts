import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rm, lstat } from 'node:fs/promises'
import path from 'node:path'
import type { ManagedPackageInfo, PackageManifest, PackagePermission } from '@infos/shared'
import type { PackageRegistry } from './packageRegistry'
import type { PackageRuntime } from './packageRuntime'
import type { PackageSecurityAuthority } from './packageSecurityAuthority'
import type { PackageDependencyPreparer } from './packageDependencies'
import { extractPackage } from './packageArchive'
import { atomicPackageJson, packageDigest, packagePath } from './packageFiles'
import { validatePackageManifest } from './packageManifest'
import { stripVTControlCharacters } from 'node:util'

interface Release {
  id: string
  manifest: PackageManifest
  digest: string
}
interface Receipt {
  current: Release
  previous?: Release
  enabled: boolean
  authorizedDigest?: string
  prepared?: boolean
  error?: string
}

/** 管理上传包的持久版本；安装、授权与激活是三个独立步骤。 */
export class PackageManagementService {
  private receipts: Record<string, Receipt> = Object.create(null)
  private queue: Promise<unknown> = Promise.resolve()
  private loadError?: Error
  constructor(
    private readonly root: string,
    private readonly registry: PackageRegistry,
    private readonly runtime: PackageRuntime,
    private readonly security: PackageSecurityAuthority,
    private readonly dependencies: PackageDependencyPreparer,
  ) {}
  private get indexFile() {
    return path.join(this.root, '.managed/index.json')
  }
  private directory(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('PACKAGE_RECEIPT_INVALID')
    return path.join(this.root, '.managed/releases', id)
  }
  manages(id: string): boolean {
    return Object.hasOwn(this.receipts, id)
  }
  list(): ManagedPackageInfo[] {
    if (this.loadError) throw this.loadError
    return Object.values(this.receipts).map((receipt) => {
      const { current } = receipt
      return {
        manifest: current.manifest,
        digest: current.digest,
        enabled: receipt.enabled,
        sourceDirectory: this.directory(current.id),
        authorized: receipt.authorizedDigest === current.digest,
        state: this.registry.get(current.manifest.packageId)?.state ?? 'installed',
        error:
          stripVTControlCharacters(
            receipt.error ?? this.registry.get(current.manifest.packageId)?.error ?? '',
          ).slice(-4000) || undefined,
        previousVersion: receipt.previous?.manifest.version,
        requestedPermissions: this.permissions(current.manifest),
      }
    })
  }
  async initialize(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.indexFile, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.packages) || saved.packages.length > 512)
        throw new Error('PACKAGE_INDEX_INVALID')
      for (const receipt of saved.packages as Receipt[]) {
        validatePackageManifest(receipt.current.manifest)
        const id = receipt.current.manifest.packageId
        if (this.receipts[id]) throw new Error('PACKAGE_INDEX_INVALID')
        this.receipts[id] = receipt
        try {
          if ((await packageDigest(this.directory(receipt.current.id))) !== receipt.current.digest)
            throw new Error('PACKAGE_SOURCE_CHANGED')
          this.registry.install(receipt.current.manifest, this.directory(receipt.current.id))
        } catch (error) {
          receipt.error = String(error)
          receipt.enabled = false
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.loadError = new Error('PACKAGE_INDEX_INVALID', { cause: error })
        for (const receipt of Object.values(this.receipts)) receipt.enabled = false
      }
    }
  }
  async startEnabled(): Promise<void> {
    if (process.env.INFOS_RESOURCE_SAFE_MODE === '1') return
    for (const [id, receipt] of Object.entries(this.receipts)) {
      if (!receipt.enabled) continue
      try {
        if (receipt.authorizedDigest !== receipt.current.digest)
          throw new Error('PACKAGE_PERMISSION_GRANT_REQUIRED')
        this.security.assertActivationAllowed(
          receipt.current.manifest,
          this.directory(receipt.current.id),
        )
        await this.security.assertSourceAllowed(
          receipt.current.manifest,
          this.directory(receipt.current.id),
        )
        await this.prepare(receipt)
        await this.runtime.activate(id)
        receipt.error = undefined
      } catch (error) {
        receipt.error = String(error)
      }
    }
  }
  install(bytes: Uint8Array): Promise<ManagedPackageInfo[]> {
    return this.serialize(async () => {
      const releaseId = randomUUID()
      const dir = this.directory(releaseId)
      await mkdir(dir, { recursive: true })
      try {
        const manifest = await extractPackage(bytes, dir)
        // 用户上传的清单不能自行获得内置代码的信任来源。
        if (manifest.trust === 'official') throw new Error('PACKAGE_OFFICIAL_SOURCE_UNTRUSTED')
        if (this.registry.get(manifest.packageId) && !this.manages(manifest.packageId))
          throw new Error('PACKAGE_BUILTIN_REPLACEMENT_FORBIDDEN')
        this.security.verifyInstallSource(manifest, dir)
        const previous = this.receipts[manifest.packageId]
        if (previous) this.security.assertUpgradeAllowed(previous.current.manifest, manifest)
        const digest = await packageDigest(dir)
        const next: Receipt = {
          current: { id: releaseId, manifest, digest },
          previous: previous?.current,
          enabled: false,
        }
        await this.switchRelease(manifest.packageId, next)
        return this.list()
      } catch (error) {
        await this.removeDirectory(releaseId)
        throw error
      }
    })
  }
  authorize(id: string, digest: string, permissions: PackagePermission[]): Promise<void> {
    return this.serialize(async () => {
      const receipt = this.get(id)
      if (
        digest !== receipt.current.digest ||
        (await packageDigest(this.directory(receipt.current.id))) !== digest
      )
        throw new Error('PACKAGE_SOURCE_CHANGED')
      if (
        this.permissions(receipt.current.manifest).some(
          (permission) => !permissions.includes(permission),
        )
      )
        throw new Error('PACKAGE_PERMISSION_DENIED')
      this.security.grantPermissions({
        packageId: id,
        version: receipt.current.manifest.version,
        publisherId: receipt.current.manifest.signature?.publisherId,
        permissions: this.permissions(receipt.current.manifest),
        contentHash: digest,
        grantedBy: 'user',
      })
      receipt.authorizedDigest = digest
      await this.persist()
    })
  }
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      if (enabled && process.env.INFOS_RESOURCE_SAFE_MODE === '1')
        throw new Error('PACKAGE_RECOVERY_MODE')
      const receipt = this.get(id)
      const previousEnabled = receipt.enabled
      if (enabled) {
        if (receipt.authorizedDigest !== receipt.current.digest)
          throw new Error('PACKAGE_PERMISSION_GRANT_REQUIRED')
        await this.prepare(receipt)
        await this.runtime.activate(id)
      } else await this.runtime.deactivate(id)
      receipt.enabled = enabled
      receipt.error = undefined
      try {
        await this.persist()
      } catch (error) {
        receipt.enabled = previousEnabled
        if (enabled) await this.runtime.deactivate(id)
        throw error
      }
    })
  }
  reload(id: string): Promise<void> {
    return this.serialize(async () => {
      if (process.env.INFOS_RESOURCE_SAFE_MODE === '1') throw new Error('PACKAGE_RECOVERY_MODE')
      const receipt = this.get(id)
      if (receipt.authorizedDigest !== receipt.current.digest)
        throw new Error('PACKAGE_PERMISSION_GRANT_REQUIRED')
      if ((await packageDigest(this.directory(receipt.current.id))) !== receipt.current.digest)
        throw new Error('PACKAGE_SOURCE_CHANGED')
      // 独立代际目录同时刷新入口和所有相对 import，避免仅加查询参数的伪重载。
      const nextId = randomUUID()
      await cp(this.directory(receipt.current.id), this.directory(nextId), {
        recursive: true,
        filter: (source) => path.basename(source) !== 'node_modules',
      })
      const next: Receipt = {
        ...receipt,
        prepared: false,
        current: { ...receipt.current, id: nextId },
      }
      try {
        await this.prepare(next)
        await this.switchRelease(id, next)
      } catch (error) {
        await this.removeDirectory(nextId)
        throw error
      }
    })
  }
  review(id: string): Promise<void> {
    return this.serialize(async () => {
      const receipt = this.get(id)
      const dir = this.directory(receipt.current.id)
      const manifest = JSON.parse(
        await readFile(path.join(dir, 'manifest.json'), 'utf8'),
      ) as PackageManifest
      validatePackageManifest(manifest)
      for (const contribution of manifest.contributions)
        if (contribution.entry) packagePath(dir, contribution.entry)
      if (manifest.packageId !== id || manifest.trust === 'official')
        throw new Error('PACKAGE_SOURCE_CHANGED')
      const digest = await packageDigest(dir)
      const nextId = randomUUID()
      await cp(dir, this.directory(nextId), {
        recursive: true,
        filter: (source) => path.basename(source) !== 'node_modules',
      })
      try {
        await this.switchRelease(id, {
          ...receipt,
          current: { id: nextId, manifest, digest },
          enabled: false,
          prepared: false,
          authorizedDigest: undefined,
        })
        this.security.revokePermissions(id)
      } catch (error) {
        await this.removeDirectory(nextId)
        throw error
      }
    })
  }
  rollback(id: string): Promise<void> {
    return this.serialize(async () => {
      const receipt = this.get(id)
      if (!receipt.previous) throw new Error('PACKAGE_ROLLBACK_UNAVAILABLE')
      // 回退后保持停用；用户核对版本并重新授权后才能执行旧代码。
      await this.switchRelease(id, {
        current: receipt.previous,
        previous: receipt.current,
        enabled: false,
      })
    })
  }
  uninstall(id: string): Promise<void> {
    return this.serialize(async () => {
      const receipt = this.get(id)
      await this.runtime.deactivate(id)
      delete this.receipts[id]
      try {
        await this.persist()
      } catch (error) {
        this.receipts[id] = receipt
        throw error
      }
      this.registry.uninstall(id)
      this.security.revokePermissions(id)
      await this.removeDirectory(receipt.current.id)
      if (receipt.previous) await this.removeDirectory(receipt.previous.id)
    })
  }
  private permissions(manifest: PackageManifest): PackagePermission[] {
    const executable = manifest.contributions.some(
      (item) => item.entry && !['skill', 'asset'].includes(item.kind),
    )
    return [
      ...new Set([
        ...(manifest.permissions ?? []),
        ...(executable ? ['runtime:execute' as const] : []),
      ]),
    ]
  }
  private async prepare(receipt: Receipt): Promise<void> {
    const dir = this.directory(receipt.current.id)
    if ((await packageDigest(dir)) !== receipt.current.digest)
      throw new Error('PACKAGE_SOURCE_CHANGED')
    // 资源回退不备份可重建依赖；恢复后的版本必须重新准备依赖。
    if (
      receipt.prepared &&
      (await lstat(path.join(dir, 'node_modules')).catch(() => undefined))?.isDirectory()
    )
      return
    await this.dependencies.prepare(dir)
    // 依赖准备会规范化 package.json 并生成锁文件，更新授权绑定的内容摘要。
    const digest = await packageDigest(dir)
    receipt.current.digest = digest
    receipt.authorizedDigest = digest
    receipt.prepared = true
    this.security.grantPermissions({
      packageId: receipt.current.manifest.packageId,
      publisherId: receipt.current.manifest.signature?.publisherId,
      version: receipt.current.manifest.version,
      permissions: this.permissions(receipt.current.manifest),
      contentHash: digest,
      grantedBy: 'user',
    })
    await this.persist()
  }
  private async switchRelease(id: string, next: Receipt): Promise<void> {
    const previous = this.receipts[id]
    await this.runtime.deactivate(id)
    try {
      this.registry.replace(next.current.manifest, this.directory(next.current.id))
      if (next.enabled) await this.runtime.activate(id)
      this.receipts[id] = next
      await this.persist()
      const retained = new Set([next.current.id, next.previous?.id])
      for (const release of [previous?.current, previous?.previous]) {
        if (release && !retained.has(release.id))
          await this.removeDirectory(release.id).catch(() => undefined)
      }
    } catch (error) {
      await this.runtime.deactivate(id)
      if (previous) {
        this.receipts[id] = previous
        this.registry.replace(previous.current.manifest, this.directory(previous.current.id))
        if (previous.authorizedDigest === previous.current.digest)
          this.security.grantPermissions({
            packageId: id,
            version: previous.current.manifest.version,
            contentHash: previous.current.digest,
            publisherId: previous.current.manifest.signature?.publisherId,
            permissions: this.permissions(previous.current.manifest),
            grantedBy: 'user',
          })
        if (previous.enabled)
          await this.runtime.activate(id).catch(() => {
            previous.enabled = false
          })
      } else {
        delete this.receipts[id]
        this.registry.uninstall(id)
      }
      throw error
    }
  }
  private get(id: string): Receipt {
    const receipt = Object.hasOwn(this.receipts, id) ? this.receipts[id] : undefined
    if (!receipt) throw new Error('PACKAGE_NOT_MANAGED')
    return receipt
  }
  private persist() {
    return atomicPackageJson(this.indexFile, { version: 1, packages: Object.values(this.receipts) })
  }
  private async removeDirectory(id: string) {
    const dir = this.directory(id)
    const stat = await lstat(dir).catch(() => undefined)
    if (stat?.isSymbolicLink()) throw new Error('PACKAGE_SYMLINK_FORBIDDEN')
    await rm(dir, { recursive: true, force: true })
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.loadError) throw this.loadError
      return operation()
    })
    this.queue = result.catch(() => undefined)
    return result
  }
}
