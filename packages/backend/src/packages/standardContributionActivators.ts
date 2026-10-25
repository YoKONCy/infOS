import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadPackageModule as loadModule } from './packageModule'
import { packageTimeout } from './packageTimeout'
import type { PackageContributionKind } from '@infos/shared'
import type { KernelEventBus } from '../kernel/kernelOutboxPublisher'
import type { CapabilityDirectory, CapabilityProviderInvoke } from '../kernel/capabilityDirectory'
import type { SkillLoader } from '../capabilities/skillLoader'
import type { ToolRegistry, ToolHandler } from '../services/agent/toolRegistry'
import type { PackageRuntime } from './packageRuntime'
import type { PackageProcessSupervisor } from './packageProcessSupervisor'
import type { PackageHookBus } from './packageHookBus'
import type { PackageInterceptEvent, PackageInterceptor } from './packageInterceptor'
import { PACKAGE_INTERCEPT_EVENTS } from '@infos/shared'

interface ToolModule {
  definition: import('../services/pipeline/types').ToolDefinition
  execute?: ToolHandler
  default?: ToolModule
}

interface SubscriberModule {
  onEvent?: Parameters<KernelEventBus['subscribe']>[0]
  hooks?: Record<string, PackageInterceptor>
  default?: SubscriberModule
}

interface ProviderModule {
  definition?: import('@infos/shared').KernelCapabilityDefinition
  offer?: import('@infos/shared').KernelCapabilityOffer
  invoke?: CapabilityProviderInvoke
  default?: ProviderModule
}

