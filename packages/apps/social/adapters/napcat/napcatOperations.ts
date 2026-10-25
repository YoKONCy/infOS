import { NAPCAT_ACTIONS } from './napcatActions'
import { t as __t } from '../../runtime/i18n'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile, stat } from 'node:fs/promises'
import {
  SOCIAL_BUSINESS_TOOLS,
  socialToolDefinition,
  validateSocialInput,
  type SocialActionDefinition,
  type SocialBusinessTool,
} from '@infos/shared'
import type { NapcatAdapter } from './napcatAdapter'
import { QzoneClient } from './qzoneClient'
import type { SocialStoragePort } from '@infos/shared'
import type { OutboundMessage } from '../../runtime/types'
import { currentSocialRecovery, socialFailure } from '../../runtime/socialRecovery'
import { NativeEmojiService } from './nativeEmoji'
import { cleanCQCodes, segmentsToCQString, type OneBotSegment } from './napcatParser'
import { createLogger, safeModelDiagnostic } from '@infos/backend/applicationHostAbi'

const logger = createLogger('SocialOperations')

import type { SocialOperationScope } from '../../runtime/socialOperations'
export type { SocialOperationScope } from '../../runtime/socialOperations'
interface ConfigPort {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}
interface JournalEntry {
  id: string
  fingerprint?: string
  action: string
  summary?: Record<string, unknown>
  status: 'pending' | 'done' | 'failed' | 'uncertain'
  createdAt: string
  result?: unknown
  error?: { code?: string; message: string; stage?: string }
}
interface PublishedPost {
  tid: string
  content: string
  visibility: string
  createdAt: string
  deletedAt?: string
}
type LegacyExecutor = (name: string, args: Record<string, unknown>) => Promise<string>
interface Dependencies {
  adapter(): NapcatAdapter | undefined
  active(agentId: string): boolean
  config: ConfigPort
  storage: SocialStoragePort
  prepareImage(source: string, scope: SocialOperationScope): Promise<string>
  send?(scope: SocialOperationScope, message: OutboundMessage): Promise<unknown>
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
const keyOrder = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  )
const platformError = (value: unknown) =>
  String(value)
    .replace(/base64:\/\/[A-Za-z0-9+/=\s]+/g, '[图片数据]')
    .slice(0, 500)

type GroupRole = 'member' | 'admin' | 'owner'
const roleLevel: Record<GroupRole, number> = { member: 0, admin: 1, owner: 2 }
const permissionDenied = (message: string) =>
  /权限不足|权限不够|没有(?:群管理|管理)?权限|无(?:群管理|管理)?权限|无权|不是.*(?:管理员|群主)|非管理员|仅.*群主|需要.*(?:管理员|群主)|ERR_NOT_GROUP_(?:ADMIN|OWNER)|permission denied|insufficient permissions?|not (?:an? |the )?(?:group )?(?:admin|owner)|cannot (?:ban|kick) (?:admin|owner)/i.test(
    message,
  )
const groupFailure = (message: string, unavailable = false) =>
  Object.assign(new Error(message), {
    rejected: true,
    code: unavailable ? 'GROUP_PERMISSION_UNAVAILABLE' : 'GROUP_PERMISSION_DENIED',
  })

/** 统一校验 OneBot 信封和 QQ 业务结果，不能把失败响应当作成功。 */
export function unwrapNapcatResponse(raw: unknown): unknown {
  const envelope = object(raw)
  if (envelope.status !== 'ok' || envelope.retcode !== 0) {
    const message = platformError(envelope.message || envelope.wording || 'NapCat 拒绝了操作')
    throw Object.assign(new Error(message), {
      rejected: envelope.retcode === 1400 || permissionDenied(message),
      permissionDenied: permissionDenied(message),
    })
  }
  const result = object(envelope.data)
  const failure =
    result.ok === false ||
    result.valid === false ||
    result.success === false ||
    (typeof result.result === 'number' && result.result !== 0) ||
    (typeof result.retCode === 'number' && result.retCode !== 0) ||
    (typeof result.retcode === 'number' && result.retcode !== 0) ||
    (typeof result.code === 'number' && result.code !== 0) ||
    (typeof envelope.data === 'number' && envelope.data !== 0)
  if (failure) {
    const message = platformError(result.errMsg || result.message || result.msg || 'QQ 拒绝了操作')
    throw Object.assign(new Error(message), {
      rejected: true,
      permissionDenied: permissionDenied(message),
    })
  }
  return envelope.data
}

