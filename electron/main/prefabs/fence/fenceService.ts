/**
 * @file 桌面收纳框（预制件 fence）的主进程服务：框的增删改、项目登记、启动、图标、文件夹监视与窗口形状。
 *
 *       - 框是卡片系统里的一种预制件卡片：位置、置顶、贴底、关闭与删除沿用 DesktopCards；
 *         框自己的状态（折叠、图标大小、排序、登记项、映射文件夹）存在 card.json 的 prefab.state。
 *       - 只登记路径引用：不移动、不复制、不删除用户文件；删除框只删卡片自己的文件夹。
 *       - 启动只按项目 ID 反查本框当前的条目，页面不能传路径；每个框每分钟最多启动 20 次。
 *       - 拖出同样只按项目 ID 反查，不改动文件；能不能放下、是复制还是引用由目标决定。
 *
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type { BrowserWindow, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_FENCE_STATE,
  DESKTOP_PREFAB_CHANNELS,
  FENCE_ICON_PIXELS,
  FENCE_LIMITS,
  addFenceItems,
  arrangeFences,
  createDesktopPrefabMeta,
  fenceBaseName,
  fenceGestureBounds,
  fenceWindowRect,
  isFenceItemId,
  normalizeFencePath,
  normalizeFenceState,
  removeFenceItems,
  reorderFenceItems,
  type DesktopCardMeta,
  type FenceCreator,
  type FenceGesture,
  type FenceIconSize,
  type FenceLayout,
  type FenceSort,
  type FenceState,
  type FenceView,
} from '../../../../packages/shared/src/desktopCards'
import type { ShellRect } from '../../../../packages/shared/src/desktopShell'
import { fail } from '../../windows/desktopCardModel'
import type { DesktopCards } from '../../windows/desktopCardManager'
import {
  resolveFenceEntries,
  viewItems,
  type FenceEntry,
  type FenceFileSystem,
} from './fenceEntries'
import { isFenceDragBlocked } from './fenceDrag'
import { FenceIcons, type FenceIconSource } from './fenceIcons'

export type FenceCards = Pick<
  DesktopCards,
  | 'create'
  | 'get'
  | 'close'
  | 'list'
  | 'windowOf'
  | 'update'
  | 'set'
  | 'setDesktopLayer'
  | 'remove'
  | 'writePrefab'
  | 'place'
  | 'commitWindowBounds'
>

/** 收纳框用到的系统能力；生产环境由 Electron 提供（见 fenceSystem.ts），测试中替换。 */
export interface FenceSystem extends FenceFileSystem, FenceIconSource {
  /** 用系统默认方式打开；返回错误说明，成功时为空字符串（同 `shell.openPath`）。 */
  openPath(target: string): Promise<string>
  /** 监视文件夹（不递归）；返回停止函数。 */
  watch(folder: string, listener: () => void): () => void
  /**
   * 发起系统文件拖拽；icon 是 data URL，空时用内置图标（Electron 要求图标非空）。
   * Windows 上要等拖拽结束才返回。
   */
  startDrag(contents: Pick<WebContents, 'startDrag'>, file: string, icon: string | null): void
}

export interface FenceCreateInput {
  title: string
  bounds?: Record<string, number>
  items?: readonly unknown[]
  folder?: string
  alwaysOnTop?: boolean
  collapsed?: boolean
  iconSize?: FenceIconSize
  sort?: FenceSort
  backgroundOpacity?: number
  createdBy: FenceCreator
}

export type FenceSkipped = { path: string; reason: 'invalid' | 'duplicate' | 'limit' | 'missing' }

/** 文件夹变化后等这么久再刷新，合并连续的改动。 */
const WATCH_DEBOUNCE_MS = 400
/** 读图标时共用同一份条目列表的时长。 */
const ICON_LOOKUP_TTL_MS = 2000
/** 缩略图按显示尺寸的 2 倍生成，200% 缩放的屏幕上也清晰。 */
const THUMBNAIL_SCALE = 2
/** 拖拽要趁鼠标还按着发起，图标最多各等这么久，没好就用下一档。 */
const DRAG_ICON_WAIT_MS = 150

