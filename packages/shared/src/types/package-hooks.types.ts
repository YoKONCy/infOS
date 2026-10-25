export const PACKAGE_INTERCEPT_EVENTS = [
  'chat:beforeSend',
  'chat:afterReply',
  'chat:beforeToolCall',
  'chat:afterToolCall',
  'memory:beforeCreate',
  'memory:afterCreate',
  'memory:beforeDelete',
  'memory:afterRetrieve',
  'agent:onSwitch',
  'agent:onMoodChange',
  'app:onStart',
  'app:onShutdown',
  'agent:beforeRun',
  'agent:afterRun',
  'agent:beforeRequest',
  'agent:afterRequest',
] as const
export type PackageInterceptEvent = (typeof PACKAGE_INTERCEPT_EVENTS)[number]

export interface PackageInterceptorContext {
  signal: AbortSignal
  logger: {
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
    error(message: string, meta?: Record<string, unknown>): void
  }
  /** 只停止本次钩子链传播，不代替 Execution 的取消权威。 */
  abort(reason?: string): void
}
export type PackageInterceptor<T = unknown> = (
  data: T,
  context: PackageInterceptorContext,
) => Promise<T | undefined | void>
