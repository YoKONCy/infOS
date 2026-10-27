// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceTree from '../../src/components/workspace/WorkspaceTree.vue'

const api = vi.hoisted(() => ({ listDir: vi.fn(), search: vi.fn() }))
vi.mock('../../src/api/modules/approvalsApi', () => ({ workspaceApi: api }))
vi.mock('../../src/stores', () => ({ useNotificationStore: () => ({ toast: vi.fn() }) }))
vi.mock('../../src/components/pixel', () => ({
  PixelIcon: { template: '<span />' },
  PDialog: { template: '<span />' },
}))
const wrappers: ReturnType<typeof mount>[] = []
const props = { agentId: 'pero', agentName: 'Pero', threadId: 'thread-a' }
const file = (name: string) => ({ name, path: name, type: 'file' })
const listing = (nodes = [file('a.txt')], root = 'C:/workspace') => ({ data: { nodes, root } })
async function view() {
  const wrapper = mount(WorkspaceTree, { props })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  api.listDir.mockImplementation(async () => listing())
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.useRealTimers()
})

describe('工作区资源树自动同步', () => {
  it('可见时刷新外部变化，后台暂停，回来立即刷新', async () => {
    const wrapper = await view()
    api.listDir.mockResolvedValue(listing([file('new.txt')]))
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(wrapper.text()).toContain('new.txt')
    await wrapper.setProps({ active: false })
    const count = api.listDir.mock.calls.length
    await vi.advanceTimersByTimeAsync(20000)
    expect(api.listDir).toHaveBeenCalledTimes(count)
    await wrapper.setProps({ active: true })
    await flushPromises()
    expect(api.listDir.mock.calls.length).toBeGreaterThan(count)
    const beforeFocus = api.listDir.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(api.listDir.mock.calls.length).toBeGreaterThan(beforeFocus)
  })
  it('只刷新展开目录，并保留已展开状态', async () => {
    let children = [file('folder/old.txt')]
    api.listDir.mockImplementation(async (_scope, path) =>
      path
        ? listing(children)
        : listing([{ name: 'folder', path: 'folder', type: 'directory' }] as never),
    )
    const wrapper = await view()
    expect(api.listDir).toHaveBeenCalledTimes(1)
    await wrapper.get('.tree-row').trigger('click')
    await flushPromises()
    children = [file('folder/new.txt')]
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(wrapper.text()).toContain('folder/new.txt')
    expect(wrapper.text()).not.toContain('folder/old.txt')
    expect(wrapper.findAll('.tree-row')).toHaveLength(2)
  })
  it('会话切换后旧请求不能覆盖新文件树', async () => {
    let finish!: (value: unknown) => void
    api.listDir.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = await view()
    api.listDir.mockResolvedValue(listing([file('other.txt')], 'C:/other'))
    await wrapper.setProps({ agentId: 'other', threadId: 'thread-b' })
    await flushPromises()
    finish(listing([file('stale.txt')]))
    await flushPromises()
    expect(wrapper.text()).toContain('other.txt')
    expect(wrapper.text()).not.toContain('stale.txt')
  })
  it('连续刷新合并为一个在途请求和一次补刷，失败后退避重试', async () => {
    let finish!: (value: unknown) => void
    api.listDir.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = await view()
    const exposed = wrapper.vm as unknown as { refresh: () => Promise<void> }
    void exposed.refresh()
    void exposed.refresh()
    void exposed.refresh()
    expect(api.listDir).toHaveBeenCalledTimes(1)
    finish(listing())
    await flushPromises()
    expect(api.listDir).toHaveBeenCalledTimes(2)
    api.listDir.mockRejectedValueOnce(new Error('暂时离线'))
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(wrapper.text()).toContain('将自动重试')
    const count = api.listDir.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.listDir).toHaveBeenCalledTimes(count)
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(wrapper.text()).not.toContain('将自动重试')
  })
  it('系统文件管理器按钮交给父级安全打开，重复打开期间禁用', async () => {
    const wrapper = await view()
    expect(wrapper.find('button[aria-label="在系统文件管理器中打开工作区"]').exists()).toBe(false)
    await wrapper.setProps({ allowReveal: true })
    const open = wrapper.get('button[aria-label="在系统文件管理器中打开工作区"]')
    await open.trigger('click')
    expect(wrapper.emitted('reveal')).toHaveLength(1)
    await wrapper.setProps({ opening: true })
    expect(open.attributes('disabled')).toBeDefined()
    await open.trigger('click')
    expect(wrapper.emitted('reveal')).toHaveLength(1)
  })
  it('页面隐藏时暂停，卸载后停止轮询', async () => {
    const wrapper = await view()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    const count = api.listDir.mock.calls.length
    await vi.advanceTimersByTimeAsync(30000)
    expect(api.listDir).toHaveBeenCalledTimes(count)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(api.listDir.mock.calls.length).toBeGreaterThan(count)
    wrapper.unmount()
    const afterUnmount = api.listDir.mock.calls.length
    await vi.advanceTimersByTimeAsync(30000)
    expect(api.listDir).toHaveBeenCalledTimes(afterUnmount)
  })
})
