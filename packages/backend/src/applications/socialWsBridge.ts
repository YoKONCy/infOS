/**
 * SocialWsBridge — 社交 WebSocket 适配器全局注册表
 *
 * 注册表由 Daemon 持有，Social runtime 通过 AppRuntimeContext 注入的函数注册。
 * 禁止 Social runtime 直接导入注册函数：独立打包会复制模块状态。
 * - SocialAppRuntime 在 initialize 后调用 registerSocialTransport 注册适配器
 * - wsUpgrade.ts 通过 getSocialTransport 获取平台端口
 *
 * @module packages/backend/src/applications/socialWsBridge
 */

/** WebSocket 宿主只依赖传输接口，不能依赖另一个 bundle 内的运行时单例。 */
export interface SocialWsSender {
  send(data: string): void | Promise<void>
  close(): void
}

export interface SocialWebSocketAdapterPort {
  /** 由平台声明其账号握手头，宿主不解释协议。 */
  accountHeader?: string
  registerConnection(selfId: string | undefined, sender: SocialWsSender): void
  unregisterConnection(selfId: string | undefined, sender?: SocialWsSender): void
  handleRawEvent(data: string): Promise<void>
}

/** 按平台隔离的传输注册表（由 SocialAppRuntime 注入） */
const transports = new Map<string, SocialWebSocketAdapterPort>()

export function registerSocialTransport(
  adapter: SocialWebSocketAdapterPort,
  platform = 'default',
): () => void {
  if (transports.has(platform)) throw new Error('SOCIAL_TRANSPORT_DUPLICATE')
  transports.set(platform, adapter)
  return () => {
    if (transports.get(platform) === adapter) transports.delete(platform)
  }
}

export function getSocialTransport(platform?: string): SocialWebSocketAdapterPort | null {
  return (
    (platform
      ? transports.get(platform)
      : transports.size === 1
        ? transports.values().next().value
        : undefined) ?? null
  )
}

/** 创建一次由宿主持有的适配器注册，返回只释放本次注册的函数。 */
export function registerSocialNapcatAdapter(adapter: SocialWebSocketAdapterPort): () => void {
  // 兼容旧宿主调用名称；新装配统一通过平台注册入口。
  transports.set('qq', adapter)
  return () => {
    if (transports.get('qq') === adapter) transports.delete('qq')
  }
}

/** 获取当前注册的社交 NapCat 适配器 */
export function getSocialNapcatAdapter(): SocialWebSocketAdapterPort | null {
  return getSocialTransport('qq')
}

/**
 * 创建 WsSender 包装器
 *
 * 将运行时特定的 WebSocket 实例包装为统一的 WsSender 接口。
 */
export function createWsSender(ws: { send: (data: string) => void; close: () => void }) {
  return {
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
  }
}
