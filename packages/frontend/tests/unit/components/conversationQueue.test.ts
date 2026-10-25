// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ConversationQueueSnapshot } from '@infos/shared'
import ConversationQueue from '../../../src/components/chat/ConversationQueue.vue'

const snapshot: ConversationQueueSnapshot = {
  threadId: 't',
  paused: false,
  active: true,
  items: [
    {
      id: 'a',
      revision: 1,
      position: 1,
      state: 'queued',
      immediate: false,
      createdAt: 1,
      input: { threadId: 't', content: '稍后检查结果', attachmentIds: ['image'] },
    },
    {
      id: 'b',
      revision: 1,
      position: 2,
      state: 'queued',
      immediate: false,
      createdAt: 2,
      input: { threadId: 't', content: '再整理说明' },
    },
  ],
}
describe('待发送消息队列交互', () => {
  it('后台结果显示用途，不展示内部提示词或提供改写与插队入口', async () => {
    const item = {
      ...snapshot.items[0]!,
      input: {
        threadId: 't',
        content: '内部执行指令不应显示',
        taskResultEvent: { taskId: 'task', deliveryId: 'delivery' },
      },
    }
    const wrapper = mount(ConversationQueue, {
      props: { snapshot: { ...snapshot, items: [item] }, busy: false, unavailable: false },
      global: { stubs: { PixelIcon: true } },
    })
    try {
      expect(wrapper.text()).toContain('后台任务结果已到达')
      expect(wrapper.text()).not.toContain('内部执行指令不应显示')
      expect(wrapper.find('.queue-return').exists()).toBe(false)
      expect(wrapper.find('.queue-immediate').exists()).toBe(false)
      await wrapper.get('[aria-label="取消自动处理"]').trigger('click')
      expect(wrapper.emitted('change')?.[0]).toEqual([item, 'cancel'])
    } finally {
      wrapper.unmount()
    }
  })
  it('立即提交、删除、调序与退回输入栏均携带指定条目身份', async () => {
    const wrapper = mount(ConversationQueue, {
      props: { snapshot, busy: false, unavailable: false },
      global: { stubs: { PixelIcon: true } },
    })
    try {
      expect(wrapper.text()).toContain('1 个附件')
      await wrapper.get('.queue-immediate').trigger('click')
      expect(wrapper.emitted('change')?.[0]).toEqual([snapshot.items[0], 'immediate'])
      await wrapper.get('.queue-return').trigger('click')
      expect(wrapper.emitted('change')?.[1]).toEqual([snapshot.items[0], 'draft'])
      expect(wrapper.find('textarea').exists()).toBe(false)
      await wrapper.get('.queue-remove').trigger('click')
      expect(wrapper.emitted('change')?.[2]).toEqual([snapshot.items[0], 'cancel'])
      await wrapper.get('[aria-label="下移消息"]').trigger('click')
      expect(wrapper.emitted('move')?.[0]).toEqual([snapshot.items[0], 1])
    } finally {
      wrapper.unmount()
    }
  })

  it('仅执行当前一条消息或首次单条提交时隐藏，有真实等待项才显示', async () => {
    const wrapper = mount(ConversationQueue, {
      props: {
        snapshot: { ...snapshot, items: [{ ...snapshot.items[0]!, state: 'running' }] },
        busy: false,
        unavailable: false,
      },
      global: { stubs: { PixelIcon: true } },
    })
    try {
      expect(wrapper.find('.conversation-queue').exists()).toBe(false)
      await wrapper.setProps({
        snapshot: { ...snapshot, active: false, items: [snapshot.items[0]!] },
      })
      expect(wrapper.find('.conversation-queue').exists()).toBe(false)
      await wrapper.setProps({
        snapshot: { ...snapshot, active: true, items: [snapshot.items[0]!] },
      })
      expect(wrapper.findAll('.queue-item')).toHaveLength(1)
      await wrapper.setProps({
        snapshot: { ...snapshot, active: false, paused: true, items: [snapshot.items[0]!] },
      })
      expect(wrapper.find('.queue-control').text()).toBe('发送')
      await wrapper.setProps({
        snapshot: { ...snapshot, active: false, items: [] },
        unavailable: true,
      })
      expect(wrapper.find('.conversation-queue').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('失败提示使用简短文案与图标，原始上游报错不铺满队列', () => {
    const wrapper = mount(ConversationQueue, {
      props: {
        snapshot: {
          ...snapshot,
          paused: true,
          reason: '上游请求失败：' + '服务端详细错误'.repeat(50),
        },
        busy: false,
        unavailable: false,
      },
      global: { stubs: { PixelIcon: true } },
    })
    try {
      expect(wrapper.get('.queue-notice').text()).toBe('发送失败，队列已暂停')
      expect(wrapper.get('.queue-notice').find('pixel-icon-stub').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('服务端详细错误')
    } finally {
      wrapper.unmount()
    }
  })

  it('中断项不再显示为待发送消息，不提供继续处理或重发入口', async () => {
    const interrupted: ConversationQueueSnapshot = {
      ...snapshot,
      paused: true,
      reason: '重启后等待确认',
      items: [{ ...snapshot.items[0]!, state: 'interrupted', error: '执行结果不确定' }],
    }
    const wrapper = mount(ConversationQueue, {
      props: { snapshot: interrupted, busy: false, unavailable: true },
      global: { stubs: { PixelIcon: true } },
    })
    try {
      expect(wrapper.find('.queue-immediate').exists()).toBe(false)
      expect(wrapper.find('.queue-item').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('继续处理')
      await wrapper.setProps({ unavailable: false })
      expect(wrapper.find('.conversation-queue').exists()).toBe(false)
      expect(wrapper.emitted('change')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })
})
