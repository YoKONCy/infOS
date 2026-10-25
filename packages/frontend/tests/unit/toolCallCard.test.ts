// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToolCallCard from '../../src/components/tools/ToolCallCard.vue'
import { useTaskNavigation } from '../../src/composables/main/useTaskNavigation'

const navigation = vi.hoisted(() => ({ setTab: vi.fn() }))
vi.mock('../../src/composables/main/useMainNav', () => ({ useMainNav: () => navigation }))

vi.mock('../../src/composables/tools/useToolDisplay', () => ({
  resolveToolDisplay: vi.fn(async () => ({
    label: '点击网页',
    icon: 'map-pin',
    color: 'sky',
    style: 'browser',
  })),
  toolDisplayColor: () => '#38bdf8',
  toolDisplayColorSoft: () => 'rgba(56,189,248,.12)',
  toolDisplayIcon: (display?: { icon?: string }) => display?.icon ?? 'tool',
  toolDisplayLabel: (name: string, display?: { label?: string }) => display?.label ?? name,
}))

afterEach(() => vi.useRealTimers())

describe('ToolCallCard Tool Atelier', () => {
  it('点击派发工具打开对应任务，技术详情保持独立', async () => {
    const wrapper = mount(ToolCallCard, {
      props: {
        tool: {
          name: 'manage_task',
          args: '{"action":"create"}',
          result: '{"id":"task-123","status":"queued"}',
        },
      },
      global: { stubs: { Teleport: true } },
    })
    await wrapper.get('.ta-task-link').trigger('click')
    await flushPromises()
    expect(useTaskNavigation().value?.taskId).toBe('task-123')
    expect(navigation.setTab).toHaveBeenCalledWith('tasks')
    const revision = useTaskNavigation().value!.revision
    await wrapper.get('summary').trigger('click')
    await flushPromises()
    expect(useTaskNavigation().value!.revision).toBeGreaterThan(revision)
    await wrapper.get('.ta-data-port').trigger('click')
    expect(useTaskNavigation().value!.revision).toBe(revision + 1)
    expect(wrapper.text()).toContain('manage_task')
  })
  it('NIT 子工具支持独立任务入口，失败工具不生成入口', () => {
    const wrapper = mount(ToolCallCard, {
      props: {
        tool: { name: 'nit', args: '{}', result: '{}' },
        children: [
          {
            name: 'interact_with_social',
            args: '{}',
            result: '{"success":true,"taskId":"social-1"}',
          },
          { name: 'manage_task', args: '{}', result: '{"id":"failed"}', isError: true },
        ],
      },
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.findAll('.ta-task-link')).toHaveLength(1)
  })
  it('执行中默认展开，展示目标和进度', async () => {
    const wrapper = mount(ToolCallCard, {
      props: { tool: { name: 'browser_click', args: '{"target":"登录"}' } },
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.classes()).toContain('is-open')
    expect(wrapper.text()).toContain('登录')
  })

  it('文件编辑执行中应明确显示编辑状态和路径', async () => {
    const wrapper = mount(ToolCallCard, {
      props: { tool: { name: 'edit_file', args: '{"path":"src/large.ts"}' } },
      global: { stubs: { Teleport: true } },
    })

    expect(wrapper.text()).toContain('src/large.ts')
  })

  it('结果到达后应自动收起', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ToolCallCard, {
      props: { tool: { name: 'browser_click', args: '{"target":"登录"}' } },
      global: { stubs: { Teleport: true } },
    })
    await wrapper.setProps({
      tool: { name: 'browser_click', args: '{"target":"登录"}', result: '完成', durationMs: 80 },
    })

    expect(wrapper.classes()).toContain('is-open')
    await vi.runOnlyPendingTimersAsync()
    await wrapper.vm.$nextTick()
    expect(wrapper.classes()).not.toContain('is-open')
  })

  it('详情按钮应可打开统一技术详情', async () => {
    const wrapper = mount(ToolCallCard, {
      props: {
        tool: { name: 'terminal_execute', args: '{"command":"pnpm test"}', result: '通过' },
      },
      global: { stubs: { Teleport: true } },
    })
    await wrapper.get('.ta-data-port').trigger('click')

    expect(wrapper.text()).toContain('terminal_execute')
    expect(wrapper.text()).toContain('pnpm test')
  })

  it('失败状态应提供可读提示', async () => {
    const wrapper = mount(ToolCallCard, {
      props: {
        tool: {
          name: 'edit_file',
          args: '{"file_path":"a.ts"}',
          result: '写入失败',
          isError: true,
        },
      },
      global: { stubs: { Teleport: true } },
    })

    expect(wrapper.classes()).toContain('ta-state-error')
  })
})

enableAutoUnmount(afterEach)
