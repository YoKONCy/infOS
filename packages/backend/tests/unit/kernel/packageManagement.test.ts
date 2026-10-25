import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import type { PackageManifest } from '@infos/shared'
import { PackageManagementService } from '@infos/backend/packages/packageManagementService'
import { PackageRegistry, PackageRuntime, PackageSecurityAuthority } from '@infos/backend/packages'
import { extractPackage } from '@infos/backend/packages/packageArchive'
import { packageDigest, packagePath } from '@infos/backend/packages/packageFiles'
import { PackageDependencies } from '@infos/backend/packages/packageDependencies'

const base = path.resolve('TEMP/plugin-infrastructure')
let root: string
let registry: PackageRegistry
let runtime: PackageRuntime
let security: PackageSecurityAuthority
let manager: PackageManagementService
const prepare = vi.fn(async (_root: string) => undefined)
const manifest = (version = '1.0.0'): PackageManifest => ({
  manifestVersion: 2,
  packageId: 'fixture.plugin',
  name: '测试插件',
  version,
  trust: 'user',
  contributions: [{ id: 'tool', kind: 'tool', entry: 'index.mjs' }],
})
const archive = (value = manifest(), code = 'export const value = 1') =>
  zipSync({
    'manifest.json': strToU8(JSON.stringify(value)),
    'index.mjs': strToU8(code),
  })
async function authorize() {
  const info = manager.list()[0]!
  await manager.authorize(info.manifest.packageId, info.digest, info.requestedPermissions)
}
beforeEach(async () => {
  await mkdir(base, { recursive: true })
  root = await mkdtemp(path.join(base, 'fixture-'))
  registry = new PackageRegistry()
  security = new PackageSecurityAuthority(path.join(root, 'security.json'))
  runtime = new PackageRuntime(registry, security)
  runtime.registerActivator('tool', () => () => undefined)
  prepare.mockClear()
  manager = new PackageManagementService(root, registry, runtime, security, { prepare })
  await manager.initialize()
})
afterEach(async () => {
  await runtime.shutdown()
  if (!root.startsWith(base + path.sep)) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})

describe('插件安装与生命周期', () => {
  it('损坏的安装记录不阻断后端启动，也不会被后续安装覆盖', async () => {
    await mkdir(path.join(root, '.managed'), { recursive: true })
    await writeFile(path.join(root, '.managed/index.json'), '损坏的内容')
    const broken = new PackageManagementService(root, registry, runtime, security, { prepare })
    await expect(broken.initialize()).resolves.toBeUndefined()
    expect(() => broken.list()).toThrow('PACKAGE_INDEX_INVALID')
    await expect(broken.install(archive())).rejects.toThrow('PACKAGE_INDEX_INVALID')
    expect(await readFile(path.join(root, '.managed/index.json'), 'utf8')).toBe('损坏的内容')
  })
  it('安装不执行代码；逐内容授权后启用，停用后重启保持停用', async () => {
    await manager.install(archive())
    expect(prepare).not.toHaveBeenCalled()
    await expect(manager.setEnabled('fixture.plugin', true)).rejects.toThrow('GRANT_REQUIRED')
    await authorize()
    await manager.setEnabled('fixture.plugin', true)
    expect(prepare).toHaveBeenCalledOnce()
    expect(manager.list()[0]?.state).toBe('active')
    await manager.setEnabled('fixture.plugin', false)
    const nextRegistry = new PackageRegistry()
    const nextRuntime = new PackageRuntime(nextRegistry, security)
    const next = new PackageManagementService(root, nextRegistry, nextRuntime, security, {
      prepare,
    })
    await next.initialize()
    await next.startEnabled()
    expect(next.list()[0]).toMatchObject({ enabled: false, authorized: true, state: 'installed' })
    await nextRuntime.shutdown()
  })
  it('更新撤销旧版本启用状态；回退到留存版本后需要重新授权', async () => {
    await manager.install(archive())
    await authorize()
    await manager.setEnabled('fixture.plugin', true)
    await manager.install(archive(manifest('1.1.0')))
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      authorized: false,
      previousVersion: '1.0.0',
    })
    await manager.rollback('fixture.plugin')
    expect(manager.list()[0]?.manifest.version).toBe('1.0.0')
    expect(manager.list()[0]?.authorized).toBe(false)
    await authorize()
    await manager.setEnabled('fixture.plugin', true)
    await manager.uninstall('fixture.plugin')
    expect(manager.list()).toEqual([])
    expect(registry.list()).toEqual([])
  })
  it('篡改源码不能沿用授权；重新读取后强制重新审核', async () => {
    await manager.install(archive())
    await authorize()
    const dir = registry.get('fixture.plugin')!.rootDir!
    await writeFile(path.join(dir, 'index.mjs'), 'export const value = 2')
    await expect(manager.setEnabled('fixture.plugin', true)).rejects.toThrow('SOURCE_CHANGED')
    await manager.review('fixture.plugin')
    expect(manager.list()[0]?.authorized).toBe(false)
    await authorize()
    await manager.setEnabled('fixture.plugin', true)
    expect(manager.list()[0]?.state).toBe('active')
  })
  it('依赖准备失败保留原插件；串行操作不会重复注册', async () => {
    await manager.install(archive())
    await authorize()
    prepare.mockRejectedValueOnce(new Error('模拟依赖失败'))
    await expect(manager.setEnabled('fixture.plugin', true)).rejects.toThrow('模拟依赖失败')
    expect(manager.list()[0]?.enabled).toBe(false)
    await Promise.all([
      manager.setEnabled('fixture.plugin', true),
      manager.setEnabled('fixture.plugin', false),
    ])
    expect(manager.list()[0]?.enabled).toBe(false)
  })
  it('重载创建新目录，失效所有相对 import 缓存', async () => {
    await manager.install(archive())
    await authorize()
    await manager.setEnabled('fixture.plugin', true)
    const old = registry.get('fixture.plugin')!.rootDir
    await manager.reload('fixture.plugin')
    expect(registry.get('fixture.plugin')!.rootDir).not.toBe(old)
    expect(manager.list()[0]?.state).toBe('active')
  })
  it('新代际激活失败时恢复旧版本和原注册', async () => {
    await manager.install(archive())
    await authorize()
    await manager.setEnabled('fixture.plugin', true)
    const original = registry.get('fixture.plugin')!.rootDir
    const remove = runtime.registerActivator('asset', () => {
      throw new Error('模拟注册失败')
    })
    const next = manifest('1.1.0')
    next.contributions.push({ id: 'bad', kind: 'asset' })
    await manager.install(archive(next))
    await authorize()
    await expect(manager.setEnabled('fixture.plugin', true)).rejects.toThrow('模拟注册失败')
    await manager.rollback('fixture.plugin')
    await authorize()
    await manager.setEnabled('fixture.plugin', true)
    expect(registry.get('fixture.plugin')!.rootDir).toBe(original)
    remove()
  })
  it('上传包不能自称内置官方，也不能替换内核已注册的包', async () => {
    await expect(manager.install(archive({ ...manifest(), trust: 'official' }))).rejects.toThrow(
      'OFFICIAL_SOURCE_UNTRUSTED',
    )
    registry.install(manifest())
    await expect(manager.install(archive())).rejects.toThrow('BUILTIN_REPLACEMENT_FORBIDDEN')
  })
})

