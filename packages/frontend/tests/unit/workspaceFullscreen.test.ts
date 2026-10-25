// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useWorkspaceFullscreen } from '../../src/composables/workspace/useWorkspaceFullscreen'

const wrappers: VueWrapper[] = []
function fixture() {
  let fullscreen: Element | null = null
  const active = ref(true)
  let controls!: ReturnType<typeof useWorkspaceFullscreen>
  const host = defineComponent({
    setup() {
      const target = ref<HTMLElement | null>(null)
      controls = useWorkspaceFullscreen(target, active)
      return () => h('div', { ref: target }, h('textarea', { value: '保留阅读与编辑状态' }))
    },
  })
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreen,
  })
  const wrapper = mount(host, { attachTo: document.body })
  wrappers.push(wrapper)
  const element = wrapper.element as HTMLElement
  const enter = vi.fn(async () => {
    fullscreen = element
    document.dispatchEvent(new Event('fullscreenchange'))
  })
  element.requestFullscreen = enter
  const exit = vi.fn(async () => {
    fullscreen = null
    document.dispatchEvent(new Event('fullscreenchange'))
  })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
  return {
    wrapper,
    element,
    active,
    controls,
    enter,
    exit,
    escape: () => {
      fullscreen = null
      document.dispatchEvent(new Event('fullscreenchange'))
    },
  }
}
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  delete (document as Partial<Document>).exitFullscreen
  Reflect.deleteProperty(document, 'fullscreenElement')
})

describe('工作区统一全屏浏览', () => {
  it('进入与退出全屏保留同一个编辑器 DOM，Esc 会更新按钮状态', async () => {
    const { wrapper, controls, enter, escape } = fixture()
    const editor = wrapper.get('textarea').element
    expect(await controls.toggle()).toBe(true)
    expect(controls.expanded.value).toBe(true)
    expect(enter).toHaveBeenCalledOnce()
    escape()
    expect(controls.expanded.value).toBe(false)
    expect(wrapper.get('textarea').element).toBe(editor)
  })
  it('切走工作区会退出本工作区的全屏', async () => {
    const { controls, active, exit } = fixture()
    await controls.toggle()
    active.value = false
    await nextTick()
    expect(exit).toHaveBeenCalledOnce()
  })
  it('浏览器拒绝全屏时保留预览并返回可处理的失败结果', async () => {
    const { controls, element } = fixture()
    element.requestFullscreen = vi.fn(async () => {
      throw new Error('模拟浏览器拒绝全屏')
    })
    expect(await controls.toggle()).toBe(false)
    expect(controls.expanded.value).toBe(false)
    expect(controls.pending.value).toBe(false)
  })
})
