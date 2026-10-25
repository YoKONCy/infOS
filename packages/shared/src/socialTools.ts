/** 社交业务工具的共享契约；平台接口与凭据始终留在子应用内。 */
export type SocialBusinessTool = 'social' | 'social_group' | 'social_account'
export type SocialParameters = Record<string, unknown>
/** 模型判断的机器人标记，仅用于本地互聊保护，不代表平台认证。 */
export interface SocialBotMark {
  platform?: string
  userId: string
  reason: string
  agentId: string
  accountId: string
  channelType: 'private' | 'group'
  channelId: string
  /** 可选佐证；未提供时，会话字段仅记录标记操作发生的位置。 */
  messageId?: string
  createdAt: string
}
export interface SocialActionDefinition {
  tool: SocialBusinessTool
  action: string
  description: string
  parameters: SocialParameters
  mutation: boolean
  ownerOnly: boolean
  groupRole?: 'admin' | 'owner'
  legacy?: string
  feature?: string
}

const object = (properties: SocialParameters, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

export const SOCIAL_BUSINESS_TOOLS: readonly SocialBusinessTool[] = [
  'social',
  'social_group',
  'social_account',
]

export function socialToolDefinition(
  tool: SocialBusinessTool,
  available: readonly SocialActionDefinition[] = [],
) {
  const label = { social: '社交', social_group: '群聊', social_account: '账号与空间' }[tool]
  return {
    name: tool,
    description: `${label}操作。action 选择操作，input 使用对应参数。\n${available.map((item) => `${item.action}：${item.description}`).join('\n')}`,
    display: { label, description: `${label}操作`, icon: 'chat', color: 'pink' },
    actionPermissions: Object.fromEntries(
      available.map((item) => [
        item.action,
        { mutation: item.mutation, requiresApproval: item.mutation && item.ownerOnly },
      ]),
    ),
    parameters: object(
      {
        action: { type: 'string', enum: available.map((item) => item.action) },
        account_id: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: '省略使用当前会话账号；跨账号操作需授权',
        },
        input: {
          anyOf: available.map((item) => ({ ...item.parameters, description: item.action })),
        },
      },
      ['action', 'input'],
    ),
  }
}

/** 对选中的操作单独验证，拒绝字段拼错、类型错误和未知参数。 */
export function validateSocialInput(
  schema: SocialParameters,
  value: unknown,
  field = 'input',
): void {
  if (schema.enum && !(schema.enum as unknown[]).includes(value))
    throw new Error(`${field} 不在允许范围内`)
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${field} 必须是对象`)
    const input = value as Record<string, unknown>
    const properties = schema.properties as Record<string, SocialParameters>
    for (const key of schema.required as string[])
      if (input[key] === undefined) throw new Error(`缺少 ${field}.${key}`)
    for (const [key, child] of Object.entries(input)) {
      if (!Object.hasOwn(properties, key)) throw new Error(`未知参数 ${field}.${key}`)
      validateSocialInput(properties[key]!, child, `${field}.${key}`)
    }
  } else if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length < Number(schema.minLength ?? 0) ||
      value.length > Number(schema.maxLength ?? 10000) ||
      (schema.pattern && !new RegExp(String(schema.pattern)).test(value))
    )
      throw new Error(`${field} 格式不正确`)
  } else if (schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < Number(schema.minimum) ||
      value > Number(schema.maximum)
    )
      throw new Error(`${field} 必须是指定范围内的整数`)
  } else if (schema.type === 'boolean' && typeof value !== 'boolean')
    throw new Error(`${field} 必须是布尔值`)
  else if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length < Number(schema.minItems ?? 0) ||
      value.length > Number(schema.maxItems) ||
      (schema.uniqueItems && new Set(value).size !== value.length)
    )
      throw new Error(`${field} 数组不符合要求`)
    value.forEach((item, index) =>
      validateSocialInput(schema.items as SocialParameters, item, `${field}[${index}]`),
    )
  }
}
