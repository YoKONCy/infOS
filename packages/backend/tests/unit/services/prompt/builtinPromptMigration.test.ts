import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MdpEngine } from '../../../../src/services/prompt/mdpEngine'
import { describe, expect, it } from 'vitest'
import type { PromptDocument } from '@infos/shared'
import { TASK_PROMPTS } from '../../../../src/services/prompt/taskPrompts'
import {
  builtinBodyHash,
  synchronizeBuiltinDocument,
} from '../../../../src/services/prompt/builtinPromptMigration'

function document(body: string): PromptDocument {
  return {
    id: 'apps/social/social_rules',
    name: '我的社交规则',
    body,
    kind: 'component',
    role: 'system',
    enabled: true,
    builtin: true,
    variables: ['owner_qq'],
  }
}

describe('内置提示词正文升级', () => {
  it('原样旧状态槽位升级社交通道过滤，用户改写保持原样', () => {
    const engine = new MdpEngine(
      fileURLToPath(new URL('../../../../src/services/mdp/prompts/', import.meta.url)),
    )
    const body = engine.getPrompt('slots/800_pet_state')!.content
    const oldBody = body
      .replace("{% if channel != 'social' %}", '')
      .replace('{% endif %}</Current_Status>', '</Current_Status>')
    expect(builtinBodyHash(oldBody)).toBe(
      '55b2e7a610ceceaadc408f70fe28d2306dbc71629d6e385b627630c6d9fec8fc',
    )
    const original = { ...document(body), id: 'slots/800_pet_state' }
    const unchanged = { ...original, body: oldBody }
    const custom = { ...unchanged, body: oldBody + '\n我的规则' }
    synchronizeBuiltinDocument(unchanged, original)
    synchronizeBuiltinDocument(custom, original)
    expect(unchanged.body).toBe(body)
    expect(custom.body).toBe(oldBody + '\n我的规则')
  })

  it('原样本轮上下文升级独立资料 XML，用户自定义正文保持不变', () => {
    const body = readFileSync(
      new URL(
        '../../../../src/services/mdp/prompts/components/state/turn_context.md',
        import.meta.url,
      ),
      'utf8',
    )
      .replaceAll('\r\n', '\n')
      .trim()
    const oldBody = readFileSync(
      new URL('../../../fixtures/prompts/turn-context-v0.9.5-hotfix1.md', import.meta.url),
      'utf8',
    )
      .replaceAll('\r\n', '\n')
      .trim()
    // 已核对的旧发行指纹保证测试原文确实属于已知内置版本。
    expect(builtinBodyHash(oldBody)).toBe(
      'ad6124337c958adcbaddcf0aacf94570ea9607e354459881731c2c1cb0a16a83',
    )
    const original = { ...document(body), id: 'components/state/turn_context' }
    const unchanged = { ...original, body: oldBody }
    const custom = { ...unchanged, body: oldBody + '\n我的规则' }
    synchronizeBuiltinDocument(unchanged, original)
    synchronizeBuiltinDocument(custom, original)
    expect(unchanged.body).toBe(body)
    expect(custom.body).toBe(oldBody + '\n我的规则')
  })
  it('旧输出约定升级 selfMinding，但用户自定义正文不覆盖', () => {
    const body = readFileSync(
      new URL(
        '../../../../src/services/mdp/prompts/components/output/output_constraint.md',
        import.meta.url,
      ),
      'utf8',
    )
      .replaceAll('\r\n', '\n')
      .trim()
    // 使用真实发行正文，不能从新版倒推历史文本并误把自定义内容视为内置原件。
    const oldBody = readFileSync(
      new URL('../../../fixtures/prompts/output-constraint-v0.9.4.md', import.meta.url),
      'utf8',
    )
      .replaceAll('\r\n', '\n')
      .trim()
    const original = { ...document(body), id: 'components/output/output_constraint' }
    const unchanged = { ...original, body: oldBody }
    const custom = { ...unchanged, body: `${oldBody}\n我的表达要求` }
    synchronizeBuiltinDocument(unchanged, original)
    synchronizeBuiltinDocument(custom, original)
    expect(unchanged.body).toBe(body)
    expect(custom.body).toBe(`${oldBody}\n我的表达要求`)
  })
  it('未改写的旧记忆反思说明升级人格约束，用户追加内容保持原样', () => {
    const body =
      '维护Agent事件记忆关系图。只允许caused_by、same_event、same_topic。caused_by必须有明确因果，时间先后或相似不够。archive只能在事件错误、被更完整事件高度覆盖或不应继续普通检索时为true，且不可恢复。revision仅用于修复主事件的记叙、重要度、情感或结构化标签；archiveOverlaps仅列出被主事件高度覆盖且应归档的候选ID。返回严格JSON：{"links":[],"removeLinks":[],"archive":false,"revision":null,"archiveOverlaps":[]}。'
    const original = TASK_PROMPTS['memory.reflect']!
    const unchanged = { ...document(body), id: original.id }
    const customized = { ...unchanged, body: `${body}\n这是我自定义的规则。` }
    synchronizeBuiltinDocument(unchanged, original)
    synchronizeBuiltinDocument(customized, original)
    expect(unchanged.body).toBe(original.body)
    expect(unchanged.variables).toContain('persona_definition')
    expect(customized.body).toBe(`${body}\n这是我自定义的规则。`)
  })

  it('已确认的无指纹旧内置规则升级，但不改变用户名称、开关或发布原件', () => {
    const body = readFileSync(
      new URL('../../../fixtures/prompts/social-rules-before-orchestration.md', import.meta.url),
      'utf8',
    ).trim()
    const released = { ...document(body), enabled: false }
    const effective = structuredClone(released)
    const original = {
      ...document('新版：通过 social_act 回复'),
      variables: ['owner_qq', 'agent_name'],
    }
    synchronizeBuiltinDocument(effective, original)
    expect(effective).toMatchObject({
      name: '我的社交规则',
      enabled: false,
      body: original.body,
      builtinBodyHash: builtinBodyHash(original.body),
      variables: original.variables,
    })
    expect(released.body).toBe(body)
    expect(released.builtinBodyHash).toBeUndefined()
  })

  it('未知旧正文和已改写的内置正文保持用户内容', () => {
    const original = document('新版规则')
    const unknown = document('用户自己的历史规则')
    const customized = {
      ...document('旧版规则\n用户补充'),
      builtinBodyHash: builtinBodyHash('旧版规则'),
    }
    const independent = {
      ...document('旧版规则'),
      builtin: false,
      builtinBodyHash: builtinBodyHash('旧版规则'),
    }
    for (const value of [unknown, customized, independent]) {
      const before = structuredClone(value)
      synchronizeBuiltinDocument(value, original)
      expect(value).toEqual(before)
    }
  })

  it('记录原版指纹后可连续升级，升级后用户改写仍不会被覆盖', () => {
    const first = document('第一版')
    const effective = document(first.body)
    synchronizeBuiltinDocument(effective, first)
    synchronizeBuiltinDocument(effective, document('第二版'))
    expect(effective.body).toBe('第二版')
    synchronizeBuiltinDocument(effective, document('第三版'))
    expect(effective.body).toBe('第三版')
    effective.body += '\n用户改写'
    synchronizeBuiltinDocument(effective, document('第四版'))
    expect(effective.body).toBe('第三版\n用户改写')
  })
})
