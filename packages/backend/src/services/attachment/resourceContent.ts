import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { Context } from 'hono'

/** 文本预览只读取限定前缀，避免为预览载入整个大文件。 */
export async function previewResourceText(filePath: string) {
  const file = await open(filePath, 'r')
  try {
    const info = await file.stat()
    const bytes = Buffer.alloc(Math.min(info.size, 128_000))
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const text = new TextDecoder('utf-8')
      .decode(bytes.subarray(0, bytesRead))
      .replace(/^\uFEFF/, '')
    return { text, truncated: info.size > bytesRead }
  } finally {
    await file.close()
  }
}

/** 大文件按范围流式读取，音视频拖动播放不需要重复下载整个文件。 */
export async function resourceContent(
  c: Context,
  filePath: string,
  mimeType: string,
  name: string,
  options?: { inline: boolean; policy: string },
): Promise<Response> {
  let info
  try {
    info = await stat(filePath)
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException
    if (error?.code === 'ENOENT') {
      return c.json({ code: 'NOT_FOUND', message: '请求的资源文件不存在或已被移除' }, 404)
    }
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      return c.json({ code: 'RESOURCE_LOCKED', message: '文件正被其他进程占用，请稍后再试' }, 423)
    }
    throw err
  }
  const download = c.req.query('download') === '1'
  const inline =
    options?.inline ||
    /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)$|audio\/|video\/|application\/pdf$|text\/plain$)/.test(
      mimeType,
    )
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'file'
  const headers = new Headers({
    'Content-Type': mimeType,
    'Content-Disposition': `${download || !inline ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Length': String(info.size),
    'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': options?.policy ?? "sandbox; default-src 'none'",
  })
  let start = 0
  let end = info.size - 1
  let status = 200
  const range = c.req.header('range')
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]))
      else {
        start = Number(match[1])
        if (match[2]) end = Math.min(end, Number(match[2]))
      }
    }
    if (
      !match ||
      (!match[1] && !match[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= info.size
    ) {
      headers.set('Content-Range', `bytes */${info.size}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }
    status = 206
    headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
    headers.set('Content-Length', String(end - start + 1))
  }
  const body =
    c.req.method === 'HEAD' || info.size === 0
      ? null
      : (Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>)
  return new Response(body, { status, headers })
}
