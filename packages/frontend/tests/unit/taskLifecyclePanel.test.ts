// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskLifecyclePanel from '../../src/components/taskCenter/TaskLifecyclePanel.vue'
import type { BackgroundTaskInfo } from '../../src/api/modules/backgroundTasksApi'

const api = vi.hoisted(() => ({ deliveries: vi.fn(), control: vi.fn() }))
vi.mock('../../src/api/modules/backgroundTasksApi', () => ({ backgroundTasksApi: api }))
vi.mock('../../src/composables/useDesktopControl', () => ({
  useDesktopControl: () => ({ supported: false }),
}))
vi.mock('../../src/components/chat/TodoPlanCard.vue', () => ({ default: { template: '<div />' } }))
const task = {
  id: 'a',
  agentId: 'nana',
  revision: 1,
  status: 'running',
  instruction: '原要求',
  lifecycle: {
    successCriteria: '',
    plan: [],
    recovery: 'confirm',
    segments: 0,
    maxSegments: 48,
    maxLlmCalls: 192,
    maxToolCalls: 768,
    usage: { llmCalls: 0, toolCalls: 0 },
    artifacts: [],
    evidence: [],
  },
} as unknown as BackgroundTaskInfo
beforeEach(() => {
  vi.resetAllMocks()
  api.control.mockResolvedValue({})
  api.deliveries.mockResolvedValue({
    data: [{ id: 'resume', channel: 'resume', status: 'sent', attempts: 2, lastError: null }],
  })
})
describe('任务计划与交付', () => {
  it('会话接续仅代表已入队，不显示为已经处理或送达', async () => {
    const wrapper = mount(TaskLifecyclePanel, { props: { task } })
    await flushPromises()
    expect(wrapper.text()).toContain('会话接续')
    expect(wrapper.text()).toContain('已加入处理队列')
    expect(wrapper.text()).toContain('已尝试 2 次')
    wrapper.unmount()
  })
  it('定时刷新不覆盖编辑草稿，保存沿用开始编辑时的版本防止覆盖并发变更', async () => {
    const wrapper = mount(TaskLifecyclePanel, { props: { task } })
    const editor = wrapper.findAll('details').find((item) => item.text().includes('调整任务'))!
    ;(editor.element as HTMLDetailsElement).open = true
    await editor.trigger('toggle')
    await wrapper.get('textarea').setValue('用户正在编辑的要求')
    await wrapper.setProps({ task: { ...task, revision: 2, instruction: '后台新要求' } })
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(
      '用户正在编辑的要求',
    )
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存调整'))!
      .trigger('click')
    await flushPromises()
    expect(api.control).toHaveBeenCalledWith(
      'nana',
      expect.objectContaining({
        action: 'update',
        instruction: '用户正在编辑的要求',
        expectedRevision: 1,
      }),
    )
    wrapper.unmount()
  })
})
