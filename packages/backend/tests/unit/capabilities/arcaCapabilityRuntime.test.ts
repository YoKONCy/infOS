import { describe, expect, it, vi } from 'vitest'
import type { KernelCapabilityOffer, KernelNodeId, KernelObjectId } from '@infos/shared'
import { arcaManifest } from '@infos/arca'
import { ApplicationRealmManager } from '../../../src/applications/applicationRealm'
import { ApplicationToolManager } from '../../../src/applications/applicationToolManager'
import { ArcaCapabilityRuntime } from '../../../src/capabilities/arcaCapabilityRuntime'
import { CapabilityDirectory } from '../../../src/kernel/capabilityDirectory'
import { CapabilityHandleRegistry } from '../../../src/kernel/capabilityHandleRegistry'
import { NodeRegistry } from '../../../src/kernel/nodeRegistry'
import { PlacementResolver } from '../../../src/kernel/placementResolver'
import { ToolRegistry } from '../../../src/services/agent/toolRegistry'

const localNodeId = 'kernel:test' as KernelNodeId
const providerNodeId = 'application:arca-test' as KernelNodeId
const operations = [...arcaManifest.offeredCapabilities[0].operations]

describe('ArcaCapabilityRuntime', () => {
  it('Tool Projection应随在线Offer注册和注销', async () => {
    const handles = new CapabilityHandleRegistry()
    const nodes = new NodeRegistry()
    nodes.registerNode({
      nodeId: providerNodeId,
      displayName: 'Arca Test',
      facets: ['application', 'capability'],
      trust: 'local',
      platform: { os: 'windows', arch: 'x64', runtime: 'node' },
      protocolVersion: 1,
      registeredAt: new Date().toISOString(),
    })
    nodes.connect({ nodeId: providerNodeId, carrier: 'websocket', leaseMs: 60_000 })
    const directory = new CapabilityDirectory(handles, new PlacementResolver(nodes), localNodeId)
    directory.registerDefinition({
      capabilityType: 'document.semantic',
      contractVersion: '1.0',
      operations: Object.fromEntries(
        operations.map((operation) => [operation, { risk: 'interact', idempotency: 'unsafe' }]),
      ),
    })
    const tools = new ToolRegistry()
    const realms = new ApplicationRealmManager(tools)
    const realm = realms.register({
      realmId: 'infos.arca',
      appId: 'infos.arca',
      principalId: 'application:infos.arca',
      instanceId: 'managed',
    })
    const applicationTools = new ApplicationToolManager()
    const runtime = new ArcaCapabilityRuntime(
      directory,
      handles,
      applicationTools.declare(realm, arcaManifest),
      localNodeId,
      arcaManifest,
    )

    await runtime.start()
    expect(tools.has('arca_document_inspect')).toBe(false)

    const invoke = vi.fn(async () => ({ revisionId: 'revision-1' }))
    const offer: KernelCapabilityOffer = {
      offerId: 'arca-document@test',
      provider: {
        objectType: 'capability-provider',
        objectId: 'arca-document/provider' as KernelObjectId,
        generation: 1,
        ownerPrincipalId: 'application:infos.arca',
        authorityNodeId: providerNodeId,
        authorityEpoch: 1,
      },
      capabilityType: 'document.semantic',
      contractVersion: '1.0',
      operations,
      resourceKinds: ['document'],
      health: 'available',
      placement: {
        providerNodeId,
        providerFacet: 'capability',
        executionLocation: 'node-local',
        resourceAuthorityNodeId: providerNodeId,
        requiresClientPresence: false,
        supportsHeadless: true,
        dataResidency: 'node-only',
        latencyClass: 'local',
        costClass: 'free',
      },
    }
    const remove = directory.registerRemoteProvider(offer, invoke)
    await vi.waitFor(() => expect(tools.has('arca_document_inspect')).toBe(true))

    expect(runtime.available()).toBe(true)
    expect(tools.has('arca_document_inspect')).toBe(true)
    expect(realms.isHostProjection('arca_document_inspect')).toBe(true)
    expect(realms.isPrivateTool('arca_document_inspect')).toBe(false)
    expect(tools.getDefinition('arca_changeset_propose')?.requiresApproval).toBe(true)
    expect(applicationTools.get('arca_document_inspect')?.appId).toBe('infos.arca')

    remove()
    await vi.waitFor(() => expect(tools.has('arca_document_inspect')).toBe(false))

    expect(runtime.available()).toBe(false)
    expect(tools.has('arca_document_inspect')).toBe(false)
    expect(realms.ownsTool('arca_document_inspect')).toBe(false)
    // 下线后整条移除，不常驻工具列表。
    expect(applicationTools.list()).toEqual([])

    await runtime.stop()
    await realms.shutdown()
  })
})
