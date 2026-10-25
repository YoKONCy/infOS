import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createStdioGuard } from './stdioGuard'

function output() {
  return Object.assign(new EventEmitter(), {
    writable: true,
    destroyed: false,
    writableEnded: false,
  })
}
describe('标准输出管道隔离', () => {
  it('异步 EPIPE 停用错误流，标准输出仍可使用', () => {
    const stdout = output(),
      stderr = output()
    const guard = createStdioGuard({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    })
    const write = vi.fn()
    expect(() =>
      stderr.emit('error', Object.assign(new Error('模拟管道已关闭'), { code: 'EPIPE' })),
    ).not.toThrow()
    expect(guard.write('stderr', write)).toBe(false)
    expect(guard.write('stdout', write)).toBe(true)
    expect(write).toHaveBeenCalledOnce()
  })
  it('同步输出失败后不再反复写入同一条坏管道', () => {
    const stdout = output()
    const guard = createStdioGuard({ stdout: stdout as unknown as NodeJS.WriteStream })
    const write = vi.fn(() => {
      throw new Error('模拟同步写入失败')
    })
    expect(() => guard.write('stdout', write)).not.toThrow()
    expect(guard.write('stdout', write)).toBe(false)
    expect(write).toHaveBeenCalledOnce()
  })
  it('没有控制台或流已关闭时不尝试输出', () => {
    const stdout = output()
    const guard = createStdioGuard({ stdout: stdout as unknown as NodeJS.WriteStream })
    const write = vi.fn()
    stdout.emit('close')
    expect(guard.write('stdout', write)).toBe(false)
    expect(guard.write('stderr', write)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