interface IconLookup {
  at: number
  entries: Map<string, FenceEntry>
  thumbnailPixels: number
}

export class DesktopFences {
  readonly icons: FenceIcons
  private readonly watchers = new Map<string, () => void>()
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly launches = new Map<string, number[]>()
  private readonly drags = new Map<string, number[]>()
  /** 系统拖拽是嵌套的消息循环，同一时间只允许一个。 */
  private dragActive = false
  private readonly iconLookups = new Map<string, IconLookup>()
  /** 进行中的移动或缩放：手势种类、开始时的窗口位置、是否折叠。 */
  private readonly gestures = new Map<
    string,
    { gesture: FenceGesture; start: ShellRect; collapsed: boolean }
  >()

  constructor(
    private readonly cards: FenceCards,
    private readonly system: FenceSystem,
    private readonly labels: () => Record<string, string> = () => ({}),
    private readonly now: () => number = Date.now,
  ) {
    this.icons = new FenceIcons(system, system)
  }

  // ─── 查询 ──────────────────────────────────────────

  isFence(id: unknown): boolean {
    try {
      return this.cards.get(id).prefab?.kind === 'fence'
    } catch {
      return false
    }
  }

  /** 收纳框卡片；不是收纳框时报错。 */
  card(id: unknown): DesktopCardMeta {
    const card = this.cards.get(id)
    if (card.prefab?.kind !== 'fence')
      fail('DESKTOP_PREFAB_KIND', '这张卡片不是收纳框：{0}', [card.id])
    return card
  }

  state(id: unknown): FenceState {
    return normalizeFenceState(this.card(id).prefab!.state)
  }

  entries(id: unknown): FenceEntry[] {
    return resolveFenceEntries(this.state(id), this.system)
  }

  /** 页面视图：不含任何路径。 */
  view(id: unknown): FenceView {
    const card = this.card(id)
    const state = this.state(card.id)
    return {
      kind: 'fence',
      title: card.name,
      collapsed: state.collapsed,
      alwaysOnTop: card.alwaysOnTop,
      desktopLayer: card.desktopLayer,
      iconSize: state.iconSize,
      sort: state.sort,
      backgroundOpacity: state.backgroundOpacity,
      ...(state.folder ? { folderName: fenceBaseName(state.folder) } : {}),
      items: viewItems(this.entries(card.id)),
      labels: this.labels(),
    }
  }

  /** 给 Agent 的摘要：含路径（她本来就能读桌面上有什么），不含图标。 */
  summary(id: unknown): Record<string, unknown> {
    const card = this.card(id)
    const state = this.state(card.id)
    return {
      fenceId: card.id,
      title: card.name,
      open: this.cards.windowOf(card.id) !== undefined,
      collapsed: state.collapsed,
      alwaysOnTop: card.alwaysOnTop,
      desktopLayer: card.desktopLayer,
      ...(card.bounds ? { bounds: card.bounds } : {}),
      iconSize: state.iconSize,
      sort: state.sort,
      backgroundOpacity: state.backgroundOpacity,
      ...(state.folder ? { folder: state.folder } : {}),
      items: this.entries(card.id).map(({ path, name, kind, missing, fromFolder }) => ({
        path,
        name,
        kind,
        missing,
        fromFolder,
      })),
    }
  }

  list(): Record<string, unknown>[] {
    return this.cards
      .list()
      .filter((card) => card.prefab?.kind === 'fence')
      .map((card) => this.summary(card.id))
  }

  // ─── 修改 ──────────────────────────────────────────

  private write(id: string, state: FenceState): void {
    this.iconLookups.delete(id)
    this.cards.writePrefab(id, { ...state })
    this.push(id)
  }

  /** 只登记本机存在的路径；其余说明原因跳过。 */
  private existing(paths: readonly unknown[]): { paths: string[]; skipped: FenceSkipped[] } {
    const kept: string[] = []
    const skipped: FenceSkipped[] = []
    for (const raw of paths) {
      const target = normalizeFencePath(raw)
      if (!target) skipped.push({ path: String(raw ?? ''), reason: 'invalid' })
      else if (!this.system.stat(target)) skipped.push({ path: target, reason: 'missing' })
      else kept.push(target)
    }
    return { paths: kept, skipped }
  }

