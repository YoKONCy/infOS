import { describe, expect, it, vi } from 'vitest'
import { StartupFlow, type StartupFlowSteps } from './startupFlow'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(overrides: Partial<StartupFlowSteps> = {}) {
  const steps = {
    phase: vi.fn(),
    open: vi.fn(async () => {}),
    prepare: vi.fn(async () => {}),
    backend: vi.fn(async () => true),
    launcher: vi.fn(async () => {}),
    verifyBackend: vi.fn(async () => true),
    finish: vi.fn(async () => {}),
    reveal: vi.fn(),
    close: vi.fn(),
    failed: vi.fn(),
    ...overrides,
  }
  return { steps, flow: new StartupFlow(steps) }
}

describe('Electron 开屏启动门控', () => {
  it('连接方式尚未选定之前不进入后端阶段，退出后迟到的选择也不能启动后端', async () => {
    const selection = deferred<void>(),
      entered = deferred<void>()
    const { flow, steps } = setup({
      prepare: () => {
        entered.resolve()
        return selection.promise
      },
    })
    const pending = flow.start()
    await entered.promise
    expect(steps.backend).not.toHaveBeenCalled()
    flow.cancel()
    selection.resolve()
    await pending
    expect(steps.backend).not.toHaveBeenCalled()
    expect(steps.launcher).not.toHaveBeenCalled()
  })
  it('重复启动请求共用后端启动链，成功只显窗一次', async () => {
    const backend = deferred<boolean>()
    const check = vi.fn(() => backend.promise)
    const { flow, steps } = setup({ backend: check })
    expect(flow.running).toBe(false)
    const first = flow.start()
    expect(flow.running).toBe(true)
    expect(flow.start()).toBe(first)
    expect(steps.reveal).not.toHaveBeenCalled()
    backend.resolve(true)
    await first
    await flow.start()
    expect(check).toHaveBeenCalledTimes(1)
    expect(steps.reveal).toHaveBeenCalledTimes(1)
    expect(flow.completed).toBe(true)
    expect(flow.running).toBe(false)
  })

  it('后端未就绪时留在开屏，不创建启动器', async () => {
    const { flow, steps } = setup({ backend: async () => false })
    await flow.start()
    expect(steps.launcher).not.toHaveBeenCalled()
    expect(steps.reveal).not.toHaveBeenCalled()
    expect(steps.close).not.toHaveBeenCalled()
    expect(steps.failed).toHaveBeenCalledWith('backend', expect.any(Error))
    expect(flow.running).toBe(false)
  })

  it('首帧未完成之前不能显窗', async () => {
    const painted = deferred<void>()
    const entered = deferred<void>()
    const { flow, steps } = setup({
      launcher: () => {
        entered.resolve()
        return painted.promise
      },
    })
    const pending = flow.start()
    await entered.promise
    expect(steps.reveal).not.toHaveBeenCalled()
    painted.resolve()
    await pending
    expect(steps.reveal).toHaveBeenCalledTimes(1)
  })

  it('首帧准备失败可再次重试，失败期间不解除门控', async () => {
    const launcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('renderer-failed'))
      .mockResolvedValueOnce(undefined)
    const { flow, steps } = setup({ launcher })
    await flow.start()
    expect(steps.reveal).not.toHaveBeenCalled()
    expect(steps.failed).toHaveBeenCalledWith('launcher', expect.any(Error))
    await flow.start()
    expect(steps.reveal).toHaveBeenCalledTimes(1)
  })

  it('后端在页面准备期间失效仍不能展示启动器', async () => {
    const { flow, steps } = setup({ verifyBackend: async () => false })
    await flow.start()
    expect(steps.finish).not.toHaveBeenCalled()
    expect(steps.reveal).not.toHaveBeenCalled()
    expect(steps.failed).toHaveBeenCalledWith('backend', expect.any(Error))
  })

  it('退出后迟到的后端成功不能继续创建窗口或显示错误', async () => {
    const backend = deferred<boolean>(),
      entered = deferred<void>()
    const { flow, steps } = setup({
      backend: () => {
        entered.resolve()
        return backend.promise
      },
    })
    const pending = flow.start()
    await entered.promise
    flow.cancel()
    backend.resolve(true)
    await pending
    await flow.start()
    expect(steps.launcher).not.toHaveBeenCalled()
    expect(steps.reveal).not.toHaveBeenCalled()
    expect(steps.failed).not.toHaveBeenCalled()
  })

  it('完成过渡前退出时不显窗', async () => {
    const finish = deferred<void>(),
      entered = deferred<void>()
    const { flow, steps } = setup({
      finish: () => {
        entered.resolve()
        return finish.promise
      },
    })
    const pending = flow.start()
    await entered.promise
    flow.cancel()
    finish.resolve()
    await pending
    expect(steps.reveal).not.toHaveBeenCalled()
    expect(flow.completed).toBe(false)
  })
})
