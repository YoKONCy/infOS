import type {
  ContextRegion,
  ContextRegionRequest,
  PackagePanel,
  PackageWebUiModule,
} from '@infos/shared'
import type { ContextRegionRegistry } from '../services/context/contextRegionRuntime'
import type { PackageRuntime } from './packageRuntime'
import type { PackageHookBus } from './packageHookBus'
import type { PackageUiRegistry } from './packageUiRegistry'
import type { PackageInterceptEvent, PackageInterceptor } from './packageInterceptor'
import { loadPackageModule } from './packageModule'
import type { PackageAssets } from './packageAssets'
import { packagePath } from './packageFiles'
import type { PackageWebUi } from './packageWebUi'

export function registerExtensionActivators(input: {
  runtime: PackageRuntime
  contexts: ContextRegionRegistry
  hooks: PackageHookBus
  ui: PackageUiRegistry
  assets: PackageAssets
  webUi?: PackageWebUi
}): void {
  if (input.webUi) {
    input.runtime.registerActivator('web-ui', async (context) => {
      const module = context.contribution.entry
        ? await loadPackageModule<PackageWebUiModule>(context)
        : undefined
      return input.webUi!.register(context, module)
    })
  }
  input.runtime.registerActivator('asset', (context) => {
    if (!context.rootDir || !context.contribution.entry) throw new Error('PACKAGE_ENTRY_REQUIRED')
    return input.assets.register(
      `${context.manifest.packageId}/${context.contribution.id}`,
      packagePath(context.rootDir, context.contribution.entry),
      context.rootDir,
    )
  })
  input.runtime.registerActivator('context-provider', async (context) => {
    const module = await loadPackageModule<{
      provide(request: ContextRegionRequest): Promise<ContextRegion[]>
    }>(context)
    if (typeof module.provide !== 'function') throw new Error('PACKAGE_CONTEXT_INVALID')
    const providerId = `package:${context.manifest.packageId}/${context.contribution.id}`
    let active = true
    const remove = input.contexts.register({
      providerId,
      provide: async (request) => {
        if (
          context.host?.threadId &&
          (request.threadId !== context.host.threadId || request.agentId !== context.host.agentId)
        )
          return []
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const regions = await Promise.race([
            module.provide(structuredClone(request)),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('PACKAGE_CONTEXT_TIMEOUT')), 3000)
            }),
          ])
          if (!active) return []
          if (!Array.isArray(regions) || regions.length > 20)
            throw new Error('PACKAGE_CONTEXT_INVALID')
          return regions.map((region, index): ContextRegion => {
            if (typeof region.content !== 'string' || region.content.length > 32000)
              throw new Error('PACKAGE_CONTEXT_INVALID')
            return {
              providerId,
              regionId: `${providerId}/${index}`,
              content: region.content,
              kind: 'custom',
              trust: 'external',
              required: false,
              priority: Math.min(50, Number(region.priority) || 0),
              tokenEstimate: 0,
              contentHash: '',
              sourceObjectRefs: [],
              delivery: 'conversation',
              provenance: {
                packageId: context.manifest.packageId,
                contributionId: context.contribution.id,
              },
              validUntil: region.validUntil,
            }
          })
        } catch {
          return []
        } finally {
          if (timer) clearTimeout(timer)
        }
      },
    })
    return () => {
      active = false
      remove()
    }
  })
  input.runtime.registerActivator('agent-flow', async (context) => {
    const module = await loadPackageModule<{ hooks: Record<string, PackageInterceptor> }>(context)
    if (
      !module.hooks ||
      Object.entries(module.hooks).some(
        ([event, handler]) =>
          ![
            'agent:beforeRun',
            'agent:afterRun',
            'agent:beforeRequest',
            'agent:afterRequest',
            'chat:beforeSend',
            'chat:afterReply',
            'chat:beforeToolCall',
            'chat:afterToolCall',
          ].includes(event) || typeof handler !== 'function',
      )
    )
      throw new Error('PACKAGE_FLOW_INVALID')
    const cleanups = Object.entries(module.hooks).map(([event, handler]) =>
      input.hooks.register(
        context.manifest.packageId,
        event as PackageInterceptEvent,
        async (data, hookContext) => {
          const caller = data as {
            threadId?: string
            agentId?: string
            realmId?: string
            taskId?: string
            capabilityScope?: string
          }
          if (
            context.host?.threadId &&
            (caller?.threadId !== context.host.threadId ||
              caller?.agentId !== context.host.agentId ||
              caller.realmId ||
              caller.taskId ||
              (caller.capabilityScope && caller.capabilityScope !== 'default'))
          )
            return
          return handler(data, hookContext)
        },
      ),
    )
    return () => cleanups.reverse().forEach((cleanup) => cleanup())
  })
  input.runtime.registerActivator('presenter', async (context) => {
    const module = await loadPackageModule<{
      panel: Omit<PackagePanel, 'id' | 'packageId'>
      onAction?: (id: string) => Promise<unknown>
    }>(context)
    const panel = module.panel
    if (!panel || typeof panel.title !== 'string') throw new Error('PACKAGE_PANEL_INVALID')
    return input.ui.register(
      {
        ...panel,
        id: `${context.manifest.packageId}/${context.contribution.id}`,
        packageId: context.manifest.packageId,
      },
      module.onAction,
    )
  })
}
