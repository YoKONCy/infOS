/**
 * @file 收纳框项目图标：
 *       - 系统图标（`app.getFileIcon`），快捷方式解析 .lnk 取目标或图标文件；
 *       - 图片缩略图（`nativeImage.createThumbnailFromPath`），失败时退回系统图标。
 *       都按「路径 + 修改时间 + 大小」缓存（缩略图再加像素档位），文件变化后自动换新，各有数量上限。
 *
 *       Windows 上 createThumbnailFromPath 虽然返回 Promise，实际在主线程同步执行（实测单张
 *       5–60ms，整个进程的第一张可能更久；工具进程里也没有 nativeImage，挪不出去）。所以缩略图排队：
 *       每轮事件循环只启动一个，中间留出空隙让主进程处理别的事。
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import { normalizeFencePath } from '../../../../packages/shared/src/desktopFence'
import type { FenceFileSystem } from './fenceEntries'

/** 图标来源；生产环境由 Electron 提供，测试中替换。 */
export interface FenceIconSource {
  /** 读取文件的系统图标，返回 PNG data URL；失败时为 null。 */
  getFileIcon(target: string): Promise<string | null>
  /** 解析 Windows 快捷方式；不是快捷方式或解析失败时为 null。 */
  readShortcutLink(target: string): { target?: string; icon?: string } | null
  /** 生成图片缩略图（保持比例，不超过 pixels），返回 PNG data URL；失败时抛错或为 null。 */
  createThumbnail(target: string, pixels: number): Promise<string | null>
}

const ICON_CACHE_LIMIT = 512
/** 约两个放满的映射文件夹（FENCE_LIMITS.folderEntries = 300）；单张约 1–40KB。 */
const THUMBNAIL_CACHE_LIMIT = 600
const THUMBNAIL_CONCURRENCY = 3
/** 两次启动之间的空隙（毫秒）。 */
const THUMBNAIL_GAP_MS = 16
/** 超过这个大小的图片不生成缩略图：解码会长时间占住主线程，直接用系统图标。 */
const THUMBNAIL_MAX_BYTES = 64 * 1024 * 1024
const THUMBNAIL_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i

/** 这个路径是不是能生成缩略图的图片（只看扩展名）。 */
export function isThumbnailTarget(target: string): boolean {
  return THUMBNAIL_EXTENSIONS.test(target)
}

/** 排队执行：最多 limit 个同时进行，每个都在独立的一轮事件循环里启动。 */
export class FenceTaskQueue {
  private readonly waiting: (() => Promise<void>)[] = []
  private active = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly limit: number,
    private readonly gapMs: number,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // 包一层 async：任务同步抛错也算失败，不会卡住队列。
      this.waiting.push(async () => {
        try {
          resolve(await task())
        } catch (error) {
          reject(error)
        }
      })
      this.schedule()
    })
  }

  private schedule(): void {
    if (this.timer || this.active >= this.limit || !this.waiting.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      const next = this.waiting.shift()
      if (next) {
        this.active += 1
        void next().finally(() => {
          this.active -= 1
          this.schedule()
        })
      }
      this.schedule()
    }, this.gapMs)
  }
}

/** 取缓存；最近用过的移到末尾，超出上限时先删最久没用的。 */
function remember<T>(cache: Map<string, T>, key: string, limit: number, make: () => T): T {
  const cached = cache.get(key)
  if (cached !== undefined) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  const value = make()
  cache.set(key, value)
  while (cache.size > limit) cache.delete(cache.keys().next().value!)
  return value
}

export class FenceIcons {
  private readonly cache = new Map<string, Promise<string | null>>()
  private readonly thumbnails = new Map<string, Promise<string | null>>()
  private readonly queue = new FenceTaskQueue(THUMBNAIL_CONCURRENCY, THUMBNAIL_GAP_MS)

  constructor(
    private readonly source: FenceIconSource,
    private readonly files: Pick<FenceFileSystem, 'stat'>,
  ) {}

  /** 快捷方式先用它指定的图标文件，再用目标程序，最后用 .lnk 本身。 */
  private iconPath(target: string): string {
    if (!target.toLowerCase().endsWith('.lnk')) return target
    const link = this.source.readShortcutLink(target)
    for (const candidate of [link?.icon, link?.target]) {
      // 快捷方式里的路径同样只接受本机绝对路径（不读网络路径的图标）。
      const local = normalizeFencePath(candidate)
      if (local && this.files.stat(local)) return local
    }
    return target
  }

  /** 项目的系统图标；文件不存在时为 null。 */
  icon(target: string): Promise<string | null> {
    const stat = this.files.stat(target)
    if (!stat) return Promise.resolve(null)
    const key = `${target.toLowerCase()}|${stat.mtimeMs}|${stat.size}`
    return remember(this.cache, key, ICON_CACHE_LIMIT, () =>
      this.source.getFileIcon(this.iconPath(target)).catch(() => null),
    )
  }

  /**
   * 图片的缩略图；生成失败时退回系统图标。不是图片或文件不存在时为 null（页面保留原来的图标）。
   * 失败的结果也缓存：同一个文件没变就不再重试，免得坏图每次都占主线程。
   */
  thumbnail(target: string, pixels: number): Promise<string | null> {
    const stat = this.files.stat(target)
    if (!stat || stat.isDirectory || !isThumbnailTarget(target)) return Promise.resolve(null)
    if (stat.size > THUMBNAIL_MAX_BYTES) return this.icon(target)
    const key = `${pixels}|${target.toLowerCase()}|${stat.mtimeMs}|${stat.size}`
    return remember(this.thumbnails, key, THUMBNAIL_CACHE_LIMIT, () =>
      this.queue
        .run(() => this.source.createThumbnail(target, pixels))
        .catch(() => null)
        .then((url) => url ?? this.icon(target)),
    )
  }

  get size(): number {
    return this.cache.size
  }

  get thumbnailCount(): number {
    return this.thumbnails.size
  }
}
