import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  writeText: vi.fn(),
  fromBuffer: vi.fn(),
  fromDataUrl: vi.fn(),
}))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('electron', () => ({
  clipboard: { read: mocks.read, write: mocks.write, writeText: mocks.writeText },
  ClipboardItem: class {
    constructor(public data: Record<string, Blob>) {}
  },
  nativeImage: { createFromBuffer: mocks.fromBuffer, createFromDataURL: mocks.fromDataUrl },
  desktopCapturer: {},
  screen: {},
}))
import {
  readClipboard,
  readClipboardImage,
  writeClipboard,
  writeClipboardImage,
} from './desktopAwareness'

describe('异步剪贴板兼容', () => {
  beforeEach(() => vi.resetAllMocks())
  it('从同一次快照读取文本、图像标记和 MIME 类型', async () => {
    mocks.read.mockResolvedValue([
      { types: ['text/plain', 'image/png'], getType: async () => new Blob(['测试文本']) },
    ])
    await expect(readClipboard()).resolves.toEqual({
      text: '测试文本',
      hasImage: true,
      formats: ['text/plain', 'image/png'],
    })
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })
  it('空剪贴板返回空内容，图片读取不创建无效图像', async () => {
    mocks.read.mockResolvedValue([])
    await expect(readClipboard()).resolves.toEqual({ text: '', hasImage: false, formats: [] })
    await expect(readClipboardImage()).resolves.toBeNull()
    expect(mocks.fromBuffer).not.toHaveBeenCalled()
  })
  it('优先读取 PNG 并返回图片数据', async () => {
    mocks.read.mockResolvedValue([{ types: ['image/png'], getType: async () => new Blob(['png']) }])
    mocks.fromBuffer.mockReturnValue({
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,cG5n',
    })
    await expect(readClipboardImage()).resolves.toBe('data:image/png;base64,cG5n')
  })
  it('写入失败必须回传给调用方，不能提前报告成功', async () => {
    mocks.writeText.mockRejectedValue(new Error('CLIPBOARD_WRITE_DENIED'))
    await expect(writeClipboard('测试')).rejects.toThrow('CLIPBOARD_WRITE_DENIED')
  })
  it('使用新 ClipboardItem 接口提交 PNG Blob', async () => {
    mocks.fromDataUrl.mockReturnValue({ toPNG: () => Buffer.from('png') })
    mocks.write.mockResolvedValue(undefined)
    await writeClipboardImage('data:image/png;base64,cG5n')
    const item = mocks.write.mock.calls[0]![0][0]
    expect(item.data['image/png'].type).toBe('image/png')
    await expect(item.data['image/png'].text()).resolves.toBe('png')
  })
})
