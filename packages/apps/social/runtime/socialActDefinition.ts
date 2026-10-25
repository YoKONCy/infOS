import { t as __t } from './i18n'
import type { ToolDefinition } from '@infos/backend/applicationHostAbi'

/** 能力目录嵌入同一入口的参数定义，避免模型先猜工具参数或绕过编排发送。 */
export function socialActDefinition(catalog: ToolDefinition[]): ToolDefinition {
  catalog = [...catalog].sort((a, b) => a.function.name.localeCompare(b.function.name, 'en'))
  const reference = {
    type: 'object',
    properties: { $ref: { type: 'string', maxLength: 200 } },
    required: ['$ref'],
    additionalProperties: false,
  }
  const scopedParameters = (schema: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...schema }
    if (result.properties) {
      result.properties = Object.fromEntries(
        Object.entries(result.properties as Record<string, Record<string, unknown>>).map(
          ([key, child]) => [key, scopedParameters(child)],
        ),
      )
    }
    if (result.items) result.items = scopedParameters(result.items as Record<string, unknown>)
    if (Array.isArray(result.anyOf)) {
      result.anyOf = result.anyOf.map((child) => scopedParameters(child as Record<string, unknown>))
    }
    if (Array.isArray(result.required)) {
      result.required = result.required.filter(
        (key) => !['channel_id', 'channel_type', 'group_id'].includes(String(key)),
      )
    }
    return result
  }
  const watch = {
    type: 'object',
    properties: {
      senders: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      events: {
        type: 'array',
        items: { type: 'string', enum: ['new_message', 'mention_me', 'image'] },
        maxItems: 3,
      },
      expires_in_seconds: { type: 'integer', minimum: 1, maximum: 21600 },
    },
    additionalProperties: false,
  }
  const message = {
    type: 'object',
    properties: {
      content: { anyOf: [{ type: 'string', maxLength: 10000 }, reference] },
      quote: {
        type: 'string',
        description: __t(
          'apps.social.ui',
          '默认 trigger 引用触发消息，none 不引用，或当前会话消息 ID。',
        ),
      },
      mentions: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      delay_ms: { type: 'integer', minimum: 0, maximum: 21600000 },
      attachments: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            source: { anyOf: [{ type: 'string' }, reference] },
            caption: { type: 'string' },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  }
  const step = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: __t('apps.social.ui', '本次计划内唯一的字母数字标识，可用它引用已完成结果。'),
      },
      op: { type: 'string', enum: ['call', 'send', 'wait', 'if', 'parallel', 'observe', 'yield'] },
      tool: { type: 'string', enum: catalog.map((tool) => tool.function.name) },
      args: {
        description: __t(
          'apps.social.ui',
          'call 的工具参数。social 等工具使用 {action,input}。省略会话标识时由系统补入当前范围。值可用 {$ref:"步骤ID.data.字段"} 引用前序结果。',
        ),
        // 原始目录保留参数说明；引用容器在执行前解析后再走原能力校验，避免给每个字段复制整份引用定义。
        anyOf: [
          ...catalog.map((tool) => scopedParameters(tool.function.parameters)),
          {
            type: 'object',
            description: __t(
              'apps.social.ui',
              '允许参数值使用 {$ref:"步骤ID.data.字段"}；解析后仍按对应工具严格校验。',
            ),
          },
        ],
      },
      action: {
        type: 'string',
        description: __t(
          'apps.social.ui',
          'social/social_group/social_account 可把 action、input 直接放在步骤中。',
        ),
      },
      input: { type: 'object' },
      ...message.properties,
      duration_ms: { type: 'integer', minimum: 0, maximum: 21600000 },
      watch,
      depends_on: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      retries: {
        type: 'integer',
        minimum: 0,
        maximum: 2,
        description: __t('apps.social.ui', '仅只读且可重试的故障可以自动重试。'),
      },
      on_error: {
        type: 'string',
        enum: ['continue', 'return_to_model', 'fallback', 'stop_branch'],
      },
      condition: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          test: { type: 'string', enum: ['exists', 'truthy', 'eq', 'ne'] },
          value: {},
        },
        required: ['ref', 'test'],
        additionalProperties: false,
      },
      steps: {
        type: 'array',
        items: { type: 'object' },
        maxItems: 24,
        description: __t(
          'apps.social.ui',
          'parallel 子步骤，格式同外层，只允许独立只读 call，最多并发 3 个。',
        ),
      },
      then: { type: 'array', items: { type: 'object' }, maxItems: 24 },
      else: { type: 'array', items: { type: 'object' }, maxItems: 24 },
      fallback: { type: 'array', items: { type: 'object' }, maxItems: 24 },
    },
    required: ['op'],
    additionalProperties: false,
  }
  return {
    type: 'function',
    function: {
      name: 'social_act',
      description:
        __t(
          'apps.social.ui',
          '社交回复与步骤编排入口。用 {"reply":"正文"} 发送回复，送达并逐条入库后结束；',
        ) +
        __t(
          'apps.social.ui',
          '普通 assistant 文字不会发送。查询使用 steps 中的 call，结果交回当前模型；',
        ) +
        __t(
          'apps.social.ui',
          '支持分段、延迟发送、PASS、等待、观察、延后重考虑、条件分支与只读并发。',
        ) +
        __t(
          'apps.social.ui',
          'next=end 结束，continue 返回模型，auto 按操作决定。相关发送者的新消息或提及触发 on_new_message：',
        ) +
        __t(
          'apps.social.ui',
          '默认 reconsider 重新判断；keep 保留计划，cancel 取消未执行步骤。每步返回结构化结果，失败须如实说明；',
        ) +
        __t('apps.social.ui', '结果未知的写操作禁止重发。yield 将判断交回当前模型。') +
        '\n' +
        catalog.map((tool) => `${tool.function.name}：${tool.function.description}`).join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['reply', 'pass', 'wait', 'observe', 'defer', 'continue'],
          },
          reply: { type: 'string', maxLength: 10000 },
          messages: { type: 'array', items: message, maxItems: 12 },
          quote: message.properties.quote,
          mentions: message.properties.mentions,
          attachments: message.properties.attachments,
          steps: { type: 'array', items: step, maxItems: 24 },
          next: { type: 'string', enum: ['auto', 'end', 'continue'] },
          on_new_message: { type: 'string', enum: ['keep', 'cancel', 'reconsider'] },
          watch,
          delay_ms: { type: 'integer', minimum: 0, maximum: 21600000 },
          expires_in_seconds: { type: 'integer', minimum: 1, maximum: 21600 },
          intention: { type: 'string', maxLength: 500 },
          reason: { type: 'string', maxLength: 500 },
          after: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['wait', 'observe', 'defer'] },
              watch,
              delay_ms: { type: 'integer', minimum: 0, maximum: 21600000 },
              expires_in_seconds: { type: 'integer', minimum: 1, maximum: 21600 },
              intention: { type: 'string', maxLength: 500 },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  }
}
