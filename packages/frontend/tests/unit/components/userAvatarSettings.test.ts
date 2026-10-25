// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UserAvatarSettings from '@infos/frontend/components/user/UserAvatarSettings.vue'
import {
  createSystemSettingsPage,
  provideSystemSettingsPage,
  type SystemSettingsPage,
} from '@infos/frontend/composables/ui/useSystemSettingsPage'

const mocks = vi.hoisted(() => ({ upload: vi.fn(), reset: vi.fn(), toast: vi.fn(), draw: vi.fn() }))
vi.mock('@infos/frontend/composables/ui/useUserAvatar', () => ({
  useUserAvatar: () => ({
    busy: ref(false),
    version: ref('existing'),
    imageUrl: ref('/api/managed-avatar'),
    upload: mocks.upload,
    reset: mocks.reset,
  }),
}))
vi.mock('@infos/frontend/api/transport', () => ({
  requestApiResource: vi.fn(),
  isElectronRuntime: () => false,
}))
vi.mock('@infos/frontend/stores', () => ({ useNotificationStore: () => ({ toast: mocks.toast }) }))

const wrappers: Array<ReturnType<typeof mount>> = []
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = 1600
      naturalHeight = 800
      decode = () => Promise.resolve()
    },
  )
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-crop')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: mocks.draw,
  } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
    callback(new Blob(['generated-png'], { type: 'image/png' })),
  )
  mocks.upload.mockResolvedValue(undefined)
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function create(page?: SystemSettingsPage) {
  const component = page
    ? defineComponent({
        setup() {
          provideSystemSettingsPage(page)
          return () => h(UserAvatarSettings)
        },
      })
    : UserAvatarSettings
  const wrapper = mount(component, { global: { stubs: { teleport: true } } })
  wrappers.push(wrapper)
  return wrapper
}
async function select(wrapper: ReturnType<typeof create>, type = 'image/jpeg') {
  const input = wrapper.get('input[type=file]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new File(['original-client-image'], 'local-photo.jpg', { type })],
  })
  await input.trigger('change')
  await flushPromises()
}
function button(wrapper: ReturnType<typeof create>, label: string) {
  return wrapper.findAll('button').find((element) => element.text() === label)!
}

describe('用户头像上传交互', () => {
  it('拖动、缩放后按当前裁切生成 PNG；原始文件和客户端路径不参与上传', async () => {
    const wrapper = create()
    await select(wrapper)
    const viewport = wrapper.get('.user-avatar-crop__viewport')
    Object.defineProperty(viewport.element, 'clientWidth', { value: 260 })
    const stage = wrapper.get('.user-avatar-crop__stage')
    Object.assign(stage.element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
    await stage.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    await stage.trigger('pointermove', { pointerId: 1, clientX: 52, clientY: 0 })
    await stage.trigger('pointerup', { pointerId: 1 })
    await button(wrapper, '＋').trigger('click')
    expect(wrapper.findAll('.user-avatar-crop__preview img')).toHaveLength(3)
    await button(wrapper, '使用此头像').trigger('click')
    await flushPromises()
    const args = mocks.draw.mock.calls[0]!
    expect(args[1]).toBeCloseTo(800 - (800 / 1.2) * 0.7)
    expect(args[2]).toBeCloseTo((800 - 800 / 1.2) / 2)
    expect(args.slice(5)).toEqual([0, 0, 512, 512])
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(mocks.upload.mock.calls[0]![0]).toBeInstanceOf(Blob)
    expect(mocks.upload.mock.calls[0]![0].type).toBe('image/png')
    expect(mocks.upload.mock.calls[0]![0].size).toBe('generated-png'.length)
    expect(wrapper.find('.user-avatar-crop__stage').exists()).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-crop')
  })
  it('取消只释放客户端预览，不保存、不清除已有头像', async () => {
    const wrapper = create()
    await select(wrapper)
    await button(wrapper, '取消').trigger('click')
    await flushPromises()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.reset).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-crop')
  })
  it('拖入图片也进入裁切；不支持的文件留在设置页提示', async () => {
    const wrapper = create()
    await select(wrapper, 'image/svg+xml')
    expect(wrapper.get('[role=alert]').text()).toContain('PNG、JPEG 或 WebP')
    expect(wrapper.find('.user-avatar-crop__stage').exists()).toBe(false)
    await wrapper.get('.user-avatar-settings').trigger('drop', {
      dataTransfer: { files: [new File(['png'], 'dragged.png', { type: 'image/png' })] },
    })
    await flushPromises()
    expect(wrapper.find('.user-avatar-crop__stage').exists()).toBe(true)
  })
  it('上传失败保留裁切窗口，允许重试', async () => {
    const wrapper = create()
    await select(wrapper)
    mocks.upload.mockRejectedValueOnce(new Error('模拟网络失败'))
    await button(wrapper, '使用此头像').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toBe('模拟网络失败')
    expect(wrapper.find('.user-avatar-crop__stage').exists()).toBe(true)
    await button(wrapper, '使用此头像').trigger('click')
    await flushPromises()
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.user-avatar-crop__stage').exists()).toBe(false)
  })
  it('整页保存模式下重新确认头像只上传一次，不重放旧失败上传', async () => {
    const page = createSystemSettingsPage({ write: vi.fn(), saved: vi.fn(), failed: vi.fn() })
    const wrapper = create(page)
    await select(wrapper)
    mocks.upload.mockRejectedValueOnce(new Error('模拟网络失败'))
    await button(wrapper, '使用此头像').trigger('click')
    await flushPromises()
    expect(wrapper.find('.user-avatar-crop__stage').exists()).toBe(true)
    await button(wrapper, '使用此头像').trigger('click')
    await flushPromises()
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.user-avatar-crop__stage').exists()).toBe(false)
  })
  it('整页保存模式下取消失败的头像上传，之后保存设置不再上传', async () => {
    const page = createSystemSettingsPage({ write: vi.fn(), saved: vi.fn(), failed: vi.fn() })
    const wrapper = create(page)
    await select(wrapper)
    mocks.upload.mockRejectedValueOnce(new Error('模拟网络失败'))
    await button(wrapper, '使用此头像').trigger('click')
    await flushPromises()
    await button(wrapper, '取消').trigger('click')
    await flushPromises()
    expect(await page.save()).toBe(true)
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.user-avatar-crop__stage').exists()).toBe(false)
  })
})
