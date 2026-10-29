import { t as __t } from './i18n'
import type { ToolDefinition } from '@infos/backend/applicationHostAbi'

/** 能力目录嵌入同一入口的参数定义，避免模型先猜工具参数或绕过编排发送。 */
export function socialActDefinition(
  catalog: ToolDefinition[],
  ownerAppellation: string,
): ToolDefinition {
  // 仅渲染说明字段，不改动工具名、参数名、枚举或运行时权限。
  const renderDescription = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string' && key === 'description')
      return value.replace(/\{\{\s*owner_appellation\s*\}\}|主人/g, () => ownerAppellation)
    if (Array.isArray(value)) return value.map((item) => renderDescription(item))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, renderDescription(item, name)]),
      )
    return value
  }
  catalog = catalog
    .map((tool) => renderDescription(tool) as ToolDefinition)
    .sort((a, b) => a.function.name.localeCompare(b.function.name, 'en'))
  const reference = {
    type: 'object',
    properties: {
      $ref: {
        type: 'string',
        maxLength: 200,
        description: __t('apps.social.ui', '前序结果路径，如 lookup.data.user_id。'),
      },
    },
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
      senders: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 200 },
        maxItems: 10,
        description: __t(
          'apps.social.ui',
          '关注的平台账号 ID；省略或为空时关注当前对话对象或提及你的消息。',
        ),
      },
      events: {
        type: 'array',
        items: { type: 'string', enum: ['new_message', 'mention_me', 'image'] },
        minItems: 1,
        maxItems: 3,
        description: __t(
          'apps.social.ui',
          '匹配任一事件：new_message 新消息、mention_me 提及你、image 图片；默认 new_message。',
        ),
      },
      expires_in_seconds: {
        type: 'integer',
        minimum: 1,
        maximum: 21600,
        description: __t(
          'apps.social.ui',
          '观察有效期（秒）；同级操作的 expires_in_seconds 优先。',
        ),
      },
    },
    additionalProperties: false,
  }
  const message = {
    type: 'object',
    properties: {
      content: {
        anyOf: [{ type: 'string', maxLength: 10000 }, reference],
        description: __t('apps.social.ui', '发送正文；content 与 attachments 至少提供一项。'),
      },
      quote: {
        type: 'string',
        maxLength: 100,
        description: __t(
          'apps.social.ui',
          '默认 trigger 引用触发消息，none 不引用，或当前会话消息 ID。',
        ),
      },
      mentions: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description: __t('apps.social.ui', '被提及者的真实平台账号 ID。'),
      },
      delay_ms: {
        type: 'integer',
        minimum: 0,
        maximum: 21600000,
        description: __t('apps.social.ui', '前一步完成后等待的毫秒数。'),
      },
      attachments: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            source: {
              anyOf: [{ type: 'string', maxLength: 2048 }, reference],
              description: __t(
                'apps.social.ui',
                '资源链接、工作区路径或 attachment:附件ID，也可引用前序结果。',
              ),
            },
            caption: {
              type: 'string',
              maxLength: 300,
              description: __t('apps.social.ui', '附件随附文字，可省略。'),
            },
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
        minLength: 1,
        maxLength: 64,
        pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$',
        description: __t(
          'apps.social.ui',
          '本次计划内唯一的步骤 ID；引用结果或声明依赖时填写，省略则自动编号。',
        ),
      },
      op: {
        type: 'string',
        enum: ['call', 'send', 'wait', 'if', 'parallel', 'observe', 'yield'],
        description: __t(
          'apps.social.ui',
          'call 调工具，send 发送，wait/observe 等待，if 分支，parallel 并行只读调用，yield 返回模型判断。',
        ),
      },
      tool: { type: 'string', enum: catalog.map((tool) => tool.function.name) },
      args: {
        description: __t(
          'apps.social.ui',
          'call 参数；social 等工具用 {action,input}，与步骤外层 action/input 二选一。当前会话查询可省略会话标识；值可用 {$ref:"步骤ID.data.字段"} 引用前序结果。',
        ),
        // 原始目录保留参数说明；引用容器在执行前解析后再走原能力校验，避免给每个字段复制整份引用定义。
        anyOf: [
          ...catalog.map((tool) => scopedParameters(tool.function.parameters)),
          { type: 'object' },
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
      duration_ms: {
        type: 'integer',
        minimum: 0,
        maximum: 21600000,
        description: __t(
          'apps.social.ui',
          'wait 的等待毫秒数，默认 5000；observe 的时长使用 watch.expires_in_seconds。',
        ),
      },
      watch,
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 20,
        description: __t('apps.social.ui', '须先成功的步骤 ID。'),
      },
      retries: {
        type: 'integer',
        minimum: 0,
        maximum: 2,
        description: __t('apps.social.ui', '只读调用的额外重试次数，默认 1；写操作不重试。'),
      },
      on_error: {
        type: 'string',
        enum: ['continue', 'return_to_model', 'fallback', 'stop_branch'],
        description: __t(
          'apps.social.ui',
          '默认 continue 继续后续步骤；return_to_model 返回模型；fallback 执行备用步骤；stop_branch 停止当前分支。uncertain 结果先核验再决定是否重试。',
        ),
      },
      condition: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            maxLength: 200,
            description: __t('apps.social.ui', '被判断的前序结果路径，如 lookup.data.found。'),
          },
          test: {
            type: 'string',
            enum: ['exists', 'truthy', 'eq', 'ne'],
            description: __t(
              'apps.social.ui',
              'exists 已有该值；truthy 为真；eq 等于 value；ne 不等于 value。',
            ),
          },
          value: { description: __t('apps.social.ui', 'eq/ne 使用的比较值，可为任意 JSON 值。') },
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
          'parallel 的子步骤，格式同外层，仅填写独立只读 call，不填写 depends_on 或 fallback。',
        ),
      },
      then: {
        type: 'array',
        items: { type: 'object' },
        maxItems: 24,
        description: __t('apps.social.ui', 'if 条件成立时执行的步骤，格式同外层。'),
      },
      else: {
        type: 'array',
        items: { type: 'object' },
        maxItems: 24,
        description: __t('apps.social.ui', 'if 条件不成立时执行的步骤，格式同外层。'),
      },
      fallback: {
        type: 'array',
        items: { type: 'object' },
        maxItems: 24,
        description: __t('apps.social.ui', 'on_error=fallback 时执行的备用步骤，格式同外层。'),
      },
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
          '社交参与入口。用 {"reply":"正文"} 发送回复，普通文字不会发送。steps 编排工具调用与发送，查询结果返回当前模型；仅把确认送达的内容视为已发送，避免重复发送。',
        ) +
        '\n' +
        __t(
          'apps.social.ui',
          '可按需通过 call 调用 social 的 image_read，每次最多 3 张；需要依据画面作答时，用 yield 或 next:continue 先返回模型。',
        ) +
        '\n' +
        catalog.map((tool) => `${tool.function.name}：${tool.function.description}`).join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['reply', 'pass', 'wait', 'observe', 'defer', 'continue'],
            description: __t(
              'apps.social.ui',
              '默认 reply 回复；pass 不参与，不能同时发送或填写 steps；wait 等对方补充；observe 关注后续消息；defer 稍后重新判断；continue 继续处理。',
            ),
          },
          reply: {
            type: 'string',
            maxLength: 10000,
            description: __t(
              'apps.social.ui',
              '单条回复正文；引用、提及和附件使用同级 quote、mentions、attachments。',
            ),
          },
          end_participation: {
            type: 'boolean',
            description: __t(
              'apps.social.ui',
              '默认 false；true 在本轮结束后退出活跃续聊，可单独使用或与回复合用，不影响之后的新提及和群聊观察。不能与等待、yield 或 next:continue 合用。',
            ),
          },
          low_activity: {
            type: 'boolean',
            description: __t(
              'apps.social.ui',
              '仅普通群聊回合可用；true 在本轮结束后进入低活跃，仅新提及或手动恢复可唤醒。可单独使用或与回复合用，不能同时等待、延后或继续判断。',
            ),
          },
          messages: {
            type: 'array',
            items: message,
            maxItems: 12,
            description: __t(
              'apps.social.ui',
              '依次发送的多段消息，每段分别设置正文、引用、提及、附件或延迟。',
            ),
          },
          quote: message.properties.quote,
          mentions: message.properties.mentions,
          attachments: message.properties.attachments,
          steps: {
            type: 'array',
            items: step,
            maxItems: 24,
            description: __t(
              'apps.social.ui',
              '按顺序执行，先于 reply/messages；含分支共最多 48 步，嵌套最多 4 层。',
            ),
          },
          next: {
            type: 'string',
            enum: ['auto', 'end', 'continue'],
            description: __t(
              'apps.social.ui',
              '默认 auto；action=continue 时默认 continue。auto 含工具调用时返回模型，仅发送则结束；end 结束；continue 返回模型。',
            ),
          },
          on_new_message: {
            type: 'string',
            enum: ['keep', 'cancel', 'reconsider'],
            description: __t(
              'apps.social.ui',
              '相关新消息到来时：reconsider 默认重新判断，keep 保留计划，cancel 取消未执行步骤。',
            ),
          },
          watch,
          delay_ms: {
            type: 'integer',
            minimum: 0,
            maximum: 21600000,
            description: __t(
              'apps.social.ui',
              'reply 发送前或 wait/defer 的等待毫秒数；默认分别为 0、5000、300000。',
            ),
          },
          expires_in_seconds: {
            type: 'integer',
            minimum: 1,
            maximum: 21600,
            description: __t(
              'apps.social.ui',
              '等待或观察有效期（秒）；默认 300，defer 默认 3600；省略时可沿用 watch 中的设置。',
            ),
          },
          intention: {
            type: 'string',
            maxLength: 500,
            description: __t('apps.social.ui', '后续关注事项，不向会话发送。'),
          },
          reason: {
            type: 'string',
            maxLength: 500,
            description: __t('apps.social.ui', '不参与或等待的简短理由，不向会话发送。'),
          },
          after: {
            type: 'object',
            description: __t('apps.social.ui', '发送后继续等待、观察或延后。'),
            properties: {
              action: { type: 'string', enum: ['wait', 'observe', 'defer'] },
              watch,
              delay_ms: {
                type: 'integer',
                minimum: 0,
                maximum: 21600000,
                description: __t(
                  'apps.social.ui',
                  'wait/defer 的等待毫秒数，默认分别为 5000、300000。',
                ),
              },
              expires_in_seconds: {
                type: 'integer',
                minimum: 1,
                maximum: 21600,
                description: __t(
                  'apps.social.ui',
                  '等待或观察有效期（秒）；默认 300，defer 默认 3600；省略时可沿用 watch 中的设置。',
                ),
              },
              intention: {
                type: 'string',
                maxLength: 500,
                description: __t('apps.social.ui', '后续关注事项，不向会话发送。'),
              },
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