  private requireFolder(value: unknown): string {
    const folder = normalizeFencePath(value)
    if (!folder || !this.system.stat(folder)?.isDirectory)
      fail('DESKTOP_FENCE_INVALID_FOLDER', '文件夹不存在或不能映射：{0}', [String(value ?? '')])
    return folder
  }

  private newItemId = () => `i-${randomUUID().replace(/-/g, '').slice(0, 12)}`

  create(input: FenceCreateInput): { card: DesktopCardMeta; skipped: FenceSkipped[] } {
    const folder = input.folder === undefined ? undefined : this.requireFolder(input.folder)
    const { paths, skipped } = this.existing(input.items ?? [])
    const added = addFenceItems(
      { ...DEFAULT_FENCE_STATE, items: [] },
      paths,
      this.newItemId,
      new Date(this.now()).toISOString(),
    )
    const state: FenceState = {
      ...added.state,
      collapsed: input.collapsed === true,
      iconSize: input.iconSize ?? DEFAULT_FENCE_STATE.iconSize,
      sort: input.sort ?? DEFAULT_FENCE_STATE.sort,
      backgroundOpacity: input.backgroundOpacity ?? DEFAULT_FENCE_STATE.backgroundOpacity,
      ...(folder ? { folder } : {}),
      createdBy: input.createdBy,
    }
    const card = this.cards.create({
      name: input.title,
      ...(input.bounds ? { bounds: input.bounds } : {}),
      alwaysOnTop: input.alwaysOnTop === true,
      prefab: createDesktopPrefabMeta('fence', state),
    })
    return { card, skipped: [...skipped, ...added.skipped] }
  }

  /** 标题栏的关闭按钮：和 Ctrl/Cmd+W 走同一条卡片关闭通路，框保留，可从卡片页重新打开。 */
  close(id: unknown): void {
    this.cards.close(this.card(id).id)
  }

  rename(id: unknown, title: unknown): void {
    const card = this.card(id)
    this.cards.update(card.id, { name: title })
    this.push(card.id)
  }

  setCollapsed(id: unknown, collapsed: boolean): void {
    const card = this.card(id)
    this.gestures.delete(card.id)
    this.write(card.id, { ...this.state(card.id), collapsed })
    const win = this.cards.windowOf(card.id)
    if (!win) return
    // 贴在桌面上的窗口坐标相对桌面图标层，只改高度、不改位置。
    if (card.desktopLayer) {
      const bounds = this.windowBounds(card, card.bounds ?? win.getBounds())
      win.setSize(bounds.width, bounds.height)
    } else if (card.bounds) win.setBounds(this.windowBounds(card, card.bounds))
  }

  /** 始终置顶与贴在桌面互斥：置顶时先取消贴底，贴底时先取消置顶。 */
  setPinned(id: unknown, alwaysOnTop: boolean): void {
    const card = this.card(id)
    if (alwaysOnTop && card.desktopLayer) this.cards.setDesktopLayer(card.id, false)
    this.cards.set(card.id, { alwaysOnTop })
    this.push(card.id)
  }

  setLayer(id: unknown, enabled: boolean): void {
    const card = this.card(id)
    this.gestures.delete(card.id)
    if (enabled && card.alwaysOnTop) this.cards.set(card.id, { alwaysOnTop: false })
    this.cards.setDesktopLayer(card.id, enabled)
    this.push(card.id)
  }

  setIconSize(id: unknown, iconSize: FenceIconSize): void {
    const card = this.card(id)
    this.write(card.id, { ...this.state(card.id), iconSize })
  }

  setSort(id: unknown, sort: FenceSort): void {
    const card = this.card(id)
    this.write(card.id, { ...this.state(card.id), sort })
  }

  /** 背景透明度（已由调用方校验范围）：只改框的背景和标题栏，由页面按视图绘制。 */
  setBackgroundOpacity(id: unknown, backgroundOpacity: number): void {
    const card = this.card(id)
    this.write(card.id, { ...this.state(card.id), backgroundOpacity })
  }

