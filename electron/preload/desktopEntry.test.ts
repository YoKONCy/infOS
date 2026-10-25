// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcRenderer } from 'electron'
import { installDesktopEntry } from './desktopEntry'

vi.mock('electron', () => ({
  ipcRenderer: { invoke: vi.fn(async () => 'zh-CN'), on: vi.fn(), off: vi.fn() },
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 16),
  )
  document.body.innerHTML = '<div id="app"></div>'
  for (const link of document.head.querySelectorAll('link[href="./desktop-entry.css"]'))
    link.remove()
  for (const key of ['desktopEntry', 'desktopEntryReady', 'desktopEntryMotion'])
    delete document.documentElement.dataset[key]
  localStorage.clear()
  location.hash = '#/app'
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
function mount() {
  installDesktopEntry()
  window.dispatchEvent(new Event('DOMContentLoaded'))
}
function loadStyles() {
  const overlay = document.getElementById('infos-desktop-entry')!
  // 保持动画待完成，用于区分停留阶段、真实展开与兜底释放。
  const animate = vi.fn(() => ({ finished: new Promise<void>(() => {}), cancel: vi.fn() }))
  for (const element of [overlay, ...overlay.querySelectorAll('*')]) {
    Object.defineProperty(element, 'animate', { configurable: true, value: animate })
  }
  document.head.querySelector('link[href="./desktop-entry.css"]')!.dispatchEvent(new Event('load'))
  return { overlay, animate }
}
describe('桌面模式首次加载过渡', () => {
  it('等待超时保留遮挡和恢复入口，不把超时当成加载成功', async () => {
    mount()
    await vi.advanceTimersByTimeAsync(30_000)
    const overlay = document.getElementById('infos-desktop-entry')!
    expect(overlay.dataset.failed).toBe('true')
    expect(overlay.querySelector('[data-entry-actions]')!.hasAttribute('hidden')).toBe(false)
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true)
    expect(overlay.textContent).toContain('桌面界面未能就绪，请重试。')
  })
  it('关闭动效仍等待首帧就绪，完成后释放操作且不响应后续导航', async () => {
    localStorage.setItem('infos.ui.motionLevel', 'off')
    mount()
    expect(document.getElementById('infos-desktop-entry')).not.toBeNull()
    document.documentElement.dataset.desktopEntryReady = 'true'
    await vi.advanceTimersByTimeAsync(100)
    expect(document.getElementById('infos-desktop-entry')).toBeNull()
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false)
    location.hash = '#/app?tab=workspace'
    await vi.advanceTimersByTimeAsync(100)
    expect(document.getElementById('infos-desktop-entry')).toBeNull()
  })
  it('启动器页面不插入第二套开屏，也不申请桌面过渡的语言监听', () => {
    location.hash = '#/launcher'
    mount()
    expect(document.getElementById('infos-desktop-entry')).toBeNull()
    expect(ipcRenderer.on).not.toHaveBeenCalled()
  })
  it('样式资源失败时也必须等真实就绪，随后直接释放页面', async () => {
    mount()
    document.head
      .querySelector('link[href="./desktop-entry.css"]')!
      .dispatchEvent(new Event('error'))
    await vi.advanceTimersByTimeAsync(100)
    expect(document.getElementById('infos-desktop-entry')).not.toBeNull()
    document.documentElement.dataset.desktopEntryReady = 'true'
    await vi.advanceTimersByTimeAsync(100)
    expect(document.getElementById('infos-desktop-entry')).toBeNull()
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false)
  })
  it('快速就绪也保留品牌停留，再完整展开；动画回调丢失可兜底交接', async () => {
    mount()
    const { overlay, animate } = loadStyles()
    document.documentElement.dataset.desktopEntryReady = 'true'
    await vi.advanceTimersByTimeAsync(1000)
    expect(overlay.dataset.phase).toBe('preparing')
    expect(animate).not.toHaveBeenCalled()
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(overlay.dataset.phase).toBe('revealing')
    expect(animate).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1300)
    expect(document.getElementById('infos-desktop-entry')).toBe(overlay)
    await vi.advanceTimersByTimeAsync(600)
    expect(document.getElementById('infos-desktop-entry')).toBeNull()
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false)
  })
  it('慢加载期间的品牌展示计入停留，收到就绪后不重复等待', async () => {
    mount()
    const { overlay, animate } = loadStyles()
    await vi.advanceTimersByTimeAsync(1400)
    expect(animate).not.toHaveBeenCalled()
    document.documentElement.dataset.desktopEntryReady = 'true'
    await vi.advanceTimersByTimeAsync(50)
    expect(overlay.dataset.phase).toBe('revealing')
    expect(animate).toHaveBeenCalled()
  })
  it('减弱动效跳过品牌停留，仅使用短淡出', async () => {
    localStorage.setItem('infos.ui.motionLevel', 'reduced')
    mount()
    const { overlay, animate } = loadStyles()
    document.documentElement.dataset.desktopEntryReady = 'true'
    await vi.advanceTimersByTimeAsync(50)
    expect(overlay.dataset.phase).toBe('revealing')
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate.mock.calls[0]).toEqual([
      [{ opacity: 1 }, { opacity: 0 }],
      expect.objectContaining({ duration: 180, delay: 0 }),
    ])
  })
  it('原生窗口显示前的等待不抵扣首次可读停留', async () => {
    mount()
    const { overlay, animate } = loadStyles()
    await vi.advanceTimersByTimeAsync(1400)
    const listener = vi
      .mocked(ipcRenderer.on)
      .mock.calls.find(([channel]) => channel === 'window-visibility-changed')![1]
    listener({} as Electron.IpcRendererEvent, true)
    document.documentElement.dataset.desktopEntryReady = 'true'
    await vi.advanceTimersByTimeAsync(1000)
    expect(overlay.dataset.phase).toBe('preparing')
    expect(animate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(overlay.dataset.phase).toBe('revealing')
    expect(animate).toHaveBeenCalled()
  })
  it('停留时关闭动效立即释放；迟到的计时器不会重复交接', async () => {
    mount()
    const { animate } = loadStyles()
    const finished = vi.fn()
    window.addEventListener('infos:desktop-entry-finished', finished)
    try {
      document.documentElement.dataset.desktopEntryReady = 'true'
      await vi.advanceTimersByTimeAsync(200)
      document.documentElement.dataset.desktopEntryMotion = 'off'
      await vi.advanceTimersByTimeAsync(50)
      expect(document.getElementById('infos-desktop-entry')).toBeNull()
      expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false)
      await vi.advanceTimersByTimeAsync(3000)
      expect(animate).not.toHaveBeenCalled()
      expect(finished).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('infos:desktop-entry-finished', finished)
    }
  })
})
