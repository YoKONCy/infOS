// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ExecutionProcess from '../../../src/components/compositor/ExecutionProcess.vue'

describe('执行段折叠交互', () => {
  it('结束时自动收起，手动展开后结果更新不覆盖选择，并保留内部 DOM', async () => {
    const wrapper = mount(ExecutionProcess, {
      props: { enabled: true, ended: false, toolCount: 2, failureCount: 0 },
      slots: { default: '<input value="工具详情的临时内容" />' },
      global: { stubs: { PixelIcon: true } },
    })
    try {
      const details = wrapper.get('details').element as HTMLDetailsElement
      const content = wrapper.get('input').element
      expect(details.open).toBe(true)
      await wrapper.setProps({ ended: true })
      expect(details.open).toBe(false)
      details.open = true
      await wrapper.get('details').trigger('toggle')
      await wrapper.setProps({ toolCount: 3 })
      expect(details.open).toBe(true)
      expect(wrapper.get('input').element).toBe(content)
    } finally {
      wrapper.unmount()
    }
  })

  it('历史执行段默认收起，单独思考或状态节点不增加执行段入口', () => {
    const wrapper = mount(ExecutionProcess, {
      props: { enabled: true, ended: true, toolCount: 1, failureCount: 0 },
      global: { stubs: { PixelIcon: true } },
    })
    const status = mount(ExecutionProcess, {
      props: { enabled: false, ended: true, toolCount: 0, failureCount: 0 },
      slots: { default: '<span>状态内容</span>' },
    })
    try {
      expect((wrapper.get('details').element as HTMLDetailsElement).open).toBe(false)
      expect(status.find('details').exists()).toBe(false)
      expect(status.text()).toBe('状态内容')
    } finally {
      wrapper.unmount()
      status.unmount()
    }
  })
})
