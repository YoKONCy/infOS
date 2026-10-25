// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import PDrawer from '../../src/components/pixel/PDrawer.vue'

let wrapper: ReturnType<typeof mount>
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})
describe('详情侧栏的键盘与滚动边界', () => {
  it('打开时聚焦关闭按钮，关闭时恢复焦点和原滚动状态', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    document.body.style.overflow = 'auto'
    wrapper = mount(PDrawer, { props: { title: '任务详情' }, attachTo: document.body })
    await flushPromises()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭')
    expect(document.body.style.overflow).toBe('hidden')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
    expect(document.activeElement).toBe(trigger)
    expect(document.body.style.overflow).toBe('auto')
  })
  it('存在更上层对话框时不抢占 Escape，点击内容不会关闭侧栏', async () => {
    wrapper = mount(PDrawer, { props: { title: '任务详情' }, attachTo: document.body })
    await flushPromises()
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    document
      .querySelector('.p-drawer__body')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    document
      .querySelector('.p-drawer-overlay')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
