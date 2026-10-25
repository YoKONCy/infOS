import type { AbstractSocialAdapter } from './ISocialAdapter'
import { WeixinAdapter } from './weixin/weixinAdapter'
import { TelegramAdapter } from './telegram/telegramAdapter'
import { DiscordAdapter } from './discord/discordAdapter'
import type { AdapterEnvironment } from './managedAdapter'
import { NapcatAdapter } from './napcat/napcatAdapter'

/** 此文件是内置平台的装配根；平台业务不得反向进入通用运行时。 */
export interface SocialAdapterFactory {
  type: string
  platform: string
  create(
    config: Record<string, unknown>,
    agentId: string,
    environment?: AdapterEnvironment,
  ): AbstractSocialAdapter
}

export const BUILTIN_SOCIAL_ADAPTERS: readonly SocialAdapterFactory[] = [
  {
    type: 'weixin-ilink',
    platform: 'weixin',
    create: (config, agentId, env) => new WeixinAdapter(config, agentId, env),
  },
  {
    type: 'telegram-bot',
    platform: 'telegram',
    create: (config, agentId, env) => new TelegramAdapter(config, agentId, env),
  },
  {
    type: 'discord-bot',
    platform: 'discord',
    create: (config, agentId, env) => new DiscordAdapter(config, agentId, env),
  },
  {
    type: 'napcat',
    platform: 'qq',
    create: (config, agentId) => {
      const owner = String(config.ownerId ?? config.ownerQq ?? '').trim()
      return new NapcatAdapter({
        defaultAgentId: agentId,
        autoAcceptFriend: config.autoAcceptFriend !== false,
        ownerQq: /^[1-9]\d{4,19}$/.test(owner) ? owner : undefined,
        legacyConfiguration: config.legacyConfiguration !== false,
        connectionId: typeof config.id === 'string' ? config.id : 'qq',
      })
    },
  },
]

export function createSocialAdapters(
  config: Record<string, unknown>,
  agentId: string,
  factories: readonly SocialAdapterFactory[] = BUILTIN_SOCIAL_ADAPTERS,
  environment?: AdapterEnvironment,
): AbstractSocialAdapter[] {
  return socialConnectionSpecs(config, factories).map(({ factory, connection }) => {
    const adapter = factory.create(connection, agentId, environment)
    if (adapter.platform !== factory.platform || adapter.connectionId !== connection.id)
      throw new Error('SOCIAL_CONNECTION_INVALID')
    return adapter
  })
}

/** 配置解释只发生在装配边界；运行时按平台和连接标识协调生命周期。 */
export function socialConnectionSpecs(
  config: Record<string, unknown>,
  factories: readonly SocialAdapterFactory[] = BUILTIN_SOCIAL_ADAPTERS,
): Array<{ factory: SocialAdapterFactory; connection: Record<string, unknown> }> {
  // 旧版只有顶层账号设置，在平台装配边界转换为默认连接。
  const connections = Array.isArray(config.connections)
    ? config.connections
    : [{ ...config, adapter: 'napcat', legacyConfiguration: true }]
  const platforms = new Set<string>()
  const identities = new Set<string>()
  return connections.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('SOCIAL_CONNECTION_INVALID')
    const connection = value as Record<string, unknown>
    if (connection.enabled === false) return []
    if (
      connection.id !== undefined &&
      (typeof connection.id !== 'string' || !connection.id || connection.id.length > 200)
    )
      throw new Error('SOCIAL_CONNECTION_INVALID')
    const factory = factories.find((item) => item.type === connection.adapter)
    if (!factory) throw new Error('SOCIAL_ADAPTER_UNKNOWN')
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(factory.platform))
      throw new Error('SOCIAL_CONNECTION_INVALID')
    // 一个平台网关管理其全部账号，避免同平台的重复消费者争抢入站流。
    if (platforms.has(factory.platform)) throw new Error('SOCIAL_PLATFORM_DUPLICATE')
    platforms.add(factory.platform)
    const id = typeof connection.id === 'string' && connection.id ? connection.id : factory.platform
    if (identities.has(id)) throw new Error('SOCIAL_CONNECTION_DUPLICATE')
    identities.add(id)
    return [{ factory, connection: { ...connection, id } }]
  })
}
