/** 插件工厂获得的作用域；不包含 AppContext 或内核服务对象。 */
export interface PackageHostContext {
  /** 调试贡献按当前 Thread 与 Agent 收窄。 */
  threadId?: string
  agentId?: string
  packageId: string
  contributionId: string
  dataDirectory?: string
  signal: AbortSignal
  onDispose(cleanup: () => void | Promise<void>): void
}
