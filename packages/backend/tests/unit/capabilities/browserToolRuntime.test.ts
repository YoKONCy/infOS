import { describe, expect, it, vi } from 'vitest'
import type { KernelCapabilityOffer, KernelNodeId, KernelObjectId } from '@infos/shared'
import { CapabilityDirectory } from '../../../src/kernel/capabilityDirectory'
import { CapabilityHandleRegistry } from '../../../src/kernel/capabilityHandleRegistry'
import { NodeRegistry } from '../../../src/kernel/nodeRegistry'
import { PlacementResolver } from '../../../src/kernel/placementResolver'
import { BrowserToolRuntime } from '../../../src/capabilities/browserToolRuntime'
import { WEB_PAGE_CAPABILITY } from '../../../src/capabilities/nativeCapabilityDefinitions'
import { ToolRegistry } from '../../../src/services/agent/toolRegistry'

const localNodeId = 'kernel:test' as KernelNodeId
const providerNodeId = 'electron:test' as KernelNodeId

describe('BrowserToolRuntime', () => {
  it('应只在真实 web.page Offer在线时注册浏览器工具', async () => {
    const handles = new CapabilityHandleRegistry()
    const nodes = new NodeRegistry()
    nodes.registerNode({
      nodeId: providerNodeId,
      displayName: 'Electron Test',
      facets: ['client', 'capability'],
      trust: 'local',
      platform: { os: 'windows', arch: 'x64', runtime: 'electron' },
      protocolVersion: 1,
      registeredAt: new Date().toISOString(),
    })
    nodes.connect({ nodeId: providerNodeId, carrier: 'websocket', leaseMs: 60_000 })
    const directory = new CapabilityDirectory(handles, new PlacementResolver(nodes), localNodeId)
    directory.registerDefinition(WEB_PAGE_CAPABILITY)
    const invoke = vi.fn(async (envelope) => ({
      operation: envelope.payload.operation,
      input: envelope.payload.input,
    }))
    const tools = new ToolRegistry()
    const runtime = new BrowserToolRuntime(directory, handles, tools, localNodeId)

    await runtime.start()
    expect(tools.has('browser_open_url')).toBe(false)

    const offer: KernelCapabilityOffer = {
      offerId: 'electron.web-page@test',
      provider: {
        objectType: 'capability-provider',
        objectId: 'electron.web-page/provider' as KernelObjectId,
        generation: 1,
        ownerPrincipalId: 'electron-client',
        authorityNodeId: providerNodeId,
        authorityEpoch: 1,
      },
      capabilityType: 'web.page',
      contractVersion: '1.0',
      operations: ['open', 'runtimeStatus'],
      resourceKinds: ['web-page'],
      health: 'available',
      placement: {
        providerNodeId,
        providerFacet: 'capability',
        executionLocation: 'client-local',
        resourceAuthorityNodeId: providerNodeId,
        requiresClientPresence: true,
        supportsHeadless: false,
        dataResidency: 'device-only',
        latencyClass: 'local',
        costClass: 'free',
      },
    }
    const remove = directory.registerRemoteProvider(offer, invoke)
    await vi.waitFor(() => expect(tools.has('browser_open_url')).toBe(true))
    expect(tools.has('browser_open_url')).toBe(true)
    expect(tools.has('browser_upload')).toBe(false)

    const handler = tools.getHandler('browser_open_url')!
    const output = await handler(
      { url: 'example.com' },
      {
        source: 'desktop',
        agentId: 'agent:test',
        sessionId: 'thread:test',
        threadId: 'thread:test',
        channel: 'desktop',
      },
    )

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: 'agent:test',
        payload: {
          operation: 'open',
          input: {
            url: 'https://example.com',
            __browserScope: {
              profileId: 'desktop',
              sessionId: '["thread:test",null]',
              principalId: 'agent:test',
            },
          },
        },
      }),
      undefined,
    )
    expect(String(output)).toContain('open')

    remove()
    await vi.waitFor(() => expect(tools.has('browser_open_url')).toBe(false))
    expect(tools.has('browser_open_url')).toBe(false)

    await runtime.stop()
  })
})