const NATIVE: Record<string, string> = {
  contacts_list: 'get_friend_list',
  contact_get: 'get_stranger_info',
  contact_remark: 'set_friend_remark',
  contact_remove: 'delete_friend',
  friend_request: 'set_friend_add_request',
  poke: 'send_poke',
  profile_like: 'send_like',
  message_react: 'set_msg_emoji_like',
  message_recall: 'delete_msg',
  forward_read: 'get_forward_msg',
  list: 'get_group_list',
  info: 'get_group_info',
  members: 'get_group_member_list',
  member_get: 'get_group_member_info',
  card_set: 'set_group_card',
  name_set: 'set_group_name',
  portrait_set: 'set_group_portrait',
  ban: 'set_group_ban',
  whole_ban: 'set_group_whole_ban',
  kick: 'set_group_kick',
  admin_set: 'set_group_admin',
  title_set: 'set_group_special_title',
  requests: 'get_group_system_msg',
  request_handle: 'set_group_add_request',
  leave: 'set_group_leave',
  notices: '_get_group_notice',
  notice_publish: '_send_group_notice',
  notice_delete: '_del_group_notice',
  essence_list: 'get_essence_msg_list',
  essence_set: 'set_essence_msg',
  essence_remove: 'delete_essence_msg',
  file_url: 'get_group_file_url',
  file_delete: 'delete_group_file',
  folder_create: 'create_group_file_folder',
  folder_delete: 'delete_group_folder',
  file_rename: 'rename_group_file',
  albums: 'get_qun_album_list',
  album_media: 'get_group_album_media_list',
  album_upload: 'upload_images_to_qun_album',
  album_comment: 'do_group_album_comment',
  album_like: 'set_group_album_media_like',
  album_delete: 'del_group_album_media',
  profile_get: 'get_stranger_info',
  profile_update: 'set_qq_profile',
  signature_set: 'set_self_longnick',
  avatar_set: 'set_qq_avatar',
  status_set: 'set_online_status',
  status_custom: 'set_diy_online_status',
  qzone_publish: 'send_qzone_msg',
  qzone_delete: 'delete_qzone_msg',
}

export class NapcatOperations {
  private writes = new AsyncLocalStorage<{ submitted: boolean }>()
  private qzone = new QzoneClient()
  private caps = new Map<string, { expires: number; packet: boolean; qzone: boolean }>()
  private queues = new Map<string, Promise<unknown>>()
  private groupVisibility = new Map<string, { expires: number; roles: Map<string, GroupRole> }>()
  private closed = false
  constructor(private readonly deps: Dependencies) {}

  close(): void {
    this.closed = true
    this.caps.clear()
    this.groupVisibility.clear()
    this.qzone.clear()
  }

  private adapter(scope: SocialOperationScope, accountId: string): NapcatAdapter {
    scope.signal?.throwIfAborted()
    const adapter = this.deps.adapter()
    if (
      this.closed ||
      !this.deps.active(scope.agentId) ||
      !adapter?.getConnectedAccountIds().includes(accountId)
    )
      throw new Error('社交应用已停止、角色已变化或 QQ 账号未连接')
    return adapter
  }

  private resolveAccount(scope: SocialOperationScope, requested?: unknown) {
    if (
      requested !== undefined &&
      (typeof requested !== 'string' || !/^[1-9]\d{4,19}$/.test(requested))
    )
      throw new Error('account_id 格式不正确')
    if (requested && requested !== scope.accountId && !scope.owner)
      throw new Error('只有主人可以指定其他 QQ 账号')
    const ids = this.deps.adapter()?.getConnectedAccountIds() ?? []
    const accountId = String(
      requested || scope.accountId || (scope.host && ids.length === 1 ? ids[0] : ''),
    )
    if (!accountId) throw new Error('请明确指定已连接的 account_id')
    this.adapter(scope, accountId)
    return accountId
  }

  private async invoke(
    scope: SocialOperationScope,
    accountId: string,
    action: string,
    input: Record<string, unknown>,
    timeout = 15_000,
  ) {
    const adapter = this.adapter(scope, accountId)
    const writing =
      NAPCAT_ACTIONS.some((item) => item.mutation && NATIVE[item.action] === action) ||
      ['mark_group_msg_as_read', 'mark_private_msg_as_read'].includes(action)
    if (writing && this.writes.getStore()) this.writes.getStore()!.submitted = true
    return unwrapNapcatResponse(
      await adapter.callApi(action, input, timeout, accountId, scope.signal),
    )
  }

