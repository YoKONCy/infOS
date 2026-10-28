import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type {
  BrowserObserverFrame,
  KernelCapabilityOffer,
  KernelNodeId,
  KernelObjectId,
} from '@infos/shared'
import { CapabilityDirectory } from '../../../src/kernel/capabilityDirectory'
import type { CapabilityProviderInvoke } from '../../../src/kernel/capabilityDirectory'
import { CapabilityHandleRegistry } from '../../../src/kernel/capabilityHandleRegistry'
import { NodeRegistry } from '../../../src/kernel/nodeRegistry'
import { PlacementResolver } from '../../../src/kernel/placementResolver'
import { BrowserToolRuntime } from '../../../src/capabilities/browserToolRuntime'
import { WEB_PAGE_CAPABILITY } from '../../../src/capabilities/nativeCapabilityDefinitions'
import { ToolRegistry } from '../../../src/services/agent/toolRegistry'
import { createBrowserObserverRouter } from '../../../src/routers/browserObserver.router'
import { errorHandler } from '../../../src/middleware/errorHandler'
import type { AppContext } from '../../../src/container'

const fixtures: BrowserToolRuntime[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((runtime) => runtime.stop()))
})
const owner = {
  source: 'desktop',
  channel: 'desktop',
  agentId: 'pero',
  threadId: 'thread-1',
  sessionId: 'thread-1',
}

async function setup(capture: () => Promise<BrowserObserverFrame>) {
  const localNodeId = 'kernel:test' as KernelNodeId
  const nodeId = 'electron:test' as KernelNodeId
  const handles = new CapabilityHandleRegistry()
  const nodes = new NodeRegistry()
  nodes.registerNode({
    nodeId,
    displayName: 'Electron',
    facets: ['client', 'capability'],
    trust: 'local',
    platform: { os: 'windows', arch: 'x64', runtime: 'electron' },
    protocolVersion: 1,
    registeredAt: new Date().toISOString(),
  })
  nodes.connect({ nodeId, carrier: 'websocket', leaseMs: 60_000 })
  const directory = new CapabilityDirectory(handles, new PlacementResolver(nodes), localNodeId)
  directory.registerDefinition(WEB_PAGE_CAPABILITY)
  const invoke = vi.fn<CapabilityProviderInvoke>(async (envelope) =>
    envelope.payload.operation === 'observeFrame' ? capture() : {},
  )
  const offer: KernelCapabilityOffer = {
    offerId: 'electron.web-page@test',
    provider: {
      objectType: 'capability-provider',
      objectId: 'browser/provider' as KernelObjectId,
      generation: 1,
      ownerPrincipalId: 'electron',
      authorityNodeId: nodeId,
      authorityEpoch: 1,
    },
    capabilityType: 'web.page',
    contractVersion: '1.0',
    operations: ['open', 'observeFrame'],
    resourceKinds: ['web-page'],
    health: 'available',
    placement: {
      providerNodeId: nodeId,
      providerFacet: 'capability',
      executionLocation: 'client-local',
      resourceAuthorityNodeId: nodeId,
      requiresClientPresence: true,
      supportsHeadless: false,
      dataResidency: 'device-only',
      latencyClass: 'local',
      costClass: 'free',
    },
  }
  const remove = directory.registerRemoteProvider(offer, invoke)
  const tools = new ToolRegistry()
  const runtime = new BrowserToolRuntime(directory, handles, tools, localNodeId)
  fixtures.push(runtime)
  await runtime.start()
  await tools.getHandler('browser_open_url')!({ url: 'example.com', preview: true }, owner)
  return {
    runtime,
    tools,
    invoke,
    remove,
    reconnect: () => directory.registerRemoteProvider(offer, invoke),
  }
}

