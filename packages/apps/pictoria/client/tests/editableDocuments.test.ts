// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { setLocale } from '@infos/shared/i18n'
import { useCanvas } from '../src/composables/useCanvas'
import { useWorkflow } from '../src/composables/useWorkflow'
import { createWorkflowExample } from '../src/services/workflowExample'

const api = vi.hoisted(() => ({ operation: vi.fn() }))
vi.mock('../src/services/transport', () => ({
  standalone: false,
  desktop: undefined,
  fileBase64: vi.fn(),
  clipboardScope: 'editable-documents',
  pictoria: api,
}))

let wrapper: VueWrapper | undefined
function mounted<T>(create: () => T): T {
  let store!: T
  wrapper = mount(
    defineComponent({
      setup() {
        store = create()
        return () => h('div')
      },
    }),
  )
  return store
}
beforeEach(() => {
  localStorage.clear()
  setLocale('zh-CN')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  api.operation.mockReset()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  localStorage.clear()
  vi.useRealTimers()
  setLocale('zh-CN')
})

describe('Pictoria 可编辑文档', () => {
  it('打开已有画布后可重命名，并完整撤销、重做标题', async () => {
    api.operation.mockResolvedValue({ id: 'saved', title: '远端画布', revision: 3, items: [] })
    const store = mounted(useCanvas)
    await store.openProject('saved')
    await nextTick()
    expect(store.error.value).toBe('')
    expect(store.project.id).toBe('saved')
    expect(store.project.title).toBe('远端画布')

    expect(await store.renameProject('saved', '海边日落')).toBe(true)
    expect(store.project.title).toBe('海边日落')
    store.undo()
    expect(store.project.title).toBe('远端画布')
    store.redo()
    expect(store.project.title).toBe('海边日落')
  })

  it('首次进入时恢复本地草稿的标题与内容，不因只读标题中途退出', () => {
    localStorage.setItem('pictoria.last.local', 'draft')
    localStorage.setItem(
      'pictoria.canvas.local.draft',
      JSON.stringify({
        id: 'draft',
        title: '未完成的构图',
        revision: 0,
        dirty: true,
        items: [
          {
            id: 'note',
            x: 30,
            y: 40,
            content: { version: 1, kind: 'text', width: 280, height: 190, text: '日落配色' },
          },
        ],
      }),
    )
    const store = mounted(useCanvas)
    expect(store.project.title).toBe('未完成的构图')
    expect(store.project.items.map((item) => [item.id, item.content.text])).toEqual([
      ['note', '日落配色'],
    ])
    expect(store.dirty.value).toBe(true)
  })

  it('空画布默认标题随语言切换，重命名后保留用户名称', async () => {
    const store = mounted(useCanvas)
    expect(store.project.title).toBe('未命名画布')
    setLocale('en-US')
    expect(store.project.title).toBe('unnamed canvas')
    expect(await store.renameProject(store.project.id, '我的画布')).toBe(true)
    setLocale('zh-TW')
    expect(store.project.title).toBe('我的画布')
  })

  it('新建备注可以编辑标题和正文，撤销重做保留两者', async () => {
    const flow = mounted(() => useWorkflow(ref('')))
    flow.addNote(20, 40)
    await nextTick()
    flow.checkpoint()
    flow.doc.notes[0]!.title = '配色说明'
    flow.doc.notes[0]!.text = '天蓝和暖橙'
    await flushPromises()
    expect(flow.doc.notes[0]).toMatchObject({ title: '配色说明', text: '天蓝和暖橙' })
    flow.undo()
    expect(flow.doc.notes[0]).toMatchObject({ title: '备注', text: '', x: 20, y: 40 })
    flow.redo()
    expect(flow.doc.notes[0]).toMatchObject({ title: '配色说明', text: '天蓝和暖橙' })
  })

  it('教学草稿的说明、节点名与字段名均可编辑，且不改变下一份示例', () => {
    const draft = reactive(createWorkflowExample())
    draft.usageDescription = '自定义创作流程'
    draft.nodes[0]!.label = '润色创意'
    draft.inputSchema.properties!.references!.title = '场景参考'
    draft.outputSchema.properties!.images!.title = '最终图像'
    expect(draft.usageDescription).toBe('自定义创作流程')
    expect(draft.nodes[0]!.label).toBe('润色创意')
    expect(draft.inputSchema.properties!.references!.title).toBe('场景参考')
    expect(draft.outputSchema.properties!.images!.title).toBe('最终图像')
    const next = createWorkflowExample()
    expect(next.nodes[0]!.label).toBe('提示词润色')
    expect(next.inputSchema.properties!.references!.title).toBe('参考图')
    expect(next.outputSchema.properties!.images!.title).toBe('图片')
  })
})
