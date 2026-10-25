import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyRendererError, reportMainError } from './mainErrorHandler'

const mocks = vi.hoisted(() => ({
  critical: vi.fn(),
  windows: vi.fn(),
  show: vi.fn(),
}))
vi.mock('./logger', () => ({ logger: { critical: mocks.critical } }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.windows },
  dialog: { showErrorBox: mocks.show },
}))
vi.mock('./i18n', () => ({
  t: (_scope: string, source: string, values: unknown[] = []) =>
    source.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)] ?? '')),
}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.windows.mockReturnValue([])
})
describe('主进程异常记录与展示隔离', () => {
  it('先记录原始异常，再展示；Promise 拒绝同样保留原始堆栈', () => {
    const reason = new Error('原始服务故障')
    reportMainError('exception', reason)
    expect(mocks.critical.mock.calls[0]![1]).toContain(reason.stack)
    expect(mocks.critical.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.show.mock.invocationCallOrder[0]!,
    )
    reportMainError('rejection', reason)
    expect(mocks.critical.mock.calls[1]![1]).toContain(reason.stack)
    expect(mocks.show).toHaveBeenCalledOnce()
  })
  it('一个窗口关闭时发送失败不阻断其他窗口通知', () => {
    const send = vi.fn()
    mocks.windows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: () => {
            throw new Error('模拟窗口销毁竞态')
          },
        },
      },
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
    ])
    expect(() => notifyRendererError('异常标题', '原始错误')).not.toThrow()
    expect(send).toHaveBeenCalledWith('system-error', { title: '异常标题', message: '原始错误' })
  })
  it('记录与展示都失败时不抛出第二个异常；后续异常仍可处理', () => {
    mocks.critical.mockImplementationOnce(() => {
      throw new Error('模拟日志通道故障')
    })
    mocks.show.mockImplementationOnce(() => {
      throw new Error('模拟弹窗故障')
    })
    expect(() => reportMainError('exception', new Error('需要保留的原始异常'))).not.toThrow()
    reportMainError('exception', new Error('后续业务异常'))
    expect(mocks.critical).toHaveBeenCalledTimes(2)
  })
  it('通知期间同步重入不递归报告，网络 EPIPE 仍作为真实异常保留', () => {
    mocks.show.mockImplementationOnce(() => reportMainError('exception', new Error('模拟展示重入')))
    reportMainError('exception', Object.assign(new Error('网络连接写入失败'), { code: 'EPIPE' }))
    expect(mocks.critical).toHaveBeenCalledOnce()
    expect(mocks.critical.mock.calls[0]![1]).toContain('网络连接写入失败')
  })
})
