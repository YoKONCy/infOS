import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ManagedPackageInfo, PackageManifest } from '@infos/shared'
import type { SkillManifest } from '@infos/backend/capabilities/types'
import { PackageRegistry } from '@infos/backend/packages/packageRegistry'
import { readExtensionInventory } from '@infos/backend/services/integrations/extensionInventory'

type Sources = Parameters<typeof readExtensionInventory>[0]
const root = path.resolve('TEMP', 'extension-inventory')
const packageRoot = path.join(root, 'data', 'packages', 'example')
const manifest: PackageManifest = {
  manifestVersion: 2,
  packageId: 'example.tools',
  name: '示例插件',
  version: '2.1.0',
  trust: 'user',
  contributions: [],
}
function skill(id: string, rootPath: string): SkillManifest {
  return {
    id,
    name: id,
    rootPath,
    description: '',
    category: '',
    tags: [],
    parameters: {},
    metadata: {},
    allowedTools: [],
    requiredTools: [],
    dependsOnSkills: [],
  }
}
function fixture(skills: SkillManifest[] = []) {
  const packages = new PackageRegistry()
  packages.install(manifest, packageRoot)
  const receipt: ManagedPackageInfo = {
    manifest,
    sourceDirectory: packageRoot,
    enabled: false,
    authorized: false,
    digest: '0'.repeat(64),
    state: 'installed',
    requestedPermissions: [],
  }
  // 只隔离文件、配置与运行时边界，投影与所属关系使用真实实现。
  return {
    pathResolver: {
      resolve: (alias: string) =>
        alias === '@app' ? path.join(root, 'app') : path.join(root, 'data'),
      getRoots: () => [],
    },
    packageRegistry: packages,
    packageManagement: {
      list: () => [receipt],
      manages: (id: string) => id === manifest.packageId,
    },
    integrationService: {
      view: () => ({
        extensions: {},
        features: {
          search: { enabled: false, ready: false },
          pdf: { enabled: false, ready: false },
        },
      }),
    },
    skillLoader: { getAllManifests: () => skills },
    toolRegistry: { getAllDefinitions: () => [{ name: 'read_file' }] },
    agentManager: { listAgents: () => [] },
    assetRegistry: { scanAll: async () => undefined, getAssetsByType: () => [] },
    mcpConfigService: { list: async () => [] },
    mcpManager: { getStatus: () => ({ connections: [] }) },
  } as unknown as Sources
}

describe('已安装拓展投影', () => {
  it('包内技能交给所属插件管理，相同路径前缀的独立技能不被误归属', async () => {
    const ctx = fixture([
      skill('owned', path.join(packageRoot, 'skills', 'owned')),
      skill('standalone', path.join(`${packageRoot}-neighbor`, 'skills', 'standalone')),
    ])
    const view = await readExtensionInventory(ctx)
    expect(view.items.find((item) => item.id === 'skill:owned')).toMatchObject({
      ownerPackageId: 'example.tools',
      manager: 'packages',
      managerId: 'example.tools',
      source: 'local',
    })
    const standalone = view.items.find((item) => item.id === 'skill:standalone')
    expect(standalone).toMatchObject({ manager: 'skills', managerId: 'standalone' })
    expect(standalone?.ownerPackageId).toBeUndefined()
  })

  it('按当前工具和技能判断缺失依赖，不虚构未声明的版本', async () => {
    const item = skill('analysis', path.join(root, 'data', 'skills', 'analysis'))
    item.requiredTools = ['read_file', 'missing_tool']
    item.dependsOnSkills = ['missing_skill']
    const view = await readExtensionInventory(fixture([item]))
    const projected = view.items.find((entry) => entry.id === 'skill:analysis')
    expect(projected).toMatchObject({
      state: 'needs-configuration',
      missingRequirements: ['missing_tool', 'missing_skill'],
    })
    expect(projected?.version).toBeUndefined()
  })

  it('安装记录读取失败时保留其他分类，并明确报告插件分类不可用', async () => {
    const ctx = fixture([skill('independent', path.join(root, 'data', 'skills', 'independent'))])
    ctx.packageManagement.list = () => {
      throw new Error('PACKAGE_INDEX_INVALID')
    }
    const view = await readExtensionInventory(ctx)
    expect(view.unavailable).toEqual(['package'])
    expect(view.items.filter((item) => item.kind === 'package')).toEqual([])
    expect(view.items.find((item) => item.id === 'skill:independent')?.manager).toBe('skills')
  })
})
