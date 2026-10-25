import {
  SOCIAL_GROUP_POLICY_LIMITS,
  socialToolDefinition,
  validateSocialInput,
  type SocialActionDefinition,
  type SocialBusinessTool,
  type SocialGroupPolicy,
} from '@infos/shared'
import type { ToolDefinition } from '@infos/backend/applicationHostAbi'
import type {
  SocialOperationDependencies,
  SocialOperationProvider,
  SocialOperationScope,
  SocialLegacyExecutor,
} from './socialOperations'

const id = { type: 'string', minLength: 1, maxLength: 200 }
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const policy = schema({
  ...Object.fromEntries(
    Object.entries(SOCIAL_GROUP_POLICY_LIMITS).map(([key, bounds]) => [
      key,
      { type: 'integer', minimum: bounds[0], maximum: bounds[1] },
    ]),
  ),
  proactiveGroupEnabled: { type: 'boolean' },
  nightSilenceEnabled: { type: 'boolean' },
})
export const SOCIAL_COMMON_ACTIONS: readonly SocialActionDefinition[] = [
  {
    tool: 'social_group',
    action: 'state_get',
    description: '查询当前群聊状态机的实际策略、阻塞原因与下次观察时间',
    parameters: schema({ group_id: id }, ['group_id']),
    mutation: false,
    ownerOnly: false,
  },
  {
    tool: 'social_group',
    action: 'state_configure',
    description: '调整当前群聊的主动观察策略并读回实际状态；reset 恢复默认策略，不影响其他群',
    parameters: schema({ group_id: id, policy, reset: { type: 'boolean' } }, ['group_id']),
    mutation: true,
    ownerOnly: false,
  },
  {
    tool: 'social',
    action: 'contact_mark_bot',
    description:
      '为当前平台的账号登记机器人判断及依据，不修改平台资料、不授予权限、不重置预算；来源消息为可选佐证',
    parameters: schema({ user_id: id, message_id: id, reason: { ...id, maxLength: 500 } }, [
      'user_id',
      'reason',
    ]),
    mutation: true,
    ownerOnly: false,
  },
]

/** 本地群策略和机器人标记不依赖平台协议；平台业务由内部提供者执行。 */
export class SocialCommonOperations implements SocialOperationProvider {
  private closed = false
  private marks = new Map<string, Promise<unknown>>()
  constructor(
    private deps: SocialOperationDependencies,
    private accounts: () => string[],
    private platformProvider?: SocialOperationProvider,
  ) {}

  actionPolicy(tool: string, action: unknown) {
    return (
      SOCIAL_COMMON_ACTIONS.find((item) => item.tool === tool && item.action === action) ??
      this.platformProvider?.actionPolicy?.(tool, action)
    )
  }

  async definitions(scope: SocialOperationScope): Promise<ToolDefinition[]> {
    if (this.closed) return []
    const definitions = (await this.platformProvider?.definitions(scope)) ?? []
    if (!this.accounts().length) return definitions
    for (const tool of ['social', 'social_group'] as const) {
      const actions = SOCIAL_COMMON_ACTIONS.filter(
        (item) =>
          item.tool === tool &&
          (item.action === 'contact_mark_bot'
            ? !scope.host
            : scope.host || scope.channelType === 'group'),
      ).map((item) =>
        item.tool === 'social_group' && !scope.host
          ? {
              ...item,
              parameters: schema(
                {
                  ...(item.parameters.properties as object),
                  group_id: { ...id, enum: [scope.channelId] },
                },
                ['group_id'],
              ),
            }
          : item,
      )
      if (!actions.length) continue
      const extra = socialToolDefinition(tool, actions)
      const { actionPermissions: _permissions, ...wire } = extra
      const existing = definitions.find((item) => item.function.name === tool)
      if (!existing) definitions.push({ type: 'function', function: wire })
      else {
        const target = existing.function.parameters.properties as Record<
          string,
          Record<string, unknown>
        >
        const source = extra.parameters.properties as Record<string, Record<string, unknown>>
        target.action!.enum = [
          ...(target.action!.enum as string[]),
          ...(source.action!.enum as string[]),
        ]
        target.input!.anyOf = [
          ...(target.input!.anyOf as unknown[]),
          ...(source.input!.anyOf as unknown[]),
        ]
        existing.function.description += `\n${extra.description}`
      }
    }
    return definitions
  }

