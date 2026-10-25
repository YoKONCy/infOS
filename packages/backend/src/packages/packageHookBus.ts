import type {
  PackageInterceptEvent,
  PackageInterceptor,
  PackageInterceptorContext,
} from './packageInterceptor'
import { PACKAGE_INTERCEPT_EVENTS } from '@infos/shared'
import { createLogger } from '../lib/logger'

interface HookEntry {
  packageId: string
  handler: PackageInterceptor
}

/** Package Policy/Event Contribution 的类型化兼容总线。 */
export class PackageHookBus {
  private readonly hooks = new Map<PackageInterceptEvent, HookEntry[]>()
  readonly failures: Array<{ packageId: string; event: string; error: string }> = []
  constructor(private readonly timeoutMs = 3000) {}
  recordFailure(packageId: string, event: string, error: unknown): void {
    this.failures.push({ packageId, event, error: String(error).slice(-4000) })
    if (this.failures.length > 50) this.failures.shift()
  }

  register(
    packageId: string,
    event: PackageInterceptEvent,
    handler: PackageInterceptor,
  ): () => void {
    if (!PACKAGE_INTERCEPT_EVENTS.includes(event) || typeof handler !== 'function')
      throw new Error('PACKAGE_HOOK_INVALID')
    const entries = this.hooks.get(event) ?? []
    const entry = { packageId, handler }
    entries.push(entry)
    this.hooks.set(event, entries)
    return () => {
      const current = this.hooks.get(event)?.filter((item) => item !== entry) ?? []
      if (current.length) this.hooks.set(event, current)
      else this.hooks.delete(event)
    }
  }

  async emitHook<T>(event: string, data: T): Promise<T> {
    const canonical =
      event === 'tool:beforeCall'
        ? 'chat:beforeToolCall'
        : event === 'tool:afterCall'
          ? 'chat:afterToolCall'
          : event
    const entries = [...(this.hooks.get(canonical as PackageInterceptEvent) ?? [])]
    if (!entries.length) return data
    let current = structuredClone(data)
    let aborted = false
    for (const entry of entries) {
      if (aborted) break
      if (!this.hooks.get(canonical as PackageInterceptEvent)?.includes(entry)) continue
      const controller = new AbortController()
      const logger = createLogger(`Package:${entry.packageId}`)
      const context: PackageInterceptorContext = {
        signal: controller.signal,
        logger: {
          info: (message, meta) => logger.info(message, meta),
          warn: (message, meta) => logger.warn(message, meta),
          error: (message, meta) => logger.error(message, meta),
        },
        abort: () => {
          aborted = true
        },
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          entry.handler(structuredClone(current), context),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error('PACKAGE_HOOK_TIMEOUT'))
            }, this.timeoutMs)
          }),
        ])
        if (
          this.hooks.get(canonical as PackageInterceptEvent)?.includes(entry) &&
          result !== undefined &&
          result !== null
        )
          current = structuredClone(result) as T
      } catch (error) {
        this.recordFailure(entry.packageId, event, error)
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    return current
  }
}
