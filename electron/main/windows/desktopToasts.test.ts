import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents } from 'electron'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopToastSnapshot } from '@infos/shared'

const mock = vi.hoisted(() => ({ createWindow: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: mock.createWindow }))
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn() } }))
import { DesktopToastLayer } from './desktopToasts'

class Contents extends EventEmitter {
  destroyed = false
  isDestroyed = () => this.destroyed
  send = vi.fn()
  getURL = () => 'http://localhost:5173/#/app'
  setWindowOpenHandler = vi.fn()
  getZoomFactor = () => 1
  setZoomFactor = vi.fn()
}
class Window extends EventEmitter {
  readonly contents = new Contents()
  get webContents() {
    if (this.destroyed) throw new TypeError('Object has been destroyed')
    return this.contents
  }
  visible = true
  focused = true
  minimized = false
  destroyed = false
  bounds = { x: 100, y: 200, width: 1280, height: 800 }
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  isFocused = () => this.focused
  isMinimized = () => this.minimized
  getContentBounds = () => this.bounds
  setBounds = vi.fn()
  setMenu = vi.fn()
  setBackgroundMaterial = vi.fn()
  setIgnoreMouseEvents = vi.fn()
  loadURL = vi.fn().mockResolvedValue(undefined)
  showInactive = vi.fn(() => {
    this.visible = true
  })
  hide = vi.fn(() => {
    this.visible = false
  })
  destroy = vi.fn(() => {
    this.destroyed = true
    this.contents.destroyed = true
    this.emit('closed')
  })
}
const asWindow = (window: Window) => window as unknown as BrowserWindow
const asContents = (window: Window) => window.webContents as unknown as WebContents
const snapshot = (revision = 1): DesktopToastSnapshot => ({
  revision,
  theme: 'dark',
  normal: [
    {
      id: 1,
      type: 'success',
      severity: 'toast',
      message: '操作完成',
      duration: 4000,
      createdAt: 1,
    },
  ],
  tasks: [
    {
      id: 'task-1',
      type: 'task_completed',
      title: '工作完成',
      message: '可以查看结果',
      createdAt: 1,
    },
  ],
})
let layer: DesktopToastLayer, host: Window, overlay: Window
beforeEach(() => {
  vi.clearAllMocks()
  host = new Window()
  overlay = new Window()
  overlay.visible = false
  mock.createWindow.mockImplementation(function () {
    return overlay
  })
  layer = new DesktopToastLayer()
  layer.attach(asWindow(host))
})
afterEach(() => {
  host.emit('closed')
})

describe('原生通知层', () => {
  it('仅在原生子视图可见时创建通知层，加载后不抢焦点地覆盖子视图', () => {
    layer.update(asContents(host), snapshot())
    expect(mock.createWindow).not.toHaveBeenCalled()
    layer.setNativeVisible(true)
    expect(mock.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({ parent: host, transparent: true, focusable: false }),
    )
    expect(mock.createWindow.mock.calls[0]![0]).not.toHaveProperty('backgroundMaterial')
    expect(overlay.showInactive).not.toHaveBeenCalled()
    overlay.webContents.emit('did-finish-load')
    expect(overlay.showInactive).toHaveBeenCalledTimes(1)
    expect(overlay.setBounds).toHaveBeenCalledWith(host.bounds)
    expect(host.webContents.send).toHaveBeenCalledWith('desktop-toasts:visibility', true)
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  })

  it('卡片外穿透点击，关闭与悬停动作只回传主窗口队列', () => {
    layer.update(asContents(host), snapshot())
    layer.setNativeVisible(true)
    overlay.webContents.emit('did-finish-load')
    layer.pointer(asContents(overlay), true)
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    layer.action(asContents(overlay), { kind: 'normal', id: 1 })
    expect(host.webContents.send).toHaveBeenCalledWith('desktop-toasts:action', {
      kind: 'normal',
      id: 1,
    })
    layer.action(asContents(overlay), { kind: 'hover', id: 'task-1', hovered: true })
    layer.setNativeVisible(false)
    expect(overlay.hide).toHaveBeenCalled()
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    expect(host.webContents.send).toHaveBeenCalledWith('desktop-toasts:action', {
      kind: 'hover',
      id: 'task-1',
      hovered: false,
    })
  })

  it('拒绝子应用伪造通知操作并忽略过期快照', () => {
    layer.update(asContents(host), snapshot(2))
    layer.setNativeVisible(true)
    expect(() => layer.update(asContents(overlay), snapshot(3))).toThrow('仅主窗口可以发布通知')
    expect(() => layer.action(asContents(host), { kind: 'normal', id: 1 })).toThrow(
      '仅通知层可以操作通知',
    )
    layer.update(asContents(host), { ...snapshot(1), normal: [] })
    expect(layer.state(asContents(overlay)).revision).toBe(2)
    host.webContents.send.mockClear()
    layer.action(asContents(overlay), { kind: 'normal', id: 999 })
    expect(host.webContents.send).not.toHaveBeenCalled()
  })

  it('跟随移动、最小化和主窗口关闭，清理原生窗口及监听器', () => {
    layer.update(asContents(host), snapshot())
    layer.setNativeVisible(true)
    overlay.webContents.emit('did-finish-load')
    host.bounds = { x: 200, y: 300, width: 1000, height: 700 }
    host.emit('move')
    expect(overlay.setBounds).toHaveBeenLastCalledWith(host.bounds)
    host.minimized = true
    host.emit('minimize')
    expect(overlay.visible).toBe(false)
    host.minimized = false
    host.emit('restore')
    expect(overlay.visible).toBe(true)
    host.emit('closed')
    expect(overlay.destroy).toHaveBeenCalledTimes(1)
    expect(host.listenerCount('move')).toBe(0)
    expect(host.webContents.listenerCount('did-start-loading')).toBe(0)
  })
  it('主窗口原生对象先销毁后仍可解绑监听器，重复清理不会访问失效对象', () => {
    const contents = host.webContents
    layer.update(asContents(host), snapshot())
    layer.setNativeVisible(true)
    overlay.webContents.emit('did-finish-load')
    layer.action(asContents(overlay), { kind: 'hover', id: 'task-1', hovered: true })
    expect(() => host.destroy()).not.toThrow()
    expect(() => host.emit('closed')).not.toThrow()
    expect(overlay.destroy).toHaveBeenCalledTimes(1)
    expect(contents.listenerCount('did-start-loading')).toBe(0)
    expect(contents.listenerCount('render-process-gone')).toBe(0)
  })
  it('WebContents 提前销毁时忽略退出期间的通知发送', () => {
    layer.update(asContents(host), snapshot())
    layer.setNativeVisible(true)
    overlay.webContents.emit('did-finish-load')
    host.contents.destroyed = true
    host.contents.send.mockClear()
    expect(() => host.emit('closed')).not.toThrow()
    expect(host.contents.send).not.toHaveBeenCalled()
  })
})