  /** 映射或取消映射文件夹（null 取消）；只读取文件夹内容，不改动它。 */
  setFolder(id: unknown, folder: string | null): void {
    const card = this.card(id)
    const { folder: _old, ...rest } = this.state(card.id)
    const next: FenceState =
      folder === null ? rest : { ...rest, folder: this.requireFolder(folder) }
    this.write(card.id, next)
    this.stopWatch(card.id)
    if (next.folder && this.cards.windowOf(card.id)) this.startWatch(card.id, next.folder)
  }

  add(id: unknown, paths: readonly unknown[]): { added: string[]; skipped: FenceSkipped[] } {
    const card = this.card(id)
    const checked = this.existing(paths)
    const result = addFenceItems(
      this.state(card.id),
      checked.paths,
      this.newItemId,
      new Date(this.now()).toISOString(),
    )
    if (result.added.length) this.write(card.id, result.state)
    return {
      added: result.added.map((item) => item.path),
      skipped: [...checked.skipped, ...result.skipped],
    }
  }

  /** 移出登记项（按项目 ID 或路径）；只改登记表，不碰文件。 */
  remove(id: unknown, refs: readonly string[]): string[] {
    const card = this.card(id)
    const result = removeFenceItems(this.state(card.id), refs)
    if (result.removed.length) this.write(card.id, result.state)
    return result.removed.map((item) => item.path)
  }

  reorder(id: unknown, refs: readonly string[]): void {
    const card = this.card(id)
    this.write(card.id, reorderFenceItems(this.state(card.id), refs))
  }

  /**
   * 把多个框排成一组：从 origin（默认第一个框的位置）开始竖排、横排或网格。
   * 贴在桌面上的框不能移动，跳过并在结果里说明。
   */
  arrange(
    ids: readonly unknown[],
    layout: FenceLayout,
    origin?: { x: number; y: number },
    gap?: number,
    columns?: number,
  ): { placed: { fenceId: string; bounds: ShellRect }[]; skipped: string[] } {
    const fences = ids.map((id) => this.card(id))
    const movable = fences.filter((card) => !card.desktopLayer && this.cards.windowOf(card.id))
    const skipped = fences.filter((card) => !movable.includes(card)).map((card) => card.id)
    const sized = movable.map((card) => {
      const window = this.cards.windowOf(card.id)!.getBounds()
      return { card, bounds: card.bounds ?? window, height: window.height }
    })
    const start = origin ?? (sized[0] ? { x: sized[0].bounds.x, y: sized[0].bounds.y } : undefined)
    if (!start) return { placed: [], skipped }
    const spots = arrangeFences(
      sized.map(({ card, bounds, height }) => ({ id: card.id, width: bounds.width, height })),
      layout,
      start,
      gap,
      columns,
    )
    const placed = spots.map((spot, index) => {
      const { bounds } = sized[index]!
      this.cards.place(spot.id, { ...bounds, x: spot.x, y: spot.y })
      return { fenceId: spot.id, bounds: this.cards.get(spot.id).bounds! }
    })
    return { placed, skipped }
  }

  /** 删除框：只删除框本身（卡片文件夹），引用的文件一律不碰。 */
  delete(id: unknown): void {
    this.cards.remove(this.card(id).id)
  }

  // ─── 启动与图标 ─────────────────────────────────────

  private entry(id: unknown, itemId: unknown): FenceEntry {
    const card = this.card(id)
    // 页面只能传项目 ID；路径或其他框的项目都找不到。
    const entry = isFenceItemId(itemId)
      ? this.entries(card.id).find((item) => item.id === itemId)
      : undefined
    if (!entry) fail('DESKTOP_FENCE_ITEM_NOT_FOUND', '收纳框里没有这个项目')
    return entry
  }

