import { NAPCAT_ACTIONS as SOCIAL_ACTIONS } from '@infos/social/adapters/napcat/napcatActions'
import { describe, expect, it } from 'vitest'
import { SOCIAL_BUSINESS_TOOLS, socialToolDefinition, validateSocialInput } from '@infos/shared'
import { sanitizeToolParameters } from '../../../../src/services/llm/sanitize'

describe('社交工具跨模型参数契约', () => {
  it('清洗对象分支时保留每个操作的参数，不裁成第一个空对象', () => {
    for (const name of SOCIAL_BUSINESS_TOOLS) {
      const wire = sanitizeToolParameters(
        socialToolDefinition(
          name,
          SOCIAL_ACTIONS.filter((item) => item.tool === name),
        ).parameters,
      )
      const input = (
        (wire.properties as Record<string, unknown>).input as {
          properties: Record<string, unknown>
        }
      ).properties
      for (const action of SOCIAL_ACTIONS.filter((item) => item.tool === name)) {
        for (const field of Object.keys(action.parameters.properties as object))
          expect(input).toHaveProperty(field)
      }
    }
  })

  it('合并后的模型文档不影响执行层按操作校验必填项和未知字段', () => {
    const publish = SOCIAL_ACTIONS.find((item) => item.action === 'qzone_publish')!
    expect(() => validateSocialInput(publish.parameters, { content: '测试' })).toThrow('visibility')
    expect(() =>
      validateSocialInput(publish.parameters, {
        content: '测试',
        visibility: 'private',
        group_id: '123456789',
      }),
    ).toThrow('未知参数')
    expect(() =>
      validateSocialInput(
        publish.parameters,
        JSON.parse('{"content":"测试","visibility":"private","__proto__":{}}'),
      ),
    ).toThrow('未知参数')
  })
})
