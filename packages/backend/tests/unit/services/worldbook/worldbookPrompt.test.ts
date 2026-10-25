import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createWorldbookEntry,
  type PromptBundle,
  type PromptFramework,
  type WorldbookEntry,
} from '@infos/shared'
import type { ConfigRepository } from '@infos/backend/repositories/config.repo'
import { MdpEngine } from '@infos/backend/services/prompt/mdpEngine'
import { PromptWorkspace } from '@infos/backend/services/prompt/promptWorkspace'
import { assembleSillyTavern } from '@infos/backend/services/prompt/sillyTavernFramework'
import { WorldbookService } from '@infos/backend/services/worldbook/worldbookService'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const entry = (id: string, patch: Partial<WorldbookEntry> = {}): WorldbookEntry => ({
  ...createWorldbookEntry(id),
  light: 'constant',
  content: id,
  ...patch,
})

async function setup(entries: WorldbookEntry[], framework: PromptFramework) {
  const directory = mkdtempSync(path.join(tmpdir(), 'infos-worldbook-prompt-'))
  directories.push(directory)
  const values = new Map<string, string>()
  const repository = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => void values.set(key, value),
    setJson: async (key: string, value: unknown) => void values.set(key, JSON.stringify(value)),
  }
  mkdirSync(path.join(directory, 'prompts'), { recursive: true })
  const engine = new MdpEngine(path.join(directory, 'prompts'), path.join(directory, 'agents'))
  const workspace = new PromptWorkspace(repository as unknown as ConfigRepository, engine)
  await workspace.initialize()
  const worldbooks = new WorldbookService(path.join(directory, 'worldbooks'))
  worldbooks.initialize()
  const book = worldbooks.create({ name: '测试', entries })
  worldbooks.saveBinding('pero', { primary: book.id, additional: [] })
  workspace.setWorldbookService(worldbooks)
  const bundle: PromptBundle = {
    documents: [],
    frameworks: [framework],
    assignments: [{ agentId: '', channel: '', frameworkId: framework.id, overrides: {} }],
  }
  await workspace.save(bundle, 0)
  await workspace.publish(1)
  return workspace
}

// 与内置框架相同的结构：系统区块、原生历史、末尾的本轮动态上下文。
const nativeFramework: PromptFramework = {
  id: 'custom.native',
  name: '原生',
  format: 'custom',
  bindings: [],
  blocks: [
    {
      id: 'persona',
      name: '人设',
      kind: 'template',
      role: 'system',
      enabled: true,
      template: '人设',
    },
    { id: 'history', name: '历史', kind: 'history', role: 'user', enabled: true },
    {
      id: 'turn',
      name: '本轮上下文',
      kind: 'template',
      role: 'user',
      enabled: true,
      template: '[动态]{% if world_info %}<world_info>{{ world_info }}</world_info>{% endif %}',
    },
  ],
}
const vars = {
  agent_name: 'Pero',
  owner_name: '小明',
  prompt_seed: 's',
  native_history: [
    { role: 'user', content: '问1' },
    { role: 'assistant', content: '答1' },
  ],
  current_message: { role: 'user', content: '问2 宝剑' },
}

