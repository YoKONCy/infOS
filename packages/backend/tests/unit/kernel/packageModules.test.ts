import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import {
  PackageRegistry,
  PackageRuntime,
  PackageSecurityAuthority,
  PackageHookBus,
  registerStandardContributionActivators,
  PackageProcessSupervisor,
} from '@infos/backend/packages'
import { PackageManagementService } from '@infos/backend/packages/packageManagementService'
import { registerExtensionActivators } from '@infos/backend/packages/packageExtensionActivators'
import { PackageUiRegistry } from '@infos/backend/packages/packageUiRegistry'
import { PackageAssets } from '@infos/backend/packages/packageAssets'
import { ContextRegionRegistry } from '@infos/backend/services/context/contextRegionRuntime'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'
import { SkillLoader } from '@infos/backend/capabilities/skillLoader'
import { KernelEventBus } from '@infos/backend/kernel/kernelOutboxPublisher'

const base = path.resolve('TEMP/plugin-infrastructure')
let root: string
let runtime: PackageRuntime
let registry: PackageRegistry
let manager: PackageManagementService
let tools: ToolRegistry
let contexts: ContextRegionRegistry
let hooks: PackageHookBus
let ui: PackageUiRegistry
let assets: PackageAssets
let events: KernelEventBus
beforeEach(async () => {
  await mkdir(base, { recursive: true })
  root = await mkdtemp(path.join(base, 'modules-'))
  registry = new PackageRegistry()
  tools = new ToolRegistry()
  contexts = new ContextRegionRegistry()
  hooks = new PackageHookBus()
  ui = new PackageUiRegistry()
  assets = new PackageAssets()
  events = new KernelEventBus()
  const security = new PackageSecurityAuthority(path.join(root, 'security.json'))
  runtime = new PackageRuntime(registry, security, path.join(root, 'data'))
  registerStandardContributionActivators({
    runtime,
    tools,
    hooks,
    skills: new SkillLoader([], path.join(root, 'skills')),
    events,
    processes: new PackageProcessSupervisor(),
  })
  registerExtensionActivators({ runtime, contexts, hooks, ui, assets })
  manager = new PackageManagementService(root, registry, runtime, security, {
    prepare: async () => undefined,
  })
  await manager.initialize()
})
afterEach(async () => {
  await runtime.shutdown()
  if (!root.startsWith(base + path.sep)) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})
