/**
 * staticAssetService — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.avif': 'image/avif',
}

/** 只有内容哈希资源允许不可变缓存；固定名称与 HTML 每次通过 ETag 协商更新。 */
export function staticAssetCacheControl(requested: string): string {
  return /^assets\/[^/]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(requested.replaceAll('\\', '/'))
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
}

/** 发行包静态资源读取服务。 */
export class StaticAssetService {
  constructor(private readonly root: string) {}

  private locate(requested: string) {
    const root = path.resolve(this.root)
    const target = path.resolve(root, requested)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('FORBIDDEN')
    if (!existsSync(target)) return null
    const stat = statSync(target)
    return stat.isFile() ? { target, stat } : null
  }

  read(requested: string): { body: ArrayBuffer; contentType: string; cacheControl: string } | null {
    const file = this.locate(requested)
    if (!file) return null
    const { target } = file
    const content = readFileSync(target)
    return {
      body: content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType: CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      cacheControl: staticAssetCacheControl(requested),
    }
  }

  /** 条件命中和 HEAD 都不读取正文；主应用与子应用共用同一缓存语义。 */
  response(requested: string, request: Request): Response | null {
    const file = this.locate(requested)
    if (!file) return null
    const { target, stat } = file
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
    const headers = new Headers({
      'Content-Type':
        CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': staticAssetCacheControl(requested),
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Referrer-Policy': 'same-origin',
    })
    const condition = request.headers.get('if-none-match')
    const unchanged =
      condition !== null
        ? condition
            .split(',')
            .some(
              (value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.slice(2),
            )
        : Boolean(request.headers.get('if-modified-since')) &&
          Math.floor(stat.mtimeMs / 1000) * 1000 <=
            Date.parse(request.headers.get('if-modified-since')!)
    if (unchanged) return new Response(null, { status: 304, headers })
    headers.set('Content-Length', String(stat.size))
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(readFileSync(target)), {
      headers,
    })
  }
}
