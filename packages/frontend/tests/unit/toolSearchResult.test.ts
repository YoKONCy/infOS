// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import ToolCardSearch from '../../src/components/tools/renderers/ToolCardSearch.vue'
import { parseToolSearchResult } from '../../src/lib/toolSearchResult'
import { useWorkspaceSearchNavigation } from '../../src/composables/workspace/useWorkspaceSearchNavigation'

const mocks = vi.hoisted(() => ({ setTab: vi.fn(), switchAgent: vi.fn(), toast: vi.fn() }))
vi.mock('../../src/composables/main/useMainNav', () => ({
  useMainNav: () => ({ setTab: mocks.setTab }),
}))
vi.mock('../../src/stores/useAgentStore', () => ({
  useAgentStore: () => ({ activeAgentId: 'pero', switchAgent: mocks.switchAgent }),
}))
vi.mock('../../src/stores/useThreadStore', () => ({
  useThreadStore: () => ({ threadId: 'thread' }),
}))
vi.mock('../../src/stores/useNotificationStore', () => ({
  useNotificationStore: () => ({ toast: mocks.toast }),
}))
enableAutoUnmount(afterEach)
afterEach(() => {
  vi.clearAllMocks()
  useWorkspaceSearchNavigation().value = null
})
const navigation = {
  agentId: 'pero',
  threadId: 'thread',
  resultRef: 'tool-result:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  taskId: 'task',
}
const result = JSON.stringify({
  navigation,
  searchRoot: '/project',
  respectGitIgnore: true,
  total: 3,
  fileCount: 2,
  matches: [
    { file: '/project/a.ts', line: 2, column: 7, content: '命中一' },
    { file: '/project/a.ts', line: 4, column: 2, content: '命中二' },
    { file: '/project/b.ts', line: 1, column: 1, content: '命中三' },
  ],
})
describe('搜索工具紧凑文件列表', () => {
  it('按文件合并匹配，保留统计、范围与忽略规则', () => {
    const wrapper = mount(ToolCardSearch, { props: { args: '{"query":"命中"}', result } })
    expect(wrapper.findAll('.search-file')).toHaveLength(2)
    expect(wrapper.text()).toContain('2 个文件')
    expect(wrapper.text()).toContain('3 处匹配')
    expect(wrapper.text()).toContain('/project')
    expect(wrapper.text()).toContain('遵守 Git 忽略规则')
  })
  it('鼠标与键盘使用原生按钮入口，点击传递精确归属和行列并切换工作区', async () => {
    const wrapper = mount(ToolCardSearch, { props: { args: '{}', result } })
    expect(wrapper.get('.search-file').attributes('type')).toBe('button')
    await wrapper.get('.search-file').trigger('click')
    await flushPromises()
    expect(useWorkspaceSearchNavigation().value).toMatchObject({
      ...navigation,
      file: '/project/a.ts',
      line: 2,
      column: 7,
    })
    expect(mocks.setTab).toHaveBeenCalledWith('workspace')
  })
  it('旧审计记录明确提示缺少预览，不能误显示未找到文件', () => {
    const wrapper = mount(ToolCardSearch, {
      props: {
        args: '{}',
        result: '{"kind":"tool_result_audit","toolName":"code_search","fileCount":2,"total":3}',
      },
    })
    expect(wrapper.text()).toContain('已保留数量，正文需重新搜索')
    expect(wrapper.text()).not.toContain('未找到匹配项')
  })
  it('历史预览和完整结果使用同一份导航信息，无命中和失败分别呈现', () => {
    expect(parseToolSearchResult(result)?.navigation).toEqual(navigation)
    const empty = mount(ToolCardSearch, {
      props: { args: '{}', result: '{"matches":[],"total":0}' },
    })
    expect(empty.text()).toContain('未找到匹配项')
    const failed = mount(ToolCardSearch, {
      props: { args: '{}', result: '路径不存在', isError: true },
    })
    expect(failed.text()).toContain('路径不存在')
    expect(failed.text()).toContain('搜索失败')
  })
})
