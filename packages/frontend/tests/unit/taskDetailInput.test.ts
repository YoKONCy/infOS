// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskDetailModal from '../../src/components/taskCenter/TaskDetailModal.vue'
import type { BackgroundTaskInfo } from '../../src/api/modules/backgroundTasksApi'
import type { SurfaceDescriptor } from '@infos/shared'

const api = vi.hoisted(() => ({ projection: vi.fn(), submitInput: vi.fn(), list: vi.fn() }))
const store = vi.hoisted(() => ({
  surfaces: new Map(),
  disposeScope: vi.fn(),
  replaceScope: vi.fn(),
}))
vi.mock('../../src/api/modules/backgroundTasksApi', () => ({ backgroundTasksApi: api }))
vi.mock('../../src/stores', () => ({ useCompositorStore: () => store }))
vi.mock('../../src/components/pixel', () => ({
  PButton: { template: '<button><slot /></button>' },
}))
vi.mock('../../src/components/pixel/PDrawer.vue', () => ({
  default: { template: '<div><slot /></div>' },
}))
vi.mock('../../src/components/taskCenter/TaskLifecyclePanel.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('../../src/components/compositor/ConversationSurface.vue', () => ({
  default: {
    name: 'TestConversationSurface',
    props: ['surface'],
    template:
      '<div><span v-for="node in surface.nodes" :key="node.nodeId">{{ node.props.question || node.props.title || node.props.source }}</span></div>',
  },
}))

const task = {
  revision: 3,
  threadId: 'thread-task',
  targetThreadId: null,
  instruction: '整理报告',
  progress: null,
  currentStage: null,
  result: null,
  errorMessage: null,
  priority: 5,
  requestedBy: 'user',
  completionAction: 'notify',
  category: 'agent_task',
  checkpoint: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  startedAt: null,
  completedAt: null,
  readAt: null,
  id: 'waiting-task',
  agentId: 'nana',
  title: '整理报告',
  status: 'waiting_input',
  inputQuestion: '是否允许写入报告？',
  inputContext: { approvalId: 'approval-report', toolName: 'write_file' },
  metadata: {},
  execution: null,
  toolCallCount: 0,
} as BackgroundTaskInfo
const surface = {
  surfaceId: 'background-task:waiting-task',
  generation: 'revision:3',
  threadId: task.threadId,
  principalId: task.agentId,
  revision: 3,
  sequence: 0,
  state: 'committed',
  nodes: [
    {
      nodeId: 'question',
      kind: 'input',
      lifecycle: 'interactive',
      revision: 1,
      props: {
        inputId: 'input-report',
        inputKind: 'agent_question',
        principalId: 'nana',
        title: '提问',
        question: '报告用什么格式？',
        actions: [],
      },
    },
    {
      nodeId: 'approval',
      kind: 'approval',
      lifecycle: 'interactive',
      revision: 1,
      props: {
        approvalId: 'approval-report',
        principalId: 'nana',
        toolName: 'write_file',
        title: '允许写入报告？',
        summary: { path: 'report.md' },
        riskLevel: 'medium',
      },
    },
    {
      nodeId: 'summary',
      kind: 'markdown',
      lifecycle: 'stable',
      revision: 1,
      props: { source: '整理报告', phase: 'committed' },
    },
  ],
} as SurfaceDescriptor

beforeEach(() => {
  vi.resetAllMocks()
  store.surfaces = reactive(new Map())
  store.replaceScope.mockImplementation((scopeId: string, surfaces: SurfaceDescriptor[]) => {
    for (const value of surfaces) store.surfaces.set(value.surfaceId, { ...value, scopeId })
  })
  api.projection.mockResolvedValue({ data: { surfaces: [surface] } })
  api.list.mockResolvedValue({ data: { items: [] } })
})

describe('等待输入的任务详情', () => {
  it('结果只显示一次，父子任务入口与运行信息页签可用', async () => {
    api.list.mockResolvedValue({ data: { items: [{ ...task, id: 'child', title: '子任务报告' }] } })
    api.projection.mockResolvedValue({
      data: {
        surfaces: [
          {
            ...surface,
            nodes: [
              {
                ...surface.nodes[2],
                nodeId: 'background-task:waiting-task:summary',
                props: { source: '重复的标题与目标' },
              },
              {
                ...surface.nodes[2],
                nodeId: 'background-task:waiting-task:result',
                props: { source: '## 结果\n\n已整理完成' },
              },
            ],
          },
        ],
      },
    })
    const wrapper = mount(TaskDetailModal, {
      props: {
        task: { ...task, parentTaskId: 'parent', result: '已整理完成', status: 'completed' },
      },
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('重复的标题与目标')
    expect(wrapper.text().match(/已整理完成/g)).toHaveLength(1)
    const links = wrapper.findAll('.detail-related')
    await links[0]!.trigger('click')
    await links[1]!.trigger('click')
    expect(wrapper.emitted('openTask')).toEqual([['parent'], ['child']])
    await wrapper.get('#task-runtime-tab').trigger('click')
    expect(wrapper.get('#task-runtime-tab').attributes('aria-selected')).toBe('true')
    expect((wrapper.get('#task-overview-panel').element as HTMLElement).style.display).toBe('none')
    wrapper.unmount()
    expect(store.disposeScope).toHaveBeenCalledWith('background-task:waiting-task')
  })
  it('将问答与批准统一交给置顶面板，正文不重复渲染，也不复制批准表单', async () => {
    const wrapper = mount(TaskDetailModal, { props: { task } })
    await flushPromises()
    const panels = wrapper.findAllComponents({ name: 'TestConversationSurface' })
    expect(panels).toHaveLength(2)
    expect(panels[0]!.props('surface').nodes.map((node: { kind: string }) => node.kind)).toEqual([
      'input',
      'approval',
    ])
    expect(panels[1]!.props('surface').nodes.map((node: { kind: string }) => node.kind)).toEqual([
      'markdown',
    ])
    expect(wrapper.text()).toContain('报告用什么格式？')
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(api.submitInput).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('读取失败可重试，已有问答内容保留到新快照成功返回', async () => {
    const wrapper = mount(TaskDetailModal, { props: { task } })
    await flushPromises()
    api.projection.mockRejectedValueOnce(new Error('连接中断'))
    await wrapper.setProps({ task: { ...task, updatedAt: '2026-01-01T00:01:00Z' } })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('连接中断')
    expect(wrapper.text()).toContain('报告用什么格式？')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '重试')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(api.projection).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })
})
