// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useCanvas } from '../src/composables/useCanvas'
import { decodeNodes, encodeNodes } from '../src/services/nodeClipboard'

vi.mock('../src/services/transport', () => ({
  standalone: false,
  desktop: undefined,
  fileBase64: vi.fn(),
  clipboardScope: 'group-test',
  pictoria: {},
}))
vi.mock('../src/i18n', () => ({ t: (_scope: string, source: string) => source }))
let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  localStorage.clear()
})
describe('画布分组复制与撤销', () => {
  it('复制宽分组包含其子节点，粘贴重映射成员并可撤销、重做', async () => {
    let store!: ReturnType<typeof useCanvas>
    wrapper = mount(
      defineComponent({
        setup() {
          store = useCanvas()
          return () => h('div')
        },
      }),
    )
    store.agentId.value = 'owner'
    store.project.id = 'group-project'
    store.project.items = [
      {
        id: 'group',
        x: 10,
        y: 20,
        content: { kind: 'group', version: 1, width: 5000, height: 2000, name: '参考组' },
      },
      {
        id: 'note',
        x: 100,
        y: 100,
        content: {
          kind: 'text',
          version: 1,
          width: 200,
          height: 100,
          text: '参考',
          groupId: 'group',
        },
      },
    ]
    store.project.viewport = { x: 40, y: 50, scale: 0.5 }
    store.selected.value = ['group']
    await nextTick()
    const copied = store.copyNodes()!
    const decoded = decodeNodes(encodeNodes(copied))!
    expect(decoded.kind).toBe('canvas')
    store.pasteNodes(decoded, { x: 1010, y: 2020 })
    const pastedGroup = store.project.items.find(
      (item) => item.id !== 'group' && item.content.kind === 'group',
    )!
    const pastedNote = store.project.items.find(
      (item) => item.id !== 'note' && item.content.kind === 'text',
    )!
    expect(pastedNote.content.groupId).toBe(pastedGroup.id)
    expect({ x: pastedNote.x, y: pastedNote.y }).toEqual({ x: 1100, y: 2100 })
    store.undo()
    expect(store.project.items.map((item) => item.id)).toEqual(['group', 'note'])
    expect(store.project.viewport).toEqual({ x: 40, y: 50, scale: 0.5 })
    store.redo()
    expect(store.project.items.length).toBe(4)
  })
})
