// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AssistantPrefillSettings from '@infos/frontend/components/dashboard/AssistantPrefillSettings.vue'
import { PSelect, PSwitch } from '@infos/frontend/components/pixel'
const wrappers: Array<ReturnType<typeof mount>> = []
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.resetAllMocks()
})

describe('预填充设置', () => {
  it('正文只更新草稿，开关、填充方式和保存按钮请求整页提交', async () => {
    const wrapper = mount(AssistantPrefillSettings, {
      props: { modelValue: { enabled: true, content: '我先' } },
    })
    wrappers.push(wrapper)
    expect(wrapper.findComponent(PSelect).props('modelValue')).toBe('once')
    await wrapper.get('textarea').setValue('我再确认')
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ content: '我再确认' })
    await wrapper.setProps({ modelValue: { enabled: true, content: '我再确认' } })
    wrapper.findComponent(PSelect).vm.$emit('update:modelValue', 'continuous')
    await flushPromises()
    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      enabled: true,
      content: '我再确认',
      mode: 'continuous',
    })
    await wrapper.setProps({
      modelValue: { enabled: true, content: '我再确认', mode: 'continuous' },
    })
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '保存')!
      .trigger('click')
    wrapper.findComponent(PSwitch).vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(wrapper.emitted('save')).toHaveLength(3)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      enabled: false,
      content: '我再确认',
      mode: 'continuous',
    })
  })
})