const request = {
  agentId: 'pero',
  threadId: 'fixture',
  channel: 'desktop',
  tokenBudget: 1000,
  now: new Date().toISOString(),
}
async function enable() {
  const info = manager.list()[0]!
  await manager.authorize(info.manifest.packageId, info.digest, info.requestedPermissions)
  await manager.setEnabled(info.manifest.packageId, true)
}
function fixture(version = '1.0.0', value = 1) {
  return zipSync(
    Object.fromEntries(
      Object.entries({
        'manifest.json': JSON.stringify({
          manifestVersion: 2,
          packageId: 'fixture.modules',
          name: '模块夹具',
          version,
          trust: 'user',
          contributions: [
            { id: 'tool', kind: 'tool', entry: 'tool.mjs' },
            { id: 'context', kind: 'context-provider', entry: 'context.mjs' },
            { id: 'flow', kind: 'agent-flow', entry: 'flow.mjs' },
            { id: 'panel', kind: 'presenter', entry: 'panel.mjs' },
            { id: 'assets', kind: 'asset', entry: 'assets' },
          ],
        }),
        'value.mjs': `export const value = ${value}`,
        'tool.mjs': `import { value } from './value.mjs'; export const definition = { name: 'fixture_tool', description: '测试工具', parameters: {type:'object'} }; export async function execute() { return String(value) }`,
        'context.mjs': `export async function provide() { return [{ content: '插件上下文', priority: 999, required: true, trust: 'system' }] }`,
        'flow.mjs': `export const hooks = { 'chat:beforeToolCall': async data => ({ ...data, args: { value: 42 } }) }`,
        'panel.mjs': `export const panel = { slot: 'integrations', title: '测试面板', actions: [{ id: 'ping', label: '检查' }] }; export async function onAction() { return 'pong' }`,
        'assets/readme.txt': '资源文件',
      }).map(([name, text]) => [name, strToU8(text)]),
    ),
  )
}
describe('真实插件模块全链路', () => {
  it('事件订阅异常不阻断内核其他订阅，也不能修改原始事件', async () => {
    await manager.install(
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            manifestVersion: 2,
            packageId: 'fixture.modules',
            name: '事件夹具',
            version: '1.0.0',
            trust: 'user',
            contributions: [{ id: 'events', kind: 'event-subscriber', entry: 'events.mjs' }],
          }),
        ),
        'events.mjs': strToU8(
          "export async function onEvent(event) { event.payload.value = 99; throw new Error('模拟订阅失败') }",
        ),
      }),
    )
    await enable()
    let received = 0
    const remove = events.subscribe((event) => {
      received = (event.payload as { value: number }).value
    })
    await expect(events.publish({ payload: { value: 1 } } as never)).resolves.toBeUndefined()
    expect(received).toBe(1)
    expect(hooks.failures[0]?.packageId).toBe('fixture.modules')
    remove()
  })
  it('贡献工厂得到独立数据目录，停用会取消信号并执行资源清理', async () => {
    const bytes = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          manifestVersion: 2,
          packageId: 'fixture.modules',
          name: '工厂夹具',
          version: '1.0.0',
          trust: 'user',
          contributions: [{ id: 'tool', kind: 'tool', entry: 'tool.mjs' }],
        }),
      ),
      'tool.mjs':
        strToU8(`import { writeFile } from 'node:fs/promises'; import path from 'node:path';
        export function createContribution(host) {
          host.onDispose(() => writeFile(path.join(host.dataDirectory, 'disposed.txt'), String(host.signal.aborted)));
          return { definition: { name: 'fixture_tool', description: '测试工具', parameters: {type:'object'} },
            async execute() { return host.dataDirectory } };
        }`),
    })
    await manager.install(bytes)
    await enable()
    const directory = (await tools.getHandler('fixture_tool')!({}, {} as never)) as string
    expect(directory.startsWith(path.join(root, 'data') + path.sep)).toBe(true)
    await manager.setEnabled('fixture.modules', false)
    expect(await readFile(path.join(directory, 'disposed.txt'), 'utf8')).toBe('true')
    await manager.uninstall('fixture.modules')
    expect(await readFile(path.join(directory, 'disposed.txt'), 'utf8')).toBe('true')
  })
  it('安装、授权、注册与停用在真实 Tool、Context、Flow、Presenter、Asset 上闭环', async () => {
    await manager.install(fixture())
    expect(tools.has('fixture_tool')).toBe(false)
    await enable()
    expect(await tools.getHandler('fixture_tool')!({}, {} as never)).toBe('1')
    expect(await contexts.collect(request)).toMatchObject([
      { trust: 'external', required: false, priority: 50, content: '插件上下文' },
    ])
    expect(await hooks.emitHook('chat:beforeToolCall', { args: {} })).toEqual({
      args: { value: 42 },
    })
    expect(await ui.invoke('fixture.modules/panel', 'ping')).toBe('pong')
    expect(
      new TextDecoder().decode((await assets.read('fixture.modules/assets', 'readme.txt')).bytes),
    ).toBe('资源文件')
    await manager.setEnabled('fixture.modules', false)
    expect(tools.has('fixture_tool')).toBe(false)
    expect(await contexts.collect(request)).toEqual([])
    expect(ui.list('integrations')).toEqual([])
    expect(await hooks.emitHook('chat:beforeToolCall', { args: {} })).toEqual({ args: {} })
    await expect(assets.read('fixture.modules/assets', 'readme.txt')).rejects.toThrow(
      'ASSET_UNAVAILABLE',
    )
  })
  it('实际相对 import 在读取修改、重新授权和重载后使用新模块', async () => {
    await manager.install(fixture())
    await enable()
    expect(await tools.getHandler('fixture_tool')!({}, {} as never)).toBe('1')
    await manager.setEnabled('fixture.modules', false)
    await writeFile(
      path.join(registry.get('fixture.modules')!.rootDir!, 'value.mjs'),
      'export const value = 2',
    )
    await manager.review('fixture.modules')
    const info = manager.list()[0]!
    await manager.authorize(info.manifest.packageId, info.digest, info.requestedPermissions)
    await manager.setEnabled('fixture.modules', true)
    expect(await tools.getHandler('fixture_tool')!({}, {} as never)).toBe('2')
    await manager.reload('fixture.modules')
    expect(await tools.getHandler('fixture_tool')!({}, {} as never)).toBe('2')
  })
  it('重复工具名不会覆盖原工具，激活失败撤销先前贡献', async () => {
    tools.register(
      { name: 'fixture_tool', description: '原工具', parameters: { type: 'object' } },
      async () => '原工具',
    )
    await manager.install(fixture())
    await expect(enable()).rejects.toThrow('TOOL_NAME_CONFLICT')
    expect(await tools.getHandler('fixture_tool')!({}, {} as never)).toBe('原工具')
    expect(await contexts.collect(request)).toEqual([])
  })
})
