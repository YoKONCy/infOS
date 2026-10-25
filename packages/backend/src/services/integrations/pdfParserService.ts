import { inflateRawSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { AppError } from '../../lib/appError'
import type { IntegrationService, IntegrationSource } from './integrationService'
import { apiUrl, integrationFetch, integrationJson, publicArtifactUrl } from './integrationHttp'

const MAX_TEXT_BYTES = 4 * 1024 * 1024
const envelope = z.object({ code: z.number(), data: z.record(z.string(), z.unknown()).optional() })

export interface PdfParseResult {
  text: string
  sourceName: string
  provider: string
}
export interface PdfParserAdapter {
  parse(
    bytes: Buffer,
    fileName: string,
    source: IntegrationSource,
    signal: AbortSignal,
  ): Promise<string>
}

/** 只面向附件输入，解析来源不会注册成 Agent 工具。 */
export class PdfParserService {
  private adapters = new Map<string, PdfParserAdapter>()
  constructor(private integrations: IntegrationService) {
    this.register('mineru-light', {
      parse: (bytes, name, source, signal) => this.mineru(bytes, name, source, signal, true),
    })
    this.register('mineru', {
      parse: (bytes, name, source, signal) => this.mineru(bytes, name, source, signal, false),
    })
    this.register('pdf-http', {
      parse: async (bytes, name, source, signal) => {
        const form = new FormData()
        form.set('file', new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }))
        form.set('language', source.options.language)
        form.set('ocr', String(source.options.ocr))
        const result = z
          .object({ text: z.string().optional(), markdown: z.string().optional() })
          .parse(
            await integrationJson(source.endpoint, {
              method: 'POST',
              body: form,
              signal,
              headers: source.apiKey ? { Authorization: `Bearer ${source.apiKey}` } : {},
            }),
          )
        const text = result.markdown ?? result.text
        if (!text?.trim())
          throw new AppError('SERVICE_UNAVAILABLE', { message: '解析服务未返回文档文字' })
        return text
      },
    })
  }

  register(provider: string, adapter: PdfParserAdapter): void {
    this.adapters.set(provider, adapter)
  }
  capture(): IntegrationSource {
    const source = this.integrations.selectedSource('pdf')
    if (!source || !this.adapters.has(source.provider))
      throw new AppError('NOT_CONFIGURED', {
        message: '请先在工具与扩展的拓展功能中配置并启用 PDF 解析来源',
      })
    return source
  }
  capabilities(): { pdf: boolean; maxPdfBytes: number; sourceName: string | null } {
    const source = this.integrations.selectedSource('pdf')
    return {
      pdf: Boolean(source && this.adapters.has(source.provider)),
      maxPdfBytes: source?.provider === 'mineru-light' ? 10 * 1024 * 1024 : 50 * 1024 * 1024,
      sourceName: source?.name ?? null,
    }
  }

  async parse(
    bytes: Buffer,
    name: string,
    source: IntegrationSource,
    signal: AbortSignal,
  ): Promise<PdfParseResult> {
    const max = source.provider === 'mineru-light' ? 10 * 1024 * 1024 : 50 * 1024 * 1024
    if (bytes.length > max)
      throw new AppError('OUT_OF_RANGE', {
        message: 'PDF 大小超过所选解析来源限制，请拆分文件后上传',
      })
    const adapter = this.adapters.get(source.provider)
    if (!adapter) throw new AppError('NOT_CONFIGURED', { message: 'PDF 解析来源不可用' })
    if (bytes.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) < 0)
      throw new AppError('INVALID_FORMAT', { message: '文件不是有效的 PDF' })
    const text = await adapter.parse(bytes, name, source, signal)
    if (!text.trim())
      throw new AppError('INVALID_FORMAT', {
        message: 'PDF 没有提取出文字，请尝试开启 OCR 或更换解析来源',
      })
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES)
      throw new AppError('OUT_OF_RANGE', { message: 'PDF 解析文字过多，请拆分文件后上传' })
    return { text, sourceName: source.name, provider: source.provider }
  }

  private async mineru(
    bytes: Buffer,
    name: string,
    source: IntegrationSource,
    signal: AbortSignal,
    lightweight: boolean,
  ): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (!lightweight) headers.Authorization = `Bearer ${source.apiKey}`
    const response = envelope.parse(
      await integrationJson(
        apiUrl(source.endpoint, lightweight ? 'api/v1/agent/parse/file' : 'api/v4/file-urls/batch'),
        {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify(
            lightweight
              ? {
                  file_name: name,
                  language: source.options.language,
                  is_ocr: source.options.ocr,
                  enable_table: true,
                  enable_formula: true,
                }
              : {
                  files: [{ name, is_ocr: source.options.ocr }],
                  language: source.options.language,
                  model_version: source.options.model,
                  enable_table: true,
                  enable_formula: true,
                },
          ),
        },
      ),
    )
    if (response.code !== 0 || !response.data)
      throw new AppError('SERVICE_UNAVAILABLE', {
        message: 'MinerU 未能创建解析任务，请检查额度和配置',
      })
    const id = z
      .string()
      .min(1)
      .max(300)
      .parse(lightweight ? response.data.task_id : response.data.batch_id)
    const uploadUrl = z
      .string()
      .parse(
        lightweight
          ? response.data.file_url
          : z.array(z.string()).min(1).parse(response.data.file_urls)[0],
      )
    await integrationFetch(
      publicArtifactUrl(uploadUrl),
      { method: 'PUT', body: new Uint8Array(bytes), signal },
      1024 * 1024,
    )
    for (;;) {
      await delay(3000, undefined, { signal })
      const status = envelope.parse(
        await integrationJson(
          apiUrl(
            source.endpoint,
            lightweight
              ? `api/v1/agent/parse/${encodeURIComponent(id)}`
              : `api/v4/extract-results/batch/${encodeURIComponent(id)}`,
          ),
          { headers, signal },
        ),
      )
      if (status.code !== 0 || !status.data)
        throw new AppError('SERVICE_UNAVAILABLE', { message: 'MinerU 解析状态查询失败' })
      const item = lightweight
        ? status.data
        : z.array(z.record(z.string(), z.unknown())).parse(status.data.extract_result)[0]
      if (!item)
        throw new AppError('SERVICE_UNAVAILABLE', { message: 'MinerU 没有返回文件解析状态' })
      if (item.state === 'failed')
        throw new AppError('SERVICE_UNAVAILABLE', {
          message: 'MinerU 解析失败，请检查文件、页数额度或更换解析模式',
        })
      if (item.state !== 'done') continue
      if (lightweight) {
        const text = await integrationFetch(
          publicArtifactUrl(z.string().parse(item.markdown_url)),
          { signal },
          MAX_TEXT_BYTES,
        )
        return new TextDecoder('utf-8', { fatal: true }).decode(text)
      }
      const zip = await integrationFetch(
        publicArtifactUrl(z.string().parse(item.full_zip_url)),
        { signal },
        50 * 1024 * 1024,
      )
      return readMarkdownZip(zip)
    }
  }
}

