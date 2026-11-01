// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CanvasProposalReview from '../src/components/CanvasProposalReview.vue'
import type { Project, Step } from '../src/types'
vi.mock('../src/i18n', () => ({
  t: (_scope: string, source: string, parameters: unknown[] = []) =>
    source.replace(/\{(\d+)\}/g, (_value, index) => String(parameters[Number(index)])),
}))
const project: Project = {
  id: 'review',
  revision: 1,
  title: '创作',
  items: [
    {
      id: 'source',
      x: 0,
      y: 0,
      content: {
        kind: 'asset',
        version: 1,
        width: 300,
        height: 200,
        name: '日落参考',
        assetId: 'asset',
      },
    },
  ],
}
describe('可读的画布方案', () => {
  it('明确展示分组成员、便签全文和删除对象，保留确认所需内容', () => {
    const note = '光线方向与阴影层次的完整说明'.repeat(8)
    const wrapper = mount(CanvasProposalReview, {
      props: {
        project,
        steps: [],
        proposal: {
          message: '',
          operations: [
            { type: 'group', id: 'group', ids: ['source'], name: '色彩研究' },
            { type: 'note', id: 'note', text: note, x: 0, y: 0 },
            { type: 'remove', ids: ['source'] },
          ],
        },
      },
    })
    const rows = wrapper.findAll('.studio-proposal-row')
    expect(rows[0]?.text()).toContain('色彩研究 · 1 个节点\n日落参考')
    expect(rows[1]?.text()).toContain(note)
    expect(rows[2]?.text()).toContain('删除节点日落参考')
    wrapper.unmount()
  })
  it('步骤草稿显示输入标题和实际参数，用户能审阅生成内容', () => {
    const step: Step = {
      id: 'edit',
      name: '参考图编辑',
      revision: 1,
      usageDescription: '',
      available: true,
      inputSchema: {
        properties: { prompt: { type: 'string', title: '修改描述' }, image: { title: '参考图' } },
      },
    }
    const wrapper = mount(CanvasProposalReview, {
      props: {
        project,
        steps: [step],
        proposal: {
          message: '',
          operations: [
            {
              type: 'draft',
              id: 'draft',
              stepId: 'edit',
              inputs: { prompt: '保留山脊，调整为夕阳', image: { assetId: 'asset' } },
              x: 0,
              y: 0,
            },
          ],
        },
      },
    })
    const detail = wrapper.get('.studio-proposal-row span').text()
    expect(detail).toBe('参考图编辑\n修改描述: 保留山脊，调整为夕阳\n参考图: 日落参考')
    wrapper.unmount()
  })
})
