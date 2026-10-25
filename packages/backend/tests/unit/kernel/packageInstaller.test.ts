import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { vi, afterEach, describe, expect, it } from 'vitest'
import type { PackageManifest } from '@infos/shared'
import {
  PackageInstaller,
  PackageRegistry,
  PackageRuntime,
  PackageSecurityAuthority,
  packageManifestHash,
  packageSignaturePayload,
} from '@infos/backend/packages'

const roots: string[] = []
const fixtureRoot = path.resolve('TEMP/plugin-infrastructure')
mkdirSync(fixtureRoot, { recursive: true })

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function signedFixture(root: string, permissions: PackageManifest['permissions'] = []) {
  mkdirSync(root, { recursive: true })
  const entry = Buffer.from('process.stdout.write("ready")')
  writeFileSync(path.join(root, 'index.js'), entry)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifest: PackageManifest = {
    manifestVersion: 2,
    packageId: 'signed.demo',
    name: '签名Package',
    version: '1.0.0',
    trust: 'signed',
    permissions,
    contributions: [
      { id: 'service.main', kind: 'service', entry: 'index.js', metadata: { transport: 'stdio' } },
    ],
  }
  manifest.signature = {
    algorithm: 'ed25519',
    publisherId: 'publisher.demo',
    keyId: 'main',
    manifestHash: packageManifestHash(manifest),
    files: [
      {
        path: 'index.js',
        sha256: createHash('sha256').update(entry).digest('hex'),
        sizeBytes: entry.length,
      },
    ],
    signature: '',
    signedAt: new Date(0).toISOString(),
  }
  manifest.signature.signature = sign(null, packageSignaturePayload(manifest), privateKey).toString(
    'base64',
  )
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest))
  return { manifest, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}

