import { describe, expect, it, vi } from 'vitest'
import { createAttachmentRouter } from '@infos/backend/routers/attachment.router'
import { errorHandler } from '@infos/backend/middleware/errorHandler'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@infos/shared'
describe('附件 HTTP 上传边界', () => {
  it('接收任意文件字节与引用模式，不把客户端路径作为文件来源', async () => {
    const upload = vi.fn(async (_file: File) => ({
      id: 'stored-file',
      kind: 'file',
      contextMode: 'reference',
    }))
    const router = createAttachmentRouter({ attachmentService: { upload } } as never, {} as never)
    router.onError(errorHandler)
    const body = new FormData()
    body.append(
      'file',
      new Blob([new Uint8Array([0, 255, 1])], { type: 'application/octet-stream' }),
      '资料.unknown',
    )
    body.append('threadId', 'thread-1')
    body.append('contextMode', 'reference')
    body.append('path', 'C:/client-only/private-file')
    const response = await router.request('/', { method: 'POST', body })
    expect(response.status).toBe(201)
    expect(upload).toHaveBeenCalledWith(expect.any(File), 'thread-1', { referenceOnly: true })
    expect(new Uint8Array(await upload.mock.calls[0]![0].arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 1]),
    )
    const invalid = new FormData()
    invalid.append('threadId', 'thread-1')
    invalid.append('path', 'C:/client-only/private-file')
    expect((await router.request('/', { method: 'POST', body: invalid })).status).toBe(400)
    expect(upload).toHaveBeenCalledOnce()
  })
  it('multipart 上限在读取上传内容前生效', async () => {
    const upload = vi.fn()
    const router = createAttachmentRouter({ attachmentService: { upload } } as never, {} as never)
    router.onError(errorHandler)
    const response = await router.request('/', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_ATTACHMENT_UPLOAD_BYTES + 65537) },
      body: 'x',
    })
    expect(response.status).toBe(413)
    expect(upload).not.toHaveBeenCalled()
  })
})
