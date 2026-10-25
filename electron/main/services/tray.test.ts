import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  tray: {
    isDestroyed: vi.fn(() => false),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
  },
  menu: vi.fn((items: Array<{ label?: string; click?: () => void; type?: string }>) => items),
  launcher: vi.fn(),
  pet: vi.fn(),
  workbench: vi.fn(),
  quit: vi.fn(),
  recovery: vi.fn(),
  connection: vi.fn(async () => {}),
  focusConnection: vi.fn(() => false),
  relaunch: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { quit: mock.quit, relaunch: mock.relaunch },
  Tray: function () {
    return mock.tray
  },
  Menu: { buildFromTemplate: mock.menu },
}))
vi.mock('../utils/appIcon', () => ({ loadSystemIcon: () => ({}) }))
vi.mock('../utils/i18n', () => ({ t: (_scope: string, source: string) => source }))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../windows/manager', () => ({
  windowManager: {
    createLauncherWindow: mock.launcher,
    createPetWindow: mock.pet,
    createDashboardWindow: mock.workbench,
  },
}))
vi.mock('../../../packages/shared/src/i18n', () => ({ onLocaleChange: () => () => {} }))
vi.mock('./resourceRecovery', () => ({ showResourceRecovery: mock.recovery }))
vi.mock('./clientConnectionSetup', () => ({
  showConnectionSetup: mock.connection,
  focusConnectionSetup: mock.focusConnection,
}))
import { createTray, destroyTray } from './tray'

beforeEach(() => vi.clearAllMocks())
afterEach(destroyTray)

describe('托盘工作台入口', () => {
  it('右键入口按指定顺序调用各自窗口，保留退出能力', () => {
    createTray()
    const entries = mock.menu.mock.calls[0]![0].filter((item) => item.type !== 'separator')
    expect(entries.map((item) => item.label)).toEqual([
      '启动器',
      '桌宠召唤',
      '工作台',
      '选择运行方式',
      '拓展恢复',
      '彻底退出',
    ])
    entries[0]!.click!()
    entries[1]!.click!()
    entries[2]!.click!()
    entries[4]!.click!()
    expect(mock.launcher).toHaveBeenCalledOnce()
    expect(mock.pet).toHaveBeenCalledOnce()
    expect(mock.workbench).toHaveBeenCalledOnce()
    expect(mock.recovery).toHaveBeenCalledOnce()
  })
  it('连接模式通过开屏保存下次配置，再重启客户端', async () => {
    createTray()
    const entry = mock.menu.mock.calls[0]![0].find((item) => item.label === '选择运行方式')!
    entry.click!()
    await Promise.resolve()
    expect(mock.connection).toHaveBeenCalledWith(false)
    expect(mock.relaunch).toHaveBeenCalledOnce()
    expect(mock.quit).toHaveBeenCalledOnce()
  })
  it('左键直接打开综合工作台，不经过启动器', () => {
    createTray()
    const click = mock.tray.on.mock.calls.find((call) => call[0] === 'click')!
    ;(click[1] as () => void)()
    expect(mock.workbench).toHaveBeenCalledOnce()
    expect(mock.launcher).not.toHaveBeenCalled()
  })
})
