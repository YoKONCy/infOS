// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UpdateCenterDialog from '../../../src/components/main/UpdateCenterDialog.vue'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listener: null as ((payload: unknown) => void) | null,
}))

vi.mock('../../../src/utils/ipcAdapter', () => ({
  isElectron: () => true,
  invoke: ipc.invoke,
  listen: ipc.listen,
}))

const releases = [
  {
    tagName: 'v1.2.0',
    version: '1.2.0',
    name: '正式发布',
    body: '稳定版本',
    publishedAt: '2026-08-20T10:00:00Z',
    htmlUrl: '',
    channel: 'stable',
    prerelease: false,
    assetName: 'App-Setup-1.2.0.exe',
    assetSize: 100,
  },
  {
    tagName: 'v1.3.0-rc1',
    version: '1.3.0-rc1',
    name: '预发版本',
    body: '候选版本',
    publishedAt: '2026-08-21T10:00:00Z',
    htmlUrl: '',
    channel: 'rc',
    prerelease: true,
    assetName: 'App-Setup-1.3.0-rc1.exe',
    assetSize: 100,
  },
  {
    tagName: 'v1.3.0-alpha1',
    version: '1.3.0-alpha1',
    name: '构建版本',
    body: '构建版本',
    publishedAt: '2026-08-22T10:00:00Z',
    htmlUrl: '',
    channel: 'alpha',
    prerelease: true,
    assetName: 'App-Setup-1.3.0-alpha1.exe',
    assetSize: 100,
  },
  {
    tagName: 'v1.3.0-beta1',
    version: '1.3.0-beta1',
    name: '测试版本',
    body: '测试版本',
    publishedAt: '2026-08-23T10:00:00Z',
    htmlUrl: '',
    channel: 'beta',
    prerelease: true,
    assetName: 'App-Setup-1.3.0-beta1.exe',
    assetSize: 100,
  },
  {
    tagName: 'v1.2.1-hotfix1',
    version: '1.2.1-hotfix1',
    name: '热补丁',
    body: '紧急修复',
    publishedAt: '2026-08-24T10:00:00Z',
    htmlUrl: '',
    channel: 'hotfix',
    prerelease: false,
    assetName: 'App-Setup-1.2.1-hotfix1.exe',
    assetSize: 100,
  },
] as const

const baseState = {
  phase: 'available',
  deployment: 'installed',
  currentVersion: '1.1.0',
  selectedVersion: '1.2.0',
  selectedTag: 'v1.2.0',
  progress: 0,
  message: '发现 5 个可用版本',
}

function mountDialog() {
  return mount(UpdateCenterDialog, {
    attachTo: document.body,
    props: { modelValue: true, currentVersion: '1.1.0' },
    global: {
      stubs: {
        PixelIcon: true,
        PButton: {
          props: ['disabled', 'loading'],
          emits: ['click'],
          template:
            '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
        },
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ipc.listener = null
  ipc.listen.mockImplementation(async (_event: string, listener: (payload: unknown) => void) => {
    ipc.listener = listener
    return vi.fn()
  })
  ipc.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    if (channel === 'get-update-state') return { ...baseState }
    if (channel === 'get-client-update-releases') return [...releases]
    if (channel === 'download-client-update') {
      return {
        ...baseState,
        phase: 'downloaded',
        selectedTag: (payload as { tagName: string }).tagName,
        progress: 100,
        message: '更新已下载',
      }
    }
    if (channel === 'install-client-update') return true
    return { ...baseState }
  })
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('UpdateCenterDialog', () => {
  it('安装失败显示错误与日志入口，保留有效下载的安装按钮用于重试', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(document.body.querySelectorAll('.release-card')).toHaveLength(5))
    ipc.listener?.({ ...baseState, phase: 'error', canInstall: true, message: '安装准备失败，更新包已保留' })
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('安装准备失败，更新包已保留')
    expect(document.body.textContent).toContain('打开更新日志目录')
    expect(document.body.textContent).toContain('前往发布页手动下载')
    expect(document.body.querySelector('.update-action')!.textContent).toContain('安装')
    wrapper.unmount()
  })

  it('准备安装期间禁用版本切换与重复安装', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(document.body.querySelectorAll('.release-card')).toHaveLength(5))
    ipc.listener?.({ ...baseState, phase: 'installing', canInstall: false, message: '正在准备安装助手' })
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector<HTMLButtonElement>('.update-action')!.disabled).toBe(true)
    expect(document.body.querySelector<HTMLButtonElement>('.release-card')!.disabled).toBe(true)
    expect(document.body.textContent).toContain('正在准备安装')
    expect(ipc.invoke).not.toHaveBeenCalledWith('install-client-update')
    wrapper.unmount()
  })

  it('应展示服务端返回的全部可选版本', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(document.body.querySelectorAll('.release-card')).toHaveLength(5))

    for (const release of releases) expect(document.body.textContent).toContain(release.version)
    wrapper.unmount()
  })

  it('选择目标版本后应按tag下载并展示进度', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(document.body.querySelectorAll('.release-card')).toHaveLength(5))

    const cards = [...document.body.querySelectorAll<HTMLButtonElement>('.release-card')]
    cards[1]!.click()
    await wrapper.vm.$nextTick()
    const action = document.body.querySelector<HTMLButtonElement>('.update-action')!
    action.click()

    await vi.waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('download-client-update', { tagName: 'v1.3.0-rc1' }),
    )

    ipc.listener?.({
      ...baseState,
      phase: 'downloading',
      selectedTag: 'v1.3.0-rc1',
      progress: 42,
      transferredBytes: 42,
      totalBytes: 100,
      message: '正在下载 42%',
    })
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('42%')
    expect((document.body.querySelector('.progress-fill') as HTMLElement).style.width).toBe('42%')
    wrapper.unmount()
  })

  it('下载完成后按钮应变为安装并调用退出安装IPC', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(document.body.querySelectorAll('.release-card')).toHaveLength(5))

    ipc.listener?.({
      ...baseState,
      phase: 'downloaded',
      selectedTag: 'v1.2.0',
      progress: 100,
      message: '更新已下载',
    })
    await wrapper.vm.$nextTick()
    const action = document.body.querySelector<HTMLButtonElement>('.update-action')!
    action.click()
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('install-client-update'))
    wrapper.unmount()
  })
})