  private async features(scope: SocialOperationScope, accountId: string) {
    const cached = this.caps.get(accountId)
    if (cached && cached.expires > Date.now()) return cached
    const [version, packet] = await Promise.allSettled([
      this.invoke(scope, accountId, 'get_version_info', {}, 3000),
      this.invoke(scope, accountId, 'nc_get_packet_status', {}, 3000),
    ])
    const info = version.status === 'fulfilled' ? object(version.value) : {}
    const number = String(info.app_version ?? info.version ?? '')
      .match(/(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number)
    const [major = 0, minor = 0, patch = 0] = number ?? []
    const qzone = major > 4 || (major === 4 && (minor > 18 || (minor === 18 && patch >= 38)))
    const result = { expires: Date.now() + 60_000, packet: packet.status === 'fulfilled', qzone }
    this.caps.set(accountId, result)
    return result
  }

  private async memberRole(
    scope: SocialOperationScope,
    accountId: string,
    groupId: string,
    userId = accountId,
  ): Promise<GroupRole> {
    try {
      const member = object(
        await this.invoke(
          scope,
          accountId,
          'get_group_member_info',
          { group_id: groupId, user_id: userId, no_cache: true },
          5000,
        ),
      )
      if (
        String(member.group_id) !== groupId ||
        String(member.user_id) !== userId ||
        !['member', 'admin', 'owner'].includes(String(member.role))
      )
        throw new Error('群成员身份无效')
      return member.role as GroupRole
    } catch {
      scope.signal?.throwIfAborted()
      throw groupFailure(`无法确认 QQ ${userId} 在群 ${groupId} 的身份，本次操作未执行`, true)
    }
  }

  /** 展示权限短暂缓存；执行阶段始终绕过缓存重新查询。 */
  private async visibleGroupRoles(scope: SocialOperationScope, accountId: string) {
    const currentGroup = scope.channelType === 'group' ? scope.channelId : undefined
    const key = `${accountId}:${currentGroup ?? '*'}`
    this.adapter(scope, accountId)
    const cached = this.groupVisibility.get(key)
    if (cached && cached.expires > Date.now()) return cached.roles
    const roles = new Map<string, GroupRole>()
    const discoveryScope = {
      ...scope,
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(scope.signal ? [scope.signal] : [])]),
    }
    try {
      const groups = currentGroup
        ? [{ group_id: currentGroup }]
        : await this.invoke(discoveryScope, accountId, 'get_group_list', { no_cache: true }, 5000)
      if (!Array.isArray(groups)) return roles
      const ids = [...new Set(groups.map((group) => String(object(group).group_id)))].filter((id) =>
        /^[1-9]\d{4,19}$/.test(id),
      )
      let cursor = 0
      // 限制查询并发，避免群较多时瞬间向 NapCat 发出大量请求。
      await Promise.all(
        Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (cursor < ids.length && !discoveryScope.signal.aborted) {
            const id = ids[cursor++]!
            try {
              roles.set(id, await this.memberRole(discoveryScope, accountId, id))
            } catch {
              scope.signal?.throwIfAborted()
            }
          }
        }),
      )
      this.adapter(scope, accountId)
      this.groupVisibility.set(key, { expires: Date.now() + 10_000, roles })
    } catch {
      scope.signal?.throwIfAborted()
    }
    return roles
  }

  private async authorizeGroup(
    definition: SocialActionDefinition,
    input: Record<string, unknown>,
    scope: SocialOperationScope,
    accountId: string,
  ): Promise<void> {
    if (definition.action === 'message_recall') {
      const row = await this.deps.storage.getByMsgId(scope.agentId, String(input.message_id))
      if (!row || row.platform !== 'qq' || row.accountId !== accountId)
        throw groupFailure('消息不属于当前 QQ 账号，未执行撤回')
      if (row.channelType === 'group' && ![accountId, 'self'].includes(row.senderId))
        return this.authorizeGroup(
          { ...definition, action: 'recall_other', groupRole: 'admin' },
          { group_id: row.channelId, user_id: row.senderId },
          scope,
          accountId,
        )
    }
    let required = definition.groupRole
    const otherCard =
      definition.action === 'card_set' && input.user_id && input.user_id !== accountId
    if (otherCard) required = 'admin'
    if (definition.action === 'leave' && input.is_dismiss === true) required = 'owner'
    if (!required) return
    const groupId = String(input.group_id)
    const ownRole = await this.memberRole(scope, accountId, groupId)
    if (roleLevel[ownRole] < roleLevel[required]) {
      this.groupVisibility.clear()
      throw groupFailure(
        `QQ ${accountId} 在群 ${groupId} ${required === 'owner' ? '不是群主' : '没有管理员权限'}，无法${definition.description}`,
      )
    }
    if (
      input.user_id &&
      ['ban', 'kick', 'admin_set', 'card_set', 'recall_other'].includes(definition.action)
    ) {
      const userId = String(input.user_id)
      if (userId === accountId && definition.action !== 'card_set')
        throw groupFailure('不能对机器人自己执行禁言、移除成员或设置管理员操作')
      const targetRole = await this.memberRole(scope, accountId, groupId, userId)
      if (roleLevel[targetRole] >= roleLevel[ownRole] && userId !== accountId)
        throw groupFailure('不能管理同级或更高身份的群成员')
    }
  }

  actionPolicy(tool: string, action: unknown) {
    return NAPCAT_ACTIONS.find((item) => item.tool === tool && item.action === action)
  }

  async definitions(scope: SocialOperationScope) {
    let features = { packet: false, qzone: false }
    const accounts = this.deps.adapter()?.getConnectedAccountIds() ?? []
    try {
      features = await this.features(
        scope,
        this.resolveAccount(scope, scope.host && !scope.accountId ? accounts[0] : undefined),
      )
    } catch {
      return []
    }
    const visibleAccounts =
      scope.owner && scope.host && !scope.accountId ? accounts : [this.resolveAccount(scope)]
    const groupRoles = scope.owner
      ? await Promise.all(
          visibleAccounts.map(async (accountId) => ({
            accountId,
            roles: await this.visibleGroupRoles(scope, accountId),
          })),
        )
      : []
    const permittedGroups = (required: 'admin' | 'owner') =>
      [
        ...new Set(
          groupRoles.flatMap(({ roles }) =>
            [...roles]
              .filter(([, role]) => roleLevel[role] >= roleLevel[required])
              .map(([id]) => id),
          ),
        ),
      ].sort()
    return SOCIAL_BUSINESS_TOOLS.flatMap((tool) => {
      const available = NAPCAT_ACTIONS.filter(
        (item) =>
          item.tool === tool &&
          (scope.enableVision !== false || !['image_read', 'sticker_read'].includes(item.action)) &&
          (!item.ownerOnly || scope.owner) &&
          (!item.groupRole || permittedGroups(item.groupRole).length > 0) &&
          (!item.feature ||
            item.feature === 'stickers' ||
            features[item.feature as 'qzone' | 'packet']),
      ).filter(
        (item) =>
          scope.owner ||
          !['contacts_list', 'list', 'diary_list', 'diary_read'].includes(item.action),
      )
      if (!available.length) return []
      const definition = socialToolDefinition(
        tool,
        available.map((item) => {
          const properties = item.parameters.properties as Record<string, unknown>
          if (item.groupRole)
            return {
              ...item,
              parameters: {
                ...item.parameters,
                properties: {
                  ...properties,
                  group_id: {
                    ...(properties.group_id as object),
                    enum: permittedGroups(item.groupRole),
                  },
                },
              },
            }
          if (item.action === 'leave' && !permittedGroups('owner').length)
            return {
              ...item,
              parameters: {
                ...item.parameters,
                properties: { ...properties, is_dismiss: { type: 'boolean', enum: [false] } },
              },
            }
          if (item.action === 'card_set' && !permittedGroups('admin').length)
            return {
              ...item,
              parameters: {
                ...item.parameters,
                properties: {
                  ...properties,
                  user_id: {
                    ...(properties.user_id as object),
                    enum: visibleAccounts,
                  },
                },
              },
            }
          return item
        }),
      )
      if (tool === 'social_group' && scope.owner) {
        const hints = groupRoles.flatMap(({ accountId, roles }) =>
          [...roles]
            .filter(([, role]) => role !== 'member')
            .map(
              ([id, role]) =>
                `QQ ${accountId}：群 ${id}（${role === 'owner' ? '群主' : '管理员'}）`,
            ),
        )
        definition.description += hints.length
          ? `\n可管理范围：${hints.sort().join('；')}。执行时会重新校验权限。`
          : '\n当前没有已确认的群管理权限；仅开放普通群操作。'
      }
      if (scope.host) {
        definition.description += `\n已连接账号：${accounts.join('、')}。${accounts.length > 1 ? '有多个账号，必须指定 account_id。' : ''}`
        if (tool === 'social')
          definition.description +=
            '\n从主应用调用 send_resource 或 status_card_send 时，发送到已绑定主人的 QQ 私聊。'
        if (accounts.length > 1) (definition.parameters.required as string[]).push('account_id')
      }
      const { actionPermissions: _permissions, ...wire } = definition
      return [{ type: 'function' as const, function: wire }]
    })
  }

  private async authorize(
    definition: SocialActionDefinition,
    input: Record<string, unknown>,
    scope: SocialOperationScope,
    accountId: string,
  ) {
    if (scope.enableVision === false && ['image_read', 'sticker_read'].includes(definition.action))
      throw new Error('当前角色模型未开启视觉能力，无法查看图片内容')
    if (definition.ownerOnly && !scope.owner) throw new Error('此操作仅对主人开放')
    if (!scope.owner) {
      if (['contacts_list', 'list'].includes(definition.action))
        throw new Error('仅主人可以查看完整联系人或群列表')
      if (definition.tool === 'social_group' || input.group_id) {
        if (scope.channelType !== 'group' || input.group_id !== scope.channelId)
          throw new Error('只能操作当前群聊')
      }
      if (
        ['history_get', 'mark_read', 'message_send'].includes(definition.action) &&
        (input.channel_id !== scope.channelId || input.channel_type !== scope.channelType)
      )
        throw new Error('只能读取或操作当前会话')
      if (definition.action === 'contact_history' && scope.channelType !== 'private')
        throw new Error('跨会话历史仅对主人开放')
      if (definition.action === 'contact_history' && input.user_id !== scope.channelId)
        throw new Error('只能回顾当前私聊对象')
      if (definition.action === 'card_set' && input.user_id && input.user_id !== accountId)
        throw new Error('只能修改自己的群名片')
      if (
        definition.action === 'poke' &&
        scope.channelType === 'private' &&
        input.user_id !== scope.channelId
      )
        throw new Error('只能戳当前私聊对象')
    }
    if (
      input.message_id &&
      ['message_react', 'message_recall', 'essence_set', 'essence_remove'].includes(
        definition.action,
      )
    ) {
      const row = await this.deps.storage.getByMsgId(scope.agentId, String(input.message_id))
      if (
        !row ||
        row.platform !== 'qq' ||
        row.accountId !== accountId ||
        (!scope.owner &&
          (row.channelId !== scope.channelId || row.channelType !== scope.channelType)) ||
        (input.group_id && (row.channelType !== 'group' || row.channelId !== input.group_id))
      )
        throw new Error('消息不属于当前账号或指定会话')
    }
    if (definition.action === 'image_read')
      for (const messageId of input.message_ids as string[]) {
        const row = await this.deps.storage.getByMsgId(scope.agentId, messageId, accountId)
        if (
          !row ||
          row.accountId !== accountId ||
          (!scope.owner &&
            (row.channelId !== scope.channelId || row.channelType !== scope.channelType))
        )
          throw new Error('图片不属于当前账号或会话')
      }
  }

  async execute(
    tool: SocialBusinessTool,
    args: Record<string, unknown>,
    scope: SocialOperationScope,
    legacy?: LegacyExecutor,
  ): Promise<string> {
    try {
      if (Object.keys(args).some((key) => !['action', 'input', 'account_id'].includes(key)))
        throw new Error('工具仅接受 action、input 和 account_id')
      const definition = NAPCAT_ACTIONS.find(
        (item) => item.tool === tool && item.action === args.action,
      )
      if (!definition) throw new Error('未知社交操作')
      validateSocialInput(definition.parameters, args.input)
      const input = args.input as Record<string, unknown>
      const accountId = this.resolveAccount(scope, args.account_id)
      if (definition.legacy && !scope.host && accountId !== scope.accountId)
        throw new Error('此操作只能使用当前会话账号')
      await this.authorize(definition, input, scope, accountId)
      if (
        definition.feature &&
        definition.feature !== 'stickers' &&
        !(await this.features(scope, accountId))[definition.feature as 'qzone' | 'packet']
      )
        throw new Error('当前 NapCat 版本或底层能力不支持此操作')
      const run = async () => {
        scope.signal?.throwIfAborted()
        await this.authorizeGroup(definition, input, scope, accountId)
        try {
          return await this.dispatch(definition, input, { ...scope, accountId }, legacy)
        } catch (error) {
          if (tool === 'social_group' && object(error).permissionDenied) {
            this.groupVisibility.clear()
            throw groupFailure(`平台拒绝群管理操作：${(error as Error).message}`)
          }
          throw error
        }
      }
      const result =
        definition.mutation && definition.action !== 'operation_resolve'
          ? await this.mutate(definition, input, scope, accountId, run)
          : await run()
      // 图片必须留在顶层，编译器才能提取为多模态内容。
      const data = object(result)
      return JSON.stringify({
        success: true,
        account_id: accountId,
        action: definition.action,
        ...(data.success !== undefined || Array.isArray(data.images) ? data : { data: result }),
      })
    } catch (error) {
      const detail = error as {
        uncertain?: boolean
        operationId?: string
        code?: string
        rejected?: boolean
        stage?: string
      }
      const input = object(args.input)
      const source = Object.fromEntries(
        ['message_id', 'image_index', 'sticker_id', 'reference', 'user_id']
          .filter((key) => input[key] !== undefined)
          .map((key) => [
            key,
            typeof input[key] === 'string' ? String(input[key]).slice(0, 200) : input[key],
          ]),
      )
      logger.warn(__t('apps.social.logs', '社交业务操作未完成'), {
        action: args.action,
        accountId: scope.accountId,
        channelId: scope.channelId,
        code: detail.code,
        stage: detail.stage,
        uncertain: detail.uncertain === true,
        source,
        reason: safeModelDiagnostic(error instanceof Error ? error.message : String(error), 500),
      })
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: socialFailure(error).retryable,
        code: detail.code,
        rejected: detail.rejected === true || !detail.uncertain,
        stage: detail.stage,
        source,
        ...(detail.uncertain
          ? {
              uncertain: true,
              operation_id: detail.operationId,
              hint: __t('apps.social.ui', '先查询实际结果，确认前不要重复提交'),
            }
          : {}),
      })
    }
  }

  private async serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    this.queues.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.queues.get(key) === pending) this.queues.delete(key)
    }
  }

  private async load<T>(key: string): Promise<T[]> {
    const raw = await this.deps.config.get(key)
    if (!raw) return []
    const data: unknown = JSON.parse(raw)
    if (!Array.isArray(data)) throw new Error('社交操作记录格式异常')
    return data as T[]
  }

  private async mutate(
    definition: SocialActionDefinition,
    input: Record<string, unknown>,
    scope: SocialOperationScope,
    accountId: string,
    run: () => Promise<unknown>,
  ) {
    return this.serialized(`mutation:${accountId}`, async () => {
      this.adapter(scope, accountId)
      const id = digest([
        scope.callId,
        accountId,
        definition.tool,
        definition.action,
        keyOrder(input),
      ])
      const key = `social.operations.${accountId}`
      const entries = await this.load<JournalEntry>(key)
      const fingerprint = digest([accountId, definition.tool, definition.action, keyOrder(input)])
      const prior = entries.find((item) => item.id === id)
      if (prior?.status === 'done') return prior.result
      const uncertain = entries.find(
        (item) =>
          item.fingerprint === fingerprint && ['pending', 'uncertain'].includes(item.status),
      )
      if (uncertain)
        throw Object.assign(new Error('相同操作的结果尚未确认'), {
          uncertain: true,
          operationId: uncertain.id,
        })
      if (prior && ['pending', 'uncertain'].includes(prior.status))
        throw Object.assign(new Error('该操作的结果尚未确认'), { uncertain: true, operationId: id })
      const summary = Object.fromEntries(
        Object.entries(input)
          .filter(([key]) =>
            [
              'user_id',
              'group_id',
              'channel_id',
              'tid',
              'content',
              'nickname',
              'remark',
              'visibility',
              'message_id',
              'image_index',
              'sticker_id',
              'reference',
            ].includes(key),
          )
          .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 200) : value]),
      )
      const entry: JournalEntry = {
        id,
        fingerprint,
        action: definition.action,
        summary,
        status: 'pending',
        createdAt: new Date().toISOString(),
      }
      const retained = entries.filter((item) => item.id !== id)
      const updated = [
        ...retained.filter((item) => ['pending', 'uncertain'].includes(item.status)),
        ...retained.filter((item) => !['pending', 'uncertain'].includes(item.status)).slice(-199),
        entry,
      ]
      if (updated.length > 1000)
        throw Object.assign(new Error('待核验操作过多，请先处理操作记录'), { rejected: true })
      await this.deps.config.set(key, JSON.stringify(updated))
      const progress = { submitted: false }
      try {
        const result = await this.writes.run(progress, run)
        if (object(result).success === false || object(result).error)
          throw Object.assign(new Error(String(object(result).error ?? '社交操作失败')), {
            rejected: true,
          })
        entry.status = 'done'
        progress.submitted = true
        // 不把图片正文和凭据写入操作日志。
        entry.result = object(result).images ? { delivered: true } : result
        await this.deps.config.set(key, JSON.stringify(updated))
        return result
      } catch (error) {
        const failure = error as {
          rejected?: boolean
          code?: string
          stage?: string
          uncertain?: boolean
        }
        entry.status =
          failure.rejected ||
          (!progress.submitted && failure.uncertain !== true) ||
          ['DELIVERY_NOT_SENT', 'DELIVERY_REJECTED'].includes(failure.code ?? '')
            ? 'failed'
            : 'uncertain'
        entry.error = {
          code: failure.code,
          stage: failure.stage,
          message: platformError(error instanceof Error ? error.message : String(error)),
        }
        await this.deps.config.set(key, JSON.stringify(updated)).catch(() => {})
        if (entry.status === 'uncertain')
          throw Object.assign(new Error(`操作结果尚未确认：${entry.error.message}`), {
            uncertain: true,
            operationId: id,
            code: failure.code ?? 'SOCIAL_WRITE_UNCERTAIN',
            stage: failure.stage,
          })
        throw error
      }
    })
  }

  private async dispatch(
    definition: SocialActionDefinition,
    params: Record<string, unknown>,
    scope: SocialOperationScope,
    legacy?: LegacyExecutor,
  ): Promise<unknown> {
    const accountId = scope.accountId!
    const action = definition.action
    const input = { ...params }
    const invoke = (name: string, data: Record<string, unknown>, timeout?: number) =>
      this.invoke(scope, accountId, name, data, timeout)
    if (action === 'emoji_list' || action === 'emoji_remember') {
      const service = new NativeEmojiService(this.deps.storage, this.deps.config)
      const emojiScope = { ...scope, accountId }
      return action === 'emoji_list'
        ? {
            success: true,
            ...(await service.list(emojiScope, input.message_ids as string[] | undefined)),
          }
        : {
            success: true,
            ...(await service.remember(
              emojiScope,
              String(input.reference),
              input.description as string | undefined,
            )),
          }
    }
    if (action === 'requests' || action === 'request_handle') {
      const result = object(await invoke('get_group_system_msg', { count: 100 }))
      const requests = Object.fromEntries(
        ['invited_requests', 'InvitedRequest', 'join_requests'].map((key) => [
          key,
          (Array.isArray(result[key]) ? result[key] : []).filter(
            (entry: unknown) => String(object(entry).group_id) === input.group_id,
          ),
        ]),
      )
      if (action === 'requests') return requests
      const target = Object.values(requests)
        .flat()
        .find(
          (entry: unknown) => String(object(entry).flag ?? object(entry).request_id) === input.flag,
        )
      if (!target || object(target).checked === true)
        throw Object.assign(new Error('申请不存在、已处理或不属于指定群聊，未执行处理'), {
          rejected: true,
        })
      return invoke('set_group_add_request', {
        flag: input.flag,
        approve: input.approve,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      })
    }
    if (action === 'operations') {
      const entries = (await this.load<JournalEntry>(`social.operations.${accountId}`)).reverse()
      return {
        operations: [
          ...entries.filter((item) => ['pending', 'uncertain'].includes(item.status)),
          ...entries.filter((item) => !['pending', 'uncertain'].includes(item.status)),
        ].slice(0, Number(input.limit ?? 20)),
      }
    }
    if (action === 'operation_resolve')
      return this.serialized(`mutation:${accountId}`, async () => {
        this.adapter(scope, accountId)
        const key = `social.operations.${accountId}`
        const entries = await this.load<JournalEntry>(key)
        const entry = entries.find((item) => item.id === input.operation_id)
        if (!entry || !['pending', 'uncertain'].includes(entry.status))
          throw new Error('没有找到需要核验的操作')
        entry.status = input.decision === 'completed' ? 'done' : 'failed'
        entry.result = { verified: true, completed: input.decision === 'completed' }
        await this.deps.config.set(key, JSON.stringify(entries))
        return { operation_id: entry.id, status: entry.status }
      })
    if (definition.legacy) {
      this.adapter(scope, accountId)
      if (!legacy) throw new Error('此操作需要当前会话上下文')
      if (action.startsWith('sticker_')) input.action = action.slice(8)
      if (action.startsWith('diary_')) input.action = action.slice(6)
      if (action.startsWith('status_card_')) input.action = action.slice(12)
      if (definition.mutation && this.writes.getStore()) this.writes.getStore()!.submitted = true
      const result: unknown = JSON.parse(await legacy(definition.legacy, input))
      if (object(result).error || object(result).success === false)
        throw Object.assign(new Error(String(object(result).error ?? '社交操作失败')), {
          rejected: !definition.mutation || object(result).rejected === true,
          code: object(result).code,
          uncertain: object(result).uncertain,
          stage: object(result).stage,
        })
      return result
    }
    if (action === 'qzone_records')
      return {
        posts: (await this.load<PublishedPost>(`social.qzone.posts.${accountId}`))
          .slice(-Number(input.limit ?? 20))
          .reverse(),
      }
    if (action.startsWith('qzone_') && !['qzone_publish', 'qzone_delete'].includes(action)) {
      if (definition.mutation && this.writes.getStore()) this.writes.getStore()!.submitted = true
      return this.qzone.execute(accountId, action, input, invoke, scope.signal)
    }
    if (action === 'message_send') {
      const message: OutboundMessage = {
        accountId,
        channelId: String(input.channel_id),
        channelType: input.channel_type as 'private' | 'group',
        content: String(input.content),
      }
      const receipt = this.deps.send
        ? await this.deps.send(scope, message)
        : await this.adapter(scope, accountId).sendMessage(message, scope.signal)
      if (this.deps.send && currentSocialRecovery()?.record.checkpoint.orchestration)
        return { sent: true, receipt }
      try {
        await this.deps.storage.insert({
          msgId: `agent_tool_${crypto.randomUUID()}`,
          platform: 'qq',
          accountId,
          channelId: String(input.channel_id),
          channelType: input.channel_type as 'private' | 'group',
          senderId: 'self',
          senderName: scope.agentId,
          content: String(input.content),
          agentId: scope.agentId,
        })
      } catch {
        return { sent: true, warning: '消息已送达，但本地发送记录保存失败' }
      }
      return { sent: true }
    }
    if (action === 'history_get' || action === 'mark_read') {
      const group = input.channel_type === 'group'
      const name =
        action === 'history_get'
          ? group
            ? 'get_group_msg_history'
            : 'get_friend_msg_history'
          : group
            ? 'mark_group_msg_as_read'
            : 'mark_private_msg_as_read'
      const result = await invoke(name, {
        [group ? 'group_id' : 'user_id']: input.channel_id,
        ...(action === 'history_get'
          ? {
              count: input.count ?? 20,
              ...(input.message_seq !== undefined ? { message_seq: input.message_seq } : {}),
            }
          : {}),
      })
      if (action !== 'history_get') return result
      const data = object(result)
      // 平台历史中的商城密钥、内部结构和图片正文不直接进入模型观察。
      return {
        ...Object.fromEntries(
          Object.entries(data).filter(
            ([key]) => key !== 'messages' && !/key|token|secret|cookie|authorization/i.test(key),
          ),
        ),
        messages: (Array.isArray(data.messages) ? data.messages : []).map((raw) => {
          const message = object(raw)
          const segments = (Array.isArray(message.message) ? message.message : []).filter(
            (item): item is OneBotSegment =>
              typeof object(item).type === 'string' && Boolean(object(item).data),
          )
          const sender = object(message.sender)
          return {
            message_id: message.message_id,
            message_seq: message.message_seq,
            time: message.time,
            sender: {
              user_id: message.user_id ?? sender.user_id,
              nickname: sender.nickname,
              card: sender.card,
            },
            content: cleanCQCodes(
              segments.length
                ? segmentsToCQString(segments)
                : typeof message.raw_message === 'string'
                  ? message.raw_message
                  : '',
            ),
            image_count: segments.filter((item) => item.type === 'image').length,
            native_emoji_count: segments.filter(
              (item) =>
                item.type === 'face' ||
                item.type === 'mface' ||
                (item.type === 'image' && item.data.emoji_id),
            ).length,
          }
        }),
        hint: __t(
          'apps.social.ui',
          '这里只是历史文字与媒体占位。查看画面请用 image_read；复用本地已收到的原生表情请用 emoji_list。',
        ),
      }
    }
    if (action === 'files')
      return invoke(input.folder_id ? 'get_group_files_by_folder' : 'get_group_root_files', {
        ...input,
        file_count: input.file_count ?? 50,
      })
    if (action === 'profile_get')
      return invoke('get_stranger_info', { user_id: accountId, no_cache: true })
    if (action === 'profile_update') {
      if (!Object.keys(input).length)
        throw Object.assign(new Error('请至少提供一项资料修改'), { rejected: true })
      const profile = object(
        await invoke('get_stranger_info', { user_id: accountId, no_cache: true }),
      )
      input.nickname = input.nickname ?? profile.nickname
      if (!input.nickname) throw new Error('无法读取当前昵称')
      if (input.signature !== undefined) {
        input.personal_note = input.signature
        delete input.signature
      }
    }
    if (action === 'signature_set') {
      input.longNick = input.signature
      delete input.signature
    }
    if (action === 'status_set') {
      const statuses: Record<string, number> = {
        online: 10,
        away: 30,
        busy: 50,
        dnd: 70,
        invisible: 40,
        qme: 60,
      }
      input.status = statuses[String(input.status)]
      input.ext_status ??= 0
      input.battery_status = input.battery ?? 100
      delete input.battery
    }
    if (action === 'status_custom') input.face_type ??= '1'
    if (['avatar_set', 'portrait_set'].includes(action)) {
      input.file = await this.deps.prepareImage(String(input.source), scope)
      delete input.source
    }
    if (action === 'notice_publish') {
      if (input.source) input.image = await this.deps.prepareImage(String(input.source), scope)
      delete input.source
      Object.assign(input, {
        pinned: input.pinned ? 1 : 0,
        type: 1,
        confirm_required: 1,
        is_show_edit_card: 0,
        tip_window_type: 0,
      })
    }
    if (action === 'card_set') input.user_id ??= accountId
    if (action === 'profile_like') input.times ??= 1
    if (action === 'poke' && !scope.owner && scope.channelType === 'group')
      input.group_id = scope.channelId
    if (action === 'message_react') input.set ??= true
    if (action === 'album_upload') {
      if (!(input.sources as string[]).length)
        throw Object.assign(new Error('请提供图片'), { rejected: true })
      input.files = await this.prepareImages(input.sources as string[], scope)
      delete input.sources
    }
    if (action === 'qzone_publish') {
      if (!String(input.content).trim() && !(input.sources as string[] | undefined)?.length)
        throw Object.assign(new Error('说说正文与图片不能同时为空'), { rejected: true })
      const rights: Record<string, number> = {
        public: 1,
        friends: 4,
        selected: 16,
        private: 64,
        exclude: 128,
      }
      if (
        ['selected', 'exclude'].includes(String(input.visibility)) &&
        !(input.target_uins as string[] | undefined)?.length
      )
        throw Object.assign(new Error('此可见范围需要指定好友'), { rejected: true })
      const images = await this.prepareImages((input.sources as string[] | undefined) ?? [], scope)
      const result = object(
        await invoke(
          'send_qzone_msg',
          {
            content: input.content,
            images,
            ugc_right: rights[String(input.visibility)],
            ...(input.target_uins ? { target_uins: input.target_uins } : {}),
          },
          120_000,
        ),
      )
      if (typeof result.tid !== 'string' || !result.tid)
        throw new Error('空间发布未返回可确认的说说 ID')
      const key = `social.qzone.posts.${accountId}`
      const posts = await this.load<PublishedPost>(key)
      posts.push({
        tid: result.tid,
        content: String(input.content),
        visibility: String(input.visibility),
        createdAt: new Date().toISOString(),
      })
      await this.deps.config.set(key, JSON.stringify(posts.slice(-500)))
      return {
        tid: result.tid,
        visibility: input.visibility,
        url: `https://user.qzone.qq.com/${accountId}/mood/${result.tid}`,
      }
    }
    if (action === 'qzone_delete') {
      await invoke('delete_qzone_msg', input)
      const key = `social.qzone.posts.${accountId}`
      const posts = await this.load<PublishedPost>(key)
      for (const post of posts)
        if (post.tid === input.tid) post.deletedAt = new Date().toISOString()
      await this.deps.config.set(key, JSON.stringify(posts))
      return { deleted: true, tid: input.tid }
    }
    // 精华接口按消息定位，群号仅用于执行前的范围验证。
    if (['essence_set', 'essence_remove'].includes(action)) delete input.group_id
    let native = NATIVE[action]
    if (action === 'album_like') {
      native = input.set === false ? 'cancel_group_album_media_like' : 'set_group_album_media_like'
      delete input.set
    }
    if (!native) throw new Error('此社交操作尚未提供执行器')
    const result = await invoke(native, input, definition.mutation ? 60_000 : 15_000)
    if (['profile_update', 'signature_set'].includes(action))
      return {
        updated: true,
        profile: await invoke('get_stranger_info', { user_id: accountId, no_cache: true }),
      }
    return result ?? { accepted: true }
  }

  private async prepareImages(sources: string[], scope: SocialOperationScope): Promise<string[]> {
    const images: string[] = []
    let total = 0
    for (const source of sources) {
      scope.signal?.throwIfAborted()
      const image = await this.deps.prepareImage(source, scope)
      total += image.length
      if (total > 32 * 1024 * 1024)
        throw Object.assign(new Error('本次图片总大小过大，请减少图片或压缩后重试'), {
          rejected: true,
        })
      images.push(image)
    }
    return images
  }
}

/** 图片先经宿主资源服务解析，再以内嵌数据传给远程 NapCat。 */
export async function socialImageData(filePath: string): Promise<string> {
  if ((await stat(filePath)).size > 12 * 1024 * 1024) throw new Error('图片不能超过 12 MB')
  const bytes = await readFile(filePath)
  if (bytes.length > 12 * 1024 * 1024) throw new Error('图片不能超过 12 MB')
  return `base64://${bytes.toString('base64')}`
}
