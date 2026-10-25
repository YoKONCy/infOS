// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldbookSettings } from '@infos/shared'
import WorldbookGlobalCard from '@infos/frontend/components/dashboard/tabs/WorldbookGlobalCard.vue'
import { PInputNumber } from '@infos/frontend/components/pixel'

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  addGlobalBook: vi.fn(),
  removeGlobalBook: vi.fn(),
  toast: vi.fn(),
}))
vi.mock('@infos/frontend/api/modules/worldbookApi', () => ({
  worldbookApi: {
    saveSettings: mocks.saveSettings,
    addGlobalBook: mocks.addGlobalBook,
    removeGlobalBook: mocks.removeGlobalBook,
  },
}))
vi.mock('@infos/frontend/stores/useNotificationStore', () => ({
  useNotificationStore: () => ({ toast: mocks.toast }),
}))

const wrappers: Array<ReturnType<typeof mount>> = []
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.resetAllMocks()
})

const books = [{ id: 'wb-a', name: '甲', entryCount: 1, revision: 1, updatedAt: '' }]

describe('全局世界书卡片', () => {
  it('增删全局世界书不重置未保存的激活设置；保存值变化时同步输入框', async () => {
    mocks.addGlobalBook.mockResolvedValue({
      data: { scanDepth: 2, tokenBudget: 0, globalBooks: ['wb-a'] },
    })
    mocks.removeGlobalBook.mockResolvedValue({
      data: { scanDepth: 2, tokenBudget: 0, globalBooks: [] },
    })
    mocks.saveSettings.mockImplementation(async (next) => ({
      data: { ...next, globalBooks: [] },
    }))
    const settings: WorldbookSettings = { scanDepth: 2, tokenBudget: 0, globalBooks: [] }
    const wrapper = mount(WorldbookGlobalCard, {
      props: {
        books,
        settings,
        loading: false,
        locked: false,
        'onUpdate:settings': (next: WorldbookSettings) => wrapper.setProps({ settings: next }),
      },
    })
    wrappers.push(wrapper)
    await wrapper.get('.wb-collapse').trigger('click')
    const depth = () => wrapper.findAllComponents(PInputNumber)[0]!
    depth().vm.$emit('update:modelValue', 5)
    await flushPromises()

    // 全局世界书按单本增删，不提交激活设置，未保存的扫描深度保留。
    wrapper.findComponent({ name: 'WorldbookBookPicker' }).vm.$emit('select', 'wb-a')
    await flushPromises()
    expect(mocks.addGlobalBook).toHaveBeenCalledWith('wb-a')
    expect(depth().props('modelValue')).toBe(5)

    await wrapper.get('.wb-chip__remove').trigger('click')
    await flushPromises()
    expect(mocks.removeGlobalBook).toHaveBeenCalledWith('wb-a')
    expect(mocks.saveSettings).not.toHaveBeenCalled()
    expect(depth().props('modelValue')).toBe(5)

    // 保存激活设置只提交扫描深度与 Token 上限。
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存设置'))!
      .trigger('click')
    await flushPromises()
    expect(mocks.saveSettings).toHaveBeenCalledWith({ scanDepth: 5, tokenBudget: 0 })
    expect(depth().props('modelValue')).toBe(5)

    // 其他窗口改了保存值（刷新后）：输入框跟随新的保存值。
    await wrapper.setProps({ settings: { scanDepth: 3, tokenBudget: 0, globalBooks: [] } })
    expect(depth().props('modelValue')).toBe(3)
  })
})