/** 注册无需内核特权的标准 Package Contribution 激活器。 */
export function registerStandardContributionActivators(input: {
  runtime: PackageRuntime
  tools: ToolRegistry
  skills: SkillLoader
  events: KernelEventBus
  processes: PackageProcessSupervisor
  hooks?: PackageHookBus
  capabilities?: CapabilityDirectory
  activateBuiltinProvider?: import('./types').ContributionActivator
  activateBuiltinTool?: import('./types').ContributionActivator
}): void {
  input.runtime.registerActivator('tool', async (context) => {
    if (!context.contribution.entry) return input.activateBuiltinTool?.(context)
    const module = await loadModule<ToolModule>(context)
    const value = module.default ?? module
    const definition = value.definition ?? context.contribution.metadata?.definition
    if (!definition || typeof value.execute !== 'function') {
      throw new Error(`Tool Contribution 无有效定义或入口: ${context.contribution.id}`)
    }
    const execute = value.execute
    if (input.tools.has((definition as { name: string }).name))
      throw new Error('PACKAGE_TOOL_NAME_CONFLICT')
    input.tools.register(
      {
        ...(definition as import('../services/pipeline/types').ToolDefinition),
        packageId: `package:${context.manifest.packageId}`,
        ...(context.host?.threadId ? { requiresApproval: true } : {}),
      },
      async (args, toolContext) => {
        if (
          context.host?.threadId &&
          (toolContext.threadId !== context.host.threadId ||
            toolContext.agentId !== context.host.agentId)
        )
          throw new Error('DEBUG_SCOPE_DENIED')
        if (
          context.host?.threadId &&
          (toolContext.realmId ||
            toolContext.taskId ||
            (toolContext.capabilityScope && toolContext.capabilityScope !== 'default'))
        )
          throw new Error('DEBUG_SCOPE_DENIED')
        const signal = context.host
          ? AbortSignal.any([
              context.host.signal,
              ...(toolContext.signal ? [toolContext.signal] : []),
            ])
          : toolContext.signal
        signal?.throwIfAborted()
        const result = await execute(args, { ...toolContext, signal })
        if (typeof result === 'string') return result
        if (result && typeof result === 'object' && 'success' in result) {
          const legacy = result as { success: boolean; data?: unknown; error?: string }
          return JSON.stringify(
            legacy.success
              ? { success: true, data: legacy.data }
              : { error: legacy.error ?? '工具执行失败' },
          )
        }
        return result
      },
      context.host?.threadId ? ['desktop'] : undefined,
      context.host?.threadId
        ? { runtimeScope: { threadId: context.host.threadId, agentId: context.host.agentId! } }
        : undefined,
    )
    return () => {
      input.tools.unregister((definition as { name: string }).name)
    }
  })

  input.runtime.registerActivator('skill', (context) => {
    if (!context.rootDir) throw new Error(`Skill Contribution 缺少 Package 根目录`)
    const dir = path.resolve(context.rootDir, context.contribution.entry ?? 'skills')
    if (context.contribution.metadata?.optional && !existsSync(dir)) return
    context.host?.onDispose(() => input.skills.removeDirs([dir]))
    input.skills.addDirs([dir])
    return () => input.skills.removeDirs([dir])
  })

  input.runtime.registerActivator('event-subscriber', async (context) => {
    const module = await loadModule<SubscriberModule>(context)
    const value = module.default ?? module
    if (value.hooks && input.hooks) {
      if (
        Object.entries(value.hooks).some(
          ([event, handler]) =>
            !PACKAGE_INTERCEPT_EVENTS.includes(event as PackageInterceptEvent) ||
            typeof handler !== 'function',
        )
      )
        throw new Error('PACKAGE_HOOK_INVALID')
      const removers = Object.entries(value.hooks).map(([event, handler]) =>
        input.hooks!.register(
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
      return () => removers.reverse().forEach((remove) => remove())
    }
    if (typeof value.onEvent !== 'function') {
      throw new Error(`Event Subscriber 无 onEvent: ${context.contribution.id}`)
    }
    const unsubscribe = input.events.subscribe(async (event) => {
      const payload = event.payload as {
        threadId?: string
        agentId?: string
        descriptor?: { threadId?: string }
      } | null
      if (
        context.host?.threadId &&
        (payload?.threadId ?? payload?.descriptor?.threadId) !== context.host.threadId
      )
        return
      try {
        await packageTimeout(Promise.resolve(value.onEvent!(structuredClone(event))))
      } catch (error) {
        input.hooks?.recordFailure(context.manifest.packageId, 'kernel:event', error)
      }
    })
    return () => {
      unsubscribe()
    }
  })

  input.runtime.registerActivator('service', async (context) => {
    if (!context.contribution.entry) return
    if (!context.rootDir) throw new Error(`Service Contribution 缺少 Package 根目录`)
    const processId = `${context.manifest.packageId}/${context.contribution.id}`
    // 启动阶段失败也要释放已拉起的进程，不能等到启动成功后才登记清理。
    context.host?.onDispose(() => input.processes.stop(processId))
    await input.processes.start({
      processId,
      packageId: context.manifest.packageId,
      entry: context.contribution.entry,
      cwd: context.rootDir,
      env: context.host?.dataDirectory
        ? { INFOS_PACKAGE_DATA_DIR: context.host.dataDirectory }
        : undefined,
    })
    return () => input.processes.stop(processId)
  })

  input.runtime.registerActivator('capability-provider', async (context) => {
    if (!context.contribution.entry) {
      return input.activateBuiltinProvider?.(context)
    }
    if (!input.capabilities) return
    const module = await loadModule<ProviderModule>(context)
    const value = module.default ?? module
    if (!value.definition || !value.offer || !value.invoke) {
      throw new Error(`Capability Provider 入口不完整: ${context.contribution.id}`)
    }
    const removeDefinition = input.capabilities.registerDefinition(value.definition)
    try {
      const removeProvider = input.capabilities.registerProvider(value.offer, value.invoke)
      return async () => {
        removeProvider()
        removeDefinition()
      }
    } catch (error) {
      removeDefinition()
      throw error
    }
  })

  input.runtime.registerActivator('runtime-adapter', (context) => {
    throw new Error(`PACKAGE_CONTRIBUTION_UNSUPPORTED: runtime-adapter/${context.contribution.id}`)
  })

  const unsupportedKinds: PackageContributionKind[] = ['application', 'policy']
  for (const kind of unsupportedKinds) {
    input.runtime.registerActivator(kind, (context) => {
      throw new Error(`PACKAGE_CONTRIBUTION_UNSUPPORTED: ${kind}/${context.contribution.id}`)
    })
  }
}