describe('世界书接入提示词装配', () => {
  it('内置本轮上下文模板渲染世界书变量', () => {
    const template = readFileSync(
      path.resolve(
        __dirname,
        '../../../../src/services/mdp/prompts/components/state/turn_context.md',
      ),
      'utf-8',
    )
    expect(template).toContain('{% if world_info %}<world_info>')
    expect(template).toContain('{{ world_info }}')
  })

  it('原生 / 自定义框架只把世界书放进末尾动态区块，系统区块与历史保持不变', async () => {
    const workspace = await setup(
      [
        entry('常驻', { order: 20 }),
        entry('剑', { light: 'keyword', keys: ['宝剑'], order: 10 }),
        entry('未提到', { light: 'keyword', keys: ['盾'] }),
      ],
      nativeFramework,
    )
    const result = workspace.assemble(workspace.snapshot(), 'desktop', 'pero', vars)
    expect(result.messages.map((message) => [message.role, message.content])).toEqual([
      ['system', '人设'],
      ['user', '问1'],
      ['assistant', '答1'],
      ['user', '[动态]<world_info>剑\n\n常驻</world_info>'],
    ])
    // 系统区块与历史与没有世界书时逐字相同，提示词缓存前缀不受影响。
    const without = workspace.assemble(workspace.snapshot(), 'desktop', 'nova', vars)
    expect(without.messages.slice(0, 3)).toEqual(result.messages.slice(0, 3))
  })

  it('其他角色、据点执行与后台任务频道不注入世界书，社交群聊按场景注入', async () => {
    const workspace = await setup([entry('常驻')], nativeFramework)
    const last = (channel: string, agentId: string, extra: Record<string, unknown> = {}) =>
      workspace
        .assemble(workspace.snapshot(), channel, agentId, { ...vars, ...extra })
        .messages.at(-1)?.content
    expect(last('desktop', 'nova')).toBe('[动态]')
    expect(last('task', 'pero')).toBe('[动态]')
    expect(last('desktop', 'pero', { realm_execution: true })).toBe('[动态]')
    expect(last('social', 'pero', { is_group: true })).toBe('[动态]<world_info>常驻</world_info>')
  })

  it('蓝灯触发概率只由对话内容决定，同一轮多次装配结果一致', async () => {
    const workspace = await setup(
      Array.from({ length: 30 }, (_, index) => entry(`p${index}`, { probability: 50 })),
      nativeFramework,
    )
    const last = (extra: Record<string, unknown>) =>
      workspace
        .assemble(workspace.snapshot(), 'desktop', 'pero', { ...vars, ...extra })
        .messages.at(-1)?.content
    const first = last({ prompt_seed: 'random-1' })
    expect(last({ prompt_seed: 'random-2' })).toBe(first)
    expect(first).not.toBe('[动态]')
    expect(last({ current_message: { role: 'user', content: '换一句话' } })).not.toBe(first)
  })

  it('编译器提供的纯正文扫描列表优先，消息前缀中的身份标记不会触发关键词', async () => {
    const workspace = await setup(
      [entry('主人设定', { light: 'keyword', keys: ['主人'] })],
      nativeFramework,
    )
    const last = (extra: Record<string, unknown>) =>
      workspace
        .assemble(workspace.snapshot(), 'social', 'pero', { ...vars, ...extra })
        .messages.at(-1)?.content
    const current = { role: 'user', content: '[“小明” 身份:主人]: 早上好' }
    expect(last({ current_message: current })).toBe('[动态]<world_info>主人设定</world_info>')
    expect(
      last({ current_message: current, worldbook_scan: [{ role: 'user', content: '早上好' }] }),
    ).toBe('[动态]')
  })

  it('酒馆框架把世界书放在当前输入之前，排在同深度预设条目之后，不改动系统区块', () => {
    const framework: PromptFramework = {
      id: 'custom.st',
      name: '酒馆',
      format: 'sillytavern',
      bindings: [],
      blocks: [
        {
          id: 'main',
          stIdentifier: 'main',
          name: '主提示词',
          kind: 'template',
          role: 'system',
          enabled: true,
          template: '主提示词',
        },
        {
          id: 'history',
          stIdentifier: 'chatHistory',
          name: '历史',
          kind: 'history',
          role: 'user',
          enabled: true,
        },
        {
          id: 'note',
          stIdentifier: 'note',
          name: '预设深度 1',
          kind: 'template',
          role: 'system',
          enabled: true,
          template: '预设条目',
          position: 'in_chat',
          depth: 1,
          order: 100,
        },
      ],
      sillyTavern: { markerBindings: {}, values: {} },
    }
    const contents = (extra: Record<string, unknown>) =>
      assembleSillyTavern(framework, 'draft', { ...vars, ...extra }).messages.map(
        (message) => message.content,
      )
    expect(contents({ world_info: '设定集' })).toEqual([
      '主提示词',
      '问1',
      '答1',
      '【系统指令】\n预设条目',
      '【系统指令】\n<world_info>\n设定集\n</world_info>',
      '问2 宝剑',
    ])
    expect(contents({ world_info: '' })).toEqual([
      '主提示词',
      '问1',
      '答1',
      '【系统指令】\n预设条目',
      '问2 宝剑',
    ])
  })
})
