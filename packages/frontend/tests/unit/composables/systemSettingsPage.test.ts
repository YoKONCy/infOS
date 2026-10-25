import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createSystemSettingsPage } from '@infos/frontend/composables/ui/useSystemSettingsPage'

describe('系统设定整页保存协调', () => {
  it('按点击时的整页快照串行保存，旧请求不能覆盖后来的文本和切换', async () => {
    let release!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = vi.fn().mockReturnValueOnce(firstWrite).mockResolvedValue(undefined)
    const saved = vi.fn(),
      failed = vi.fn()
    const page = createSystemSettingsPage({ write, saved, failed })
    const persona = ref('草稿一'),
      language = ref('zh-CN')
    page.register({
      capture: () => ({
        items: [
          { key: 'owner.persona', value: persona.value },
          { key: 'user.language', value: language.value },
        ],
      }),
    })
    const first = page.save()
    persona.value = '草稿二'
    language.value = 'en-US'
    const second = page.save()
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
    expect(page.saving.value).toBe(true)
    release()
    await Promise.all([first, second])
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      [
        { key: 'owner.persona', value: '草稿一' },
        { key: 'user.language', value: 'zh-CN' },
      ],
      [
        { key: 'owner.persona', value: '草稿二' },
        { key: 'user.language', value: 'en-US' },
      ],
    ])
    expect(saved).toHaveBeenCalledTimes(2)
    expect(failed).not.toHaveBeenCalled()
    expect(page.saving.value).toBe(false)
  })

  it('加载未完成不保存默认值；子项失败保留草稿且能重新提交', async () => {
    const loaded = ref(false),
      draft = ref('未保存文本')
    const write = vi.fn().mockResolvedValue(undefined)
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('模拟失败'))
      .mockResolvedValue(undefined)
    const committed = vi.fn(),
      failed = vi.fn()
    const page = createSystemSettingsPage({ write, saved: vi.fn(), failed })
    page.register({
      ready: () => loaded.value,
      capture: () => ({ items: [{ key: 'text', value: draft.value }], persist, committed }),
    })
    expect(await page.save()).toBe(false)
    expect(write).not.toHaveBeenCalled()
    loaded.value = true
    expect(await page.save()).toBe(false)
    expect(committed).not.toHaveBeenCalled()
    expect(draft.value).toBe('未保存文本')
    expect(await page.save()).toBe(true)
    expect(committed).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it('明确重试会重新提交整页及上次失败的设备或资源操作', async () => {
    const after = vi
      .fn()
      .mockRejectedValueOnce(new Error('设备写入失败'))
      .mockResolvedValue(undefined)
    const page = createSystemSettingsPage({ write: vi.fn(), saved: vi.fn(), failed: vi.fn() })
    expect(await page.save(after)).toBe(false)
    expect(await page.retry()).toBe(true)
    expect(after).toHaveBeenCalledTimes(2)
  })

  it('资源操作失败后点击普通保存，仍提交最新草稿并重试未完成操作', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('头像上传失败'))
      .mockResolvedValue(undefined)
    const draft = ref('旧人设')
    const write = vi.fn().mockResolvedValue(undefined)
    const saved = vi.fn()
    const page = createSystemSettingsPage({ write, saved, failed: vi.fn() })
    page.register({ capture: () => ({ items: [{ key: 'owner.persona', value: draft.value }] }) })
    expect(await page.save(upload)).toBe(false)
    draft.value = '修改后的人设'
    expect(await page.save()).toBe(true)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith([{ key: 'owner.persona', value: '修改后的人设' }])
    expect(saved).toHaveBeenCalledTimes(1)
    expect(await page.save()).toBe(true)
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('后续操作不会替换先前失败的操作，重试只继续尚未完成的部分', async () => {
    const calls: string[] = []
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('头像上传失败'))
      .mockImplementation(async () => {
        calls.push('上传')
      })
    const device = vi
      .fn()
      .mockRejectedValueOnce(new Error('设备设置失败'))
      .mockImplementation(async () => {
        calls.push('设备')
      })
    const page = createSystemSettingsPage({ write: vi.fn(), saved: vi.fn(), failed: vi.fn() })
    expect(await page.save(upload)).toBe(false)
    expect(await page.save(device)).toBe(false)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(device).toHaveBeenCalledTimes(1)
    expect(await page.retry()).toBe(true)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(device).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['上传', '设备'])
  })

  it('配置写入失败时也保留资源操作，排队的普通保存会继续执行', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('配置写入失败'))
      .mockResolvedValue(undefined)
    const upload = vi.fn().mockResolvedValue(undefined)
    const page = createSystemSettingsPage({ write, saved: vi.fn(), failed: vi.fn() })
    page.register({ capture: () => ({ items: [{ key: 'owner.persona', value: '草稿' }] }) })
    const first = page.save(upload)
    const second = page.save()
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('同一资源重新提交时替代旧失败操作，避免重复上传或应用旧选择', async () => {
    const previous = vi.fn().mockRejectedValue(new Error('旧头像上传失败'))
    const latest = vi.fn().mockResolvedValue(undefined)
    const page = createSystemSettingsPage({ write: vi.fn(), saved: vi.fn(), failed: vi.fn() })
    expect(await page.save(previous, 'user-avatar')).toBe(false)
    expect(await page.save(latest, 'user-avatar')).toBe(true)
    expect(previous).toHaveBeenCalledTimes(1)
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('取消头像裁切后移除未完成上传，后续整页保存不再上传已取消的图片', async () => {
    const upload = vi.fn().mockRejectedValue(new Error('上传失败'))
    const page = createSystemSettingsPage({ write: vi.fn(), saved: vi.fn(), failed: vi.fn() })
    expect(await page.save(upload, 'user-avatar')).toBe(false)
    page.discard('user-avatar')
    expect(await page.save()).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)
  })
})
