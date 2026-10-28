import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type {
  InstalledExtension,
  InstalledExtensionKind,
  InstalledExtensionSource,
  InstalledExtensionState,
  InstalledExtensionsView,
} from '@infos/shared'
import type { AppContext } from '../../container'
import { EXTENSION_PACKAGES } from './integrationDefinitions'

type Sources = Pick<
  AppContext,
  | 'pathResolver'
  | 'packageRegistry'
  | 'packageManagement'
  | 'integrationService'
  | 'skillLoader'
  | 'toolRegistry'
  | 'agentManager'
  | 'assetRegistry'
  | 'mcpConfigService'
  | 'mcpManager'
>

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** 汇总现有权威管理器，不建立第二套安装记录或资源生命周期。 */
export async function readExtensionInventory(ctx: Sources): Promise<InstalledExtensionsView> {
  const packages = ctx.packageRegistry.list()
  const owner = (location: string) =>
    packages
      .filter((item) => item.rootDir && contains(item.rootDir, location))
      .sort((left, right) => (right.rootDir?.length ?? 0) - (left.rootDir?.length ?? 0))[0]
  const source = (location?: string): InstalledExtensionSource => {
    if (!location) return 'official'
    if (ctx.pathResolver.getRoots('@workshop').some((root) => contains(root, location)))
      return 'workshop'
    if (contains(ctx.pathResolver.resolve('@app'), location)) return 'official'
    return 'local'
  }
  const groups: Array<
    [InstalledExtensionKind, () => Promise<InstalledExtension[]> | InstalledExtension[]]
  > = [
    [
      'package',
      () => {
        const managed = new Map(
          ctx.packageManagement.list().map((item) => [item.manifest.packageId, item]),
        )
        const all = new Map(packages.map((item) => [item.manifest.packageId, item]))
        // 安装记录仍可能存在于恢复模式中，不能仅枚举已激活的运行时包。
        for (const item of managed.values()) {
          if (!all.has(item.manifest.packageId)) {
            all.set(item.manifest.packageId, {
              manifest: item.manifest,
              rootDir: item.sourceDirectory,
              state: 'installed',
              installedAt: '',
            })
          }
        }
        const integrations = ctx.integrationService.view()
        return [...all.values()].map((item): InstalledExtension => {
          const manifest = item.manifest
          const receipt = managed.get(manifest.packageId)
          const builtin = (
            Object.keys(EXTENSION_PACKAGES) as Array<keyof typeof EXTENSION_PACKAGES>
          ).find((key) => EXTENSION_PACKAGES[key] === manifest.packageId)
          let state: InstalledExtensionState =
            item.state === 'active'
              ? 'ready'
              : item.state === 'activating'
                ? 'starting'
                : item.state === 'failed'
                  ? 'failed'
                  : 'disabled'
          if (receipt?.error) state = 'failed'
          if (receipt && !receipt.authorized) state = 'needs-authorization'
          if (builtin && state !== 'failed') {
            const config = integrations.extensions[builtin]
            state = config.ready ? 'ready' : config.enabled ? 'needs-configuration' : 'disabled'
          }
          return {
            id: `package:${manifest.packageId}`,
            resourceId: manifest.packageId,
            kind: 'package',
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            author: manifest.author,
            source: receipt ? 'local' : source(item.rootDir),
            location: receipt?.sourceDirectory ?? item.rootDir,
            state,
            manager: receipt ? 'packages' : builtin ? 'extensions' : undefined,
            managerId: manifest.packageId,
            requirements: [
              ...(manifest.minInfosVersion ? [`infOS >= ${manifest.minInfosVersion}`] : []),
              ...(manifest.platforms?.length ? [manifest.platforms.join(', ')] : []),
              ...(manifest.requires ?? []).map(
                (entry) => `${entry.capabilityType} ${entry.contractVersion}`,
              ),
            ],
            missingRequirements: [],
            contributions: manifest.contributions.map((entry) => entry.kind),
            hasRollback: Boolean(receipt?.previousVersion),
          }
        })
      },
    ],
    [
      'skill',
      () => {
        const skills = ctx.skillLoader.getAllManifests()
        const skillIds = new Set(skills.map((item) => item.id))
        const tools = new Set(ctx.toolRegistry.getAllDefinitions().map((item) => item.name))
        return skills.map((item): InstalledExtension => {
          const parent = owner(item.rootPath)
          const missing = [
            ...item.requiredTools.filter((id) => !tools.has(id)),
            ...item.dependsOnSkills.filter((id) => !skillIds.has(id)),
          ]
          return {
            id: `skill:${item.id}`,
            resourceId: item.id,
            kind: 'skill',
            name: item.name,
            description: item.description,
            version: text(item.metadata.version),
            author: text(item.metadata.author),
            source: source(item.rootPath),
            location: item.rootPath,
            ownerPackageId: parent?.manifest.packageId,
            state: missing.length ? 'needs-configuration' : 'available',
            manager: parent
              ? ctx.packageManagement.manages(parent.manifest.packageId)
                ? 'packages'
                : undefined
              : 'skills',
            managerId: parent?.manifest.packageId ?? item.id,
            requirements: [
              ...item.requiredTools,
              ...item.dependsOnSkills,
              ...(item.compatibility ? [item.compatibility] : []),
            ],
            missingRequirements: missing,
          }
        })
      },
    ],
    [
      'persona',
      async () =>
        Promise.all(
          ctx.agentManager.listAgents().map(async (item): Promise<InstalledExtension> => {
            const profile = ctx.agentManager.getAgent(item.id)!
            let metadata: Record<string, unknown> = {}
            let metadataUnavailable = false
            try {
              // 只读取小型元数据；不将完整角色配置、提示词或账号绑定送到列表。
              if ((await stat(profile.configPath)).size > 512 * 1024)
                throw new Error('EXTENSION_METADATA_TOO_LARGE')
              metadata = JSON.parse(await readFile(profile.configPath, 'utf8')) as Record<
                string,
                unknown
              >
            } catch {
              metadataUnavailable = true
            }
            const location = path.dirname(profile.configPath)
            const parent = owner(location)
            return {
              id: `persona:${item.id}`,
              resourceId: item.id,
              kind: 'persona',
              name: item.name,
              description: item.description,
              version: text(metadata?.version),
              author: text(metadata?.author),
              source: source(location),
              location,
              ownerPackageId: parent?.manifest.packageId,
              state: item.isEnabled ? 'ready' : 'disabled',
              manager: parent
                ? ctx.packageManagement.manages(parent.manifest.packageId)
                  ? 'packages'
                  : undefined
                : 'agents',
              managerId: parent?.manifest.packageId ?? item.id,
              requirements: [],
              missingRequirements: [],
              metadataUnavailable,
            }
          }),
        ),
    ],
    [
      'model',
      async () => {
        await ctx.assetRegistry.scanAll()
        return ctx.assetRegistry.getAssetsByType('model_3d').map((item): InstalledExtension => {
          const parent = owner(item.path)
          return {
            id: `model:${item.assetId}`,
            resourceId: item.assetId,
            kind: 'model',
            name: item.displayName,
            description: text(item.config?.description),
            version: text(item.config?.version),
            author: text(item.config?.author),
            source: item.source,
            location: item.path,
            state: 'available',
            ownerPackageId: parent?.manifest.packageId,
            manager:
              parent && ctx.packageManagement.manages(parent.manifest.packageId)
                ? 'packages'
                : undefined,
            managerId: parent?.manifest.packageId,
            requirements: [],
            missingRequirements: [],
          }
        })
      },
    ],
    [
      'mcp',
      async () => {
        const connections = ctx.mcpManager.getStatus().connections
        return (await ctx.mcpConfigService.list()).map((item): InstalledExtension => {
          const connection = connections.find((entry) => entry.name === item.name)
          return {
            id: `mcp:${item.id}`,
            resourceId: String(item.id),
            kind: 'mcp',
            name: item.name,
            source: 'local',
            state: !item.enabled
              ? 'disabled'
              : connection?.status === 'connected'
                ? 'ready'
                : connection?.status === 'error'
                  ? 'failed'
                  : 'needs-configuration',
            manager: 'mcp',
            managerId: String(item.id),
            requirements: [],
            missingRequirements: [],
          }
        })
      },
    ],
    [
      'feature',
      () => {
        const features = ctx.integrationService.view().features
        return (['search', 'pdf'] as const).map(
          (id): InstalledExtension => ({
            id: `feature:${id}`,
            resourceId: id,
            kind: 'feature',
            name: id,
            source: 'official',
            state: features[id].ready
              ? 'ready'
              : features[id].enabled
                ? 'needs-configuration'
                : 'disabled',
            manager: 'features',
            managerId: id,
            requirements: [],
            missingRequirements: [],
          }),
        )
      },
    ],
  ]
  const results = await Promise.allSettled(
    groups.map(([, collect]) => Promise.resolve().then(collect)),
  )
  return {
    items: results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
    unavailable: results.flatMap((result, index) =>
      result.status === 'rejected' ? [groups[index]![0]] : [],
    ),
  }
}
