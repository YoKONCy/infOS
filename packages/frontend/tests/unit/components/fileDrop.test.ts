// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { useFileDrop } from '@infos/frontend/composables/chat/useFileDrop'

let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})
function event(type: string, files: File[], types = ['Files'], items: unknown[] = []) {
  const result = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(result, 'dataTransfer', {
    value: { files, types, items, dropEffect: 'none' },
  })
  return result
}
describe('文件拖放与上传入口', () => {
  it('嵌套输入栏与聊天区域只处理一次，父级提示也能正确消失', async () => {
    const parentFiles = vi.fn(),
      childFiles = vi.fn()
    let parent!: ReturnType<typeof useFileDrop>, child!: ReturnType<typeof useFileDrop>
    wrapper = mount(
      defineComponent({
        setup() {
          parent = useFileDrop({ enabled: () => true, files: parentFiles })
          child = useFileDrop({ enabled: () => true, files: childFiles })
          return () =>
            h('div', { onDragenter: parent.enter, onDrop: parent.drop }, [
              h('div', { class: 'child', onDragenter: child.enter, onDrop: child.drop }),
            ])
        },
      }),
    )
    const file = new File(['原件'], '资源.unknown')
    wrapper.get('.child').element.dispatchEvent(event('dragenter', [file]))
    expect(parent.dragging.value).toBe(true)
    wrapper.get('.child').element.dispatchEvent(event('drop', [file]))
    await flushPromises()
    expect(childFiles).toHaveBeenCalledWith([file])
    expect(parentFiles).not.toHaveBeenCalled()
    expect(parent.dragging.value).toBe(false)
  })
  it('文本拖动不接管，禁用会话的文件拖动不触发上传', async () => {
    const files = vi.fn(),
      unavailable = vi.fn()
    wrapper = mount(
      defineComponent({
        setup() {
          const drop = useFileDrop({ enabled: () => false, files, unavailable })
          return () => h('div', { onDrop: drop.drop })
        },
      }),
    )
    const text = event('drop', [], ['text/plain'])
    wrapper.element.dispatchEvent(text)
    expect(text.defaultPrevented).toBe(false)
    const file = event('drop', [new File(['内容'], 'test.bin')])
    wrapper.element.dispatchEvent(file)
    await flushPromises()
    expect(file.defaultPrevented).toBe(true)
    expect(files).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })
  it('目录只给提示，同批普通文件仍按原件上传', async () => {
    const files = vi.fn(),
      directory = vi.fn()
    wrapper = mount(
      defineComponent({
        setup() {
          const drop = useFileDrop({ enabled: () => true, files, directory })
          return () => h('div', { onDrop: drop.drop })
        },
      }),
    )
    const folder = new File([], '目录'),
      file = new File(['内容'], '文件.bin')
    wrapper.element.dispatchEvent(
      event(
        'drop',
        [folder, file],
        ['Files'],
        [
          {
            kind: 'file',
            getAsFile: () => folder,
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
          { kind: 'file', getAsFile: () => file },
        ],
      ),
    )
    await flushPromises()
    expect(directory).toHaveBeenCalledOnce()
    expect(files).toHaveBeenCalledWith([file])
  })
})
