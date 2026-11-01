import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  development: true,
  quit: vi.fn(),
  exit: vi.fn(),
  relaunch: vi.fn(),
  dialog: vi.fn(async (_options: unknown) => ({})),
}))
vi.mock('electron', () => ({
  app: { quit: runtime.quit, exit: runtime.exit, relaunch: runtime.relaunch },
  dialog: { showMessageBox: runtime.dialog },
}))
vi.mock('../utils/runtimeMode', () => ({
  get isDevelopmentRuntime() {
    return runtime.development
  },
}))
vi.mock('../utils/i18n', () => ({ t: (_scope: string, source: string) => source }))
import { requestClientRestart, completeClientRestart, cancelClientRestart } from './clientRestart'
import { DEVELOPMENT_RESTART_EXIT_CODE } from '../../shared/developmentRestart.mjs'

beforeEach(() => {
  cancelClientRestart()
  vi.clearAllMocks()
  runtime.development = true
  vi.stubEnv('INFOS_DEV_RESTART_MANAGED', '1')
})
afterEach(() => vi.unstubAllEnvs())

describe('客户端连接切换的退出交接', () => {
  it('开发重启先请求正常退出，清理完成才向父启动器返回重启状态', async () => {
    await requestClientRestart()
    expect(runtime.quit).toHaveBeenCalledOnce()
    expect(runtime.exit).not.toHaveBeenCalled()
    expect(runtime.relaunch).not.toHaveBeenCalled()
    expect(completeClientRestart()).toBe(true)
    expect(runtime.exit).toHaveBeenCalledWith(DEVELOPMENT_RESTART_EXIT_CODE)
    expect(completeClientRestart()).toBe(false)
  })
  it('用户取消退出后，后续普通退出不会再重启', async () => {
    await requestClientRestart()
    cancelClientRestart()
    expect(completeClientRestart()).toBe(false)
    expect(runtime.exit).not.toHaveBeenCalled()
    expect(runtime.relaunch).not.toHaveBeenCalled()
  })
  it('非受管开发入口保留窗口并提示终端恢复；正式版延后安排原生重启', async () => {
    vi.stubEnv('INFOS_DEV_RESTART_MANAGED', '')
    await requestClientRestart()
    expect(runtime.dialog.mock.calls[0]?.[0]).toMatchObject({
      message: '连接配置已保存。请在开发终端停止并重新运行 pnpm dev:electron 或 pnpm start。',
    })
    expect(runtime.quit).not.toHaveBeenCalled()
    expect(completeClientRestart()).toBe(false)
    runtime.development = false
    await requestClientRestart()
    expect(runtime.relaunch).not.toHaveBeenCalled()
    expect(completeClientRestart()).toBe(false)
    expect(runtime.relaunch).toHaveBeenCalledOnce()
    expect(runtime.exit).not.toHaveBeenCalled()
  })
})
