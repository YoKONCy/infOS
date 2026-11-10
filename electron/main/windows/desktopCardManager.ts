/**
 * @file 桌面卡片管理：卡片的增删改、窗口打开与恢复、卡片页面的请求。
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 */

import { t as __t } from '../utils/i18n'
import type { BrowserWindow, WebContents } from 'electron'
import { logger } from '../utils/logger'
import {
  CARD_MIN_SIZE,
  DESKTOP_CARD_CHANNELS,
  DESKTOP_CARD_LIMITS,
  desktopCardExpiresAt,
  isDesktopCardId,
  normalizeDesktopCardName,
  type DesktopCardAdminPatch,
  type DesktopCardListItem,
  type DesktopCardMeta,
} from '../../../packages/shared/src/desktopCards'
import {
  clampRectToArea,
  normalizeOpacity,
  type ShellRect,
} from '../../../packages/shared/src/desktopShell'
import { DesktopCardRequests } from './desktopCardRequests'
import { DesktopCardStore } from './desktopCardStore'
import {
  countsTowardCardLimit,
  electronDisplays,
  fail,
  newCardMeta,
  requireCardHtml,
  placeNewCard,
  readCardBounds,
  resolveCardBounds,
  type DesktopCardDisplays,
  type DesktopCardInput,
  type DesktopCardPrefabHooks,
  type DesktopCardsHost,
} from './desktopCardModel'
import { CARD_CONSOLE_LIMIT, wireCardWindow } from './desktopCardWiring'

export class DesktopCards {
  private host: DesktopCardsHost | null = null
  private prefabs: DesktopCardPrefabHooks | null = null
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly consoles = new Map<string, string[]>()
  private shuttingDown = false
  /** 遗留临时卡片的清理每个进程只做一次（首次恢复时）；主窗口重建后再次恢复不能删除仍在屏幕上的卡片。 */
  private leftoversCleaned = false

  private readonly store: DesktopCardStore
  /** 卡片页面发来的请求（数据、打开功能页），见 desktopCardRequests.ts。 */
  readonly pageRequests: DesktopCardRequests

  constructor(
    root: () => string,
    private readonly displays: DesktopCardDisplays = electronDisplays,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DesktopCardStore(root)
    this.pageRequests = new DesktopCardRequests(now, () => this.host)
  }

  configure(host: DesktopCardsHost): void {
    this.host = host
  }

  /** 接入预制件模块（见 electron/main/prefabs）。 */
  usePrefabs(hooks: DesktopCardPrefabHooks): void {
    this.prefabs = hooks
  }

  // ─── 存储（见 desktopCardStore.ts） ────────────────────

  private get cards(): Map<string, DesktopCardMeta> {
    return this.store.cards
  }

  private erase(id: string): void {
    this.pageRequests.forget(id)
    this.consoles.delete(id)
    this.store.erase(id)
  }

  /** 卡片页面的 HTML；卡片不存在时为 undefined。供 `infos-card://` 协议读取。 */
  readHtml = (id: string): string | undefined => {
    const card = this.cards.get(id)
    if (!card?.prefab) return this.store.readHtml(id)
    return this.prefabs?.document(card)
  }

  // ─── 查询 ──────────────────────────────────────────

