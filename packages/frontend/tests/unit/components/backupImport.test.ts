// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setLocale } from '@infos/shared/i18n'
import BackupsTab from '@infos/frontend/components/dashboard/tabs/BackupsTab.vue'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  catalogue: vi.fn(),
  beginImport: vi.fn(),
  beginSavedImport: vi.fn(),
  uploadImport: vi.fn(),
  importProgress: vi.fn(),
  commit: vi.fn(),
  cancel: vi.fn(),
  inspect: vi.fn(),
  copy: vi.fn(),
}))
vi.mock('@infos/frontend/api/modules/backupApi', () => ({ backupApi: mocks }))
vi.mock('@infos/frontend/api/modules/backupFile', () => ({ inspectBackupFile: mocks.inspect }))
vi.mock('@infos/frontend/api/transport', () => ({
  getWebServerOrigin: () => 'https://restore.example',
  isLocalBackendRuntime: () => false,
  isElectronRuntime: () => false,
}))
vi.mock('@infos/frontend/lib/clientPlatform', () => ({ copyClientText: mocks.copy }))

const wrappers: Array<ReturnType<typeof mount>> = []
const pending = { ticket: 'restore-ticket', backupId: 'backup-id' }
function status(overrides: Record<string, unknown> = {}) {
  return {
    records: [],
    pending: null,
    lastImport: null,
    activeImport: null,
    runtime: 'docker',
    ...overrides,
  }
}
function progress() {
  return {
    id: 'upload-id',
    phase: 'uploading',
    receivedBytes: 0,
    uploadBytes: 1024,
    unpackedBytes: 0,
    unpackedTotal: 0,
    completedFiles: 0,
    totalFiles: 0,
  }
}
async function page() {
  const wrapper = mount(BackupsTab, { global: { stubs: { teleport: true, PixelIcon: true } } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
async function click(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((item) => item.text() === text)
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  setLocale('zh-CN')
  sessionStorage.clear()
  mocks.list.mockResolvedValue({ data: status() })
  mocks.catalogue.mockResolvedValue({
    data: { agents: [], threads: [], documents: [], facts: [], tasks: [] },
  })
  mocks.copy.mockResolvedValue(undefined)
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('备份导入的口令与恢复引导', () => {
  it('先处理加密口令，预检失败保留同一文件，修正后才调用上传', async () => {
    mocks.inspect.mockResolvedValue({ encrypted: true, prefix: 'bounded-header' })
    const wrapper = await page()
    const file = new File([new Uint8Array(1024)], 'encrypted.infos-backup')
    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    await flushPromises()
    expect(wrapper.find('.backup-source').text()).toContain('这份备份已加密')
    await wrapper.find('.backup-source').trigger('submit')
    await flushPromises()
    expect(mocks.beginImport).not.toHaveBeenCalled()
    expect(mocks.uploadImport).not.toHaveBeenCalled()

    mocks.beginImport.mockRejectedValueOnce(new Error('备份口令不正确或文件头已损坏，请检查后重试'))
    await wrapper.find('.backup-source input[type="password"]').setValue('错误口令')
    await wrapper.find('.backup-source').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.backup-source [role="alert"]').text()).toContain('备份口令不正确')
    expect(wrapper.find('.backup-source').text()).toContain('encrypted.infos-backup')
    expect(mocks.uploadImport).not.toHaveBeenCalled()

    mocks.beginImport.mockResolvedValue({ data: progress() })
    mocks.importProgress.mockResolvedValue({ data: progress() })
    mocks.uploadImport.mockResolvedValue(undefined)
    await wrapper.find('.backup-source input[type="password"]').setValue('正确口令')
    await wrapper.find('.backup-source').trigger('submit')
    await flushPromises()
    expect(mocks.beginImport).toHaveBeenLastCalledWith(file, '正确口令')
    expect(mocks.uploadImport).toHaveBeenCalledWith(
      file,
      'upload-id',
      expect.any(AbortSignal),
      expect.any(Function),
      undefined,
    )
    expect(wrapper.text()).toContain('正在上传备份')
  })

  it('确认暂存即显示 Docker 重启弹窗，关闭后仍保留页面指引', async () => {
    const preview = {
      ticket: pending.ticket,
      manifest: {
        id: pending.backupId,
        appVersion: '0.9.9',
        createdAt: '2026-10-30T00:00:00Z',
        selection: { level: 'full', agentIds: [] },
        files: [],
      },
      counts: {},
      conflicts: {},
      warnings: [],
      alreadyImported: false,
    }
    const ready = { ...progress(), phase: 'ready', preview }
    mocks.list
      .mockResolvedValueOnce({ data: status({ activeImport: progress() }) })
      .mockResolvedValue({ data: status({ pending }) })
    mocks.importProgress.mockResolvedValue({ data: ready })
    mocks.commit.mockResolvedValue({ data: { restartRequired: true } })
    const wrapper = await page()
    await click(wrapper, '确认导入方案')
    expect(wrapper.find('.p-dialog').text()).toContain('应用导入方案')
    await click(wrapper, '确定')
    expect(mocks.commit).toHaveBeenCalledWith(pending.ticket, {
      conflict: 'replace',
      agentTargets: {},
    })
    expect(wrapper.find('.p-dialog').text()).toContain('备份已暂存，下一步：重启服务端')
    expect(wrapper.find('.p-dialog').text()).toContain('docker compose restart backend')
    expect(wrapper.find('.backup-result').exists()).toBe(false)
    const copyButton = wrapper
      .find('.p-dialog')
      .findAll('button')
      .find((item) => item.text() === '复制重启命令')!
    await copyButton.trigger('click')
    await flushPromises()
    expect(mocks.copy).toHaveBeenCalledWith('docker compose restart backend')
    expect(wrapper.find('.p-dialog').text()).toContain('重启命令已复制')
    await click(wrapper, '我知道了，保留页面指引')
    expect(wrapper.find('.backup-pending').text()).toContain('docker compose restart backend')
    expect(wrapper.find('.backup-pending').text()).toContain(
      '刷新浏览器或重启 frontend 容器不会应用恢复',
    )
  })

  it('重启断线期间持续等待，重新连接后只展示服务端确认的恢复结果', async () => {
    mocks.list.mockResolvedValue({ data: status({ pending }) })
    const wrapper = await page()
    mocks.list.mockRejectedValueOnce(new Error('网络暂时中断'))
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(wrapper.find('.backup-pending').text()).toContain('服务暂时无法连接')
    expect(wrapper.find('.backup-result').exists()).toBe(false)
    mocks.list.mockResolvedValue({
      data: status({ lastImport: { status: 'completed', id: pending.backupId } }),
    })
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(wrapper.find('.backup-pending').exists()).toBe(false)
    expect(wrapper.find('.backup-result').text()).toContain('上次备份恢复已完成')
    expect(wrapper.find('.backup-result').text()).toContain('重新载入界面')
    expect(mocks.beginImport).not.toHaveBeenCalled()
    expect(mocks.uploadImport).not.toHaveBeenCalled()
  })
})
