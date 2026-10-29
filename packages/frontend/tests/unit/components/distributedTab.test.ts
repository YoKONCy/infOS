// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DistributedTab from '@infos/frontend/components/dashboard/tabs/DistributedTab.vue'
import { ApiError } from '@infos/frontend/api/errors'

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  servers: vi.fn(),
  pending: vi.fn(),
  capabilityNodes: vi.fn(),
  toast: vi.fn(),
}))
vi.mock('@infos/frontend/api/modules/distributedApi', () => ({
  distributedApi: {
    identity: mocks.identity,
    servers: mocks.servers,
    pending: mocks.pending,
    capabilityNodes: mocks.capabilityNodes,
  },
}))
vi.mock('@infos/frontend/stores', () => ({ useNotificationStore: () => ({ toast: mocks.toast }) }))
vi.mock('@infos/frontend/components/connection/ClientAccessSettings.vue', () => ({
  default: { name: 'ClientAccessSettings', render: () => null },
}))

afterEach(() => vi.clearAllMocks())

describe('分布式页面的普通设备视图', () => {
  it('同步管理接口拒绝普通设备时仍显示当前服务器与能力节点，并提示需要管理员', async () => {
    mocks.identity.mockResolvedValue({
      data: { serverId: 'home-server', displayName: '家里的服务器', appVersion: '0.9.7' },
    })
    mocks.capabilityNodes.mockResolvedValue({
      data: {
        nodes: [{ nodeId: 'pc', facets: ['capability'] }],
        sessions: [{ sessionId: 's1', nodeId: 'pc', health: 'online', leaseExpiresAt: '' }],
        offers: [],
      },
    })
    const forbidden = new ApiError('FORBIDDEN', '请使用管理员凭据管理分布式同步')
    mocks.servers.mockRejectedValue(forbidden)
    mocks.pending.mockRejectedValue(forbidden)

    const wrapper = mount(DistributedTab)
    await flushPromises()

    expect(wrapper.text()).toContain('家里的服务器')
    expect(wrapper.text()).toContain('home-server')
    expect(wrapper.find('.capability-summary').text()).toContain('1')
    expect(wrapper.text()).toContain('服务器管理与完整同步需要管理员凭据')
    // 普通设备不再看到会被服务端拒绝的添加、同步入口
    expect(wrapper.find('.server-form').exists()).toBe(false)
    expect(wrapper.find('.server-list').exists()).toBe(false)
  })

  it('管理员身份照常显示服务器管理入口，不出现权限提示', async () => {
    mocks.identity.mockResolvedValue({ data: { serverId: 'a', displayName: 'A', appVersion: '1' } })
    mocks.capabilityNodes.mockResolvedValue({ data: { nodes: [], sessions: [], offers: [] } })
    mocks.servers.mockResolvedValue({ data: [] })
    mocks.pending.mockResolvedValue({ data: { pending: null, lastSync: null } })

    const wrapper = mount(DistributedTab)
    await flushPromises()

    expect(wrapper.find('.server-form').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('服务器管理与完整同步需要管理员凭据')
  })
})
