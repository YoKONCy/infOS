import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityGate } from '@infos/backend/capabilities/capabilityGate'
import type { SkillManifest } from '@infos/backend/capabilities/types'

vi.mock('@infos/backend/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))

type SkillLoaderMock = {
  getManifest: ReturnType<typeof vi.fn>
}

type ToolRegistryMock = {
  isVisibleTo: ReturnType<typeof vi.fn>
  isRuntimeScoped: ReturnType<typeof vi.fn>
  getDefinitions: ReturnType<typeof vi.fn>
}

function createManifest(id: string, requiredTools: string[] = []): SkillManifest {
  return {
    id,
    name: `${id} 技能`,
    description: `${id} 描述`,
    requiredTools,
    category: 'test',
    tags: [],
    parameters: {},
    dependsOnSkills: [],
    metadata: {},
    allowedTools: [],
    rootPath: '',
  }
}

describe('CapabilityGate', () => {
  let rootDir: string
  let skillLoader: SkillLoaderMock
  let toolRegistry: ToolRegistryMock

  beforeEach(() => {
    rootDir = join(tmpdir(), `infos-capability-${Date.now()}-${Math.random()}`)
    mkdirSync(join(rootDir, 'pero'), { recursive: true })
    writeFileSync(
      join(rootDir, 'pero', 'capabilities.yaml'),
      `agent: pero
modes:
  desktop:
    tools:
      - chat.send
      - memory.search
    skills:
      - diary
    prompt_fragments:
      - prompts/base.md
  browser:
    tools:
      - browser.open
    skills: []
    prompt_fragments:
      - prompts/browser.md
`,
      'utf-8',
    )
    skillLoader = {
      getManifest: vi.fn((skillId: string) =>
        skillId === 'diary' ? createManifest('diary', ['memory.write']) : undefined,
      ),
    }
    toolRegistry = {
      isVisibleTo: vi.fn(() => true),
      isRuntimeScoped: vi.fn(() => false),
      getDefinitions: vi.fn(() => [
        { name: 'chat.send', description: '发送聊天消息' },
        { name: 'memory.search', description: '搜索记忆' },
        { name: 'browser.open', description: '打开浏览器' },
        { name: 'memory.write', description: '写入记忆' },
        { name: 'blocked.tool', description: '不可用工具' },
      ]),
    }
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  describe('resolve', () => {
    it('条目引导可动态增减，只影响已获准工具的说明', () => {
      toolRegistry.getDefinitions.mockReturnValue([
        { name: 'search_knowledge', description: '检索文档' },
        { name: 'query_facts', description: '查询事实' },
      ])
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)
      let hasDocuments = false
      gate.setToolDescriptionResolver((name, description) =>
        name === 'search_knowledge'
          ? hasDocuments
            ? description + ' 相关主题可查询参考。'
            : undefined
          : description,
      )
      expect(gate.describeTools(['search_knowledge', 'query_facts'])).toBe(
        '- query_facts: 查询事实',
      )
      hasDocuments = true
      expect(gate.describeTools(['search_knowledge'])).toContain('相关主题可查询参考')
      expect(gate.describeTools(['query_facts'])).not.toContain('search_knowledge')
    })
    it('到期跟进只开放读取和建议，不能加载技能、写文件、发消息或执行命令', () => {
      writeFileSync(
        join(rootDir, 'pero', 'capabilities.yaml'),
        `agent: pero\nchannels:\n  desktop:\n    tools:\n      - '*'\n    skills:\n      - diary\n    prompt_fragments: []\n`,
        'utf8',
      )
      const names = [
        'read_file',
        'read_file_range',
        'web_fetch',
        'suggest_next_step',
        'schedule_follow_up',
        'write_file',
        'terminal_execute',
        'mcp_send',
        'write_fact',
      ]
      toolRegistry.getDefinitions.mockReturnValue(
        names.map((name) => ({ name, description: name })),
      )
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)
      const resolved = gate.resolve('pero', 'desktop', undefined, 'follow_up')
      expect([...resolved.allowedTools]).toEqual(names.slice(0, 5))
      expect(resolved.enabledSkills).toEqual([])
      expect(gate.isToolAllowed('pero', 'desktop', 'load_skill', undefined, 'follow_up')).toBe(
        false,
      )
      expect(
        gate.isToolAllowed('pero', 'desktop', 'expand_advanced_tools', undefined, 'follow_up'),
      ).toBe(false)
      expect(gate.isToolAllowed('unknown', 'desktop', 'read_file', undefined, 'follow_up')).toBe(
        false,
      )
    })
    it('应当按 Agent 和模式解析工具、技能、提示片段与描述文本', () => {
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      const resolved = gate.resolve('pero', 'desktop')

      expect([...resolved.allowedTools]).toEqual(['chat.send', 'memory.search'])
      expect(resolved.enabledSkills).toEqual([createManifest('diary', ['memory.write'])])
      expect(resolved.promptFragments).toEqual(['prompts/base.md'])
      expect(resolved.toolsDescription).toContain('chat.send')
      expect(resolved.toolsDescription).toContain('memory.search')
      expect(resolved.toolsDescription).not.toContain('blocked.tool')
      expect(resolved.skillMenuText).toContain('diary')
      expect(resolved.skillMenuText).toContain('diary 描述')
    })

    it('加载旧配置时应自动移除视觉Prompt并写回YAML', () => {
      const configPath = join(rootDir, 'pero', 'capabilities.yaml')
      writeFileSync(
        configPath,
        `agent: pero
channels:
  desktop:
    tools:
      - '*'
    skills: []
    prompt_fragments:
      - components/abilities/vision
      - prompts/base.md
`,
        'utf-8',
      )

      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      expect(gate.resolve('pero', 'desktop').promptFragments).toEqual(['prompts/base.md'])
      expect(readFileSync(configPath, 'utf-8')).not.toContain('components/abilities/vision')
    })

    it('万能通配符应只展开当前Channel的上游工具', () => {
      writeFileSync(
        join(rootDir, 'pero', 'capabilities.yaml'),
        `agent: pero
channels:
  desktop:
    tools:
      - '*'
    skills: []
    prompt_fragments:
      - components/abilities/vision
      - prompts/base.md
`,
        'utf-8',
      )
      toolRegistry.getDefinitions.mockImplementation((channel?: string) =>
        channel === 'desktop'
          ? [
              { name: 'chat.send', description: '发送聊天消息' },
              { name: 'memory.search', description: '搜索记忆' },
            ]
          : [{ name: 'blocked.tool', description: '其他通道工具' }],
      )
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      const resolved = gate.resolve('pero', 'desktop')

      expect([...resolved.allowedTools]).toEqual(['chat.send', 'memory.search'])
      expect(resolved.promptFragments).toEqual(['prompts/base.md'])
    })

    it('角色显式工具列表也不能绕过Channel上游工具范围', () => {
      toolRegistry.getDefinitions.mockImplementation((channel?: string) =>
        channel === 'desktop' ? [{ name: 'chat.send', description: '发送聊天消息' }] : [],
      )
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      const resolved = gate.resolve('pero', 'desktop')

      expect([...resolved.allowedTools]).toEqual(['chat.send'])
      expect(gate.isToolAllowed('pero', 'desktop', 'memory.search')).toBe(false)
    })

    it('第七阶段修复（批次 B3）：未配置的 channel 应当 fail-closed返回空能力集', () => {
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      // mobile channel 未在 capabilities.yaml 中配置
      // 原实现会回退 desktop，导致意外继承桌面工具集 —— 安全漏洞
      // 现在改为 fail-closed，未配置 = 最小权限
      const resolved = gate.resolve('pero', 'mobile')

      expect([...resolved.allowedTools]).toEqual([])
      expect(resolved.enabledSkills).toEqual([])
      expect(resolved.promptFragments).toEqual([])
    })

    it('Agent 没有配置时应当返回空能力', () => {
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      const resolved = gate.resolve('unknown', 'desktop')

      expect([...resolved.allowedTools]).toEqual([])
      expect(resolved.enabledSkills).toEqual([])
      expect(resolved.promptFragments).toEqual([])
      expect(resolved.toolsDescription).toBe('')
      expect(resolved.skillMenuText).toBe('')
    })
  })

  describe('isToolAllowed', () => {
    it('应当始终允许 finish_task 和 load_skill', () => {
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      const finishAllowed = gate.isToolAllowed('unknown', 'desktop', 'finish_task')
      const loadAllowed = gate.isToolAllowed('unknown', 'desktop', 'load_skill')

      expect(finishAllowed).toBe(true)
      expect(loadAllowed).toBe(true)
    })

    it('应当基于模式白名单判断普通工具权限', () => {
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      const allowed = gate.isToolAllowed('pero', 'browser', 'browser.open')
      const denied = gate.isToolAllowed('pero', 'browser', 'memory.search')

      expect(allowed).toBe(true)
      expect(denied).toBe(false)
    })
  })

  describe('unlockSkillTools', () => {
    it('Skill工具可绕过角色显式列表但不能绕过Channel上游列表', () => {
      toolRegistry.getDefinitions.mockImplementation((channel?: string) =>
        channel === 'desktop'
          ? [
              { name: 'chat.send', description: '发送聊天消息' },
              { name: 'memory.write', description: '写入记忆' },
            ]
          : [],
      )
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      gate.unlockSkillTools('session-skill', 'diary')

      expect(
        gate.resolve('pero', 'desktop', 'session-skill').allowedTools.has('memory.write'),
      ).toBe(true)
      expect(
        gate.resolve('pero', 'browser', 'session-skill').allowedTools.has('memory.write'),
      ).toBe(false)
      expect(gate.isSkillUnlockedTool('session-skill', 'memory.write')).toBe(true)
    })

    it('应当把 Skill 依赖工具临时加入指定会话白名单，并在清理会话后移除', () => {
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      gate.unlockSkillTools('session-1', 'diary')
      const allowedAfterUnlock = gate.isToolAllowed('pero', 'desktop', 'memory.write', 'session-1')
      gate.clearSession('session-1')
      const allowedAfterClear = gate.isToolAllowed('pero', 'desktop', 'memory.write', 'session-1')

      expect(allowedAfterUnlock).toBe(true)
      expect(allowedAfterClear).toBe(false)
    })

    it('Skill 不存在或没有依赖工具时不应创建额外权限', () => {
      skillLoader.getManifest.mockReturnValueOnce(undefined)
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      gate.unlockSkillTools('session-2', 'missing')
      const allowed = gate.isToolAllowed('pero', 'desktop', 'memory.write', 'session-2')

      expect(allowed).toBe(false)
    })
  })

  describe('Facts 工具权限', () => {
    it('仅在 Channel 白名单声明后允许 Facts 工具，ambient 不得绕过白名单扩权', () => {
      const configPath = join(rootDir, 'pero', 'capabilities.yaml')
      writeFileSync(
        configPath,
        `agent: pero
channels:
  desktop:
    tools:
      - query_facts
      - write_fact
      - supersede_fact
      - delete_fact
      - add_fact_object_alias
      - remove_fact_object_alias
    skills: []
    prompt_fragments: []
`,
        'utf-8',
      )
      toolRegistry.getDefinitions.mockReturnValue(
        [
          'query_facts',
          'write_fact',
          'supersede_fact',
          'delete_fact',
          'add_fact_object_alias',
          'remove_fact_object_alias',
        ].map((name) => ({ name, description: name })),
      )
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      for (const tool of [
        'query_facts',
        'write_fact',
        'supersede_fact',
        'delete_fact',
        'add_fact_object_alias',
        'remove_fact_object_alias',
      ]) {
        expect(gate.isToolAllowed('pero', 'desktop', tool, undefined, 'ambient')).toBe(true)
      }
      expect(gate.isToolAllowed('unknown', 'desktop', 'write_fact', undefined, 'ambient')).toBe(
        false,
      )
      expect(gate.isToolAllowed('pero', 'browser', 'write_fact', undefined, 'ambient')).toBe(false)
    })
  })

  describe('配置查询', () => {
    it('应当返回 Agent 配置存在性、模式清单和去重后的技能清单', () => {
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      const hasPero = gate.hasConfig('pero')
      const hasUnknown = gate.hasConfig('unknown')
      const modes = gate.getAgentModes('pero')
      const skills = gate.getAgentSkills('pero')

      expect(hasPero).toBe(true)
      expect(hasUnknown).toBe(false)
      expect(modes).toEqual({
        desktop: {
          tools: ['chat.send', 'memory.search'],
          skills: ['diary'],
        },
        browser: {
          tools: ['browser.open'],
          skills: [],
        },
      })
      expect(skills).toEqual([{ id: 'diary', name: 'diary 技能', description: 'diary 描述' }])
    })

    it('未知 Agent 查询模式和技能时应当返回空结果', () => {
      const gate = new CapabilityGate([rootDir], skillLoader as never, toolRegistry as never)

      const modes = gate.getAgentModes('unknown')
      const skills = gate.getAgentSkills('unknown')

      expect(modes).toEqual({})
      expect(skills).toEqual([])
    })
  })
})
