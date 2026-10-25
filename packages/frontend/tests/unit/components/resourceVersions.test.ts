// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ResourceVersionsPane from '@infos/frontend/components/integrations/ResourceVersionsPane.vue'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }))
vi.mock('@infos/frontend/api/client', () => ({ apiClient: mocks }))
vi.mock('@infos/frontend/utils/ipcAdapter', () => ({ isElectron: () => false, invoke: vi.fn() }))
const wrappers: Array<ReturnType<typeof mount>> = []
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.resetAllMocks()
})
describe('资源版本由用户确认应用', () => {
  it('读取与查看候选不调用应用接口，确认后仅登记切换', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    mocks.get.mockResolvedValue({
      data: {
        safeMode: false,
        interrupted: false,
        pending: [],
        revisions: [
          {
            id,
            kind: 'skills',
            state: 'draft',
            candidateDirectory: '/隔离候选目录',
            createdAt: '2026-10-24T00:00:00Z',
            baseDigest: 'a',
          },
        ],
      },
    })
    mocks.post.mockResolvedValue({ code: 'OK' })
    const wrapper = mount(ResourceVersionsPane, { global: { stubs: { teleport: true } } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(mocks.post).not.toHaveBeenCalled()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '应用并等待重启')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('确认资源切换')
    expect(mocks.post).not.toHaveBeenCalled()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '确定')!
      .trigger('click')
    await flushPromises()
    expect(mocks.post).toHaveBeenCalledWith(`/resource-versions/${id}/apply`)
  })
})
