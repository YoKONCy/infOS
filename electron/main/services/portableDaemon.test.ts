import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  spawn: vi.fn(),
  healthy: false,
  log: '',
  logWritable: true,
  remote: false,
}))

vi.mock('node:child_process', () => ({ spawn: state.spawn }))
vi.mock('electron', () => ({ app: { getPath: () => '/隔离程序/应用.exe' } }))
vi.mock('@infos/shared', () => ({
  electronProcessEnvironment: (env: unknown) => env,
  DAEMON_ALREADY_RUNNING_EXIT_CODE: 75,
  DAEMON_SHUTDOWN_MESSAGE: 'infos:shutdown',
}))
vi.mock('../utils/env', () => ({
  isDev: false,
  paths: { data: '/隔离数据', logs: '/隔离日志' },
}))
vi.mock('./steam', () => ({ getWorkshopInstallations: () => [] }))
vi.mock('./clientConnection', () => ({ isRemoteConnection: () => state.remote }))
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../utils/i18n', () => ({
  t: (_scope: string, source: string, args: unknown[] = []) =>
    source.replace(/\{(\d+)\}/g, (_token, index: string) => String(args[Number(index)])),
}))
vi.mock('node:fs', () => ({
  default: {
    existsSync: () => true,
    mkdirSync: vi.fn(),
    openSync: () => {
      if (!state.logWritable) throw Object.assign(new Error('模拟日志占用'), { code: 'EACCES' })
      return 1
    },
    closeSync: vi.fn(),
    fstatSync: () => ({ size: Buffer.byteLength(state.log) }),
    writeSync: (_fd: number, text: string) => {
      state.log += text
    },
    readSync: (_fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      Buffer.from(state.log).copy(buffer, offset, position, position + length),
  },
}))

class FakeChild extends EventEmitter {
  pid = 123
  exitCode: number | null = null
  signalCode: string | null = null
  kill = vi.fn(() => true)
  connected = false
  send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
    callback(null)
    return true
  })
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  exit(code: number): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  state.healthy = false
  state.remote = false
  state.log = ''
  state.logWritable = true
  Object.defineProperty(process, 'resourcesPath', { value: '/隔离资源', configurable: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: state.healthy,
      body: { cancel: vi.fn() },
      json: async () => ({ data: { status: state.healthy ? 'ok' : 'error' } }),
    })),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
  else Reflect.deleteProperty(process, 'resourcesPath')
})

describe('内置 Daemon 生命周期', () => {
  it('远程模式的启动和健康重试均不探测或拉起本机后台', async () => {
    state.remote = true
    const daemon = await import('./portableDaemon')
    expect(await daemon.ensurePortableDaemon()).toBe(false)
    expect(await daemon.probeBusinessHealth()).toBe(false)
    expect(state.spawn).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('日志不可写时继续启动，并通过内存缓冲提供诊断', async () => {
    state.logWritable = false
    const child = new FakeChild()
    state.spawn.mockImplementation(() => {
      state.healthy = true
      return child
    })
    const daemon = await import('./portableDaemon')
    expect(await daemon.ensurePortableDaemon()).toBe(true)
    child.stderr.emit('data', Buffer.from('本次内存诊断'))
    expect(daemon.getPortableDaemonStatus()).toMatchObject({
      ready: true,
      logPath: '',
      logTail: expect.stringContaining('本次内存诊断'),
    })
  })

  it('正常退出通过 IPC 清理，超时后才强制结束', async () => {
    const child = new FakeChild()
    child.connected = true
    state.spawn.mockImplementation(() => {
      state.healthy = true
      return child
    })
    const daemon = await import('./portableDaemon')
    await daemon.ensurePortableDaemon()
    const stopping = daemon.stopPortableDaemon()
    expect(child.send).toHaveBeenCalledWith({ type: 'infos:shutdown' }, expect.any(Function))
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.exit(0)
    await stopping
  })

  it('重复实例退出后等待持锁的后端就绪，不再次创建进程', async () => {
    state.spawn.mockImplementation(() => {
      const child = new FakeChild()
      queueMicrotask(() => child.exit(75))
      return child
    })
    const daemon = await import('./portableDaemon')
    const pending = daemon.ensurePortableDaemon()
    await vi.advanceTimersByTimeAsync(1000)
    state.healthy = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(true)
    expect(state.spawn).toHaveBeenCalledTimes(1)
  })

  it('并发启动只创建一个子进程，退出后重试会重新拉起', async () => {
    const children: FakeChild[] = []
    state.spawn.mockImplementation(() => {
      const child = new FakeChild()
      children.push(child)
      state.healthy = true
      return child
    })
    const daemon = await import('./portableDaemon')
    expect(
      await Promise.all([daemon.ensurePortableDaemon(), daemon.ensurePortableDaemon()]),
    ).toEqual([true, true])
    expect(state.spawn).toHaveBeenCalledTimes(1)
    state.healthy = false
    children[0]!.exit(1)
    expect(daemon.getPortableDaemonStatus().ready).toBe(false)
    expect(await daemon.ensurePortableDaemon()).toBe(true)
    expect(state.spawn).toHaveBeenCalledTimes(2)
  })

  it('进程提前退出立即报告失败，不继续等满启动超时', async () => {
    state.spawn.mockImplementation(() => {
      const child = new FakeChild()
      queueMicrotask(() => child.exit(1))
      return child
    })
    const daemon = await import('./portableDaemon')
    const result = daemon.ensurePortableDaemon()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe(false)
    expect(daemon.getPortableDaemonStatus()).toMatchObject({ ready: false, running: false })
  })

  it('停止操作等待实际退出，退出过程中不再启动新进程', async () => {
    const child = new FakeChild()
    state.spawn.mockImplementation(() => {
      state.healthy = true
      return child
    })
    const daemon = await import('./portableDaemon')
    await daemon.ensurePortableDaemon()
    let stopped = false
    const stopping = daemon.stopPortableDaemon().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(stopped).toBe(false)
    expect(await daemon.ensurePortableDaemon()).toBe(false)
    child.exit(0)
    await stopping
    expect(stopped).toBe(true)
    expect(state.spawn).toHaveBeenCalledTimes(1)
  })

  it('启动失败仍可重试，诊断只返回本次日志并清理颜色码', async () => {
    state.log = '旧启动的报错\n'
    state.spawn.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const daemon = await import('./portableDaemon')
    expect(await daemon.ensurePortableDaemon()).toBe(false)
    state.spawn.mockImplementation(() => {
      state.healthy = true
      return new FakeChild()
    })
    expect(await daemon.ensurePortableDaemon()).toBe(true)
    state.log += '\u001b[31m本次诊断\u001b[0m\n'
    const status = daemon.getPortableDaemonStatus()
    expect(status.logTail).toContain('本次诊断')
    expect(status.logTail).not.toContain('旧启动的报错')
    expect(status.logTail).not.toContain('\u001b')
  })
})
