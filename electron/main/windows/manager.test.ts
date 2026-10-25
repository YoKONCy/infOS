import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guardTransparentWindowMaterial, resolveWindowBackground } from './windowConfig'

const backdrop = vi.hoisted(() => ({ disable: vi.fn() }))
vi.mock('../utils/windowsSystemBackdrop', () => ({
  disableWindowsSystemBackdrop: backdrop.disable,
}))
beforeEach(() => {
  backdrop.disable.mockReset()
  backdrop.disable.mockReturnValue(true)
})

describe('resolveWindowBackground', () => {
  it('可缩放主窗口应使用不透明底色', () => {
    expect(resolveWindowBackground({ transparent: false })).toMatch(/^#[\da-f]{6}(?:ff)?$/i)
  })

  it('桌宠等透明窗口应继续使用透明底色', () => {
    expect(resolveWindowBackground({ transparent: true })).toMatch(/^#[\da-f]{6}00$/i)
  })
})

class MaterialWindow extends EventEmitter {
  destroyed = false
  material = 'acrylic'
  getNativeWindowHandle = vi.fn(() => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]))
  isDestroyed = () => this.destroyed
  setBackgroundMaterial = vi.fn((material: string) => {
    this.material = material
  })
}

const asWindow = (win: MaterialWindow) => win as unknown as BrowserWindow

describe('透明窗口系统材质防护', () => {
  it('创建时清除材质，显窗和聚焦时恢复被外部修改的材质策略', () => {
    const win = new MaterialWindow()
    backdrop.disable.mockImplementation(() => {
      win.material = 'none'
      return true
    })
    guardTransparentWindowMaterial(asWindow(win), 'win32')
    expect(win.material).toBe('none')

    win.material = 'mica'
    win.emit('show')
    expect(win.material).toBe('none')

    win.material = 'acrylic'
    win.emit('focus')
    expect(win.material).toBe('none')
    expect(backdrop.disable).toHaveBeenCalledTimes(3)
    expect(backdrop.disable).toHaveBeenCalledWith(win.getNativeWindowHandle())
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it('窗口销毁后不再访问原生材质接口，并在关闭时解绑事件', () => {
    const win = new MaterialWindow()
    guardTransparentWindowMaterial(asWindow(win), 'win32')
    backdrop.disable.mockClear()
    win.getNativeWindowHandle.mockClear()
    win.destroyed = true
    win.emit('focus')
    expect(backdrop.disable).not.toHaveBeenCalled()
    expect(win.getNativeWindowHandle).not.toHaveBeenCalled()

    win.emit('closed')
    expect(win.listenerCount('show')).toBe(0)
    expect(win.listenerCount('focus')).toBe(0)
  })

  it('原生句柄暂时不可读时，创建与显窗仍可继续', () => {
    const win = new MaterialWindow()
    win.getNativeWindowHandle.mockImplementation(() => {
      throw new Error('窗口句柄不可用')
    })
    expect(() => guardTransparentWindowMaterial(asWindow(win), 'win32')).not.toThrow()
    expect(() => win.emit('show')).not.toThrow()
    expect(() => win.emit('focus')).not.toThrow()
    win.emit('closed')
    expect(win.listenerCount('show')).toBe(0)
  })

  it.each(['darwin', 'linux'] as const)('在 %s 上保留平台原有材质策略', (platform) => {
    const win = new MaterialWindow()
    guardTransparentWindowMaterial(asWindow(win), platform)
    win.emit('show')
    win.emit('focus')
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled()
    expect(backdrop.disable).not.toHaveBeenCalled()
    expect(win.listenerCount('show')).toBe(0)
    expect(win.listenerCount('focus')).toBe(0)
  })

  it('原生防护不可用时保留透明合成，不回退到 Electron 材质接口', () => {
    const win = new MaterialWindow()
    backdrop.disable.mockReturnValue(false)
    guardTransparentWindowMaterial(asWindow(win), 'win32')
    win.emit('show')
    win.emit('focus')
    expect(backdrop.disable).toHaveBeenCalledTimes(3)
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled()
  })
})
