import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentService } from '@infos/backend/services/attachment/attachmentService'

const tempRoot = path.resolve('TEMP/attachment-upload')
async function createRoot() {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(path.join(tempRoot, 'upload-'))
}
async function cleanup(root: string) {
  if (!root.startsWith(tempRoot + path.sep)) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
}
function createService(rootDir = 'C:\\safe\\attachments', parser?: unknown) {
  const repo = {
    create: vi.fn(async (value) => ({
      ...value,
      messageId: null,
      contextPolicy: 'once',
      status: value.status ?? 'uploaded',
    })),
    findById: vi.fn(),
    findByIds: vi.fn(),
    bind: vi.fn(),
    listByMessageIds: vi.fn(),
    markDeletedUnbound: vi.fn(),
    finishPdf: vi.fn(),
  }
  const threadRepo = { getThread: vi.fn(() => Promise.resolve({ id: 'thread-1' })) }
  return {
    service: new AttachmentService(repo as never, threadRepo as never, rootDir, parser as never),
    repo,
  }
}

describe('AttachmentService', () => {
  it('音频按实际内容保存 WAV 元信息，明确只引用的音频保留播放器类型', async () => {
    const root = await createRoot(),
      { service, repo } = createService(root)
    const bytes = Buffer.alloc(48044)
    bytes.write('RIFF')
    bytes.writeUInt32LE(bytes.length - 8, 4)
    bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16)
    bytes.writeUInt16LE(1, 20)
    bytes.writeUInt16LE(1, 22)
    bytes.writeUInt32LE(24000, 24)
    bytes.writeUInt32LE(48000, 28)
    bytes.writeUInt16LE(2, 32)
    bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36)
    bytes.writeUInt32LE(48000, 40)
    try {
      const file = new File([bytes], '录音.wav', { type: 'audio/x-wav' })
      expect(await service.upload(file, 'thread-1')).toMatchObject({
        kind: 'audio',
        mimeType: 'audio/wav',
        contextMode: 'inline',
        audio: { durationMs: 1000, sampleRate: 24000, channels: 1 },
      })
      const stored = repo.create.mock.calls[0]![0]
      expect(await readFile(service.resolveStoragePath(stored.storageKey))).toEqual(bytes)
      expect(await service.upload(file, 'thread-1', { referenceOnly: true })).toMatchObject({
        kind: 'audio',
        contextMode: 'reference',
      })
      expect(
        await service.upload(new File(['伪装音频'], '假的.wav', { type: 'audio/wav' }), 'thread-1'),
      ).toMatchObject({ kind: 'file', contextMode: 'reference' })
      const large = Buffer.alloc(13 * 1024 * 1024)
      bytes.copy(large, 0, 0, 44)
      large.writeUInt32LE(large.length - 8, 4)
      large.writeUInt32LE(large.length - 44, 40)
      expect(
        await service.upload(new File([large], '超限.wav', { type: 'audio/wav' }), 'thread-1'),
      ).toMatchObject({ kind: 'audio', contextMode: 'reference' })
    } finally {
      await cleanup(root)
    }
  })
  it('批量读图的所有预览都绑定到回复，避免只有首张图留存', async () => {
    const { service, repo } = createService()
    repo.findById.mockImplementation(async (id) => ({
      id,
      threadId: 'thread-1',
      messageId: null,
      status: 'uploaded',
      metadataJson: JSON.stringify({ resource: { agentId: 'pero', pairId: 'pair-1' } }),
    }))
    await service.bindOutgoing('thread-1', 'pero', 'pair-1', 42, [
      {
        name: 'read_image',
        result: JSON.stringify({
          images: ['a', 'b', 'c'].map((id) => ({
            imagePreview: {
              id,
              name: `${id}.png`,
              kind: 'image',
              mimeType: 'image/png',
              sizeBytes: 10,
            },
          })),
        }),
      },
    ])
    expect(repo.bind).toHaveBeenCalledWith(['a', 'b', 'c'], 'thread-1', 42)
  })
  it('历史消息不把工具预览重复展示成普通附件', async () => {
    const { service, repo } = createService()
    repo.listByMessageIds.mockResolvedValue([
      { id: 'preview-1', messageId: 42, metadataJson: '{"resource":{"toolPreview":true}}' },
      { id: 'user-image', messageId: 41, metadataJson: '{}' },
    ])
    const attachments = await service.listForMessages([41, 42])
    expect(attachments.has(42)).toBe(false)
    expect(attachments.get(41)).toEqual([expect.objectContaining({ id: 'user-image' })])
  })

  it('读图预览与回复一起绑定，转述失败也保留用户可浏览的图片', async () => {
    const { service, repo } = createService()
    repo.findById.mockResolvedValue({
      id: 'preview-1',
      threadId: 'thread-1',
      messageId: null,
      status: 'uploaded',
      metadataJson: JSON.stringify({ resource: { agentId: 'pero', pairId: 'pair-1' } }),
    })
    await service.bindOutgoing('thread-1', 'pero', 'pair-1', 42, [
      {
        name: 'read_image',
        isError: true,
        result: JSON.stringify({
          success: false,
          error: '转述不可用',
          imagePreview: {
            id: 'preview-1',
            kind: 'image',
            name: '图片.png',
            mimeType: 'image/png',
            sizeBytes: 1024,
          },
        }),
      },
    ])
    expect(repo.bind).toHaveBeenCalledWith(['preview-1'], 'thread-1', 42)
  })

  it('无效 PDF 作为普通原件保存，不将未知字节交给解析器', async () => {
    const root = await createRoot()
    const parser = { capture: vi.fn(), parse: vi.fn() }
    const { service } = createService(root, parser)
    try {
      const file = new File([new Uint8Array([1, 2, 3])], 'test.pdf', { type: 'application/pdf' })
      expect(await service.upload(file, 'thread-1')).toMatchObject({
        kind: 'file',
        status: 'uploaded',
        contextMode: 'reference',
      })
      expect(parser.parse).not.toHaveBeenCalled()
    } finally {
      await cleanup(root)
    }
  })

  it('未配置外部来源时保存 PDF 原件，等待工作模式按需读取', async () => {
    const rootDir = await createRoot()
    const { service, repo } = createService(rootDir)
    repo.create.mockImplementation(async (value) => ({
      ...value,
      messageId: null,
      contextPolicy: 'once',
    }))
    try {
      const file = new File(['%PDF-1.7\n%%EOF'], '资料.pdf', { type: 'application/pdf' })
      expect(await service.upload(file, 'thread-1')).toMatchObject({
        kind: 'pdf',
        status: 'uploaded',
      })
      expect(repo.create.mock.calls[0]?.[0].extractedText).toBeUndefined()
      expect(service.capabilities()).toMatchObject({ pdf: true, office: true })
      const office = new File([new Uint8Array([0x50, 0x4b, 3, 4])], '预算.xlsx', {
        type: 'application/octet-stream',
      })
      expect(await service.upload(office, 'thread-1')).toMatchObject({
        kind: 'file',
        status: 'uploaded',
      })
    } finally {
      await cleanup(rootDir)
    }
  })

  it('20MB 内图片可识图，更大图片保存为原件且不自动注入', async () => {
    const rootDir = await createRoot()
    const { service, repo } = createService(rootDir)
    repo.create.mockImplementation(async (value) => ({
      ...value,
      messageId: null,
      contextPolicy: 'once',
      status: 'uploaded',
      createdAt: null,
      boundAt: null,
    }))

    try {
      const accepted = new File([new Uint8Array(20 * 1024 * 1024)], '边界.png', {
        type: 'image/png',
      })
      await expect(service.upload(accepted, 'thread-1')).resolves.toMatchObject({
        kind: 'image',
        sizeBytes: 20 * 1024 * 1024,
      })

      const oversized = new File([new Uint8Array(20 * 1024 * 1024 + 1)], '超限.png', {
        type: 'image/png',
      })
      await expect(service.upload(oversized, 'thread-1')).resolves.toMatchObject({
        kind: 'file',
        contextMode: 'reference',
        status: 'uploaded',
      })
    } finally {
      await cleanup(rootDir)
    }
  })

  it('拒绝越界 storageKey', () => {
    const { service } = createService()
    expect(() => service.resolveStoragePath('../secret')).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })
  it('1.4MB JSON 不因上下文预算失败，原件完整保存且不内联全文', async () => {
    const root = await createRoot(),
      { service, repo } = createService(root)
    const text = JSON.stringify({ content: 'x'.repeat(1_400_000) })
    try {
      expect(
        await service.upload(
          new File([text], '预设.json', { type: 'application/json' }),
          'thread-1',
        ),
      ).toMatchObject({ kind: 'file', status: 'uploaded', contextMode: 'reference' })
      const stored = repo.create.mock.calls[0]![0]
      expect(stored.extractedText).toBeUndefined()
      expect(stored.tokenEstimate).toBeUndefined()
      expect(await readFile(service.resolveStoragePath(stored.storageKey), 'utf8')).toBe(text)
    } finally {
      await cleanup(root)
    }
  })
  it('ZIP、未知二进制和非 UTF-8 文本都能上传并仅提供原件引用', async () => {
    const root = await createRoot(),
      { service } = createService(root)
    try {
      for (const [name, type] of [
        ['资源.zip', 'application/zip'],
        ['数据.custom', ''],
        ['旧编码.txt', 'text/plain'],
      ]) {
        expect(
          await service.upload(
            new File([new Uint8Array([0xff, 0xfe, 0, 1])], name!, { type }),
            'thread-1',
          ),
        ).toMatchObject({ kind: 'file', status: 'uploaded', contextMode: 'reference' })
      }
    } finally {
      await cleanup(root)
    }
  })
  it('无 MIME 的小文本可按后缀识别，客户端也可明确要求仅文件引用', async () => {
    const root = await createRoot(),
      { service, repo } = createService(root)
    try {
      expect(await service.upload(new File(['{"key":1}'], '设置.json'), 'thread-1')).toMatchObject({
        kind: 'text',
        contextMode: 'inline',
      })
      expect(repo.create.mock.calls[0]![0].extractedText).toBe('{"key":1}')
      expect(
        await service.upload(new File(['{"key":1}'], '设置.json'), 'thread-1', {
          referenceOnly: true,
        }),
      ).toMatchObject({ kind: 'file', contextMode: 'reference' })
    } finally {
      await cleanup(root)
    }
  })
  it('超出原件上传上限时在读取内容前拒绝', async () => {
    const file = new File([], '大文件.bin')
    Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 + 1 })
    const read = vi.spyOn(file, 'arrayBuffer')
    await expect(createService().service.upload(file, 'thread-1')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(read).not.toHaveBeenCalled()
  })
  it('PDF 解析失败或文字过大仍保留上传成功的原件', async () => {
    const root = await createRoot()
    try {
      for (const result of ['large', 'failed']) {
        const parser = {
          capture: () => ({ id: 'pdf-source', provider: 'pdf-http', name: '模拟来源' }),
          capabilities: () => ({ pdf: true, maxPdfBytes: 20 * 1024 * 1024 }),
          parse:
            result === 'large'
              ? vi.fn(async () => ({ text: 'x'.repeat(150_000) }))
              : vi.fn(async () => {
                  throw new Error('模拟解析失败')
                }),
        }
        const { service, repo } = createService(root, parser)
        await service.upload(
          new File(['%PDF-1.7\n%%EOF'], '资料.pdf', { type: 'application/pdf' }),
          'thread-1',
        )
        await vi.waitFor(() => expect(repo.finishPdf).toHaveBeenCalled())
        expect(repo.finishPdf.mock.calls[0]![1]).toMatchObject({ status: 'uploaded' })
        expect(JSON.parse(repo.finishPdf.mock.calls[0]![1].metadataJson).upload.contextMode).toBe(
          'reference',
        )
        await service.dispose()
      }
    } finally {
      await cleanup(root)
    }
  })

  it('绑定校验要求附件属于当前 Thread 且未绑定', async () => {
    const { service, repo } = createService()
    repo.findByIds.mockResolvedValue([
      { id: 'a', threadId: 'other', status: 'uploaded', messageId: null },
    ])
    await expect(service.validateForBinding(['a'], 'thread-1')).rejects.toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })
})
