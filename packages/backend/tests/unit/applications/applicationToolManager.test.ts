import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationAdapterManifest, ApplicationToolProjection } from '@infos/shared'
import { ApplicationRealmManager } from '../../../src/applications/applicationRealm'
import { ApplicationToolManager } from '../../../src/applications/applicationToolManager'
import { CapabilityGate } from '../../../src/capabilities/capabilityGate'
import type { SkillLoader } from '../../../src/capabilities/skillLoader'
import { ToolRegistry } from '../../../src/services/agent/toolRegistry'

vi.mock('../../../src/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

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

  it('离线时仅保留目录条目，上线后才进入工具注册表并可随时撤回', async () => {
    const { tools, realms, manager, realm } = setup()
    const declaration = manager.declare(realm('demo'), manifest('demo', [projection('demo_run')]))

    expect(manager.list()).toEqual([
      expect.objectContaining({
        name: 'demo_run',
        appId: 'demo',
        appName: 'demo 应用',
        available: false,
      }),
    ])
    expect(tools.has('demo_run')).toBe(false)

    expect(declaration.online('demo_run', handler)).toBe(true)
    expect(tools.has('demo_run')).toBe(true)
    expect(tools.getDefinition('demo_run')?.packageId).toBe('application:demo')
    expect(realms.isHostProjection('demo_run')).toBe(true)
    expect(realms.isPrivateTool('demo_run')).toBe(false)
    expect(manager.get('demo_run')?.available).toBe(true)

    await declaration.offlineAll()
    expect(tools.has('demo_run')).toBe(false)
    expect(manager.get('demo_run')?.available).toBe(false)
  })

  it('跳过尚未支持的 open_session 声明，其余工具照常登记', () => {
    const { manager, realm } = setup()
    const declaration = manager.declare(
      realm('demo'),
      manifest('demo', [projection('demo_run'), projection('demo_chat', 'open_session')]),
    )
    expect(declaration.names).toEqual(['demo_run'])
    expect(manager.get('demo_chat')).toBeUndefined()
  })

  it('不同子应用声明同名工具时整体拒绝，且不留下半登记', () => {
    const { manager, realm } = setup()
    manager.declare(realm('a'), manifest('a', [projection('shared_tool')]))
    expect(() =>
      manager.declare(realm('b'), manifest('b', [projection('b_only'), projection('shared_tool')])),
    ).toThrow('APPLICATION_TOOL_NAME_CONFLICT')
    expect(manager.get('b_only')).toBeUndefined()
    expect(manager.list().map((entry) => entry.name)).toEqual(['shared_tool'])
  })

  it('与主应用已有工具重名时上线失败，不覆盖原工具', async () => {
    const { tools, manager, realm } = setup()
    const builtin = vi.fn(async () => 'builtin')
    tools.register({ name: 'web_search', description: '', parameters: {} }, builtin)
    const declaration = manager.declare(realm('demo'), manifest('demo', [projection('web_search')]))
    expect(declaration.online('web_search', handler)).toBe(false)
    expect(tools.getHandler('web_search')).toBe(builtin)
    expect(manager.get('web_search')?.available).toBe(false)
  })

  it('只能上下线本子应用声明过的工具', async () => {
    const { manager, realm } = setup()
    manager.declare(realm('a'), manifest('a', [projection('a_tool')]))
    const b = manager.declare(realm('b'), manifest('b', [projection('b_tool')]))
    expect(() => b.online('a_tool', handler)).toThrow('APPLICATION_TOOL_UNDECLARED')
  })

  it('Realm 释放后目录条目一并撤销，可重新登记', async () => {
    const { tools, manager, realm } = setup()
    const demo = realm('demo')
    const declaration = manager.declare(demo, manifest('demo', [projection('demo_run')]))
    declaration.online('demo_run', handler)
    await demo.dispose()
    expect(tools.has('demo_run')).toBe(false)
    expect(manager.list()).toEqual([])
    expect(() =>
      manager.declare(realm('demo'), manifest('demo', [projection('demo_run')])),
    ).not.toThrow()
  })

  it('在线子应用工具与普通工具一样受 CapabilityGate 角色白名单约束', async () => {
    const { tools, manager, realm } = setup()
    const root = join(tmpdir(), `infos-app-tools-${Date.now()}-${Math.random()}`)
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

    // 离线：即使角色允许全部工具，也不可调用。
    expect(gate.isToolAllowed('open', 'desktop', 'demo_run')).toBe(false)

    declaration.online('demo_run', handler)
    expect(gate.isToolAllowed('open', 'desktop', 'demo_run')).toBe(true)
    expect(gate.isToolAllowed('strict', 'desktop', 'demo_run')).toBe(false)
    expect(gate.isToolAllowed('open', 'desktop', 'demo_run', undefined, 'ambient')).toBe(false)

    await declaration.offline('demo_run')
    expect(gate.isToolAllowed('open', 'desktop', 'demo_run')).toBe(false)
  })
})
