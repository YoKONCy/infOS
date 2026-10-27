// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { ApiError } from '@infos/frontend/api/errors'
import { useConversationQueue } from '@infos/frontend/composables/chat/useConversationQueue'

const api = vi.hoisted(() => ({ queue: vi.fn(), session: vi.fn() }))
vi.mock('@infos/frontend/api/modules/chatApi', () => ({ chatApi: { queue: api.queue } }))
vi.mock('@infos/frontend/api/modules/clientAccessApi', () => ({
  clientAccessApi: { session: api.session },
}))
vi.mock('@infos/frontend/api/transport', () => ({
  getClientToken: () => 'credential',
  isLocalBackendRuntime: () => true,
}))
vi.mock('@infos/frontend/composables/gateway/useGateway', () => ({ useGateway: () => ({}) }))
vi.mock('@infos/frontend/stores', () => ({
  useThreadStore: () => ({ threadId: 'thread', agentId: 'pero', messages: [] }),
  useNotificationStore: () => ({}),
  useCompositorStore: () => ({}),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('消息队列鉴权恢复', () => {
  it('401 后停止业务轮询，只在公开状态确认恢复后继续读取队列', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    api.queue.mockResolvedValue({
      data: { threadId: 'thread', active: false, paused: false, items: [] },
    })
    api.queue.mockRejectedValueOnce(new ApiError('UNAUTHORIZED', '未授权'))
    api.session.mockResolvedValue({ data: { authenticated: false } })
    let queue: ReturnType<typeof useConversationQueue> | undefined
    const wrapper = mount(
      defineComponent({
        setup() {
          queue = useConversationQueue()
          return () => null
        },
      }),
    )
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(4000)
      expect(api.queue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(api.session).toHaveBeenCalledTimes(1)
      expect(api.queue).toHaveBeenCalledTimes(1)
      api.session.mockResolvedValue({ data: { authenticated: true } })
      await vi.advanceTimersByTimeAsync(6000)
      expect(api.queue).toHaveBeenCalledTimes(2)
      expect(queue?.unavailable.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })
})
