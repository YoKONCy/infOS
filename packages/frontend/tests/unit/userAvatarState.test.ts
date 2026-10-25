// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  origin: 'https://server-a.test',
  callbacks: [] as Array<{ onStateUpdate: (value: Record<string, unknown>) => void }>,
  profile: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@infos/frontend/api/modules/userAvatarApi', () => ({
  userAvatarApi: {
    profile: mocks.profile,
    upload: mocks.upload,
    remove: mocks.remove,
    contentUrl: (version: string) => `${mocks.origin}/avatar?v=${version}`,
  },
}))
vi.mock('@infos/frontend/api/transport', () => ({ getApiBaseUrl: () => mocks.origin }))
vi.mock('@infos/frontend/composables/gateway/useGateway', () => ({
  useGateway: (callbacks: (typeof mocks.callbacks)[number]) => {
    mocks.callbacks.push(callbacks)
    return { isConnected: ref(false) }
  },
}))

const wrappers: Array<ReturnType<typeof mount>> = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.origin = 'https://server-a.test'
  mocks.callbacks.length = 0
  mocks.profile.mockResolvedValue({ data: { version: 'initial', name: '主人' } })
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})

async function consumer() {
  const { useUserAvatar } = await import('@infos/frontend/composables/ui/useUserAvatar')
  let state!: ReturnType<typeof useUserAvatar>
  wrappers.push(
    mount(
      defineComponent({
        setup() {
          state = useUserAvatar()
          return () => h('span', state.imageUrl.value)
        },
      }),
    ),
  )
  return state
}

describe('用户头像共享状态', () => {
  it('多个展示入口共用一次初始读取，上传后同时切换到服务端资源', async () => {
    const read = deferred<{ data: { version: string; name: string } }>()
    mocks.profile.mockReturnValueOnce(read.promise)
    const first = await consumer()
    const second = await consumer()
    expect(mocks.profile).toHaveBeenCalledTimes(1)
    read.resolve({ data: { version: 'initial', name: '主人' } })
    await flushPromises()
    const png = new Blob(['png'], { type: 'image/png' })
    mocks.upload.mockResolvedValue({ data: { version: 'saved', name: '主人' } })
    await first.upload(png)
    expect(mocks.upload).toHaveBeenCalledWith(png)
    expect(first.imageUrl.value).toContain('v=saved')
    expect(second.imageUrl.value).toBe(first.imageUrl.value)
  })
  it('跨窗口更新到达时，正在进行的旧读取不会吞掉更新通知', async () => {
    const old = deferred<{ data: { version: string; name: string } }>()
    mocks.profile
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ data: { version: 'new', name: '主人' } })
    const state = await consumer()
    mocks.callbacks[0]!.onStateUpdate({ ownerAvatarChanged: true })
    old.resolve({ data: { version: 'old', name: '主人' } })
    await flushPromises()
    expect(mocks.profile).toHaveBeenCalledTimes(2)
    expect(state.version.value).toBe('new')
  })
  it('保存期间发出的读取晚到，也不会覆盖已保存的头像', async () => {
    const state = await consumer()
    await flushPromises()
    const saving = deferred<{ data: { version: string; name: string } }>()
    const old = deferred<{ data: { version: string; name: string } }>()
    mocks.upload.mockReturnValueOnce(saving.promise)
    const save = state.upload(new Blob(['png']))
    mocks.profile.mockReturnValueOnce(old.promise)
    const refresh = state.refresh(true)
    saving.resolve({ data: { version: 'saved', name: '主人' } })
    await save
    old.resolve({ data: { version: 'old', name: '主人' } })
    await refresh
    expect(state.version.value).toBe('saved')
  })
  it('恢复默认会同步清空所有入口；失败不会丢失原头像', async () => {
    const first = await consumer()
    const second = await consumer()
    await flushPromises()
    mocks.remove.mockRejectedValueOnce(new Error('模拟保存失败'))
    await expect(first.reset()).rejects.toThrow('模拟保存失败')
    expect(second.version.value).toBe('initial')
    expect(first.busy.value).toBe(false)
    mocks.remove.mockResolvedValueOnce({ data: { version: null, name: '主人' } })
    await first.reset()
    expect(first.imageUrl.value).toBe('')
    expect(second.imageUrl.value).toBe('')
  })
  it('切换服务端后，前一服务端的晚到响应不能串入当前头像', async () => {
    const old = deferred<{ data: { version: string; name: string } }>()
    mocks.profile.mockReturnValueOnce(old.promise)
    const state = await consumer()
    mocks.origin = 'https://server-b.test'
    mocks.profile.mockResolvedValueOnce({ data: { version: 'server-b', name: '新用户' } })
    await state.refresh(true)
    old.resolve({ data: { version: 'server-a', name: '旧用户' } })
    await flushPromises()
    expect(state.imageUrl.value).toBe('https://server-b.test/avatar?v=server-b')
    expect(state.name.value).toBe('新用户')
  })
})
