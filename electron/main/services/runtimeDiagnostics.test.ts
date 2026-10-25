import { beforeEach, describe, it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ windows: vi.fn(), execute: vi.fn(), daemon: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.9.5-hotfix1' },
  BrowserWindow: { getAllWindows: mocks.windows },
}))
vi.mock('../utils/env', () => ({
  paths: { app: 'C:/fixture/app.asar', data: 'C:/fixture/data', resources: 'C:/fixture/resources' },
}))
vi.mock('./portableDaemon', () => ({ getPortableDaemonStatus: mocks.daemon }))
import { runtimeDiagnostics } from './runtimeDiagnostics'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.daemon.mockReturnValue({
    ready: true,
    running: true,
    logPath: 'C:/fixture/data/logs/bootstrap.log',
  })
  mocks.windows.mockReturnValue([
    {
      id: 1,
      getTitle: () => 'infOS',
      isVisible: () => true,
      isDestroyed: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }),
      webContents: {
        isDestroyed: () => false,
        isCrashed: () => false,
        getURL: () => 'http://localhost/workbench?token=private',
        getOSProcessId: () => 321,
        executeJavaScript: mocks.execute,
      },
    },
  ])
})
describe('Electron 只读运行诊断', () => {
  it('只执行固定页面快照，不回传 URL 查询凭据，提供安装版路径', async () => {
    mocks.execute.mockResolvedValue({ readyState: 'complete', canvasCount: 1 })
    const scene = await runtimeDiagnostics(new AbortController().signal)
    expect(scene.packaged).toBe(true)
    expect(scene.paths.app).toBe('C:/fixture/app.asar')
    expect(scene.windows[0]).toMatchObject({
      url: 'http://localhost/workbench',
      rendererPid: 321,
      page: { canvasCount: 1 },
    })
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('getComputedStyle(document.documentElement)'),
    )
  })
  it('单个渲染器失败不阻止其他现场返回，取消时不继续查询', async () => {
    mocks.execute.mockRejectedValue(new Error('模拟渲染进程退出'))
    expect((await runtimeDiagnostics(new AbortController().signal)).windows[0]).toMatchObject({
      page: null,
    })
    const controller = new AbortController()
    controller.abort()
    mocks.windows.mockClear()
    await expect(runtimeDiagnostics(controller.signal)).rejects.toThrow()
    expect(mocks.windows).not.toHaveBeenCalled()
  })
})
