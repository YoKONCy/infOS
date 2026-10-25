// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'
import Viewer from '../../src/components/workspace/WorkspacePdfViewer.vue'
import { createPreviewState } from '../../src/components/workspace/workspacePreview'

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroy: vi.fn(async () => {}),
  getPage: vi.fn(async (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 900 * scale }),
    getTextContent: async () => ({ items: [{ str: `页面唯一词-${number}` }] }),
  })),
}))
vi.mock('pdfjs-dist', () => ({
  getDocument: mocks.getDocument,
  GlobalWorkerOptions: {},
  PasswordResponses: { INCORRECT_PASSWORD: 2 },
}))
vi.mock('../../src/api/transport', () => ({
  getApiBaseUrl: () => 'http://localhost/',
  getApiResourceHeaders: () => ({}),
}))

const pageProbe = defineComponent({
  props: ['page', 'document', 'width', 'zoom', 'query'],
  setup: (props) => () => h('div', { class: 'pdf-page-probe', 'data-number': props.page }),
})
const wrappers: VueWrapper[] = []
let intersect!: IntersectionObserverCallback
beforeEach(() => {
  mocks.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({ numPages: 20, getPage: mocks.getPage }),
    destroy: mocks.destroy,
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.callback([{ contentRect: { width: 800, height: 600 } }] as never, this as never)
      }
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function fixture() {
  const state = reactive(createPreviewState())
  const host = defineComponent({
    setup: () => () =>
      h(Viewer, {
        src: 'http://localhost/manual.pdf',
        state,
        onState: (patch: Partial<ReturnType<typeof createPreviewState>>) =>
          Object.assign(state, patch),
      }),
  })
  const wrapper = mount(host, { global: { stubs: { WorkspacePdfPage: pageProbe } } })
  wrappers.push(wrapper)
  await flushPromises()
  const stage = wrapper.get('.workspace-pdf__stage').element as HTMLElement
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 600 })
  for (const [index, sheet] of wrapper.findAll('.workspace-pdf__sheet').entries()) {
    Object.defineProperties(sheet.element, {
      offsetTop: { configurable: true, value: index * 1000 + 24 },
      offsetHeight: { configurable: true, value: 980 },
    })
  }
  return { wrapper, state, stage }
}

describe('PDF 连续拼页与按需渲染', () => {
  it('默认将全部页面纵向占位，只准备当前页及接近视口的页面', async () => {
    const { wrapper } = await fixture()
    expect(wrapper.findAll('.workspace-pdf__sheet')).toHaveLength(20)
    expect(wrapper.findAll('.pdf-page-probe')).toHaveLength(1)
    const third = wrapper.get('[data-page="3"]').element
    intersect([{ target: third, isIntersecting: true }] as never, {} as IntersectionObserver)
    await nextTick()
    expect(wrapper.findAll('.pdf-page-probe')).toHaveLength(2)
    expect(wrapper.find('[data-page="10"] .pdf-page-probe').exists()).toBe(false)
    intersect([{ target: third, isIntersecting: false }] as never, {} as IntersectionObserver)
    await nextTick()
    expect(wrapper.find('[data-page="3"] .pdf-page-probe').exists()).toBe(false)
    expect(mocks.destroy).not.toHaveBeenCalled()
  })
  it('连续滚动同步页码和阅读位置，不重新载入 PDF', async () => {
    const { wrapper, stage, state } = await fixture()
    vi.useFakeTimers()
    stage.scrollTop = 2140
    await wrapper.get('.workspace-pdf__stage').trigger('scroll')
    await vi.advanceTimersByTimeAsync(110)
    expect(state.page).toBe(3)
    expect(state.pdfScrollTop).toBe(2140)
    expect(mocks.getDocument).toHaveBeenCalledOnce()
  })
  it('可以切换单页模式并跳到指定页，再恢复连续阅读', async () => {
    const { wrapper, state } = await fixture()
    await wrapper.get('select').setValue('single')
    await wrapper.get('input[type="number"]').setValue(12)
    await flushPromises()
    expect(state.page).toBe(12)
    expect(wrapper.findAll('.workspace-pdf__sheet')).toHaveLength(1)
    expect(wrapper.get('.workspace-pdf__sheet').attributes('data-page')).toBe('12')
    await wrapper.get('select').setValue('continuous')
    await flushPromises()
    expect(wrapper.findAll('.workspace-pdf__sheet')).toHaveLength(20)
    expect(state.page).toBe(12)
    expect(mocks.getDocument).toHaveBeenCalledOnce()
  })
  it('全文查找可以跳到尚未渲染的页面', async () => {
    const { wrapper, state } = await fixture()
    await wrapper.get('input[type="search"]').setValue('页面唯一词-17')
    await wrapper.get('form.workspace-pdf__search').trigger('submit')
    await flushPromises()
    expect(state.page).toBe(17)
    expect(wrapper.find('[data-page="17"] .pdf-page-probe').exists()).toBe(true)
  })
  it('关闭预览释放 PDF Worker', async () => {
    const { wrapper } = await fixture()
    wrappers.pop()
    wrapper.unmount()
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })
})
