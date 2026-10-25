import { createHash, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PackageManifest, PackagePermission } from '@infos/shared'
import { packageDigest } from './packageFiles'

export interface TrustedPackagePublisher {
  publisherId: string
  keyId: string
  publicKeyPem: string
  trustedAt: string
  revokedAt?: string
}

export interface PackagePermissionGrant {
  packageId: string
  version: string
  contentHash?: string
  publisherId?: string
  permissions: PackagePermission[]
  grantedBy: 'user' | 'system'
  grantedAt: string
  revokedAt?: string
}

interface PackageSecurityFile {
  version: 1
  publishers: TrustedPackagePublisher[]
  grants: PackagePermissionGrant[]
}

/** Package签名、Publisher Trust与权限Grant的持久安全权威。 */
export class PackageSecurityAuthority {
  private readonly publishers = new Map<string, TrustedPackagePublisher>()
  private readonly grants = new Map<string, PackagePermissionGrant>()
  private readonly revocationListeners = new Set<(packageId: string) => void>()

  constructor(private readonly filePath?: string) {
    this.load()
  }

  trustPublisher(input: Omit<TrustedPackagePublisher, 'trustedAt' | 'revokedAt'>): void {
    const key = publisherKey(input.publisherId, input.keyId)
    const current = this.publishers.get(key)
    if (current && current.publicKeyPem !== input.publicKeyPem) {
      throw new Error('PACKAGE_PUBLISHER_KEY_CONFLICT')
    }
    this.publishers.set(key, {
      ...input,
      trustedAt: current?.trustedAt ?? new Date().toISOString(),
    })
    this.persist()
  }

  revokePublisher(publisherId: string, keyId: string): boolean {
    const current = this.publishers.get(publisherKey(publisherId, keyId))
    if (!current || current.revokedAt) return false
    current.revokedAt = new Date().toISOString()
    this.persist()
    for (const grant of this.grants.values()) {
      if (!grant.revokedAt && grant.publisherId === publisherId)
        for (const listener of this.revocationListeners) listener(grant.packageId)
    }
    return true
  }

  grantPermissions(input: Omit<PackagePermissionGrant, 'grantedAt' | 'revokedAt'>): void {
    this.grants.set(input.packageId, {
      ...input,
      permissions: [...new Set(input.permissions)].sort(),
      grantedAt: new Date().toISOString(),
    })
    this.persist()
  }

  revokePermissions(packageId: string): boolean {
    const current = this.grants.get(packageId)
    if (!current || current.revokedAt) return false
    current.revokedAt = new Date().toISOString()
    this.persist()
    for (const listener of this.revocationListeners) listener(packageId)
    return true
  }

  subscribeRevocation(listener: (packageId: string) => void): () => void {
    this.revocationListeners.add(listener)
    return () => this.revocationListeners.delete(listener)
  }

  assertInstallAllowed(manifest: PackageManifest, rootDir?: string): void {
    if (manifest.trust === 'official') {
      if (rootDir) throw new Error('PACKAGE_OFFICIAL_SOURCE_UNTRUSTED')
      return
    }
    if (!rootDir) throw new Error('PACKAGE_ROOT_REQUIRED')
    if (manifest.trust === 'signed') this.verifySignature(manifest, rootDir)
    else if (!this.hasCodeGrant(manifest)) this.assertIsolatedContributions(manifest)
    this.assertPermissions(manifest)
  }

  verifyInstallSource(manifest: PackageManifest, rootDir: string): void {
    if (manifest.trust === 'official') throw new Error('PACKAGE_OFFICIAL_SOURCE_UNTRUSTED')
    if (manifest.trust === 'signed') this.verifySignature(manifest, rootDir)
    const platform =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
    if (
      manifest.platforms?.length &&
      !manifest.platforms.includes(platform) &&
      !(process.env.INFOS_DOCKER && manifest.platforms.includes('docker'))
    )
      throw new Error('PACKAGE_PLATFORM_UNSUPPORTED')
  }

  assertActivationAllowed(manifest: PackageManifest, rootDir?: string): void {
    if (manifest.trust === 'official') {
      if (rootDir) throw new Error('PACKAGE_OFFICIAL_SOURCE_UNTRUSTED')
      return
    }
    if (manifest.trust === 'signed') {
      const signature = manifest.signature
      const publisher =
        signature && this.publishers.get(publisherKey(signature.publisherId, signature.keyId))
      if (!publisher || publisher.revokedAt) throw new Error('PACKAGE_PUBLISHER_UNTRUSTED')
    }
    this.assertPermissions(manifest)
    if (!this.hasCodeGrant(manifest) && manifest.trust !== 'signed')
      this.assertIsolatedContributions(manifest)
  }

  async assertSourceAllowed(manifest: PackageManifest, rootDir?: string): Promise<void> {
    if (!rootDir) return
    const grant = this.grants.get(manifest.packageId)
    if (
      this.hasCodeGrant(manifest) &&
      (!grant?.contentHash || grant.contentHash !== (await packageDigest(rootDir)))
    )
      throw new Error('PACKAGE_SOURCE_CHANGED')
  }

  hasCodeGrant(manifest: PackageManifest): boolean {
    const grant = this.grants.get(manifest.packageId)
    return (
      !!grant &&
      !grant.revokedAt &&
      grant.version === manifest.version &&
      grant.permissions.includes('runtime:execute') &&
      !!grant.contentHash
    )
  }