  list(): DesktopCardMeta[] {
    this.purgeExpired()
    return (
      [...this.cards.values()]
        .map((card) => ({ ...card, open: this.windowOf(card.id) !== undefined }))
        // 同一毫秒创建的卡片按 ID 排序，保证顺序稳定。
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        )
    )
  }

  /** 卡片页的列表：先刷新打开着的卡片的缩略图，再附上缩略图与「最近关闭」的过期时间。 */
  async adminList(): Promise<DesktopCardListItem[]> {
    await Promise.all([...this.windows.keys()].map((id) => this.captureThumbnail(id)))
    return this.list().map((card) => {
      const thumbnail = this.store.readThumbnail(card.id)
      const expiresAt = desktopCardExpiresAt(card)
      return { ...card, ...(thumbnail ? { thumbnail } : {}), ...(expiresAt ? { expiresAt } : {}) }
    })
  }

  get(id: unknown): DesktopCardMeta {
    const card = isDesktopCardId(id) ? this.cards.get(id) : undefined
    if (!card) fail('DESKTOP_CARD_NOT_FOUND', '卡片不存在：{0}', [String(id)])
    return card
  }

  windowOf(id: string): BrowserWindow | undefined {
    const win = this.windows.get(id)
    return win && !win.isDestroyed() ? win : undefined
  }

  openWindows(): BrowserWindow[] {
    return [...this.windows.values()].filter((win) => !win.isDestroyed())
  }

  /** 发送者是哪张卡片的窗口。 */
  idOf(sender: WebContents): string | undefined {
    for (const [id, win] of this.windows)
      if (!win.isDestroyed() && win.webContents === sender) return id
    return undefined
  }

  /** 读回源码与最近的控制台错误。 */
  read(id: unknown): { card: DesktopCardMeta; html: string; console: string[] } {
    const card = this.get(id)
    return {
      card: { ...card, open: this.windowOf(card.id) !== undefined },
      html: this.readHtml(card.id) ?? '',
      console: [...(this.consoles.get(card.id) ?? [])],
    }
  }

  // ─── 操作 ──────────────────────────────────────────

  private readBounds(value: unknown): ShellRect | undefined {
    return readCardBounds(value, this.displays, (size) => this.placeNew(size))
  }

  /** 位置可选：给了 x、y 时修正到工作区内；只给大小时自动放在主窗口旁边。 */
  create(input: DesktopCardInput): DesktopCardMeta {
    const name = normalizeDesktopCardName(input.name)
    if (!name) fail('DESKTOP_CARD_INVALID_NAME', '卡片需要名称')
    const prefab = input.prefab
    // 预制件没有角色写的 HTML，页面由宿主提供。
    const html = prefab ? undefined : requireCardHtml(input.html)
    this.purgeExpired()
    // 到上限时先删掉关闭最早的最近关闭卡片；不计数的预制件（收纳框）不受上限限制。
    const limited = countsTowardCardLimit(input)
    const oldest = this.store.oldestRecentId((id) => this.windows.has(id))
    if (limited && this.store.limitedCount() >= DESKTOP_CARD_LIMITS.cards && oldest)
      this.erase(oldest)
    if (limited && this.store.limitedCount() >= DESKTOP_CARD_LIMITS.cards)
      fail('DESKTOP_CARD_LIMIT', '卡片数量已达上限 {0}，请先删除不用的卡片', [
        DESKTOP_CARD_LIMITS.cards,
      ])
    const bounds = this.readBounds(input.bounds)
    const id = this.store.newId()
    const card = newCardMeta(id, name, input, bounds, new Date(this.now()).toISOString())
    this.store.createFiles(card, html)
    this.cards.set(id, card)
    this.open(card)
    logger.info('DesktopCards', __t('electron.logs.windows', '已创建桌面卡片 {0}', [id]))
    return { ...card }
  }

  /** 整页替换 HTML 与 / 或改名；打开的卡片重新加载。 */
  update(id: unknown, input: DesktopCardInput): DesktopCardMeta {
    const card = this.get(id)
    const name = input.name === undefined ? undefined : normalizeDesktopCardName(input.name)
    if (input.name !== undefined && !name) fail('DESKTOP_CARD_INVALID_NAME', '卡片需要名称')
    const html = input.html === undefined ? undefined : requireCardHtml(input.html)
    if (html !== undefined && card.prefab)
      fail('DESKTOP_PREFAB_READONLY', '预制件的页面由 infOS 提供，不能替换 HTML')
    if (name === undefined && html === undefined)
      fail('DESKTOP_CARD_INVALID_PATCH', 'update 需要 name 或 html')
    if (html !== undefined) this.store.writeHtml(card.id, html)
    if (name) card.name = name
    card.updatedAt = new Date(this.now()).toISOString()
    this.store.writeMeta(card)
    const win = this.windowOf(card.id)
    if (win) {
      if (html !== undefined) {
        this.consoles.delete(card.id)
        win.webContents.reload()
      }
      this.notify(card)
    }
    return { ...card, open: win !== undefined }
  }

  /** 收藏或取消收藏；收藏会把卡片从「最近关闭」捡回，取消收藏且窗口未打开的卡片进「最近关闭」。 */
  save(id: unknown, saved = true): DesktopCardMeta {
    const card = this.get(id)
    card.saved = saved
    if (saved) delete card.closedAt
    else {
      card.autoOpen = false
      if (!this.windowOf(card.id)) card.closedAt = new Date(this.now()).toISOString()
    }
    this.store.writeMeta(card)
    this.notify(card)
    return { ...card, open: this.windowOf(card.id) !== undefined }
  }

  /** 打开已收藏但关闭了的卡片；已打开时聚焦。 */
  show(id: unknown): DesktopCardMeta {
    const card = this.get(id)
    const win = this.windowOf(card.id)
    if (win) {
      if (!win.isVisible()) win.show()
      win.focus()
    } else {
      card.open = true
      delete card.closedAt
      this.store.writeMeta(card)
      this.open(card)
    }
    return { ...card, open: true }
  }

  /**
   * 关闭卡片窗口：收藏的保留；未收藏的进「最近关闭」，7 天内可收藏捡回，不会立即删除。
   * `deleted` 恒为 false（保留字段供旧调用方判断），`recentlyClosed` 表示进了最近关闭。
   */
  close(id: unknown): { deleted: false; recentlyClosed: boolean } {
    const card = this.get(id)
    const win = this.windowOf(card.id)
    this.windows.delete(card.id)
    this.afterClose(card)
    if (win) win.destroy()
    return { deleted: false, recentlyClosed: !card.saved }
  }

  /** 卡片页的修改：改名、收藏、置顶、开机自动打开。开机自动打开需要收藏，开启时一并收藏。 */
  patch(id: unknown, patch: DesktopCardAdminPatch): DesktopCardMeta {
    const card = this.get(id)
    if (patch.name !== undefined) this.update(card.id, { name: patch.name })
    const saved = patch.autoOpen === true ? true : patch.saved
    if (saved !== undefined && saved !== card.saved) this.save(card.id, saved)
    if (patch.alwaysOnTop !== undefined) this.set(card.id, { alwaysOnTop: patch.alwaysOnTop })
    if (patch.autoOpen !== undefined && card.saved) {
      card.autoOpen = patch.autoOpen
      this.store.writeMeta(card)
    }
    return { ...card, open: this.windowOf(card.id) !== undefined }
  }

  remove(id: unknown): void {
    const card = this.get(id)
    const win = this.windowOf(card.id)
    this.windows.delete(card.id)
    this.erase(card.id)
    if (win) win.destroy()
    // 只删卡片自己的文件夹（card.json 等）；预制件引用的用户文件不在其中，不会被碰。
    if (card.prefab) this.prefabs?.released(card.id, true)
    logger.info('DesktopCards', __t('electron.logs.windows', '已删除桌面卡片 {0}', [card.id]))
  }

  /** 置顶与透明度（标题栏按钮与 `shell_window set`）。 */
  set(id: unknown, patch: { alwaysOnTop?: boolean; opacity?: number }): DesktopCardMeta {
    const card = this.get(id)
    const win = this.windowOf(card.id)
    if (patch.alwaysOnTop !== undefined) {
      card.alwaysOnTop = patch.alwaysOnTop
      win?.setAlwaysOnTop(patch.alwaysOnTop)
    }
    if (patch.opacity !== undefined) {
      card.opacity = normalizeOpacity(patch.opacity)
      win?.setOpacity(card.opacity)
    }
    this.store.writeMeta(card)
    this.notify(card)
    return { ...card, open: win !== undefined }
  }

  /**
   * 贴到桌面底层或取消（阶段 5）。不支持或失败时抛 `DESKTOP_CARD_LAYER_UNAVAILABLE`，设置不变；
   * 关闭着的卡片只记下设置，下次打开时挂接。
   */
  setDesktopLayer(id: unknown, enabled: boolean): DesktopCardMeta {
    const card = this.get(id)
    const win = this.windowOf(card.id)
    if (win && !this.host?.desktopLayer?.set(win, enabled))
      fail('DESKTOP_CARD_LAYER_UNAVAILABLE', '无法贴到桌面：只支持 Windows，或没有找到桌面图标层')
    card.desktopLayer = enabled
    this.store.writeMeta(card)
    return { ...card, open: win !== undefined }
  }

  /** 移动或缩放卡片窗口（修正到工作区内）。 */
  place(id: unknown, rect: ShellRect): ShellRect {
    const card = this.get(id)
    const win = this.windowOf(card.id)
    if (!win) fail('DESKTOP_CARD_CLOSED', '卡片没有打开：{0}', [card.id])
    // 贴底后窗口坐标相对桌面图标层，先取消贴底再移动。
    if (card.desktopLayer)
      fail('DESKTOP_CARD_PINNED', '卡片贴在桌面上，请先取消贴到桌面再移动或缩放')
    const bounds = clampRectToArea(rect, this.displays.workAreaNear(rect), CARD_MIN_SIZE)
    // 折叠的预制件只改位置与宽度，窗口仍只显示标题栏；返回窗口应有的位置供核对。
    const applied = this.toWindow(card, bounds)
    win.setBounds(applied)
    card.bounds = bounds
    this.store.writeMeta(card)
    return applied
  }

  /** 页面内的移动或缩放结束：按窗口实际位置立即写盘（平时由 move / resize 事件延迟保存）。 */
  commitWindowBounds(id: unknown): void {
    const card = this.get(id)
    const win = this.windowOf(card.id)
    if (!win) return
    card.bounds = this.fromWindow(card, win.getBounds())
    this.store.writeMeta(card)
  }

  /** 预制件状态写回 card.json（状态由预制件模块校验）；返回卡片信息。 */
  writePrefab(id: unknown, state: Record<string, unknown>): DesktopCardMeta {
    const card = this.get(id)
    if (!card.prefab) fail('DESKTOP_PREFAB_REQUIRED', '这张卡片不是预制件：{0}', [card.id])
    card.prefab = { ...card.prefab, state }
    card.updatedAt = new Date(this.now()).toISOString()
    this.store.writeMeta(card)
    return card
  }

  /** 主窗口显示后恢复卡片（与面板相同的时机）。 */
  restoreWhenReady(main: BrowserWindow): void {
    const run = () => {
      if (!main.isDestroyed()) this.restore()
    }
    if (main.isVisible()) setImmediate(run)
    else main.once('show', run)
  }

  /**
   * 主窗口显示后：恢复打开着的收藏卡片。首次调用（即启动时）另外打开「开机自动打开」的收藏卡片，
   * 并把上次异常退出遗留的临时卡片放进「最近关闭」；过了保留期的最近关闭卡片清理掉。
   * 窗口仍打开的卡片（本进程创建的）永远不动。
   */
  restore(): void {
    if (this.shuttingDown) return
    const firstRestore = !this.leftoversCleaned
    this.leftoversCleaned = true
    this.purgeExpired()
    for (const card of [...this.cards.values()]) {
      if (this.windows.has(card.id)) continue
      if (!card.saved) {
        if (firstRestore && !card.closedAt) this.markRecent(card)
      } else if (card.open || (firstRestore && card.autoOpen)) this.open(card)
    }
  }

  /** 显示器拔掉或分辨率变化后：可见面积不足一半的已打开卡片拉回工作区（贴底的卡片不动）。 */
  correctOffscreen(): void {
    for (const card of this.cards.values()) {
      const win = this.windowOf(card.id)
      if (!win || card.desktopLayer) continue
      const bounds = this.toWindow(
        card,
        resolveCardBounds(
          { ...card, bounds: this.fromWindow(card, win.getBounds()) },
          this.displays,
          (size) => this.placeNew(size),
        ),
      )
      if (JSON.stringify(bounds) !== JSON.stringify(win.getBounds())) win.setBounds(bounds)
    }
  }

  /** 退出应用前调用：打开着的临时卡片进「最近关闭」，收藏的卡片保持“打开”状态以便下次恢复。 */
  shutdown(): void {
    this.shuttingDown = true
    for (const card of [...this.cards.values()]) {
      try {
        if (!card.saved) {
          if (!card.closedAt) this.markRecent(card)
        } else if (this.store.hasPendingSave(card.id)) this.store.writeMeta(card)
      } catch (error) {
        logger.warn(
          'DesktopCards',
          __t('electron.logs.windows', '桌面卡片保存失败：{0}', [String(error)]),
        )
      }
    }
  }

  // ─── 内部 ──────────────────────────────────────────

  private open(card: DesktopCardMeta): BrowserWindow {
    if (!this.host) throw new Error('DESKTOP_CARD_NOT_CONFIGURED')
    const bounds = this.resolveBounds(card)
    card.bounds = bounds
    const win = this.host.createWindow(card, this.toWindow(card, bounds))
    this.windows.set(card.id, win)
    // 透明窗口上调用 setOpacity 会给窗口加整体透明样式，可能影响逐像素透明；不透明时不调用。
    if (!card.prefab || card.opacity !== 1) win.setOpacity(card.opacity)
    if (card.alwaysOnTop) win.setAlwaysOnTop(true)
    // 阶段 5：收藏时选了贴底的卡片，窗口就绪后重新挂到桌面图标层；失败时保持普通窗口。
    if (card.desktopLayer)
      win.once('ready-to-show', () => {
        if (!win.isDestroyed() && !this.host?.desktopLayer?.set(win, true))
          logger.warn(
            'DesktopCards',
            __t('electron.logs.windows', '卡片未能贴到桌面，按普通窗口显示：{0}', [card.id]),
          )
      })
    if (card.prefab) this.prefabs?.opened(card, win)
    wireCardWindow(win, {
      isCurrent: () => this.windows.get(card.id) === win && this.cards.has(card.id),
      moved: () => {
        card.bounds = this.fromWindow(card, win.getBounds())
        this.store.scheduleSave(card)
      },
      closed: () => this.handleClosed(card, win),
      closeShortcut: () => this.close(card.id),
      thumbnail: () => void this.captureThumbnail(card.id),
      console: (line) => {
        const lines = this.consoles.get(card.id) ?? []
        lines.push(line)
        this.consoles.set(card.id, lines.slice(-CARD_CONSOLE_LIMIT))
      },
    })
    return win
  }

  /** 保存的位置 → 窗口位置（预制件可改写，例如折叠）。 */
  private toWindow(card: DesktopCardMeta, rect: ShellRect): ShellRect {
    return card.prefab && this.prefabs ? this.prefabs.windowBounds(card, rect) : rect
  }

  /** 窗口位置 → 要保存的位置。 */
  private fromWindow(card: DesktopCardMeta, rect: ShellRect): ShellRect {
    return card.prefab && this.prefabs ? this.prefabs.persistBounds(card, rect) : rect
  }

  private resolveBounds(card: DesktopCardMeta): ShellRect {
    return resolveCardBounds(card, this.displays, (size) => this.placeNew(size))
  }

  /** 新卡片放在主窗口旁边，多张依次错开。 */
  private placeNew(size: { width: number; height: number }): ShellRect {
    return placeNewCard(size, this.displays, this.host?.mainWindow(), this.windows.size)
  }

  /** 关闭后：收藏的卡片记为未打开，临时卡片进「最近关闭」。 */
  private afterClose(card: DesktopCardMeta): void {
    if (card.saved) {
      card.open = false
      this.store.writeMeta(card)
    } else this.markRecent(card)
  }

  /** 临时卡片进「最近关闭」：记下关闭时间并写盘。 */
  private markRecent(card: DesktopCardMeta): void {
    card.open = false
    card.closedAt = new Date(this.now()).toISOString()
    this.store.writeMeta(card)
  }

  /** 清理超过保留期的最近关闭卡片。 */
  private purgeExpired(): void {
    for (const id of this.store.expiredIds(this.now(), (id) => this.windows.has(id))) this.erase(id)
  }

  /** 截取卡片窗口作为缩略图（见 desktopCardStore.captureThumbnail）。 */
  private captureThumbnail = (id: string) => this.store.captureThumbnail(id, this.windowOf(id))

  /** 窗口真正关闭（标题栏关闭、系统快捷键）；退出应用时由 shutdown 处理。 */
  private handleClosed(card: DesktopCardMeta, win: BrowserWindow): void {
    if (this.windows.get(card.id) !== win) return
    this.windows.delete(card.id)
    if (card.prefab) this.prefabs?.released(card.id, false)
    if (this.shuttingDown || !this.cards.has(card.id)) return
    try {
      this.afterClose(card)
    } catch (error) {
      logger.warn(
        'DesktopCards',
        __t('electron.logs.windows', '桌面卡片保存失败：{0}', [String(error)]),
      )
    }
  }

  private notify(card: DesktopCardMeta): void {
    const win = this.windowOf(card.id)
    if (win && !win.webContents.isDestroyed())
      win.webContents.send(DESKTOP_CARD_CHANNELS.changed, DesktopCardRequests.info(card))
  }
}
