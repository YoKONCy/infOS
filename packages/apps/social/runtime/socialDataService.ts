import { t as __t } from './i18n'
import { projectSocialSurface } from './socialSurfaceProjection'
import type { SocialStoragePort, SocialStorageScope } from '@infos/shared'
import { invalidatePromptReplay } from '@infos/backend/applicationHostAbi'

export interface SocialDataServiceDeps {
  storage: SocialStoragePort
  getAgentName(agentId: string): string | undefined
  cancelTasks?(agentId: string, scope?: SocialStorageScope): void
  getPlatforms?(): string[]
}

/** Social隐私数据清理用例层；统一处理Tombstone与跨存储删除。 */
export class SocialDataService {
  constructor(private readonly deps: SocialDataServiceDeps) {}

  listContacts(agentId: string) {
    return this.deps.storage.listContactImpressions(agentId)
  }

  project(agentId: string) {
    return projectSocialSurface(this.deps.storage, agentId)
  }

  async clear(input: Record<string, unknown>) {
    const agentId = String(input.agentId ?? '')
    const scope = String(input.scope ?? '')
    const agentName = this.deps.getAgentName(agentId)
    if (!agentName) return { error: __t('apps.social.ui', '目标 Agent 不存在') }
    const platforms = this.deps.getPlatforms?.() ?? []
    const platform =
      typeof input.platform === 'string'
        ? /^[a-z][a-z0-9_-]{0,63}$/.test(input.platform)
          ? input.platform
          : undefined
        : platforms.length === 1
          ? platforms[0]
          : undefined
    if (scope === 'channel') {
      const channelType = String(input.channelType ?? '')
      const channelId = String(input.channelId ?? '')
      const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
      if (
        !platform ||
        !accountId ||
        accountId.length > 200 ||
        // eslint-disable-next-line no-control-regex -- 显式拦截控制字符，防止标识或路径混入不可见内容。
        /[\u0000-\u001f]/.test(accountId) ||
        !['private', 'group'].includes(channelType) ||
        !channelId ||
        channelId.length > 200
      ) {
        return { error: __t('apps.social.ui', '请明确指定平台、账号、会话类型和会话标识') }
      }
      const address = { platform, accountId, channelType, channelId }
      this.deps.cancelTasks?.(agentId, address)
      invalidatePromptReplay('social:')
      await this.deps.storage.deleteTurns(agentId, channelType, channelId, address)
      await this.deps.storage.upsertTombstone({
        agentId,
        platform,
        accountId,
        channelType,
        channelId,
        deletedBefore: Math.floor(Date.now() / 1000),
      })
      return {
        message: __t('apps.social.ui', '会话记录已清除'),
        data: {
          deleted: await this.deps.storage.deleteChannelMessages(
            agentId,
            channelType,
            channelId,
            address,
          ),
        },
      }
    }
    if (scope === 'contact_impression') {
      const userId = String(input.userId ?? '')
      if (!platform || !userId) return { error: __t('apps.social.ui', '缺少用户 ID') }
      await this.deps.storage.deleteContactImpression(agentId, platform, userId)
      invalidatePromptReplay('social:')
      return { message: __t('apps.social.ui', '联系人印象已清除') }
    }
    if (String(input.confirmAgentName ?? '') !== agentName) {
      return { precondition: __t('apps.social.ui', '请输入角色名“{0}”确认', [agentName]) }
    }
    if (scope === 'all_messages' || scope === 'all_social_data') {
      invalidatePromptReplay('social:')
      this.deps.cancelTasks?.(agentId)
      await this.deps.storage.deleteTurns(agentId)
      await this.deps.storage.upsertTombstone({
        agentId,
        platform: '*',
        deletedBefore: Math.floor(Date.now() / 1000),
      })
      const messages = await this.deps.storage.deleteAllMessages(agentId)
      if (scope === 'all_messages')
        return { message: __t('apps.social.ui', '全部社交消息已清除'), data: { deleted: messages } }
      const impressions = await this.deps.storage.deleteAllContactImpressions(agentId)
      await this.deps.storage.deleteLongMemory(agentId)
      return {
        message: __t('apps.social.ui', '全部社交数据已清除'),
        data: { messages, impressions },
      }
    }
    if (scope === 'long_memory') {
      invalidatePromptReplay('social:')
      this.deps.cancelTasks?.(agentId)
      await this.deps.storage.deleteLongMemory(agentId)
      return { message: __t('apps.social.ui', '全部社交长记忆已清除') }
    }
    return { error: __t('apps.social.ui', '未知清理范围') }
  }
}
