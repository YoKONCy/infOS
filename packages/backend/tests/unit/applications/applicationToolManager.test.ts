import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationAdapterManifest, ApplicationToolProjection } from '@infos/shared'
import { ApplicationRealmManager } from '../../../src/applications/applicationRealm'
import { ApplicationToolManager } from '../../../src/applications/applicationToolManager'
import { CapabilityGate } from '../../../src/capabilities/capabilityGate'
import type { SkillLoader } from '../../../src/capabilities/skillLoader'
import { ToolRegistry } from '../../../src/services/agent/toolRegistry'

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
vi.mock('../../../src/lib/logger', () => ({ createLogger: () => logger }))

function projection(
  name: string,
  invocation: ApplicationToolProjection['invocation'] = 'invoke',
): ApplicationToolProjection {
  return {
    name,
    endpointId: 'main',
    operation: 'do',
    audience: 'host_agent',
    availability: 'while_ready',
    invocation,
    description: `${name} 描述`,
    parameters: { type: 'object', properties: {} },
    display: { label: name },
  }
}

function manifest(id: string, toolProjections: ApplicationToolProjection[]) {
  return {
    manifestVersion: 1,
    id,
    name: `${id} 应用`,
    description: '',
    adapterVersion: '1.0.0',
    protocolVersion: 1,
    application: { versions: '*', transports: ['websocket'] },
    endpoints: [{ endpointId: 'main', kind: 'task', version: '1.0', operations: ['do'] }],
    offeredCapabilities: [],
    requestedCapabilities: [],
    toolProjections,
  } as unknown as ApplicationAdapterManifest
}

function setup() {
  const tools = new ToolRegistry()
  const realms = new ApplicationRealmManager(tools)
  const manager = new ApplicationToolManager()
  const realm = (appId: string) =>
    realms.register({
      realmId: appId,
      appId,
      principalId: `application:${appId}`,
      instanceId: 'managed',
    })
  return { tools, realms, manager, realm }
}

const handler = async () => 'ok'

