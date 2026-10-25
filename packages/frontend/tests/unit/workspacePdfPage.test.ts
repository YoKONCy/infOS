// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import Page from '../../src/components/workspace/WorkspacePdfPage.vue'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  cleanup: vi.fn(),
  cancelText: vi.fn(),
}))
vi.mock('pdfjs-dist', () => ({
  TextLayer: class {
    render = async () => {}
    cancel = mocks.cancelText
  },
}))
const wrappers: VueWrapper[] = []
beforeEach(() => {
  mocks.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
})
afterEach(async () => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  await flushPromises()
  vi.resetAllMocks()
})
async function fixture(zoom = 1) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 900 * scale,
      scale,
      userUnit: 1,
    }),
    render: mocks.render,
    streamTextContent: () => ({}),
    cleanup: mocks.cleanup,
  }
  const wrapper = mount(Page, {
    props: {
      document: { getPage: async () => page } as unknown as PDFDocumentProxy,
      page: 1,
      width: 800,
      zoom,
      query: '',
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
describe('PDF 页面渲染资源边界', () => {
  it('高倍率阅读仍限制单页位图面积与边长', async () => {
    const wrapper = await fixture(4)
    const canvas = wrapper.get('canvas').element as HTMLCanvasElement
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_000_000)
    expect(canvas.width).toBeLessThanOrEqual(8192)
    expect(canvas.height).toBeLessThanOrEqual(8192)
    expect(canvas.style.width).toBe('2400px')
  })
  it('快速缩放会取消旧任务，旧任务的取消不显示为页面故障', async () => {
    let reject!: (error: Error) => void
    const cancel = vi.fn(() => {
      const error = new Error('取消旧绘制')
      error.name = 'RenderingCancelledException'
      reject(error)
    })
    mocks.render.mockImplementationOnce(() => ({
      promise: new Promise<void>((_resolve, fail) => {
        reject = fail
      }),
      cancel,
    }))
    const wrapper = await fixture()
    const canvas = wrapper.get('canvas').element
    await wrapper.setProps({ zoom: 2 })
    await flushPromises()
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.render).toHaveBeenCalledTimes(2)
    expect(wrapper.get('canvas').element).toBe(canvas)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('离开附近视口卸载页面时释放位图与页面资源', async () => {
    const wrapper = await fixture()
    const canvas = wrapper.get('canvas').element as HTMLCanvasElement
    wrappers.pop()
    wrapper.unmount()
    await flushPromises()
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(mocks.cleanup).toHaveBeenCalledOnce()
    expect(mocks.cancelText).toHaveBeenCalled()
  })
})
