// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { SurfaceNode, SurfaceNodeId } from '@infos/shared'
import type { CompositorSurface } from '../../../src/stores/useCompositorStore'
import ConversationSurface from '../../../src/components/compositor/ConversationSurface.vue'

vi.mock('../../../src/stores', () => ({ useCompositorStore: () => ({ surfaces: new Map() }) }))
vi.mock('../../../src/composables/gateway/useGateway', () => ({
  useGateway: () => ({ withInputSeatFor: vi.fn() }),
}))
vi.mock('../../../src/composables/tools/useToolDisplay', async (original) => ({
  ...(await original<typeof import('../../../src/composables/tools/useToolDisplay')>()),
  resolveToolDisplay: vi.fn(async () => ({ style: 'generic' })),
}))

function node(id: string, kind: SurfaceNode['kind'], props: object): SurfaceNode {
  return { nodeId: id as SurfaceNodeId, kind, lifecycle: 'stable', revision: 1, props }
}

describe('NIT 内部工具轨迹', () => {
  it('子工具归属外层 NIT，折叠摘要有名称与数量，各子工具可独立展开', async () => {
    const surface: CompositorSurface = {
      surfaceId: 'nit-surface' as CompositorSurface['surfaceId'],
      generation: 'g1',
      threadId: 't1',
      principalId: 'pero',
      revision: 1,
      sequence: 1,
      state: 'committed',
      operationIds: new Set(),
      nodes: [
        node('parent', 'tool-call', {
          callId: 'script',
          name: 'run_script',
          args: '{}',
          state: 'completed',
        }),
        node('one', 'tool-call', {
          callId: 'child-1',
          parentCallId: 'script',
          name: 'read_file',
          args: '{"path":"a.ts"}',
          state: 'calling',
        }),
        node('two', 'tool-call', {
          callId: 'child-2',
          parentCallId: 'script',
          name: 'terminal_execute',
          args: '{"command":"node a.js"}',
          state: 'calling',
        }),
        node('one-result', 'tool-result', {
          callId: 'child-1',
          result: '读取完成',
          isError: false,
          durationMs: 12,
        }),
        node('two-result', 'tool-result', {
          callId: 'child-2',
          result: '命令失败',
          isError: true,
          durationMs: 18,
        }),
        node('parent-result', 'tool-result', {
          callId: 'script',
          result: '脚本结束',
          isError: false,
          durationMs: 40,
        }),
        node('orphan', 'tool-call', {
          callId: 'orphan',
          parentCallId: 'missing',
          name: 'read_file',
          args: '{}',
          state: 'calling',
        }),
      ],
    }
    const wrapper = mount(ConversationSurface, {
      props: { surface },
      global: {
        stubs: { ToolArchetypeSignature: true, ToolTechnicalDrawer: true, PixelIcon: true },
      },
    })
    try {
      expect(wrapper.findAll('.surface-execution')).toHaveLength(1)
      const process = wrapper.get('.surface-execution')
      expect((process.element as HTMLDetailsElement).open).toBe(false)
      ;(process.element as HTMLDetailsElement).open = true
      await process.trigger('toggle')
      expect(wrapper.findAll('.surface-execution__body > .ta-node')).toHaveLength(2)
      const parent = wrapper.get('.surface-execution__body > .ta-node')
      expect(parent.get('.ta-summary').text()).toContain('NIT · 2')
      expect(parent.get('.ta-copy small').text()).toContain('读取文件')
      expect(parent.get('.ta-copy small').text()).toContain('2/2')
      expect((parent.element as HTMLDetailsElement).open).toBe(false)
      await parent.get('.ta-summary').trigger('click')
      const children = parent.findAll('.ta-nested-tools > .ta-node')
      expect(children).toHaveLength(2)
      expect(children[1]!.classes()).toContain('ta-state-error')
      expect(children[0]!.get('time').text()).toBe('12ms')
      expect((children[0]!.element as HTMLDetailsElement).open).toBe(false)
      await children[0]!.get('.ta-summary').trigger('click')
      expect((children[0]!.element as HTMLDetailsElement).open).toBe(true)
      expect((parent.element as HTMLDetailsElement).open).toBe(true)
      expect((children[1]!.element as HTMLDetailsElement).open).toBe(false)
      expect(wrapper.get('.surface-execution__body > .ta-node:last-of-type').classes()).toContain(
        'ta-state-error',
      )
    } finally {
      wrapper.unmount()
    }
  })
})
