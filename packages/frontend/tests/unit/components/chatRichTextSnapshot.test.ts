// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import ChatRichText from '@infos/frontend/components/chat/ChatRichText.vue'
import * as renderer from '@infos/frontend/lib/chatRichRenderer'
import * as preview from '@infos/frontend/lib/embeddedWebPreview'
import { applyLanguage } from '@infos/frontend/i18n'
import {
  readRichTextSnapshot,
  writeRichTextSnapshot,
} from '@infos/frontend/compositor/richTextSnapshot'

const pending = vi.hoisted(() => new Set<() => void>())
vi.mock('@infos/frontend/compositor/renderQueue', () => ({
  queueTextRender: (job: () => void) => {
    pending.add(job)
    return () => pending.delete(job)
  },
}))
vi.mock('@infos/frontend/stores/useNotificationStore', () => ({
  useNotificationStore: () => ({ toast: vi.fn() }),
}))

const wrappers: Array<ReturnType<typeof mount>> = []
beforeEach(() => {
  applyLanguage('zh-CN')
  vi.spyOn(renderer, 'renderChatRichText')
  vi.spyOn(preview, 'segmentChatContent')
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  pending.clear()
  vi.restoreAllMocks()
  applyLanguage('zh-CN')
})

function create(content: string, visible = ref(true), props = {}) {
  const wrapper = mount(ChatRichText, {
    props: { content, ...props },
    global: {
      provide: { 'infos:main-surface-visible': visible },
      stubs: { EmbeddedWebPreview: true, ResourceReferenceCard: true },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

async function renderPending() {
  await flushPromises()
  for (const job of pending) {
    pending.delete(job)
    job()
  }
  await flushPromises()
}

describe('聊天富文本驻留快照', () => {
  it('会话信息、外观和可见性变化保留原 DOM，不重新分段或渲染', async () => {
    const visible = ref(true)
    const wrapper = create('**驻留内容**：上下文与可见性', visible)
    await renderPending()
    const paragraph = wrapper.get('.chat-rich-text p').element
    await wrapper.setProps({ agentId: 'agent-next', threadId: 'thread-next', compact: true })
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })
    visible.value = false
    await flushPromises()
    visible.value = true
    await renderPending()
    expect(renderer.renderChatRichText).toHaveBeenCalledTimes(1)
    expect(preview.segmentChatContent).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.chat-rich-text p').element).toBe(paragraph)
  })

  it('组件重新挂载直接恢复完整快照，不再次运行解析器', async () => {
    const content = '**驻留内容**：重新挂载'
    const first = create(content)
    await renderPending()
    first.unmount()
    const next = create(content)
    await renderPending()
    expect(next.get('.chat-rich-text strong').text()).toBe('驻留内容')
    expect(renderer.renderChatRichText).toHaveBeenCalledTimes(1)
    expect(preview.segmentChatContent).toHaveBeenCalledTimes(1)
  })

  it('共享缓存淘汰后，仍挂载的消息继续保留已渲染内容', async () => {
    const content = '**驻留内容**：缓存淘汰'
    const wrapper = create(content)
    await renderPending()
    const paragraph = wrapper.get('.chat-rich-text p').element
    for (let index = 0; index < 200; index++) {
      writeRichTextSnapshot({
        content: `其他消息-${index}`,
        webPreview: true,
        locale: 'zh-CN',
        segments: [{ type: 'rich-text', source: `其他消息-${index}`, html: '<p>其他消息</p>' }],
      })
    }
    expect(readRichTextSnapshot({ content, webPreview: true, locale: 'zh-CN' })).toBeUndefined()
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })
    await renderPending()
    expect(renderer.renderChatRichText).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.chat-rich-text p').element).toBe(paragraph)
  })

  it('隐藏期间不解析，恢复可见后只渲染最新内容', async () => {
    const wrapper = create('**驻留内容**：隐藏前')
    await renderPending()
    await wrapper.setProps({ active: false, content: '**不应解析**：过渡内容' })
    await wrapper.setProps({ content: '**最新内容**：恢复可见' })
    await renderPending()
    expect(renderer.renderChatRichText).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ active: true })
    await renderPending()
    expect(renderer.renderChatRichText).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.chat-rich-text strong').text()).toBe('最新内容')
  })

  it('取消旧渲染任务，流式尾部稳定后才缓存富文本', async () => {
    const wrapper = create('**流式内容**：第一版', ref(true), { stable: false })
    await renderPending()
    expect(renderer.renderChatRichText).not.toHaveBeenCalled()
    await wrapper.setProps({ stable: true })
    await flushPromises()
    await wrapper.setProps({ content: '**流式内容**：最终版' })
    await renderPending()
    expect(renderer.renderChatRichText).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('最终版')
  })

  it('语言切换更新复制按钮，切回原语言复用既有快照', async () => {
    const wrapper = create('```json\n{"测试":"语言快照"}\n```')
    await renderPending()
    expect(wrapper.get('[data-copy-code]').text()).toBe('复制')
    applyLanguage('en-US')
    await renderPending()
    expect(wrapper.get('[data-copy-code]').text()).toBe('Copy')
    applyLanguage('zh-CN')
    await renderPending()
    expect(wrapper.get('[data-copy-code]').text()).toBe('复制')
    expect(renderer.renderChatRichText).toHaveBeenCalledTimes(2)
  })
})
