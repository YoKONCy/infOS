import { describe, expect, it, vi } from 'vitest'
import { createSystemBackdropDisabler } from './windowsSystemBackdrop'

function fixture(result = 0) {
  const setAttribute = vi.fn(
    (_window: number | bigint, _attribute: number, _value: Buffer, _size: number) => result,
  )
  const func = vi.fn(() => setAttribute)
  const load = vi.fn(() => ({ func }))
  const loadNative = vi.fn(() => ({ load }))
  const disable = createSystemBackdropDisabler(loadNative as never)
  return { disable, loadNative, load, func, setAttribute }
}
function handle(value: number | bigint, size: 4 | 8) {
  const bytes = Buffer.alloc(size)
  if (size === 8) bytes.writeBigUInt64LE(BigInt(value))
  else bytes.writeUInt32LE(Number(value))
  return bytes
}

describe('Windows 透明窗口背景属性', () => {
  it.each([4, 8] as const)('正确解析 %s 字节 HWND，只写背景禁用属性', (size) => {
    const native = fixture()
    expect(native.disable(handle(12345, size))).toBe(true)
    const args = native.setAttribute.mock.calls[0] as unknown as [
      number | bigint,
      number,
      Buffer,
      number,
    ]
    expect(BigInt(args[0])).toBe(12345n)
    expect(args[1]).toBe(38)
    expect(args[2].readInt32LE()).toBe(1)
    expect(args[3]).toBe(4)
    expect(native.load).toHaveBeenCalledWith('dwmapi.dll')
    expect(native.func).toHaveBeenCalledTimes(1)
  })
  it('64 位句柄保持整数精度，并复用原生函数绑定', () => {
    const native = fixture()
    const value = 0x20000000000001n
    native.disable(handle(value, 8))
    native.disable(handle(value, 8))
    expect(native.setAttribute.mock.calls[0]![0]).toBe(value)
    expect(native.loadNative).toHaveBeenCalledTimes(1)
  })
  it('无效或空句柄不触发原生加载', () => {
    const native = fixture()
    expect(native.disable(Buffer.alloc(3))).toBe(false)
    expect(native.disable(handle(0, 8))).toBe(false)
    expect(native.loadNative).not.toHaveBeenCalled()
  })
  it('旧系统不支持属性或原生组件不可用时安全退化', () => {
    const native = fixture(-2147024809)
    expect(native.disable(handle(1, 8))).toBe(false)
    const loadNative = vi.fn(() => {
      throw new Error('原生组件不可用')
    })
    const disable = createSystemBackdropDisabler(loadNative)
    expect(disable(handle(1, 8))).toBe(false)
    expect(disable(handle(1, 8))).toBe(false)
    expect(loadNative).toHaveBeenCalledTimes(1)
  })
})