  async launch(id: unknown, itemId: unknown): Promise<void> {
    const entry = this.entry(id, itemId)
    if (!this.system.stat(entry.path))
      fail('DESKTOP_FENCE_ITEM_MISSING', '找不到原文件：{0}', [entry.name])
    const key = this.card(id).id
    const now = this.now()
    const recent = (this.launches.get(key) ?? []).filter((time) => now - time < 60_000)
    if (recent.length >= FENCE_LIMITS.launchesPerMinute)
      fail('DESKTOP_FENCE_RATE_LIMITED', '启动得太频繁了，请稍后再试')
    this.launches.set(key, [...recent, now])
    const error = await this.system.openPath(entry.path)
    if (error) fail('DESKTOP_FENCE_LAUNCH_FAILED', '打不开：{0}', [error])
  }

  /**
   * 把项目作为系统文件拖出去。页面只能传项目 ID：路径在本框当前条目里反查，
   * 伪造的路径和别的框的 ID 都找不到。隐藏和受保护的文件不允许，文件本身不做任何改动。
   */
  async dragOut(id: unknown, itemId: unknown): Promise<void> {
    const entry = this.entry(id, itemId)
    const card = this.card(id)
    if (!this.system.stat(entry.path))
      fail('DESKTOP_FENCE_ITEM_MISSING', '找不到原文件：{0}', [entry.name])
    if (isFenceDragBlocked(entry.path, this.system))
      fail('DESKTOP_FENCE_ITEM_PROTECTED', '这个文件不能拖出去：{0}', [entry.name])
    if (this.dragActive) fail('DESKTOP_FENCE_DRAG_BUSY', '已经在拖动了')
    const now = this.now()
    const recent = (this.drags.get(card.id) ?? []).filter((time) => now - time < 60_000)
    if (recent.length >= FENCE_LIMITS.dragsPerMinute)
      fail('DESKTOP_FENCE_RATE_LIMITED', '拖动得太频繁了，请稍后再试')
    this.drags.set(card.id, [...recent, now])
    const win = this.cards.windowOf(card.id)
    if (!win) fail('DESKTOP_CARD_CLOSED', '卡片没有打开：{0}', [card.id])
    this.dragActive = true
    try {
      const icon = await this.dragIcon(entry, card.id)
      if (!win.webContents.isDestroyed()) this.system.startDrag(win.webContents, entry.path, icon)
    } finally {
      this.dragActive = false
    }
  }

