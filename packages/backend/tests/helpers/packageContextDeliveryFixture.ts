// Package context-provider 投递回归的共享夹具：真实插件运行时 + 本地假模型 HTTP 边界。
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { ContextRegion, InteractionMode, PromptFramework } from '@infos/shared'
import { PackageRegistry } from '@infos/backend/packages/packageRegistry'
import { PackageRuntime } from '@infos/backend/packages/packageRuntime'
import { PackageSecurityAuthority } from '@infos/backend/packages/packageSecurityAuthority'
import { PackageManagementService } from '@infos/backend/packages/packageManagementService'
import { registerExtensionActivators } from '@infos/backend/packages/packageExtensionActivators'
import { PackageHookBus } from '@infos/backend/packages/packageHookBus'
import { PackageUiRegistry } from '@infos/backend/packages/packageUiRegistry'
import { PackageAssets } from '@infos/backend/packages/packageAssets'
import { ContextRegionRegistry } from '@infos/backend/services/context/contextRegionRuntime'
import { ContextCompiler } from '@infos/backend/services/context/contextCompiler'
import { MdpEngine } from '@infos/backend/services/prompt/mdpEngine'
import { PromptWorkspace } from '@infos/backend/services/prompt/promptWorkspace'
import { OpenAiProvider } from '@infos/backend/services/llm/providers/openaiProvider'
import { invalidatePromptReplay } from '@infos/backend/services/llm/promptCache'
import type { ChatMessage } from '@infos/backend/services/llm/types'
import type { ThreadMessageInfo } from '@infos/backend/services/thread/threadService'

export const base = path.resolve('TEMP/package-context-delivery')
export const packageId = 'fixture.context-delivery'
export const providerId = `package:${packageId}/context`
export const marker = 'PACKAGE_CONTEXT_7C3F'
export const wire: Array<{ role: string; content: string }[]> = []
export const compiled: ChatMessage[][] = []
let server: Server
let port = 0
export let root: string
export let runtime: PackageRuntime
export let manager: PackageManagementService
export let contexts: ContextRegionRegistry
export let hooks: PackageHookBus

/** 注册夹具生命周期；每个测试文件各自监听随机本地端口，可并行运行。 */
export function useDeliveryFixture() {
  beforeAll(async () => {
    // 真实 HTTP 边界，只监听本地测试端口，不读取任何模型配置或凭据。
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      wire.push(JSON.parse(Buffer.concat(chunks).toString()).messages)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'fake',
          choices: [
            { message: { role: 'assistant', content: '假模型答复' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
  beforeEach(async () => {
    wire.length = 0
    compiled.length = 0
    await mkdir(base, { recursive: true })
    root = await mkdtemp(path.join(base, 'run-'))
    const registry = new PackageRegistry()
    const security = new PackageSecurityAuthority(path.join(root, 'security.json'))
    runtime = new PackageRuntime(registry, security, path.join(root, 'data'))
    contexts = new ContextRegionRegistry()
    hooks = new PackageHookBus()
    registerExtensionActivators({
      runtime,
      contexts,
      hooks,
      ui: new PackageUiRegistry(),
      assets: new PackageAssets(),
    })
    manager = new PackageManagementService(root, registry, runtime, security, {
      prepare: async () => undefined,
    })
    await manager.initialize()
    await setRegions([
      { content: marker, priority: 999, trust: 'system', delivery: 'system', required: true },
    ])
    await manager.install(
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            manifestVersion: 2,
            packageId,
            name: '上下文回归夹具',
            version: '1.0.0',
            trust: 'user',
            contributions: [{ id: 'context', kind: 'context-provider', entry: 'index.mjs' }],
          }),
        ),
        'index.mjs': strToU8(
          `import { readFile } from 'node:fs/promises';
           export async function provide() {
             return JSON.parse(await readFile(${JSON.stringify(path.join(root, 'regions.json'))}, 'utf8'));
           }`,
        ),
      }),
    )
    const info = manager.list()[0]!
    await manager.authorize(packageId, info.digest, info.requestedPermissions)
    await manager.setEnabled(packageId, true)
  })
  afterEach(async () => {
    invalidatePromptReplay()
    await runtime.shutdown()
    const relative = path.relative(base, root)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('测试清理路径越界')
    await rm(root, { recursive: true, force: true })
  })
}