  async execute(
    tool: SocialBusinessTool,
    args: Record<string, unknown>,
    scope: SocialOperationScope,
    legacy?: SocialLegacyExecutor,
  ): Promise<string> {
    const action = SOCIAL_COMMON_ACTIONS.find(
      (item) => item.tool === tool && item.action === args.action,
    )
    if (!action) {
      if (!this.platformProvider) throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
      return this.platformProvider.execute(tool, args, scope, legacy)
    }
    try {
      scope.signal?.throwIfAborted()
      if (this.closed) throw new Error('SOCIAL_AGENT_INACTIVE')
      if (!this.deps.active(scope.agentId)) throw new Error('SOCIAL_AGENT_INACTIVE')
      if (Object.keys(args).some((key) => !['action', 'input', 'account_id'].includes(key)))
        throw new Error('SOCIAL_INPUT_INVALID')
      validateSocialInput(action.parameters, args.input)
      const input = args.input as Record<string, unknown>
      const available = this.accounts()
      const accountId = String(
        args.account_id ?? scope.accountId ?? (available.length === 1 ? available[0] : ''),
      )
      if (!available.includes(accountId) || (!scope.owner && accountId !== scope.accountId))
        throw new Error('SOCIAL_ACCOUNT_FORBIDDEN')
      const bound = { ...scope, accountId }
      let data: unknown
      if (action.tool === 'social_group') {
        const groupId = String(input.group_id)
        if (
          !scope.host &&
          (scope.channelType !== 'group' ||
            scope.channelId !== groupId ||
            accountId !== scope.accountId)
        )
          throw new Error('SOCIAL_CHANNEL_FORBIDDEN')
        if (scope.host && !scope.owner) throw new Error('SOCIAL_OWNER_REQUIRED')
        if (action.action === 'state_get') data = this.deps.groupState(bound, groupId)
        else {
          if (
            input.reset === true
              ? input.policy !== undefined
              : !input.policy || !Object.keys(input.policy as object).length
          )
            throw new Error('SOCIAL_POLICY_INVALID')
          data = await this.deps.configureGroupState(
            bound,
            groupId,
            (input.policy ?? {}) as Partial<SocialGroupPolicy>,
            input.reset === true,
          )
        }
      } else {
        if (scope.host) throw new Error('SOCIAL_CHANNEL_FORBIDDEN')
        if (!String(input.reason).trim()) throw new Error('SOCIAL_INPUT_INVALID')
        if (input.message_id !== undefined) {
          const row =
            (await this.deps.storage.getByMsgId(
              scope.agentId,
              String(input.message_id),
              accountId,
              {
                platform: scope.platform,
                accountId,
                channelType: scope.channelType,
                channelId: scope.channelId,
              },
            )) ??
            (await this.deps.storage.getByMsgId(
              scope.agentId,
              String(input.message_id),
              undefined,
              {
                platform: scope.platform,
                accountId: undefined,
                channelType: undefined,
                channelId: undefined,
              },
            ))
          if (
            !row ||
            row.agentId !== scope.agentId ||
            row.platform !== scope.platform ||
            row.msgId !== input.message_id ||
            row.senderId !== input.user_id ||
            !['private', 'group'].includes(row.channelType)
          )
            throw new Error('SOCIAL_MESSAGE_SOURCE_INVALID')
          bound.accountId = row.accountId
          bound.channelId = row.channelId
          bound.channelType = row.channelType as 'private' | 'group'
        }
        const key = JSON.stringify([scope.platform, scope.agentId, accountId, scope.callId, input])
        let result = this.marks.get(key)
        if (!result) {
          result = this.deps.markBot(bound, {
            userId: String(input.user_id),
            messageId: input.message_id as string | undefined,
            reason: String(input.reason),
          })
          if (this.marks.size >= 256) this.marks.delete(this.marks.keys().next().value!)
          this.marks.set(key, result)
        }
        try {
          data = await result
        } catch (error) {
          this.marks.delete(key)
          throw error
        }
      }
      return JSON.stringify({ success: true, action: action.action, account_id: accountId, data })
    } catch (error) {
      return JSON.stringify({
        success: false,
        rejected: true,
        retryable: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  close(): void {
    this.closed = true
    this.marks.clear()
    this.platformProvider?.close()
  }
}
