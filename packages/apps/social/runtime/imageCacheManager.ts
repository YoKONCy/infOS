import { t as __t } from './i18n'
/**
 * ImageCacheManager — 社交图片本地缓存
 *
 * 负责:
 * 1. 将规范消息中的远程图片 URL 下载到本地缓存目录
 * 2. 提供本地绝对路径，供后续 base64 编码传给 LLM
 * 3. 自动清理旧文件，保持缓存大小在限定范围内
 *
 * 缓存目录: data/social_images/
 *
 * @module packages/apps/social/runtime/imageCacheManager
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createLogger } from '@infos/backend/applicationHostAbi'

const logger = createLogger('ImageCache')

export interface ImageCacheConfig {
  requestContext?: (url: string) => { partition?: string; headers?: Record<string, string> }
  /** 缓存目录绝对路径 */
  cacheDir: string
  /** 最大缓存文件数 */
  maxFiles: number
  /** 下载超时 (ms) */
  downloadTimeout: number
}

const DEFAULT_CONFIG: ImageCacheConfig = {
  cacheDir: '', // 由外部注入
  maxFiles: 100,
  downloadTimeout: 10_000,
}

export class ImageCacheManager {
  private config: ImageCacheConfig
  private initialized = false
  private downloads = new Map<string, Promise<string | null>>()

  constructor(config: Partial<ImageCacheConfig> & { cacheDir: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 确保缓存目录存在 */
  private ensureDir(): void {
    if (this.initialized) return
    if (!fs.existsSync(this.config.cacheDir)) {
      fs.mkdirSync(this.config.cacheDir, { recursive: true })
      logger.info(__t('apps.social.logs', '缓存目录已创建: {0}', [this.config.cacheDir]))
    }
    this.initialized = true
  }

  /**
   * 下载远程图片到本地缓存
   *
   * @returns 本地绝对路径; 下载失败返回 null
   */
  async download(url: string): Promise<string | null> {
    const context = this.config.requestContext?.(url)
    const key = JSON.stringify([context?.partition ?? '', url])
    const pending = this.downloads.get(key)
    if (pending) return pending
    const downloading = this.downloadImage(url, key, context?.headers)
    this.downloads.set(key, downloading)
    try {
      return await downloading
    } finally {
      this.downloads.delete(key)
    }
  }

  private async downloadImage(
    url: string,
    key: string,
    headers?: Record<string, string>,
  ): Promise<string | null> {
    try {
      this.ensureDir()

      // 使用 URL 的 MD5 作为文件名
      const hash = crypto.createHash('md5').update(key).digest('hex')
      const ext = this.guessExtension(url)
      const filename = `${hash}.${ext}`
      const filepath = path.join(this.config.cacheDir, filename)

      // 命中缓存直接返回
      if (fs.existsSync(filepath)) {
        return filepath
      }

      // 使用 fetch 下载 (Node 18+ 原生支持)
      // 下载请求的认证与平台请求头由适配器提供。
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.downloadTimeout)

      try {
        const resp = await fetch(url, { signal: controller.signal, headers })
        if (!resp.ok) {
          logger.warn(__t('apps.social.logs', '下载图片失败 {0}: HTTP {1}', [url, resp.status]))
          return null
        }

        const buffer = Buffer.from(await resp.arrayBuffer())
        fs.writeFileSync(filepath, buffer)

        // 清理旧文件
        this.cleanup()

        return filepath
      } finally {
        clearTimeout(timeout)
      }
    } catch (err) {
      logger.warn(__t('apps.social.logs', '下载图片错误: {0}', [err]))
      return null
    }
  }

  /**
   * 将本地缓存图片读取为 data URL (base64)
   *
   * @returns data:image/xxx;base64,... 格式字符串; 失败返回 null
   */
  readAsDataUrl(filepath: string): string | null {
    try {
      if (!fs.existsSync(filepath)) return null

      const data = fs.readFileSync(filepath)
      // 平台图片地址可能没有扩展名，优先按真实文件头判断，避免 PNG 被标成 JPEG。
      const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
          ? 'image/jpeg'
          : /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))
            ? 'image/gif'
            : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
              ? 'image/webp'
              : undefined
      if (!mime) {
        logger.warn(__t('apps.social.logs', '图片缓存内容为空或格式不可识别，已跳过视觉输入'))
        return null
      }
      return `data:${mime};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  }

  /** 从 URL 推断扩展名 */
  private guessExtension(url: string): string {
    if (url.includes('.png')) return 'png'
    if (url.includes('.gif')) return 'gif'
    if (url.includes('.webp')) return 'webp'
    return 'jpg'
  }

  /** 清理旧文件，保持缓存大小在 maxFiles 以内 */
  private cleanup(): void {
    try {
      const dir = this.config.cacheDir
      const entries = fs
        .readdirSync(dir)
        .map((name) => {
          const fullPath = path.join(dir, name)
          const stat = fs.statSync(fullPath)
          return { path: fullPath, mtime: stat.mtimeMs }
        })
        .sort((a, b) => a.mtime - b.mtime) // 最旧的在前

      if (entries.length <= this.config.maxFiles) return

      const toDelete = entries.length - this.config.maxFiles
      for (let i = 0; i < toDelete; i++) {
        try {
          fs.unlinkSync(entries[i]!.path)
        } catch {
          // 静默忽略删除错误
        }
      }

      logger.debug(__t('apps.social.logs', '缓存清理: 删除了 {0} 个旧文件', [toDelete]))
    } catch {
      // 清理失败不影响主流程
    }
  }
}
