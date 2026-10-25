// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RuntimeDebugToggle from '@infos/frontend/components/chat/RuntimeDebugToggle.vue'
const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), toast: vi.fn() }))
vi.mock('@infos/frontend/api/client', () => ({ apiClient: mocks }))
vi.mock('@infos/frontend/stores', () => ({ useNotificationStore: () => ({ toast: mocks.toast }) }))
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.resetAllMocks()
})
describe('当前会话调试按钮', () => {
  it('只允许工作模式开启，读取和切换均绑定当前 Thread', async () => {
    mocks.get.mockResolvedValue({ data: { enabled: false } })
    mocks.put.mockResolvedValue({ data: { enabled: true } })
    const wrapper = mount(RuntimeDebugToggle, {
      props: { threadId: 'thread-a', mode: 'chat', ensureThread: async () => 'thread-a' },
    })
    wrappers.push(wrapper)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(mocks.get).not.toHaveBeenCalled()
    await wrapper.setProps({ mode: 'work' })
    await flushPromises()
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(mocks.put).toHaveBeenCalledWith('/runtime-debug/thread-a', { enabled: true })
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('true')
    await wrapper.setProps({ threadId: 'thread-b' })
    await flushPromises()
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('false')
  })
  it('首次创建 Thread 后开启状态不被旧 GET 请求覆盖', async () => {
    mocks.get.mockResolvedValue({ data: { enabled: false } })
    mocks.put.mockResolvedValue({ data: { enabled: true } })
    const wrapper = mount(RuntimeDebugToggle, {
      props: {
        threadId: null,
        mode: 'work',
        ensureThread: async () => {
          await wrapper.setProps({ threadId: 'created' })
          return 'created'
        },
      },
    })
    wrappers.push(wrapper)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(mocks.put).toHaveBeenCalledWith('/runtime-debug/created', { enabled: true })
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('true')
    expect(wrapper.emitted('change')).toHaveLength(1)
  })
  it('生成过程中仍能关闭已经开启的调试', async () => {
    mocks.get.mockResolvedValue({ data: { enabled: true } })
    mocks.put.mockResolvedValue({ data: { enabled: false } })
    const wrapper = mount(RuntimeDebugToggle, {
      props: {
        threadId: 'thread-a',
        mode: 'work',
        disabled: true,
        ensureThread: async () => 'thread-a',
      },
    })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(mocks.put).toHaveBeenCalledWith('/runtime-debug/thread-a', { enabled: false })
  })
})
