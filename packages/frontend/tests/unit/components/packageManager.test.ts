// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PackageManagerPane from '@infos/frontend/components/integrations/PackageManagerPane.vue'
import PackageSlot from '@infos/frontend/components/integrations/PackageSlot.vue'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  install: vi.fn(),
  enabled: vi.fn(),
  authorize: vi.fn(),
  reload: vi.fn(),
  rollback: vi.fn(),
  review: vi.fn(),
  uninstall: vi.fn(),
  panels: vi.fn(),
  action: vi.fn(),
}))
vi.mock('@infos/frontend/api/modules/packagesApi', () => ({ packagesApi: mocks }))
const wrappers: Array<ReturnType<typeof mount>> = []
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.resetAllMocks()
})

describe('插件管理与声明式 UI', () => {
  it('启用前展示该版本申请的权限，由明确确认触发授权和启用', async () => {
    mocks.list.mockResolvedValue({
      data: [
        {
          manifest: {
            packageId: 'fixture.plugin',
            name: '夹具插件',
            version: '1.0.0',
            contributions: [],
          },
          enabled: false,
          authorized: false,
          state: 'installed',
          digest: 'a'.repeat(64),
          requestedPermissions: ['runtime:execute'],
        },
      ],
    })
    mocks.panels.mockResolvedValue({ data: [] })
    const wrapper = mount(PackageManagerPane, { global: { stubs: { teleport: true } } })
    wrappers.push(wrapper)
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '启用')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('审核插件权限')
    expect(mocks.authorize).not.toHaveBeenCalled()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '确定')!
      .trigger('click')
    await flushPromises()
    expect(mocks.authorize).toHaveBeenCalledWith('fixture.plugin', 'a'.repeat(64), [
      'runtime:execute',
    ])
    expect(mocks.enabled).toHaveBeenCalledWith('fixture.plugin', true)
  })
  it('声明式面板将脚本文字按文本渲染，操作仅传面板 ID 和动作 ID', async () => {
    mocks.panels.mockResolvedValue({
      data: [
        {
          id: 'fixture/panel',
          packageId: 'fixture',
          slot: 'chat.footer',
          title: '扩展面板',
          text: '<img src=x onerror=alert(1)>',
          actions: [{ id: 'run', label: '执行' }],
        },
      ],
    })
    const wrapper = mount(PackageSlot, { props: { region: 'chat.footer' } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(mocks.action).toHaveBeenCalledWith('fixture/panel', 'run')
  })
})