describe('Package Installer', () => {
  it('应把旧安装目录迁移到 packages 并保留新目录冲突项', () => {
    const previous = path.join(fixtureRoot, `.tmp-extensions-${Date.now()}`)
    const packages = path.join(fixtureRoot, `.tmp-packages-${Date.now()}`)
    roots.push(previous, packages)
    mkdirSync(path.join(previous, 'old-only'), { recursive: true })
    mkdirSync(path.join(previous, 'same'), { recursive: true })
    mkdirSync(path.join(packages, 'same'), { recursive: true })
    writeFileSync(path.join(previous, 'old-only', 'value.txt'), '旧目录')
    writeFileSync(path.join(previous, 'same', 'value.txt'), '旧版本')
    writeFileSync(path.join(packages, 'same', 'value.txt'), '新版本')

    new PackageInstaller(new PackageRegistry()).migrateInstallDirectory(previous, packages)

    expect(readFileSync(path.join(packages, 'old-only', 'value.txt'), 'utf-8')).toBe('旧目录')
    expect(readFileSync(path.join(packages, 'same', 'value.txt'), 'utf-8')).toBe('新版本')
    expect(existsSync(path.join(previous, 'same'))).toBe(true)
  })

  it('Signed Package应验证Publisher、文件完整性和权限Grant', () => {
    const root = path.join(fixtureRoot, `.tmp-signed-package-${Date.now()}`)
    roots.push(root)
    const { manifest, publicKeyPem } = signedFixture(root, ['network:internet'])
    const registry = new PackageRegistry()
    const security = new PackageSecurityAuthority()
    security.trustPublisher({ publisherId: 'publisher.demo', keyId: 'main', publicKeyPem })
    const installer = new PackageInstaller(registry, security)
    expect(() => installer.installManifest(manifest, root)).toThrow(
      'PACKAGE_PERMISSION_GRANT_REQUIRED',
    )
    security.grantPermissions({
      packageId: manifest.packageId,
      version: manifest.version,
      permissions: ['network:internet'],
      grantedBy: 'user',
    })
    installer.installManifest(manifest, root)
    expect(registry.get(manifest.packageId)?.manifest.trust).toBe('signed')
  })

  it('Signed Package文件被篡改或Publisher被撤销时应fail-closed', () => {
    const root = path.join(fixtureRoot, `.tmp-tampered-package-${Date.now()}`)
    roots.push(root)
    const { manifest, publicKeyPem } = signedFixture(root)
    const security = new PackageSecurityAuthority()
    security.trustPublisher({ publisherId: 'publisher.demo', keyId: 'main', publicKeyPem })
    writeFileSync(path.join(root, 'index.js'), '篡改')
    expect(() =>
      new PackageInstaller(new PackageRegistry(), security).installManifest(manifest, root),
    ).toThrow('PACKAGE_FILE_INTEGRITY_FAILED')
    signedFixture(root)
    security.revokePublisher('publisher.demo', 'main')
    expect(() =>
      new PackageInstaller(new PackageRegistry(), security).installManifest(manifest, root),
    ).toThrow('PACKAGE_PUBLISHER_UNTRUSTED')
  })

  it('User Package必须使用隔离Service，禁止进程内贡献', () => {
    const security = new PackageSecurityAuthority()
    const manifest: PackageManifest = {
      manifestVersion: 2,
      packageId: 'user.demo',
      name: '用户Package',
      version: '1.0.0',
      trust: 'user',
      contributions: [{ id: 'tool.bad', kind: 'tool', entry: 'index.js' }],
    }
    expect(() => security.assertInstallAllowed(manifest, process.cwd())).toThrow(
      'PACKAGE_ISOLATION_REQUIRED',
    )
  })

  it('权限Grant撤销后应立即停用已激活Package', async () => {
    const root = path.join(fixtureRoot, `.tmp-revoke-package-${Date.now()}`)
    roots.push(root)
    const { manifest, publicKeyPem } = signedFixture(root, ['system:info'])
    const registry = new PackageRegistry()
    const security = new PackageSecurityAuthority()
    security.trustPublisher({ publisherId: 'publisher.demo', keyId: 'main', publicKeyPem })
    security.grantPermissions({
      packageId: manifest.packageId,
      version: manifest.version,
      permissions: ['system:info'],
      grantedBy: 'user',
    })
    new PackageInstaller(registry, security).installManifest(manifest, root)
    const runtime = new PackageRuntime(registry, security)
    runtime.registerActivator('service', async () => () => undefined)
    await runtime.activate(manifest.packageId)
    expect(registry.get(manifest.packageId)?.state).toBe('active')
    security.revokePermissions(manifest.packageId)
    await vi.waitFor(() => expect(registry.get(manifest.packageId)?.state).toBe('inactive'))
  })

  it('升级应拒绝版本降级和Publisher替换', () => {
    const security = new PackageSecurityAuthority()
    const current = {
      manifestVersion: 2,
      packageId: 'signed.demo',
      name: 'Demo',
      version: '2.0.0',
      trust: 'signed',
      contributions: [],
      signature: { publisherId: 'publisher.a' },
    } as unknown as PackageManifest
    expect(() => security.assertUpgradeAllowed(current, { ...current, version: '1.9.9' })).toThrow(
      'PACKAGE_DOWNGRADE_REJECTED',
    )
    expect(() =>
      security.assertUpgradeAllowed(current, {
        ...current,
        version: '2.1.0',
        signature: { ...current.signature!, publisherId: 'publisher.b' },
      }),
    ).toThrow('PACKAGE_PUBLISHER_REPLACEMENT_REJECTED')
  })

  it('旧 Extension 清单投影后应因缺少官方信任而拒绝安装', () => {
    const root = path.join(fixtureRoot, `.tmp-package-${Date.now()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        id: 'legacy.demo',
        name: '旧扩展',
        version: '1.0.0',
        type: 'tool',
        entry: 'index.js',
        tools: [{ name: 'legacy_demo', description: '测试', parameters: { type: 'object' } }],
      }),
    )
    const registry = new PackageRegistry()
    const installer = new PackageInstaller(registry)
    expect(() => installer.installFromDirectory(root)).toThrow('PACKAGE_TRUST_UNSUPPORTED')
    expect(registry.get('legacy.demo')).toBeUndefined()
  })
})