  assertUpgradeAllowed(current: PackageManifest, next: PackageManifest): void {
    if (current.packageId !== next.packageId) throw new Error('PACKAGE_UPGRADE_ID_MISMATCH')
    if (compareVersions(next.version, current.version) < 0)
      throw new Error('PACKAGE_DOWNGRADE_REJECTED')
    const currentPublisher = current.signature?.publisherId
    const nextPublisher = next.signature?.publisherId
    if (currentPublisher && nextPublisher !== currentPublisher) {
      throw new Error('PACKAGE_PUBLISHER_REPLACEMENT_REJECTED')
    }
  }

  private verifySignature(manifest: PackageManifest, rootDir: string): void {
    const signature = manifest.signature
    if (!signature || signature.algorithm !== 'ed25519')
      throw new Error('PACKAGE_SIGNATURE_REQUIRED')
    const publisher = this.publishers.get(publisherKey(signature.publisherId, signature.keyId))
    if (!publisher || publisher.revokedAt) throw new Error('PACKAGE_PUBLISHER_UNTRUSTED')
    const unsigned = { ...manifest, signature: undefined }
    const manifestHash = digest(Buffer.from(canonicalJson(unsigned)))
    if (manifestHash !== signature.manifestHash) throw new Error('PACKAGE_MANIFEST_HASH_MISMATCH')
    const files = [...signature.files].sort((left, right) => left.path.localeCompare(right.path))
    for (const file of files) {
      const resolved = safePackagePath(rootDir, file.path)
      const content = readFileSync(resolved)
      if (content.length !== file.sizeBytes || digest(content) !== file.sha256) {
        throw new Error(`PACKAGE_FILE_INTEGRITY_FAILED: ${file.path}`)
      }
    }
    const declared = new Set(files.map((file) => normalizePath(file.path)))
    for (const executable of executableFiles(rootDir)) {
      if (!declared.has(executable)) throw new Error(`PACKAGE_EXECUTABLE_UNDECLARED: ${executable}`)
    }
    const payload = Buffer.from(canonicalJson({ manifestHash, files }))
    if (
      !verify(null, payload, publisher.publicKeyPem, Buffer.from(signature.signature, 'base64'))
    ) {
      throw new Error('PACKAGE_SIGNATURE_INVALID')
    }
  }

  private assertPermissions(manifest: PackageManifest): void {
    const requested = [...new Set(manifest.permissions ?? [])].sort()
    if (!requested.length) return
    const grant = this.grants.get(manifest.packageId)
    if (!grant || grant.revokedAt || grant.version !== manifest.version) {
      throw new Error('PACKAGE_PERMISSION_GRANT_REQUIRED')
    }
    if (requested.some((permission) => !grant.permissions.includes(permission))) {
      throw new Error('PACKAGE_PERMISSION_DENIED')
    }
  }

  private assertIsolatedContributions(manifest: PackageManifest): void {
    const forbidden = manifest.contributions.find((contribution) =>
      ['tool', 'policy', 'event-subscriber', 'runtime-adapter'].includes(contribution.kind),
    )
    if (forbidden) throw new Error(`PACKAGE_ISOLATION_REQUIRED: ${forbidden.kind}`)
    const service = manifest.contributions.find(
      (contribution) =>
        contribution.kind === 'service' && contribution.metadata?.transport !== 'stdio',
    )
    if (service) throw new Error('PACKAGE_USER_SERVICE_STDIO_REQUIRED')
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return
    const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as PackageSecurityFile
    if (value.version !== 1) throw new Error('PACKAGE_SECURITY_FILE_UNSUPPORTED')
    value.publishers.forEach((publisher) =>
      this.publishers.set(publisherKey(publisher.publisherId, publisher.keyId), publisher),
    )
    value.grants.forEach((grant) => this.grants.set(grant.packageId, grant))
  }

  private persist(): void {
    if (!this.filePath) return
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const value: PackageSecurityFile = {
      version: 1,
      publishers: [...this.publishers.values()],
      grants: [...this.grants.values()],
    }
    writeFileSync(this.filePath, JSON.stringify(value, null, 2), { mode: 0o600 })
  }
}

export function packageSignaturePayload(manifest: PackageManifest): Buffer {
  const signature = manifest.signature
  if (!signature) throw new Error('PACKAGE_SIGNATURE_REQUIRED')
  return Buffer.from(
    canonicalJson({
      manifestHash: signature.manifestHash,
      files: [...signature.files].sort((left, right) => left.path.localeCompare(right.path)),
    }),
  )
}

export function packageManifestHash(manifest: PackageManifest): string {
  return digest(Buffer.from(canonicalJson({ ...manifest, signature: undefined })))
}

function executableFiles(rootDir: string): string[] {
  const result: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry)
      if (statSync(absolute).isDirectory()) visit(absolute)
      else if (/\.(?:[cm]?js|node|wasm)$/i.test(entry)) {
        result.push(normalizePath(path.relative(rootDir, absolute)))
      }
    }
  }
  visit(rootDir)
  return result.sort()
}

function safePackagePath(rootDir: string, relative: string): string {
  const resolved = path.resolve(rootDir, relative)
  const fromRoot = path.relative(path.resolve(rootDir), resolved)
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot))
    throw new Error('PACKAGE_FILE_OUTSIDE_ROOT')
  if (!existsSync(resolved) || !statSync(resolved).isFile())
    throw new Error(`PACKAGE_FILE_MISSING: ${relative}`)
  return resolved
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function publisherKey(publisherId: string, keyId: string): string {
  return `${publisherId}:${keyId}`
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    return String(x).localeCompare(String(y))
  }
  return 0
}