export async function setRegions(regions: unknown[]) {
  await writeFile(path.join(root, 'regions.json'), JSON.stringify(regions))
}
export function row(id: number, role: 'user' | 'assistant', content: string): ThreadMessageInfo {
  return {
    id,
    role,
    content,
    threadId: 'fixture-thread',
    pairId: `pair-${Math.ceil(id / 2)}`,
    revision: 1,
    metadataJson: '{}',
    timestamp: '2026-10-27 12:00:00',
    agentId: role === 'assistant' ? 'fixture' : null,
    senderId: null,
    rawContent: null,
    status: 'active',
  }
}
export const rows = () => [
  row(1, 'user', '历史问题甲'),
  row(2, 'assistant', '历史答复甲'),
  row(3, 'user', '本轮问题乙'),
]
export type Layout = 'native' | 'sillytavern' | 'legacy'
export async function fixture(layout: Layout, mode: InteractionMode = 'chat') {
  let messages = rows()
  let channel = 'desktop'
  const values = new Map<string, string>()
  const repository = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => {
      values.set(key, value)
    },
    setJson: async (key: string, value: unknown) => {
      values.set(key, JSON.stringify(value))
    },
  }
  // 兼容路径的旧式槽位不渲染历史文本；历史由 compiler 独立追加。
  const legacyPrompts = path.join(root, 'legacy-prompts')
  await mkdir(path.join(legacyPrompts, 'slots'), { recursive: true })
  await writeFile(
    path.join(legacyPrompts, 'slots/100_system.md'),
    '---\nrole: system\nslotId: system_persona\n---\n固定系统前缀',
  )
  const engine = new MdpEngine(
    layout === 'legacy' ? legacyPrompts : path.resolve('packages/backend/src/services/mdp/prompts'),
    path.join(root, 'agents'),
  )
  const compiler = new ContextCompiler(
    {
      getThread: async () => ({
        id: 'fixture-thread',
        agentId: 'fixture',
        channel,
        interactionMode: mode,
        disabledTools: [],
        contextPolicy: JSON.stringify({
          enableStateInjection: false,
          enableToolDescriptions: false,
          enableContinuity: false,
        }),
      }),
      getActiveMessagePairs: async () => messages,
      getWorkingMessagePairs: async () => messages,
      getConversationTimeAnchors: async () => new Map(),
    } as never,
    { getAgent: () => undefined } as never,
    repository as never,
    engine,
    {
      resolve: () => ({ allowedTools: new Set(), promptFragments: [], skillMenuText: '' }),
      isToolAllowedInMode: () => false,
    } as never,
    { get: async () => ({ currentGoal: '', privateFacts: '' }) } as never,
    contexts,
  )
  let workspace: PromptWorkspace | undefined
  if (layout !== 'legacy') {
    workspace = new PromptWorkspace(repository as never, engine)
    await workspace.initialize()
    if (layout === 'sillytavern') {
      const framework: PromptFramework = {
        id: 'fixture.st',
        name: '酒馆回归',
        format: 'sillytavern',
        bindings: [],
        blocks: [
          {
            id: 'main',
            name: '固定系统',
            kind: 'template',
            role: 'system',
            enabled: true,
            template: '固定系统前缀',
          },
          { id: 'history', name: '历史', kind: 'history', role: 'user', enabled: true },
          // 深度 0 的尾注让当前输入不在末尾，防止错误地按最后一条 user 定位。
          {
            id: 'tail',
            name: '尾注',
            kind: 'template',
            role: 'user',
            enabled: true,
            template: '酒馆尾注',
            position: 'in_chat',
            depth: 0,
          },
        ],
        sillyTavern: { markerBindings: {}, values: {} },
      }
      await workspace.save(
        {
          documents: [],
          frameworks: [framework],
          assignments: [{ agentId: '', channel: '', frameworkId: framework.id, overrides: {} }],
        },
        0,
      )
      await workspace.publish(1)
    }
    compiler.setPromptWorkspace(workspace)
  }
  return {
    compiler,
    workspace,
    setRows: (next: ThreadMessageInfo[]) => {
      messages = next
    },
    setChannel: (next: string) => {
      channel = next
    },
  }
}
export async function send(messages: ChatMessage[]) {
  compiled.push(structuredClone(messages))
  const provider = new OpenAiProvider({
    apiBase: `http://127.0.0.1:${port}/v1`,
    apiKey: 'fictional-test-key',
    modelId: 'fake-context-model',
  })
  await provider.chat(messages, { timeout: 3000 })
  return wire.at(-1)!
}
export function count(messages: Array<{ content: unknown }>, text: string) {
  return messages.reduce((sum, message) => sum + String(message.content).split(text).length - 1, 0)
}
export function region(
  provider: string,
  content: string,
  delivery: ContextRegion['delivery'],
): ContextRegion {
  return {
    providerId: provider,
    regionId: `${provider}/fixture`,
    kind: 'custom',
    content,
    trust: 'external',
    required: false,
    priority: 10,
    tokenEstimate: 0,
    contentHash: '',
    sourceObjectRefs: [],
    provenance: {},
    delivery,
  }
}
