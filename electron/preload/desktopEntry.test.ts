// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
})
