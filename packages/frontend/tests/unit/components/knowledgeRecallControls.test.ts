// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import KnowledgeRecallControls from '../../../src/components/knowledge/KnowledgeRecallControls.vue'

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock('../../../src/api/modules/knowledgeApi', () => ({
  knowledgeApi: { recallSettings: mocks.load, saveRecallSettings: mocks.save },
}))
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue({ data: { documentAutoRecall: false, factAutoRecall: false } })
  mocks.save.mockImplementation(async (settings) => ({ data: settings }))
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('资料自动召回控制', () => {
  it('默认关闭，切换文档与事实面板时各自独立保存', async () => {
    wrapper = mount(KnowledgeRecallControls, { props: { kind: 'documents' } })
    await flushPromises()
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.text()).toContain('独立于事件记忆')
    await wrapper.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(mocks.save).toHaveBeenLastCalledWith({ documentAutoRecall: true, factAutoRecall: false })
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true')
    await wrapper.setProps({ kind: 'facts' })
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    await wrapper.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(mocks.save).toHaveBeenLastCalledWith({ documentAutoRecall: true, factAutoRecall: true })
  })
  it('保存失败保留真实开关状态，读取失败可重试', async () => {
    mocks.save.mockRejectedValueOnce(new Error('模拟网络失败'))
    wrapper = mount(KnowledgeRecallControls, { props: { kind: 'facts' } })
    await flushPromises()
    await wrapper.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('保存失败')
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    wrapper.unmount()
    mocks.load.mockRejectedValueOnce(new Error('模拟网络失败'))
    wrapper = mount(KnowledgeRecallControls, { props: { kind: 'documents' } })
    await flushPromises()
    expect(wrapper.get('[role="switch"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="switch"]').attributes('disabled')).toBeUndefined()
  })
})
