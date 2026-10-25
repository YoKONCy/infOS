import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWriteStream: vi.fn(),
  appendFileSync: vi.fn(),
  development: true,
}))
vi.mock('node:fs', () => ({
  default: {
    existsSync: () => true,
    createWriteStream: mocks.createWriteStream,
    appendFileSync: mocks.appendFileSync,
  },
}))
vi.mock('./env', () => ({
  paths: { logs: '/隔离日志' },
  get isDev() {
    return mocks.development
  },
}))
vi.mock('./stdioGuard', () => ({
  stdioGuard: {
    write: (_channel: string, output: () => void) => {
      try {
        output()
        return true
      } catch {
        return false
      }
    },
  },
}))
function stream() {
  return Object.assign(new EventEmitter(), {
    writable: true,
    destroyed: false,
    writableEnded: false,
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  })
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.createWriteStream.mockReset()
  mocks.appendFileSync.mockReset()
  vi.stubEnv('INFOS_LOG_STDIO', '')
  mocks.development = true
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
describe('桌面日志降级', () => {
  it('异步权限错误不抛出未处理异常，后续日志继续输出到控制台', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const target = stream()
    mocks.createWriteStream.mockReturnValue(target)
    const { logger } = await import('./logger')
    logger.info('启动诊断', '第一次记录')
    expect(() =>
      target.emit('error', Object.assign(new Error('模拟日志权限不足'), { code: 'EACCES' })),
    ).not.toThrow()
    logger.info('启动诊断', '第二次记录')
    expect(target.destroy).toHaveBeenCalledOnce()
    expect(target.write).toHaveBeenCalledTimes(1)
    expect(output).toHaveBeenCalledTimes(2)
    logger.close()
  })
  it('正式版默认只写文件，不调用继承自安装器的控制台', async () => {
    mocks.development = false
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const target = stream()
    mocks.createWriteStream.mockReturnValue(target)
    const { logger } = await import('./logger')
    logger.error('启动诊断', '原始业务错误')
    expect(target.write).toHaveBeenCalledOnce()
    expect(output).not.toHaveBeenCalled()
    logger.close()
  })
  it('控制台同步抛出 EPIPE 时原始日志已先交给文件流', async () => {
    const target = stream()
    mocks.createWriteStream.mockReturnValue(target)
    const output = vi.spyOn(console, 'error').mockImplementation(() => {
      expect(target.write).toHaveBeenCalledOnce()
      throw Object.assign(new Error('模拟控制台已断开'), { code: 'EPIPE' })
    })
    const { logger } = await import('./logger')
    expect(() => logger.error('启动诊断', '需要保留的原始错误')).not.toThrow()
    expect(output).toHaveBeenCalledOnce()
    expect(target.write.mock.calls[0]![0]).toContain('需要保留的原始错误')
    logger.close()
  })
  it('文件异步失败后同一天可以限频重新打开，旧流错误不清除新流', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const first = stream(),
      second = stream()
    mocks.createWriteStream.mockReturnValueOnce(first).mockReturnValue(second)
    const { logger } = await import('./logger')
    logger.info('启动诊断', '打开第一个流')
    first.emit('error', new Error('模拟暂时不可写'))
    logger.info('启动诊断', '重试冷却期间')
    expect(mocks.createWriteStream).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(30_001)
    logger.info('启动诊断', '恢复文件记录')
    first.emit('error', new Error('旧流迟到的错误'))
    logger.info('启动诊断', '新流继续可写')
    expect(second.write).toHaveBeenCalledTimes(2)
    expect(second.destroy).not.toHaveBeenCalled()
    logger.close()
  })
  it('关键异常独立同步落盘，不经过控制台或异步日志流', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { logger } = await import('./logger')
    logger.critical('Main', '原始异常与调用栈')
    expect(mocks.appendFileSync).toHaveBeenCalledOnce()
    expect(mocks.appendFileSync.mock.calls[0]![1]).toContain('原始异常与调用栈')
    expect(mocks.createWriteStream).not.toHaveBeenCalled()
    expect(output).not.toHaveBeenCalled()
    mocks.appendFileSync.mockImplementationOnce(() => {
      throw new Error('模拟磁盘不可写')
    })
    expect(() => logger.critical('Main', '磁盘故障时也不递归记录')).not.toThrow()
    logger.close()
  })
  it('关闭流失败不抛错，关闭后不再重新打开日志', async () => {
    const target = stream()
    target.end.mockImplementation(() => {
      throw new Error('模拟关闭失败')
    })
    mocks.createWriteStream.mockReturnValue(target)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { logger } = await import('./logger')
    logger.info('启动诊断', '退出前记录')
    expect(() => logger.close()).not.toThrow()
    logger.info('启动诊断', '退出后不重开')
    expect(mocks.createWriteStream).toHaveBeenCalledOnce()
    expect(target.destroy).toHaveBeenCalledOnce()
  })
})