describe('插件文件与依赖边界', () => {
  it.each([
    '../escape',
    'C:/escape',
    '/absolute',
    'safe/../../escape',
    'file:stream',
    'con.txt',
    'safe\\escape',
    'safe/file.',
  ])('拒绝危险路径 %s', (name) => {
    expect(() => packagePath(root, name)).toThrow('PACKAGE_PATH_INVALID')
  })
  it('ZIP 拒绝路径穿越、配置注入和预装依赖', async () => {
    for (const name of ['../escape.mjs', '.npmrc', 'node_modules/evil.js']) {
      const dir = path.join(root, String(Math.random()))
      await mkdir(dir)
      await expect(
        extractPackage(
          zipSync({
            'manifest.json': strToU8(JSON.stringify(manifest())),
            [name]: strToU8('危险内容'),
          }),
          dir,
        ),
      ).rejects.toThrow('PACKAGE_')
    }
  })
  it('支持单一顶层目录，摘要随任意源码改变', async () => {
    const dir = path.join(root, 'extract')
    await mkdir(dir)
    await extractPackage(
      zipSync({
        'plugin/manifest.json': strToU8(JSON.stringify(manifest())),
        'plugin/index.mjs': strToU8('代码'),
      }),
      dir,
    )
    const original = await packageDigest(dir)
    await writeFile(path.join(dir, 'index.mjs'), '修改代码')
    expect(await packageDigest(dir)).not.toBe(original)
  })
  it('独立依赖准备会移除脚本和外部路径依赖', async () => {
    const dir = path.join(root, 'dependency')
    await mkdir(dir)
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { install: '不能执行' },
        pnpm: { overrides: {} },
        type: 'module',
      }),
    )
    await new PackageDependencies(path.join(root, 'store')).prepare(dir)
    expect(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))).toEqual({
      name: 'fixture',
      type: 'module',
      dependencies: {},
    })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { evil: 'file:../outside' } }),
    )
    await expect(new PackageDependencies(path.join(root, 'store')).prepare(dir)).rejects.toThrow(
      'DEPENDENCY_SPEC_UNSUPPORTED',
    )
    expect(await readdir(root)).not.toContain('outside')
  })
})
