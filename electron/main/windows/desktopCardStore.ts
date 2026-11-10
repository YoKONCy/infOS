/**
 * @file 桌面卡片的磁盘存储：`desktop-cards/<卡片 ID>/` 下的 card.json 与 index.html。
 *       写入用临时文件再改名；移动、缩放的位置延迟写盘。
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 */

import { t as __t } from '../utils/i18n'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../utils/logger'
import type { BrowserWindow } from 'electron'
import {
  DESKTOP_CARD_DOCUMENT,
  DESKTOP_CARD_MANIFEST,
  isDesktopCardExpired,
  isDesktopCardId,
  normalizeDesktopCardMeta,
  type DesktopCardMeta,
} from '../../../packages/shared/src/desktopCards'
import { DESKTOP_SHELL_SAVE_DELAY_MS } from '../../../packages/shared/src/desktopShell'
import { countsTowardCardLimit } from './desktopCardModel'

/** 卡片页显示的缩略图（卡片窗口截图，PNG）。 */
const THUMBNAIL_FILE = 'thumbnail.png'
/** 缩略图宽度（像素）。 */
const THUMBNAIL_WIDTH = 320

export class DesktopCardStore {
  private cache: Map<string, DesktopCardMeta> | null = null
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly root: () => string) {}

  get cards(): Map<string, DesktopCardMeta> {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  private load(): Map<string, DesktopCardMeta> {
    const cards = new Map<string, DesktopCardMeta>()
    const root = this.root()
    if (!fs.existsSync(root)) return cards
    for (const id of fs.readdirSync(root)) {
      if (!isDesktopCardId(id)) continue
      const dir = path.join(root, id)
      try {
        if (!fs.existsSync(path.join(dir, DESKTOP_CARD_MANIFEST))) continue
        const meta = normalizeDesktopCardMeta(
          JSON.parse(fs.readFileSync(path.join(dir, DESKTOP_CARD_MANIFEST), 'utf8')),
          id,
        )
        // 普通卡片必须有 index.html；预制件的页面由宿主提供。未知种类的预制件没有页面，同样跳过。
        if (!meta.prefab && !fs.existsSync(path.join(dir, DESKTOP_CARD_DOCUMENT))) continue
        cards.set(id, meta)
      } catch (error) {
        logger.warn(
          'DesktopCards',
          __t('electron.logs.windows', '桌面卡片读取失败，已跳过：{0} — {1}', [id, String(error)]),
        )
      }
    }
    return cards
  }

  dir(id: string): string {
    return path.join(this.root(), id)
  }

  writeAtomic(file: string, content: string): void {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, content, 'utf8')
      fs.renameSync(temporary, file)
    } catch (error) {
      fs.rmSync(temporary, { force: true })
      throw error
    }
  }

  writeMeta(meta: DesktopCardMeta): void {
    clearTimeout(this.saveTimers.get(meta.id))
    this.saveTimers.delete(meta.id)
    fs.mkdirSync(this.dir(meta.id), { recursive: true })
    this.writeAtomic(
      path.join(this.dir(meta.id), DESKTOP_CARD_MANIFEST),
      `${JSON.stringify(meta, null, 2)}\n`,
    )
  }

  /** 新卡片写盘：普通卡片写 index.html 与 card.json，预制件只写 card.json；失败时删掉半成品。 */
  createFiles(card: DesktopCardMeta, html: string | undefined): void {
    fs.mkdirSync(this.dir(card.id), { recursive: true })
    try {
      if (html !== undefined)
        this.writeAtomic(path.join(this.dir(card.id), DESKTOP_CARD_DOCUMENT), html)
      this.writeMeta(card)
    } catch (error) {
      fs.rmSync(this.dir(card.id), { recursive: true, force: true })
      throw error
    }
  }

  /** 新卡片 ID：`card-` 加 8 位随机十六进制，不与现有卡片或残留文件夹重名。 */
  newId(): string {
    let id: string
    do id = `card-${randomUUID().slice(0, 8)}`
    while (this.cards.has(id) || fs.existsSync(this.dir(id)))
    return id
  }

  /** 整页替换普通卡片的 HTML。 */
  writeHtml(id: string, html: string): void {
    this.writeAtomic(path.join(this.dir(id), DESKTOP_CARD_DOCUMENT), html)
  }

  /** 计入上限的卡片数（不含收纳框等不计数的预制件）。 */
  limitedCount(): number {
    return [...this.cards.values()].filter(countsTowardCardLimit).length
  }

  /** 移动、缩放停止一段时间后再写盘。 */
  scheduleSave(meta: DesktopCardMeta): void {
    clearTimeout(this.saveTimers.get(meta.id))
    this.saveTimers.set(
      meta.id,
      setTimeout(() => {
        try {
          if (this.cards.get(meta.id) === meta) this.writeMeta(meta)
        } catch (error) {
          logger.warn(
            'DesktopCards',
            __t('electron.logs.windows', '桌面卡片保存失败：{0}', [String(error)]),
          )
        }
      }, DESKTOP_SHELL_SAVE_DELAY_MS),
    )
  }

  erase(id: string): void {
    clearTimeout(this.saveTimers.get(id))
    this.saveTimers.delete(id)
    this.cards.delete(id)
    fs.rmSync(this.dir(id), { recursive: true, force: true })
  }

  /** 是否有尚未写盘的位置或大小改动。 */
  hasPendingSave(id: string): boolean {
    return this.saveTimers.has(id)
  }

  /** 截取卡片窗口写成缩略图；窗口不可用或截图失败时保留旧图，不抛错。 */
  async captureThumbnail(id: string, win: BrowserWindow | undefined): Promise<void> {
    if (!win || typeof win.webContents.capturePage !== 'function') return
    try {
      const image = await win.webContents.capturePage()
      if (image.isEmpty() || !this.cards.has(id)) return
      const png = image.resize({ width: THUMBNAIL_WIDTH }).toPNG()
      this.writeAtomicBytes(path.join(this.dir(id), THUMBNAIL_FILE), png)
    } catch (error) {
      logger.warn(
        'DesktopCards',
        __t('electron.logs.windows', '卡片缩略图保存失败：{0}', [String(error)]),
      )
    }
  }

  /** 超过保留期的最近关闭卡片（窗口打开着的不算）。 */
  expiredIds(now: number, isOpen: (id: string) => boolean): string[] {
    return [...this.cards.values()]
      .filter((card) => !isOpen(card.id) && isDesktopCardExpired(card, now))
      .map((card) => card.id)
  }

  /** 关闭最早的那张最近关闭卡片；卡片数到上限时先删它，为新卡片腾位置。 */
  oldestRecentId(isOpen: (id: string) => boolean): string | undefined {
    return [...this.cards.values()]
      .filter((card) => !card.saved && card.closedAt && !isOpen(card.id))
      .sort((left, right) => left.closedAt!.localeCompare(right.closedAt!))[0]?.id
  }

  /** 缩略图的 data URL；没有截过或读取失败时为 undefined。 */
  readThumbnail(id: string): string | undefined {
    try {
      const png = fs.readFileSync(path.join(this.dir(id), THUMBNAIL_FILE))
      return png.length ? `data:image/png;base64,${png.toString('base64')}` : undefined
    } catch {
      return undefined
    }
  }

  private writeAtomicBytes(file: string, content: Buffer): void {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, content)
      fs.renameSync(temporary, file)
    } catch (error) {
      fs.rmSync(temporary, { force: true })
      throw error
    }
  }

  /** 卡片页面的 HTML；卡片不存在时为 undefined。供 `infos-card://` 协议读取。 */
  readHtml(id: string): string | undefined {
    if (!isDesktopCardId(id) || !this.cards.has(id)) return undefined
    try {
      return fs.readFileSync(path.join(this.dir(id), DESKTOP_CARD_DOCUMENT), 'utf8')
    } catch {
      return undefined
    }
  }
}