  /** 拖拽图标：图片先用缩略图，再用系统图标；页面已经要过，通常直接命中缓存。 */
  private async dragIcon(entry: FenceEntry, id: string): Promise<string | null> {
    const soon = (loading: Promise<string | null>) =>
      Promise.race([
        loading.catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), DRAG_ICON_WAIT_MS)),
      ])
    const pixels = FENCE_ICON_PIXELS[this.state(id).iconSize] * THUMBNAIL_SCALE
    const thumbnail = entry.thumbnail ? await soon(this.icons.thumbnail(entry.path, pixels)) : null
    return thumbnail ?? soon(this.icons.icon(entry.path))
  }

  /**
   * 按项目 ID 读图标，`variant` 为 `thumbnail` 时读图片缩略图（大小按框的图标档位）。
   * 路径同样由主进程反查，页面传不了路径。
   */
  icon(id: unknown, itemId: unknown, variant?: unknown): Promise<string | null> {
    const lookup = this.iconLookup(id, itemId)
    const entry = lookup.entries.get(itemId as string)
    if (!entry) fail('DESKTOP_FENCE_ITEM_NOT_FOUND', '收纳框里没有这个项目')
    return variant === 'thumbnail'
      ? this.icons.thumbnail(entry.path, lookup.thumbnailPixels)
      : this.icons.icon(entry.path)
  }

  /**
   * 页面打开时会一次要几百个图标。每次都重新列文件夹就是「项目数的平方」次 stat，会卡主进程，
   * 所以短时间内共用一份列表；框的状态变化时清掉，找不到项目时也立刻重新读一次。
   */
  private iconLookup(id: unknown, itemId: unknown): IconLookup {
    const card = this.card(id)
    const cached = this.iconLookups.get(card.id)
    if (
      cached &&
      this.now() - cached.at < ICON_LOOKUP_TTL_MS &&
      cached.entries.has(itemId as string)
    )
      return cached
    const entries = isFenceItemId(itemId) ? this.entries(card.id) : []
    const lookup: IconLookup = {
      at: this.now(),
      entries: new Map(entries.map((entry) => [entry.id, entry])),
      thumbnailPixels: FENCE_ICON_PIXELS[this.state(card.id).iconSize] * THUMBNAIL_SCALE,
    }
    this.iconLookups.set(card.id, lookup)
    return lookup
  }

  // ─── 页面内的窗口手势（发送者身份由 IPC 层确认） ──────

  /**
   * 开始移动或缩放：记下窗口当前位置作为起点。之后每次都用「起点 + 累计增量」计算，
   * 不在当前值上累加，混合 DPI 下尺寸不会越拖越偏。贴在桌面上时坐标系不同，不能拖动。
   */
  beginGesture(id: unknown, gesture: FenceGesture): void {
    const card = this.card(id)
    const win = this.cards.windowOf(card.id)
    if (!win) fail('DESKTOP_CARD_CLOSED', '卡片没有打开：{0}', [card.id])
    if (card.desktopLayer)
      fail('DESKTOP_CARD_PINNED', '卡片贴在桌面上，请先取消贴到桌面再移动或缩放')
    const collapsed = this.state(card.id).collapsed
    this.gestures.set(card.id, { gesture, start: win.getBounds(), collapsed })
  }

  /** 没有进行中的手势时忽略（例如手势途中被折叠、贴底或窗口重建）。 */
  updateGesture(id: unknown, dx: number, dy: number): void {
    const card = this.card(id)
    const active = this.gestures.get(card.id)
    const win = this.cards.windowOf(card.id)
    if (!active || !win || win.isDestroyed()) return
    win.setBounds(fenceGestureBounds(active.start, active.gesture, dx, dy, active.collapsed))
  }

  /** 结束手势：应用最终位置并立即写盘，不只依赖窗口的 move / resize 事件。 */
  endGesture(id: unknown, dx: number, dy: number): void {
    const card = this.card(id)
    if (!this.gestures.has(card.id)) return
    this.updateGesture(card.id, dx, dy)
    this.gestures.delete(card.id)
    this.cards.commitWindowBounds(card.id)
  }

  // ─── 窗口钩子（经 DesktopPrefabs 调用） ──────────────

  opened(card: DesktopCardMeta, _win: BrowserWindow): void {
    const state = this.state(card.id)
    if (state.folder) this.startWatch(card.id, state.folder)
  }

  released(id: string): void {
    this.stopWatch(id)
    this.launches.delete(id)
    this.drags.delete(id)
    this.gestures.delete(id)
    this.iconLookups.delete(id)
  }

  /** 折叠时窗口只有标题栏，保存的仍是展开时的高度。 */
  persistBounds(card: DesktopCardMeta, rect: ShellRect): ShellRect {
    if (!this.collapsed(card)) return rect
    return { ...rect, height: card.bounds?.height ?? rect.height }
  }

  windowBounds(card: DesktopCardMeta, rect: ShellRect): ShellRect {
    return fenceWindowRect(rect, this.collapsed(card))
  }

  private collapsed(card: DesktopCardMeta): boolean {
    return normalizeFenceState(card.prefab?.state).collapsed
  }

  /** 把最新视图推给框的页面。 */
  push(id: string): void {
    const win = this.cards.windowOf(id)
    if (!win || win.webContents.isDestroyed() || !this.isFence(id)) return
    win.webContents.send(DESKTOP_PREFAB_CHANNELS.changed, this.view(id))
  }

  private startWatch(id: string, folder: string): void {
    this.stopWatch(id)
    try {
      this.watchers.set(
        id,
        this.system.watch(folder, () => {
          clearTimeout(this.refreshTimers.get(id))
          this.refreshTimers.set(
            id,
            setTimeout(() => {
              this.refreshTimers.delete(id)
              this.push(id)
            }, WATCH_DEBOUNCE_MS),
          )
        }),
      )
    } catch {
      // 文件夹暂时不可用（例如移动硬盘拔出）：不监视，打开时按当时内容显示。
    }
  }

  private stopWatch(id: string): void {
    this.watchers.get(id)?.()
    this.watchers.delete(id)
    clearTimeout(this.refreshTimers.get(id))
    this.refreshTimers.delete(id)
  }
}
