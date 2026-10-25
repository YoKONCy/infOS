import type { SocialBusinessTool, SocialStoragePort, SocialGroupPolicy } from '@infos/shared'
import type { ToolDefinition } from '@infos/backend/applicationHostAbi'
import type { OutboundMessage } from './types'
import { withSocialScope } from './socialStorageScope'

/** 操作现场由可信连接和回合绑定，平台模块不得自行切换其所属平台。 */
export interface SocialOperationScope {
  platform?: string
  agentId: string
  accountId?: string
  channelId: string
  channelType: 'private' | 'group'
  owner: boolean
  enableVision?: boolean
  host?: boolean
  signal?: AbortSignal
  callId: string
  threadId?: string
}

export type SocialLegacyExecutor = (name: string, args: Record<string, unknown>) => Promise<string>

/** 业务目录、平台权限校验和外部调用由各平台提供。 */
export interface SocialOperationProvider {
  actionPolicy?(
    tool: string,
    action: unknown,
  ): { mutation: boolean; ownerOnly: boolean } | undefined
  definitions(scope: SocialOperationScope): Promise<ToolDefinition[]>
  execute(
    tool: SocialBusinessTool,
    args: Record<string, unknown>,
    scope: SocialOperationScope,
    legacy?: SocialLegacyExecutor,
  ): Promise<string>
  close(): void
}

export interface SocialOperationDependencies {
  active(agentId: string): boolean
  config: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<void>
  }
  storage: SocialStoragePort
  prepareImage(source: string, scope: SocialOperationScope): Promise<string>
  send(scope: SocialOperationScope, message: OutboundMessage): Promise<unknown>
  groupState(scope: SocialOperationScope & { accountId: string }, groupId: string): unknown
  configureGroupState(
    scope: SocialOperationScope & { accountId: string },
    groupId: string,
    policy: Partial<SocialGroupPolicy>,
    reset: boolean,
  ): Promise<unknown>
  markBot(
    scope: SocialOperationScope & { accountId: string },
    input: { userId: string; messageId?: string; reason: string },
  ): Promise<unknown>
}

/** 通用入口只路由到所选平台；平台缺失或选择不明确时明确失败。 */
export class SocialOperations implements SocialOperationProvider {
  private readonly providers = new Map<string, SocialOperationProvider>()

  register(platform: string, provider: SocialOperationProvider): void {
    if (this.providers.has(platform)) throw new Error('SOCIAL_OPERATION_PROVIDER_DUPLICATE')
    this.providers.set(platform, provider)
  }

  unregister(platform: string): void {
    this.providers.get(platform)?.close()
    this.providers.delete(platform)
  }

  private resolve(scope: SocialOperationScope): SocialOperationProvider {
    if (!scope.platform && this.providers.size === 1)
      scope.platform = this.providers.keys().next().value
    const provider = scope.platform
      ? this.providers.get(scope.platform)
      : this.providers.size === 1
        ? this.providers.values().next().value
        : undefined
    if (!provider) throw new Error('SOCIAL_PLATFORM_REQUIRED')
    scope.signal?.throwIfAborted()
    return provider
  }

  async definitions(scope: SocialOperationScope): Promise<ToolDefinition[]> {
    if (scope.platform || this.providers.size === 1) {
      const provider = this.resolve(scope)
      return withSocialScope(scope, () => provider.definitions(scope))
    }
    return []
  }

  isReadOnly(scope: SocialOperationScope, tool: string, args: Record<string, unknown>): boolean {
    return this.resolve(scope).actionPolicy?.(tool, args.action)?.mutation === false
  }

  execute(
    tool: SocialBusinessTool,
    args: Record<string, unknown>,
    scope: SocialOperationScope,
    legacy?: SocialLegacyExecutor,
  ): Promise<string> {
    const provider = this.resolve(scope)
    return withSocialScope(
      {
        platform: scope.platform,
        accountId:
          scope.owner && typeof args.account_id === 'string' ? args.account_id : scope.accountId,
        channelType: scope.channelType,
        channelId: scope.channelId,
      },
      () => provider.execute(tool, args, scope, legacy),
    )
  }

  close(): void {
    for (const provider of this.providers.values()) provider.close()
    this.providers.clear()
  }
}
