// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { h, KeepAlive, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSocialConnectionStatus } from '../../src/composables/social/useSocialConnectionStatus'
import { ApiError } from '../../src/api/errors'

const api = vi.hoisted(() => ({ getStatus: vi.fn() }))
vi.mock('../../src/api/modules/socialApi', () => ({ socialApi: api }))
const wrappers: Array<{ unmount: () => void }> = []
const response = (connected: boolean) => ({ data: { adapters: [{ platform: 'qq', connected }] } })
const Status = {
  setup: () => useSocialConnectionStatus(() => 'qq'),
  template:
    '<div>{{ connected ? "已连接" : "未连接" }}<p v-if="error" role="alert">{{ error }}</p></div>',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  api.getStatus.mockResolvedValue(response(false))
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.useRealTimers()
})

describe('NapCat 连接状态刷新', () => {
  it('扫码连接后自动更新状态，不需要重新打开页面', async () => {
    const wrapper = mount(Status)
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.text()).toBe('未连接')
    api.getStatus.mockResolvedValue(response(true))
    await vi.advanceTimersByTimeAsync(5000)
    expect(wrapper.text()).toBe('已连接')
  })

  it('慢请求期间不重复查询，手动检查等待同一个结果并返回服务就绪状态', async () => {
    let finish!: (value: unknown) => void
    api.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = mount(Status)
    wrappers.push(wrapper)
    const pending = (
      wrapper.vm as unknown as ReturnType<typeof useSocialConnectionStatus>
    ).refresh()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(api.getStatus).toHaveBeenCalledTimes(1)
    finish(response(false))
    await expect(pending).resolves.toBe(true)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('KeepAlive 隐藏时暂停，激活后丢弃旧请求结果', async () => {
    let finish!: (value: unknown) => void
    api.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const shown = ref(true)
    const placeholder = { render: () => h('div') }
    const wrapper = mount({
      render: () =>
        h(KeepAlive, null, {
          default: () =>
            shown.value ? h(Status, { key: 'status' }) : h(placeholder, { key: 'other' }),
        }),
    })
    wrappers.push(wrapper)
    shown.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.getStatus).toHaveBeenCalledTimes(1)
    api.getStatus.mockResolvedValue(response(true))
    shown.value = true
    await nextTick()
    await flushPromises()
    finish(response(false))
    await flushPromises()
    expect(wrapper.text()).toBe('已连接')
  })

  it('社交服务不可用显示原因，权限错误停止自动轮询', async () => {
    api.getStatus.mockRejectedValueOnce(new ApiError('FORBIDDEN', '不可访问'))
    const wrapper = mount(Status)
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text().trim()).not.toBe('')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(api.getStatus).toHaveBeenCalledTimes(1)
  })
})