describe('ApplicationToolManager', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('子应用启动前不登记任何工具，上线时动态注册、下线时整条移除', async () => {
    const { tools, realms, manager, realm } = setup()
    const declaration = manager.declare(realm('demo'), manifest('demo', [projection('demo_run')]))

    expect(manager.list()).toEqual([])
    expect(tools.has('demo_run')).toBe(false)

    expect(declaration.online('demo_run', handler)).toBe(true)
    expect(manager.list()).toEqual([
      expect.objectContaining({ name: 'demo_run', appId: 'demo', appName: 'demo 应用' }),
    ])
    expect(tools.getDefinition('demo_run')?.packageId).toBe('application:demo')
    expect(realms.isHostProjection('demo_run')).toBe(true)
    expect(realms.isPrivateTool('demo_run')).toBe(false)

    await declaration.offlineAll()
    expect(tools.has('demo_run')).toBe(false)
    expect(manager.list()).toEqual([])
  })

  it('跳过尚未支持的 open_session 声明，其余工具照常可上线', () => {
    const { manager, realm } = setup()
    const declaration = manager.declare(
      realm('demo'),
      manifest('demo', [projection('demo_run'), projection('demo_chat', 'open_session')]),
    )
    expect(declaration.names).toEqual(['demo_run'])
    expect(() => declaration.online('demo_chat', handler)).toThrow('APPLICATION_TOOL_UNDECLARED')
  })

  it('与其他子应用或主应用工具重名时上线失败，不覆盖已有工具', () => {
    const { tools, manager, realm } = setup()
    const builtin = vi.fn(async () => 'builtin')
    tools.register({ name: 'web_search', description: '', parameters: {} }, builtin)
    const a = manager.declare(realm('a'), manifest('a', [projection('shared_tool')]))
    const b = manager.declare(
      realm('b'),
      manifest('b', [projection('shared_tool'), projection('web_search')]),
    )

    expect(a.online('shared_tool', handler)).toBe(true)
    expect(b.online('shared_tool', handler)).toBe(false)
    expect(b.online('web_search', handler)).toBe(false)
    expect(manager.get('shared_tool')?.appId).toBe('a')
    expect(manager.has('web_search')).toBe(false)
    expect(tools.getHandler('web_search')).toBe(builtin)
  })

  it('重名导致的上线失败只记一次日志', () => {
    const { tools, manager, realm } = setup()
    tools.register({ name: 'clash', description: '', parameters: {} }, handler)
    const demo = manager.declare(realm('demo'), manifest('demo', [projection('clash')]))
    logger.warn.mockClear()
    demo.online('clash', handler)
    demo.online('clash', handler)
    demo.online('clash', handler)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('下线全部工具时单个失败不影响其余工具下线', async () => {
    const { tools, manager, realm } = setup()
    const demo = realm('demo')
    const declaration = manager.declare(
      demo,
      manifest('demo', [projection('demo_a'), projection('demo_b')]),
    )
    declaration.online('demo_a', handler)
    declaration.online('demo_b', handler)
    const original = demo.unregisterTool.bind(demo)
    vi.spyOn(demo, 'unregisterTool').mockImplementation(async (name) => {
      if (name === 'demo_a') throw new Error('boom')
      return original(name)
    })
    await expect(declaration.offlineAll()).rejects.toThrow('boom')
    expect(tools.has('demo_b')).toBe(false)
    // 注销失败的工具仍记为在线，下次同步可重试。
    expect(manager.has('demo_a')).toBe(true)
  })

  it('只能上下线本子应用声明过的工具', async () => {
    const { tools, manager, realm } = setup()
    const a = manager.declare(realm('a'), manifest('a', [projection('a_tool')]))
    const b = manager.declare(realm('b'), manifest('b', [projection('b_tool')]))
    a.online('a_tool', handler)
    expect(() => b.online('a_tool', handler)).toThrow('APPLICATION_TOOL_UNDECLARED')
    await b.offline('a_tool')
    expect(tools.has('a_tool')).toBe(true)
  })

  it('同一子应用重复接入时拒绝', () => {
    const { manager, realm } = setup()
    const demo = realm('demo')
    manager.declare(demo, manifest('demo', []))
    expect(() => manager.declare(demo, manifest('demo', []))).toThrow(
      'APPLICATION_TOOLS_ALREADY_DECLARED',
    )
  })

  it('拒绝把其他应用的声明登记到当前 Realm', () => {
    const { manager, realm } = setup()
    expect(() => manager.declare(realm('a'), manifest('b', [projection('b_tool')]))).toThrow(
      'APPLICATION_TOOLS_ID_MISMATCH',
    )
    expect(manager.list()).toEqual([])
  })

  it('Realm 释放后在线工具一并撤销，可重新接入', async () => {
    const { tools, manager, realm } = setup()
    const demo = realm('demo')
    manager.declare(demo, manifest('demo', [projection('demo_run')])).online('demo_run', handler)
    await demo.dispose()
    expect(tools.has('demo_run')).toBe(false)
    expect(manager.list()).toEqual([])
    expect(() =>
      manager.declare(realm('demo'), manifest('demo', [projection('demo_run')])),
    ).not.toThrow()
  })

  it('旧声明在 Realm 释放后不能重新上线或操作同一应用的新实例', async () => {
    const { tools, manager, realm } = setup()
    const oldRealm = realm('demo')
    const old = manager.declare(oldRealm, manifest('demo', [projection('demo_run')]))
    old.online('demo_run', handler)
    await oldRealm.dispose()
    const current = manager.declare(realm('demo'), manifest('demo', [projection('demo_run')]))
    current.online('demo_run', handler)

    expect(old.isOnline('demo_run')).toBe(false)
    expect(() => old.online('demo_run', handler)).toThrow('APPLICATION_TOOLS_REALM_CLOSED')
    await old.offline('demo_run')
    expect(tools.has('demo_run')).toBe(true)
    expect(current.isOnline('demo_run')).toBe(true)
  })

  it('旧实例注销的迟到结果不能移除新实例的工具目录', async () => {
    const { tools, manager, realm } = setup()
    const oldRealm = realm('demo')
    const old = manager.declare(oldRealm, manifest('demo', [projection('demo_run')]))
    old.online('demo_run', handler)
    let release!: () => void
    let entered!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const unregister = oldRealm.unregisterTool.bind(oldRealm)
    vi.spyOn(oldRealm, 'unregisterTool').mockImplementationOnce(async (name) => {
      const removed = await unregister(name)
      entered()
      await wait
      return removed
    })
    const pending = old.offline('demo_run')
    await started
    try {
      await oldRealm.dispose()
      const current = manager.declare(realm('demo'), manifest('demo', [projection('demo_run')]))
      current.online('demo_run', handler)
      release()
      await pending
      expect(current.isOnline('demo_run')).toBe(true)
      expect(tools.has('demo_run')).toBe(true)
    } finally {
      release()
    }
  })

  it('在线子应用工具与普通工具一样受 CapabilityGate 角色白名单约束', async () => {
    const { tools, manager, realm } = setup()
    const root = join(resolve('TEMP'), `infos-app-tools-${Date.now()}-${Math.random()}`)
    dirs.push(root)
    for (const [agent, list] of [
      ['open', ['"*"']],
      ['strict', ['web_search']],
    ] as const) {
      mkdirSync(join(root, agent), { recursive: true })
      writeFileSync(
        join(root, agent, 'capabilities.yaml'),
        `agent: ${agent}\nchannels:\n  desktop:\n    tools:\n${list.map((tool) => `      - ${tool}`).join('\n')}\n    skills: []\n    prompt_fragments: []\n`,
        'utf-8',
      )
    }
    tools.register({ name: 'web_search', description: '', parameters: {} }, handler)
    const skills = { getManifest: vi.fn(), getAllManifests: vi.fn(() => []) }
    const gate = new CapabilityGate([root], skills as unknown as SkillLoader, tools)
    const declaration = manager.declare(realm('demo'), manifest('demo', [projection('demo_run')]))

    // 子应用未启动：即使角色允许全部工具，也不可调用。
    expect(gate.isToolAllowed('open', 'desktop', 'demo_run')).toBe(false)

    declaration.online('demo_run', handler)
    expect(gate.isToolAllowed('open', 'desktop', 'demo_run')).toBe(true)
    expect(gate.isToolAllowed('strict', 'desktop', 'demo_run')).toBe(false)
    expect(gate.isToolAllowed('open', 'desktop', 'demo_run', undefined, 'ambient')).toBe(false)

    await declaration.offline('demo_run')
    expect(gate.isToolAllowed('open', 'desktop', 'demo_run')).toBe(false)
  })

  it('application:* 放行全部在线子应用工具，mcp:* 放行 MCP 工具，均只在默认作用域生效', () => {
    const { tools, manager, realm } = setup()
    const root = join(resolve('TEMP'), `infos-app-wildcard-${Date.now()}-${Math.random()}`)
    dirs.push(root)
    mkdirSync(join(root, 'pero'), { recursive: true })
    writeFileSync(
      join(root, 'pero', 'capabilities.yaml'),
      [
        'agent: pero',
        'channels:',
        '  desktop:',
        '    tools:',
        '      - read_file',
        '      - application:*',
        '      - mcp:*',
        '    skills: []',
        '    prompt_fragments: []',
        '',
      ].join('\n'),
      'utf-8',
    )
    for (const name of ['read_file', 'web_search', 'mcp_demo_echo'])
      tools.register({ name, description: '', parameters: {} }, handler)
    const skills = { getManifest: vi.fn(), getAllManifests: vi.fn(() => []) }
    const gate = new CapabilityGate([root], skills as unknown as SkillLoader, tools)
    manager
      .declare(realm('demo'), manifest('demo', [projection('demo_run')]))
      .online('demo_run', handler)

    const allowed = gate.resolve('pero', 'desktop').allowedTools
    expect([...allowed].sort()).toEqual(['demo_run', 'mcp_demo_echo', 'read_file'])
    expect(allowed.has('application:*')).toBe(false)
    expect(gate.isToolAllowed('pero', 'desktop', 'demo_run', undefined, 'ambient')).toBe(false)
    expect(gate.isToolAllowed('pero', 'desktop', 'mcp_demo_echo', undefined, 'ambient')).toBe(false)
  })
})
