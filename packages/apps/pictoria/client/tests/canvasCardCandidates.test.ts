// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CanvasCard from '../src/components/CanvasCard.vue'
import type { CanvasItem } from '../src/types'
vi.mock('../src/i18n', () => ({ t: (_scope: string, source: string) => source }))
describe('卡片中的候选入口', () => {
  it.each(['asset', 'run'] as const)(
    '%s 卡片按数量提供明确入口，点击请求展开候选面板',
    async (kind) => {
      const item: CanvasItem = {
        id: 'item',
        x: 0,
        y: 0,
        content: {
          kind,
          version: 1,
          name: '日落',
          width: 300,
          height: 260,
          state: 'completed',
          assetId: kind === 'asset' ? 'image' : undefined,
        },
      }
      const wrapper = mount(CanvasCard, { props: { item, selected: false, candidateCount: 1 } })
      expect(wrapper.findAll('button').some((button) => button.text().includes('候选图'))).toBe(
        false,
      )
      await wrapper.setProps({ candidateCount: 3 })
      const button = wrapper.findAll('button').find((button) => button.text() === '候选图 · 3')
      expect(button).toBeDefined()
      await button!.trigger('click')
      expect(wrapper.emitted('candidates')).toEqual([[]])
      wrapper.unmount()
    },
  )
})
