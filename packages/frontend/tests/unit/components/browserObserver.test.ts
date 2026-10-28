// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserObserverFrame, BrowserObserverSession } from '@infos/shared'
import BrowserObserver from '@infos/frontend/components/chat/BrowserObserver.vue'
import { applyLanguage } from '@infos/frontend/i18n'

const api = vi.hoisted(() => ({ sessions: vi.fn(), frame: vi.fn() }))
vi.mock('@infos/frontend/api/modules/browserObserverApi', () => ({ browserObserverApi: api }))
const wrappers: Array<ReturnType<typeof mount>> = []
const session: BrowserObserverSession = {
  id: 'watch-1',
  agentId: 'pero',
  threadId: 'thread-1',
  requestedVisible: true,
  available: true,
  updatedAt: 1,
}
beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  applyLanguage('zh-CN')
  api.sessions.mockResolvedValue({ data: [session] })
  api.frame.mockResolvedValue({ data: { state: 'live', dataUri: 'data:image/jpeg;base64,YWJj' } })
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  api.sessions.mockReset()
  api.frame.mockReset()
})
function create() {
  const wrapper = mount(BrowserObserver, {
    props: { agentId: 'pero', threadId: 'thread-1' },
    global: { stubs: { Teleport: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('只读浏览器旁观小窗', () => {
  it('手动收起停止取帧，Agent 后续请求展开也不覆盖用户选择', async () => {
    const wrapper = create()
    await flushPromises()
    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,YWJj')
    await wrapper.get('[aria-label="收起小窗"]').trigger('click')
    api.sessions.mockResolvedValue({
      data: [{ ...session, id: 'watch-reconnected', updatedAt: 2 }],
    })
    const captured = api.frame.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(api.frame.mock.calls.length).toBe(captured)
    expect(wrapper.find('.browser-observer').exists()).toBe(false)
    expect(wrapper.get('.browser-observer-launcher').text()).toBe('查看浏览器')
    await wrapper.get('.browser-observer-launcher').trigger('click')
    await flushPromises()
    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,YWJj')
  })

  it('缩放仅改变小窗尺寸，不向浏览器传递视口或输入', async () => {
    const wrapper = create()
    await flushPromises()
    const panel = wrapper.get('.browser-observer').element as HTMLElement
    const initialWidth = parseFloat(panel.style.width)
    await wrapper.get('[aria-label="放大小窗"]').trigger('click')
    expect(
      parseFloat((wrapper.get('.browser-observer').element as HTMLElement).style.width),
    ).toBeGreaterThan(initialWidth)
    expect(wrapper.get('img').attributes('draggable')).toBe('false')
    expect(api.frame).toHaveBeenCalledWith('watch-1', 'pero', 'thread-1', expect.any(AbortSignal))
    expect(api.frame).toHaveBeenCalledTimes(1)
  })

  it('切换会话后丢弃旧请求返回的画面，并中止旧轮询', async () => {
    let resolve!: (value: { data: BrowserObserverFrame }) => void
    api.frame.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const wrapper = create()
    await flushPromises()
    const signal = api.frame.mock.calls[0]![3] as AbortSignal
    api.sessions.mockResolvedValue({ data: [] })
    await wrapper.setProps({ threadId: 'thread-2' })
    resolve({ data: { state: 'live', dataUri: 'data:image/jpeg;base64,YWJj' } })
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.browser-observer').exists()).toBe(false)
  })
})