describe('浏览器只读旁观', () => {
  it('发现会话不采集画面，跨角色或会话请求不能读取帧', async () => {
    const capture = vi.fn(async (): Promise<BrowserObserverFrame> => ({ state: 'closed' }))
    const { runtime } = await setup(capture)
    const [session] = runtime.listObservations('pero', 'thread-1')
    expect(session).toMatchObject({ agentId: 'pero', threadId: 'thread-1', requestedVisible: true })
    expect(runtime.listObservations('other', 'thread-1')).toEqual([])
    expect(await runtime.observe(session!.id, 'pero', 'thread-2')).toEqual({ state: 'paused' })
    expect(await runtime.observe(session!.id, 'other', 'thread-1')).toEqual({ state: 'paused' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('并发观看共享采集，输出去除操作截图引用，节点离线停止取帧', async () => {
    let resolve!: (frame: BrowserObserverFrame) => void
    const capture = vi.fn(
      () =>
        new Promise<BrowserObserverFrame>((done) => {
          resolve = done
        }),
    )
    const { runtime, invoke, remove } = await setup(capture)
    const [session] = runtime.listObservations('pero', 'thread-1')
    const first = runtime.observe(session!.id, 'pero', 'thread-1')
    const second = runtime.observe(session!.id, 'pero', 'thread-1')
    resolve({
      state: 'live',
      dataUri: 'data:image/jpeg;base64,YWJj',
      width: 960,
      height: 540,
      screenshotId: '不能离开操作链路',
    } as BrowserObserverFrame)
    const results = await Promise.all([first, second])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ state: 'live', dataUri: 'data:image/jpeg;base64,YWJj' })
    expect(results[0]).not.toHaveProperty('screenshotId')
    expect(capture).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls.at(-1)![0]).toMatchObject({
      principalId: 'pero',
      payload: {
        operation: 'observeFrame',
        input: {
          __browserScope: {
            principalId: 'pero',
            profileId: 'desktop',
            sessionId: '["thread-1",null]',
          },
        },
      },
    })
    remove()
    await vi.waitFor(() =>
      expect(runtime.listObservations('pero', 'thread-1')[0]?.available).toBe(false),
    )
    expect(await runtime.observe(session!.id, 'pero', 'thread-1')).toEqual({ state: 'paused' })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('HTTP 读取重新验证会话归属，错误归属不会调用取帧', async () => {
    const capture = vi.fn(async (): Promise<BrowserObserverFrame> => ({ state: 'closed' }))
    const { runtime } = await setup(capture)
    const [session] = runtime.listObservations('pero', 'thread-1')
    const app = new Hono().onError(errorHandler)
    app.route(
      '/',
      createBrowserObserverRouter({
        browserTools: runtime,
        threadService: { getThread: async () => ({ agentId: 'other' }) },
      } as unknown as AppContext),
    )
    const response = await app.request(
      `/sessions/${session!.id}/frame?agentId=pero&threadId=thread-1`,
    )
    expect(response.status).toBe(403)
    expect(capture).not.toHaveBeenCalled()
  })

  it('当前对话只发现自身及其交办任务，不带回其他对话的任务画面', async () => {
    const capture = vi.fn(async (): Promise<BrowserObserverFrame> => ({ state: 'closed' }))
    const { runtime, tools } = await setup(capture)
    const open = tools.getHandler('browser_open_url')!
    await open(
      { url: 'example.com', preview: true },
      { ...owner, threadId: 'task-thread', taskId: 'task-1' },
    )
    await open(
      { url: 'example.com', preview: true },
      { ...owner, threadId: 'foreign-task-thread', taskId: 'task-2' },
    )
    const tasks = {
      'task-1': {
        id: 'task-1',
        agentId: 'pero',
        threadId: 'task-thread',
        targetThreadId: 'thread-1',
      },
      'task-2': {
        id: 'task-2',
        agentId: 'pero',
        threadId: 'foreign-task-thread',
        targetThreadId: 'thread-2',
      },
    }
    const app = new Hono().onError(errorHandler)
    app.route(
      '/',
      createBrowserObserverRouter({
        browserTools: runtime,
        threadService: { getThread: async () => ({ agentId: 'pero' }) },
        backgroundTaskRepo: { findById: async (id: keyof typeof tasks) => tasks[id] ?? null },
      } as unknown as AppContext),
    )
    const response = await app.request('/sessions?agentId=pero&threadId=thread-1')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.data.map((item: { threadId: string }) => item.threadId).sort()).toEqual([
      'task-thread',
      'thread-1',
    ])
    expect(capture).not.toHaveBeenCalled()
  })

  it('拒绝节点返回的非 JPEG 画面，不把任意内容带入客户端', async () => {
    const { runtime } = await setup(async () => ({
      state: 'live',
      dataUri: 'data:text/html;base64,YWJj',
    }))
    const [session] = runtime.listObservations('pero', 'thread-1')
    expect(await runtime.observe(session!.id, 'pero', 'thread-1')).toEqual({ state: 'paused' })
  })

  it('同一节点重连后恢复原会话，不要求 Agent 再调用浏览器工具', async () => {
    const capture = vi.fn(
      async (): Promise<BrowserObserverFrame> => ({
        state: 'live',
        dataUri: 'data:image/jpeg;base64,YWJj',
      }),
    )
    const { runtime, remove, reconnect } = await setup(capture)
    const [session] = runtime.listObservations('pero', 'thread-1')
    remove()
    await vi.waitFor(() =>
      expect(runtime.listObservations('pero', 'thread-1')[0]?.available).toBe(false),
    )
    reconnect()
    await vi.waitFor(() =>
      expect(runtime.listObservations('pero', 'thread-1')[0]?.available).toBe(true),
    )
    expect(await runtime.observe(session!.id, 'pero', 'thread-1')).toMatchObject({
      state: 'live',
      dataUri: 'data:image/jpeg;base64,YWJj',
    })
  })
})
