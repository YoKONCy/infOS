import type { PackageContributionKind } from '@infos/shared'
import { LifecycleScope } from '../kernel/lifecycleScope'
import type { PackageSecurityAuthority } from './packageSecurityAuthority'
import type { PackageRegistry } from './packageRegistry'
import type { ContributionActivator } from './types'
import type { PackageActivationContext } from './types'
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { packageTimeout } from './packageTimeout'

/** 按 Contribution Kind 激活 Package，并保证失败时原子回滚。 */
export class PackageRuntime {
  private readonly activators = new Map<PackageContributionKind, ContributionActivator>()
  private readonly scopes = new Map<string, LifecycleScope>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private requirementResolver?: (
    requirement: import('@infos/shared').PackageCapabilityRequirement,
  ) => boolean

  private unsubscribeRevocation?: () => void

  constructor(
    private readonly registry: PackageRegistry,
    private readonly security?: PackageSecurityAuthority,
    private readonly dataRoot?: string,
  ) {
    this.unsubscribeRevocation = security?.subscribeRevocation((packageId) => {
      void this.deactivate(packageId).catch(() => undefined)
    })
  }

  setRequirementResolver(
    resolver: (requirement: import('@infos/shared').PackageCapabilityRequirement) => boolean,
  ): void {
    this.requirementResolver = resolver
  }

  registerActivator(kind: PackageContributionKind, activator: ContributionActivator): () => void {
    if (this.activators.has(kind)) throw new Error(`Contribution Activator 已注册: ${kind}`)
    this.activators.set(kind, activator)
    return () => {
      if (this.activators.get(kind) === activator) this.activators.delete(kind)
    }
  }

  async activate(packageId: string): Promise<void> {
    return this.serialize(packageId, () => this.activateOnce(packageId))
  }

  /** 已获代码授权的宿主调试会话复用贡献边界，不创建安装包或权限主体。 */
  async activateContribution(context: PackageActivationContext) {
    const activator = this.activators.get(context.contribution.kind)
    if (!activator) throw new Error('DEBUG_CONTRIBUTION_UNSUPPORTED')
    return activator(context)
  }

  private async activateOnce(packageId: string): Promise<void> {
    const installed = this.registry.get(packageId)
    if (!installed) throw new Error(`Package 未安装: ${packageId}`)
    if (process.env.INFOS_RESOURCE_SAFE_MODE === '1' && installed.manifest.trust !== 'official')
      throw new Error('PACKAGE_RECOVERY_MODE')
    if (installed.state === 'active') return
    if (installed.state === 'activating') throw new Error(`Package 正在激活: ${packageId}`)
    this.security?.assertActivationAllowed(installed.manifest, installed.rootDir)
    await this.security?.assertSourceAllowed(installed.manifest, installed.rootDir)
    for (const requirement of installed.manifest.requires ?? []) {
      if (requirement.required && !this.requirementResolver?.(requirement)) {
        throw new Error(`PACKAGE_REQUIREMENT_UNAVAILABLE: ${requirement.capabilityType}`)
      }
    }
    const scope = new LifecycleScope(`package:${packageId}`)
    const controller = new AbortController()
    const dataDirectory = this.dataRoot
      ? path.join(this.dataRoot, createHash('sha256').update(packageId).digest('hex').slice(0, 32))
      : undefined
    this.registry.setState(packageId, 'activating')
    try {
      if (dataDirectory) await mkdir(dataDirectory, { recursive: true })
      for (const contribution of installed.manifest.contributions) {
        const activator = this.activators.get(contribution.kind)
        if (!activator) {
          if (contribution.entry || contribution.kind === 'capability-provider') {
            throw new Error(`缺少 Contribution Activator: ${contribution.kind}`)
          }
          continue
        }
        const cleanup = await activator({
          manifest: installed.manifest,
          rootDir: installed.rootDir,
          contribution,
          host: {
            packageId,
            contributionId: contribution.id,
            dataDirectory,
            signal: controller.signal,
            onDispose: (cleanup) =>
              scope.defer(() => packageTimeout(Promise.resolve().then(cleanup))),
          },
        })
        if (cleanup) scope.defer(cleanup)
      }
      scope.defer(() => controller.abort())
      this.scopes.set(packageId, scope)
      this.registry.setState(packageId, 'active')
    } catch (error) {
      controller.abort()
      await scope.dispose().catch(() => undefined)
      this.registry.setState(
        packageId,
        'failed',
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  async deactivate(packageId: string): Promise<void> {
    return this.serialize(packageId, () => this.deactivateOnce(packageId))
  }

  private async deactivateOnce(packageId: string): Promise<void> {
    const installed = this.registry.get(packageId)
    if (!installed) return
    try {
      await this.scopes.get(packageId)?.dispose()
    } finally {
      this.scopes.delete(packageId)
      this.registry.setState(packageId, 'inactive')
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.operations.values()])
    for (const packageId of [...this.scopes.keys()].reverse())
      await this.deactivate(packageId).catch(() => undefined)
    this.unsubscribeRevocation?.()
    this.unsubscribeRevocation = undefined
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation)
    this.operations.set(id, next)
    void next
      .finally(() => {
        if (this.operations.get(id) === next) this.operations.delete(id)
      })
      .catch(() => undefined)
    return next
  }
}
