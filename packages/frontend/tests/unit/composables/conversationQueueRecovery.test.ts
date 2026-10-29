// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { ApiError } from '@infos/frontend/api/errors'
import { useConversationQueue } from '@infos/frontend/composables/chat/useConversationQueue'

const api = vi.hoisted(() => ({ queue: vi.fn(), session: vi.fn(), enqueue: vi.fn() }))
const history = vi.hoisted(() => ({ loadThreadMessages: vi.fn(), finishStreaming: vi.fn() }))
vi.mock('@infos/frontend/api/modules/chatApi', () => ({
  chatApi: { queue: api.queue, enqueue: api.enqueue },
}))
vi.mock('@infos/frontend/api/modules/clientAccessApi', () => ({
  clientAccessApi: { session: api.session },
}))
vi.mock('@infos/frontend/api/transport', () => ({
  getClientToken: () => 'credential',
  isLocalBackendRuntime: () => true,
}))
vi.mock('@infos/frontend/composables/gateway/useGateway', () => ({ useGateway: () => ({}) }))
vi.mock('@infos/frontend/stores', () => ({
  useThreadStore: () => ({ threadId: 'thread', agentId: 'pero', messages: [], ...history }),
  useNotificationStore: () => ({}),
  useCompositorStore: () => ({}),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('消息队列反馈与鉴权恢复', () => {
  it('入队后立即失败且未收到实时帧，也读取已保存的原文与错误', async () => {
    vi.useFakeTimers()
    api.queue.mockResolvedValue({
      data: { threadId: 'thread', active: false, paused: true, items: [] },
    })
    api.enqueue.mockResolvedValue({
      data: { threadId: 'thread', active: false, paused: true, items: [] },
    })
    let queue!: ReturnType<typeof useConversationQueue>
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
      expect(history.loadThreadMessages).not.toHaveBeenCalled()
      await expect(
        queue.enqueue({ threadId: 'thread', agentId: 'pero', content: '请保存原文' }),
      ).resolves.toBe(true)
      await flushPromises()
      expect(history.loadThreadMessages).toHaveBeenCalledWith('thread', 'pero')
      expect(history.finishStreaming).toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

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
