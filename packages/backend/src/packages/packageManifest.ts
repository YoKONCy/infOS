import type {
  PackageCapabilityRequirement,
  PackageContribution,
  PackageManifest,
} from '@infos/shared'

interface LegacyToolDefinitionInput {
  name: string
  description: string
  parameters: Record<string, unknown>
  display?: {
    label?: string
    description?: string
    icon?: string
    color?: string
    style?: string
    [key: string]: unknown
  }
}

/** 仅存在于安装边界的历史清单输入，不属于公共 ABI。 */
export interface LegacyPackageManifestInput {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  type: 'tool' | 'hook' | 'service'
  entry: string
  platforms?: PackageManifest['platforms']
  permissions?: PackageManifest['permissions']
  toolDefinition?: LegacyToolDefinitionInput
  tools?: LegacyToolDefinitionInput[]
  service?: { transport: 'stdio' | 'http'; port?: number; healthCheck?: string }
}

const TOOL_CAPABILITY_MAP: Record<string, { capabilityType: string; operation: string }> = {
  read_file: { capabilityType: 'filesystem.object', operation: 'read' },
  write_file: { capabilityType: 'filesystem.object', operation: 'write' },
  file_edit: { capabilityType: 'filesystem.object', operation: 'patch' },
  terminal_execute: { capabilityType: 'terminal.command', operation: 'execute' },
  browser_open_url: { capabilityType: 'web.page', operation: 'open' },
  browser_get_content: { capabilityType: 'web.page', operation: 'inspect' },
}

export function validatePackageManifest(manifest: PackageManifest): void {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof manifest.packageId !== 'string' ||
    typeof manifest.version !== 'string' ||
    typeof manifest.name !== 'string' ||
    !manifest.name.trim() ||
    !Array.isArray(manifest.contributions) ||
    manifest.contributions.length > 100 ||
    !['official', 'signed', 'user', 'generated'].includes(manifest.trust)
  )
    throw new Error('PACKAGE_MANIFEST_INVALID')
  if (manifest.manifestVersion !== 2) throw new Error('仅支持 Package Manifest V2')
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(manifest.packageId)) throw new Error('Package ID 无效')
  if (!manifest.version.trim()) throw new Error('Package 版本不能为空')
  if (
    manifest.packageId.length > 160 ||
    manifest.version.length > 80 ||
    manifest.name.length > 200 ||
    (manifest.description && manifest.description.length > 8000)
  )
    throw new Error('PACKAGE_MANIFEST_INVALID')
  const permissions = [
    'runtime:execute',
    'filesystem:read',
    'filesystem:write',
    'network:local',
    'network:internet',
    'process:spawn',
    'database:read',
    'database:write',
    'system:info',
  ]
  if (
    manifest.permissions &&
    (!Array.isArray(manifest.permissions) ||
      manifest.permissions.some((value) => !permissions.includes(value)))
  )
    throw new Error('PACKAGE_MANIFEST_INVALID')
  const ids = new Set<string>()
  for (const contribution of manifest.contributions) {
    if (
      !contribution ||
      ![
        'application',
        'service',
        'capability-provider',
        'runtime-adapter',
        'tool',
        'skill',
        'policy',
        'event-subscriber',
        'presenter',
        'web-ui',
        'asset',
        'context-provider',
        'agent-flow',
      ].includes(contribution.kind) ||
      (contribution.entry !== undefined && typeof contribution.entry !== 'string')
    )
      throw new Error('PACKAGE_MANIFEST_INVALID')
    if (!contribution.id || ids.has(contribution.id)) {
      throw new Error(`Package Contribution ID 重复或为空: ${contribution.id}`)
    }
    ids.add(contribution.id)
    if (contribution.kind === 'web-ui') {
      const ui = contribution.webUi
      if (
        typeof contribution.id !== 'string' ||
        contribution.id.length > 160 ||
        !ui ||
        typeof ui.root !== 'string' ||
        !ui.root ||
        ui.root.length > 240 ||
        (ui.index !== undefined && (typeof ui.index !== 'string' || !ui.index.endsWith('.html'))) ||
        (ui.title !== undefined &&
          (typeof ui.title !== 'string' || !ui.title.trim() || ui.title.length > 200)) ||
        (ui.actions !== undefined &&
          (!Array.isArray(ui.actions) ||
            ui.actions.length > 32 ||
            ui.actions.some(
              (action) => typeof action !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/i.test(action),
            ) ||
            new Set(ui.actions).size !== ui.actions.length)) ||
        ((ui.actions?.length ?? 0) > 0 && !contribution.entry)
      )
        throw new Error('PACKAGE_MANIFEST_INVALID')
    }
    if (
      ['capability-provider', 'runtime-adapter'].includes(contribution.kind) &&
      (!contribution.capabilityType || !contribution.contractVersion)
    ) {
      throw new Error(`能力 Contribution 缺少契约: ${contribution.id}`)
    }
  }
  const requirements = new Set<string>()
  for (const requirement of manifest.requires ?? []) {
    if (requirements.has(requirement.id)) {
      throw new Error(`Capability Requirement 重复: ${requirement.id}`)
    }
    requirements.add(requirement.id)
    if (!requirement.operations.length) {
      throw new Error(`Capability Requirement 无操作: ${requirement.id}`)
    }
  }
}

/** 历史清单只在安装边界投影一次，运行时从不接收历史类型。 */
export function legacyPackageManifestToPackage(
  manifest: LegacyPackageManifestInput,
): PackageManifest {
  const contributions: PackageContribution[] = []
  if (manifest.type === 'tool') {
    for (const tool of manifest.tools ??
      (manifest.toolDefinition ? [manifest.toolDefinition] : [])) {
      contributions.push({
        id: `tool.${tool.name}`,
        kind: 'tool',
        entry: manifest.entry,
        metadata: { definition: tool, migrated: true },
      })
    }
  } else if (manifest.type === 'hook') {
    contributions.push({
      id: `interceptor.${manifest.id}`,
      kind: 'event-subscriber',
      entry: manifest.entry,
      metadata: { interceptor: true, migrated: true },
    })
  } else {
    contributions.push({
      id: `service.${manifest.id}`,
      kind: 'service',
      entry: manifest.entry,
      metadata: { transport: manifest.service?.transport ?? 'stdio', migrated: true },
    })
  }
  contributions.push({
    id: `skill.${manifest.id}`,
    kind: 'skill',
    entry: 'skills',
    metadata: { optional: true, migrated: true },
  })
  return {
    manifestVersion: 2,
    packageId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    trust: 'user',
    contributions,
    permissions: manifest.permissions,
    platforms: manifest.platforms,
  }
}

export function requiredToolsToRequirements(
  skillId: string,
  requiredTools: readonly string[],
): PackageCapabilityRequirement[] {
  const grouped = new Map<string, Set<string>>()
  for (const tool of requiredTools) {
    const mapped = TOOL_CAPABILITY_MAP[tool] ?? {
      capabilityType: `tool.${tool}`,
      operation: 'invoke',
    }
    const operations = grouped.get(mapped.capabilityType) ?? new Set<string>()
    operations.add(mapped.operation)
    grouped.set(mapped.capabilityType, operations)
  }
  return [...grouped].map(([capabilityType, operations], index) => ({
    id: `skill.${skillId}.${index}`,
    capabilityType,
    contractVersion: '1.0',
    operations: [...operations],
    required: true,
    binding: 'lazy',
    cardinality: 'one',
  }))
}