/** 只从中央目录读取 full.md 到内存，不释放压缩包中的任何路径或其他文件。 */
function readMarkdownZip(zip: Buffer): string {
  let end = -1
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new AppError('INVALID_FORMAT', { message: 'MinerU 返回的结果包无效' })
  const entries = zip.readUInt16LE(end + 10)
  let cursor = zip.readUInt32LE(end + 16)
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) break
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > zip.length) break
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (name === 'full.md' || name.endsWith('/full.md')) {
      const flags = zip.readUInt16LE(cursor + 8)
      const method = zip.readUInt16LE(cursor + 10)
      const compressedSize = zip.readUInt32LE(cursor + 20)
      const size = zip.readUInt32LE(cursor + 24)
      const local = zip.readUInt32LE(cursor + 42)
      if (
        flags & 1 ||
        size > MAX_TEXT_BYTES ||
        local + 30 > zip.length ||
        zip.readUInt32LE(local) !== 0x04034b50
      )
        break
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      if (start + compressedSize > zip.length) break
      const content = zip.subarray(start, start + compressedSize)
      const decoded =
        method === 0
          ? content
          : method === 8
            ? inflateRawSync(content, { maxOutputLength: MAX_TEXT_BYTES })
            : null
      if (!decoded || decoded.length !== size) break
      return new TextDecoder('utf-8', { fatal: true }).decode(decoded)
    }
    cursor = next
  }
  throw new AppError('INVALID_FORMAT', {
    message: '结果包缺少可读取的 full.md，或文字内容超过限制',
  })
}
