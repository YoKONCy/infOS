import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  windows: [] as any[],
  save: vi.fn(),
  profile: {
    mode: 'remote',
    origin: 'https://server.example',
    token: 'saved-secret',
    capabilityEndpoint: 'wss://server.example/capabilities',
  },
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/fixture' },
  screen: {
    getCursorScreenPoint: () => ({}),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  dialog: { showMessageBox: vi.fn() },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (key: string, fn: (...args: any[]) => any) => state.handlers.set(key, fn),
    removeHandler: (key: string) => state.handlers.delete(key),
    on: (key: string, fn: (...args: any[]) => any) => state.listeners.set(key, fn),
    off: (key: string) => state.listeners.delete(key),
  },
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
      isCrashed: () => false,
    })
    show = vi.fn()
    focus = vi.fn()
    restore = vi.fn()
    isMinimized = () => false
    setMenu = vi.fn()
    getBounds = () => this.options
    setBounds = vi.fn((bounds: any) => Object.assign(this.options, bounds))
    loadFile = vi.fn(async () => {})
    constructor(public options: any) {
      super()
      state.windows.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  },
}))
vi.mock('../services/clientConnection', () => ({
  clientConnection: () => ({ current: state.profile, save: state.save }),
}))
vi.mock('../utils/appIcon', () => ({ loadSystemIcon: () => undefined }))
vi.mock('../utils/appIdentity', () => ({ APPLICATION_NAME: 'infOS', applyWindowIdentity: vi.fn() }))
vi.mock('../utils/env', () => ({ paths: { logs: '/fixture/logs' } }))
vi.mock('../utils/runtimeMode', () => ({ isPackagedRuntime: false }))
vi.mock('../utils/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('../utils/i18n', () => ({
  getLocale: () => 'zh-CN',
  t: (_scope: string, source: string) => source,
}))
vi.mock('../../../packages/shared/src/i18n', () => ({ onLocaleChange: () => () => {} }))
vi.mock('./windowConfig', () => ({ guardTransparentWindowMaterial: vi.fn() }))
import { StartupSplash } from './startupSplash'

const hosts: StartupSplash[] = []
function host() {
  const actions = { retry: vi.fn(), quit: vi.fn() }
  const splash = new StartupSplash(actions)
  hosts.push(splash)
  return { splash, actions }
}
function eventFor(window = state.windows.at(-1)) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}
function snapshot() {
  return state.handlers.get('startup-splash:state')!(eventFor())
}
async function paint(splash: StartupSplash) {
  const opened = splash.open()
  state.listeners.get('startup-splash:painted')!(eventFor())
  await opened
}
afterEach(() => {
  for (const splash of hosts.splice(0)) splash.dispose()
  state.windows.splice(0)
  vi.clearAllMocks()
})

describe('开屏内的连接选择', () => {
  it('复用已显示的开屏，不创建第二个窗口或暴露保存的令牌', async () => {
    const { splash } = host()
    await paint(splash)
    const selected = splash.selectConnection()
    expect(state.windows).toHaveLength(1)
    expect(snapshot()).toMatchObject({
      phase: 'connection',
      connection: { mode: 'remote', restartRequired: false },
    })
    expect(JSON.stringify(snapshot())).not.toContain(state.profile.token)
    expect(state.windows[0].options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    const save = state.handlers.get('startup-splash:save-connection')!
    expect(await save({ sender: {}, senderFrame: {} }, { mode: 'local' })).toEqual({ ok: false })
    expect(await save({ ...eventFor(), senderFrame: {} }, { mode: 'local' })).toEqual({ ok: false })
    expect(state.save).not.toHaveBeenCalled()
    state.save.mockResolvedValue(undefined)
    expect(await save(eventFor(), { mode: 'local' })).toEqual({ ok: true })
    await selected
    expect(snapshot()).toMatchObject({ phase: 'opening', connection: null })
    expect(state.windows[0].isDestroyed()).toBe(false)
    expect(state.save).toHaveBeenCalledWith({ mode: 'local' }, true, expect.any(AbortSignal))
  })

  it('验证失败留在开屏内重试，未验证完成不放行启动，也拒绝重复提交', async () => {
    const { splash } = host()
    await paint(splash)
    const selected = splash.selectConnection()
    const settled = vi.fn()
    void selected.then(settled)
    const save = state.handlers.get('startup-splash:save-connection')!
    let fail!: (reason: Error) => void
    state.save.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    const saving = save(eventFor(), { mode: 'remote' })
    expect(snapshot().connection.busy).toBe(true)
    expect(await save(eventFor(), { mode: 'local' })).toEqual({ ok: false })
    expect(settled).not.toHaveBeenCalled()
    fail(new Error('REMOTE_CONNECTION_FAILED'))
    await saving
    expect(snapshot().connection).toMatchObject({
      busy: false,
      error: '连接失败，请检查地址、令牌和网络。',
    })
    state.save.mockResolvedValue(undefined)
    await save(eventFor(), { mode: 'local' })
    await selected
  })

  it('运行中取消会中止验证并关闭开屏，保留主客户端；迟到的验证不能重新启动', async () => {
    const { splash, actions } = host()
    const selected = splash.selectConnection(false)
    const cancelled = expect(selected).rejects.toThrow('CONNECTION_CANCELLED')
    await paint(splash)
    const window = state.windows[0]
    let finish!: () => void
    state.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const saving = state.handlers.get('startup-splash:save-connection')!(eventFor(), {
      mode: 'remote',
    })
    const signal = state.save.mock.calls.at(-1)![2] as AbortSignal
    state.listeners.get('startup-splash:action')!(eventFor(), 'cancel-connection')
    await cancelled
    expect(signal.aborted).toBe(true)
    expect(window.isDestroyed()).toBe(true)
    expect(actions.quit).not.toHaveBeenCalled()
    finish()
    expect(await saving).toEqual({ ok: false })
    expect(state.handlers.has('startup-splash:state')).toBe(true)
  })

  it('启动后可重新使用同一开屏宿主编辑下次配置，保存后回收开屏', async () => {
    const { splash } = host()
    await paint(splash)
    splash.hide()
    const selected = splash.selectConnection(false)
    await paint(splash)
    expect(snapshot().connection.restartRequired).toBe(true)
    state.save.mockResolvedValue(undefined)
    await state.handlers.get('startup-splash:save-connection')!(eventFor(), { mode: 'local' })
    await selected
    expect(state.save).toHaveBeenCalledWith({ mode: 'local' }, false, expect.any(AbortSignal))
    expect(state.windows.every((window) => window.isDestroyed())).toBe(true)
    splash.dispose()
    expect(state.handlers.size).toBe(0)
  })
})
