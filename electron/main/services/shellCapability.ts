/**
 * @file 外壳能力（desktop.shell）
 * @description 阶段 3：角色查看并操作 infOS 自己的窗口（主窗口、已摘出的面板、卡片）与主题；
 *              不涉及其他程序，不占用键盘鼠标，也不受「桌面操作」总开关影响。
 *              - 入参在此校验，坐标越界时修正到工作区内；移动或缩放前先退出全屏/最大化，应用后读回实际位置。
 *              - 撤回：每次改动布局前记录内存快照（最近 20 份），`undo` 恢复最近一份；主题与卡片不在撤回范围内。
 *              - 宿主接口与入参校验见 `shellCapabilityModel.ts`，位置核对与复位见 `shellWindowBounds.ts`。
 *              - 窗口在操作途中被关掉：统一报 `DESKTOP_SHELL_TARGET_CLOSED`（见 `rethrowClosedWindow`）。
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 3
 * @module electron/main/services/shellCapability
 */

import type { BrowserWindow } from 'electron'
import { createHomeCard } from '../home/createHomeCard'
import {
  DESKTOP_SHELL_CHANNELS,
  DETACHABLE_PAGE_IDS,
  clampRectToArea,
  normalizeOpacity,
  normalizeShellRect,
  type DesktopShellOperation,
  type DetachedPanelPatch,
  type MainPageId,
  type ShellRect,
} from '../../../packages/shared/src/desktopShell'
import { isCustomThemeId } from '../../../packages/shared/src/customTheme'
import { CARD_MIN_SIZE, desktopCardTarget } from '../../../packages/shared/src/desktopCards'
import {
  fail,
  isLayoutChange,
  isRecord,
  pageTitle,
  readPartialRect,
  requirePage,
  resolveShellTarget,
  rethrowClosedWindow,
  type ShellTarget,
  SHELL_UNDO_LIMIT,
  type ShellHost,
  type ShellLayout,
  type ShellSnapshot,
  type ShellWindowInfo,
} from './shellCapabilityModel'
import {
  centeredRect,
  defaultWindowSize,
  placeWindow,
  restoreNormalState,
  verifyAppliedBounds,
  type AppliedCheck,
} from './shellWindowBounds'
import { nativeWindowId, nativeWindowIds } from './shellWindowIds'

export {
  SHELL_UNDO_LIMIT,
  pageTitle,
  type ShellCards,
  type ShellDesktopLayer,
  type ShellDisplay,
  type ShellHost,
  type ShellLayout,
  type ShellPanels,
  type ShellSnapshot,
  type ShellWindowInfo,
} from './shellCapabilityModel'

export class ShellCapability {
  /** 撤回快照（最新的在末尾），只保存在内存中。 */
  private readonly snapshots: ShellSnapshot[] = []

  constructor(private readonly host: ShellHost) {}

  /** 可撤回的次数（供测试与结果说明）。 */
  get undoDepth(): number {
    return this.snapshots.length
  }

  invoke(operation: string, input: unknown): Promise<unknown> {
    return this.dispatch(operation, isRecord(input) ? input : {}).catch(rethrowClosedWindow)
  }

  private async dispatch(operation: string, args: Record<string, unknown>): Promise<unknown> {
    switch (operation as DesktopShellOperation) {
      case 'layout':
        return this.layout()
      case 'detach':
        return this.recorded(() => this.detach(args))
      case 'attach':
        return this.recorded(() => this.attach(args))
      case 'setWindow':
        // amendLast：后端「摘出带位置」的第二步，与摘出合并为一次改动，不另记快照。
        // 卡片不在撤回范围内，也不记快照。
        return args.amendLast === true ||
          (typeof args.target === 'string' && args.target.startsWith('card:'))
          ? this.setWindow(args)
          : this.recorded(() => this.setWindow(args))
      case 'reset':
        return this.recorded(() => this.reset())
      case 'undo':
        return this.undo()
      case 'applyTheme':
        return this.applyTheme(args)
      case 'card':
        return this.card(args)
      case 'prefab':
        // 预制件（收纳框等）：身份已由后端注入 `__homeScope`，由预制件模块校验与分派。
        if (this.host.prefabs) return this.host.prefabs.invoke(args)
        return fail('CAPABILITY_OPERATION_UNSUPPORTED', '未知的外壳操作：{0}', [operation])
      default:
        return fail('CAPABILITY_OPERATION_UNSUPPORTED', '未知的外壳操作：{0}', [operation])
    }
  }

  async layout(): Promise<ShellLayout> {
    const detached = new Set(this.host.panels.states().map((state) => state.pageId))
    const windows: ShellWindowInfo[] = []
    const main = this.host.mainWindow()
    if (main && !main.isDestroyed()) windows.push(this.describe('main', main))
    for (const pageId of DETACHABLE_PAGE_IDS) {
      const win = this.host.panels.windowOf(pageId)
      if (win) windows.push(this.describe(`panel:${pageId}`, win))
    }
    const cards = this.host.cards.list()
    for (const card of cards) {
      const win = this.host.cards.windowOf(card.id)
      if (win) windows.push(this.describe(desktopCardTarget(card.id), win))
    }
    return {
      displays: this.host.displays(),
      windows,
      pages: DETACHABLE_PAGE_IDS.map((id) => ({
        id,
        title: pageTitle(id),
        detached: detached.has(id),
      })),
      cards: cards.map(({ id, name, saved, open }) => ({ id, name, saved, open })),
      theme: { mode: this.host.themeMode(), custom: await this.host.readCustomTheme() },
    }
  }

  private describe(id: string, win: BrowserWindow): ShellWindowInfo {
    const page = id.startsWith('panel:') ? (id.slice(6) as MainPageId) : undefined
    const card = id.startsWith('card:') ? id.slice(5) : undefined
    return {
      id,
      kind: page ? 'panel' : card ? 'card' : 'main',
      ...(page ? { page } : {}),
      ...(card ? { card } : {}),
      title: page
        ? pageTitle(page)
        : card
          ? (this.host.cards.list().find((item) => item.id === card)?.name ?? card)
          : 'infOS',
      bounds: win.getBounds(),
      focused: win.isFocused(),
      minimized: win.isMinimized(),
      alwaysOnTop: win.isAlwaysOnTop(),
      opacity: Math.round(win.getOpacity() * 100) / 100,
      desktopLayer: this.host.desktopLayer?.isPinned(win) ?? false,
    }
  }

  private async detach(args: Record<string, unknown>) {
    const pageId = requirePage(args.pageId)
    const already = this.host.panels.states().some((state) => state.pageId === pageId)
    if (already) {
      this.host.panels.focus(pageId)
      return { changed: false, page: pageId, window: this.panelInfo(pageId) }
    }
    const rect = normalizeShellRect(args.bounds)
    const bounds = rect ? clampRectToArea(rect, this.host.workAreaNear(rect)) : undefined
    this.host.panels.detach({ pageId, ...(bounds ? { bounds } : {}) })
    return {
      changed: true,
      page: pageId,
      previous: { detached: false },
      window: this.panelInfo(pageId),
    }
  }

  private panelInfo(pageId: MainPageId): ShellWindowInfo | null {
    const win = this.host.panels.windowOf(pageId)
    return win ? this.describe(`panel:${pageId}`, win) : null
  }

  private async attach(args: Record<string, unknown>) {
    const pageId = requirePage(args.pageId)
    const previous = this.panelInfo(pageId)
    const detached = this.host.panels.states().some((state) => state.pageId === pageId)
    if (!detached && !previous) return { changed: false, page: pageId }
    if (!(await this.host.panels.attachGracefully(pageId)))
      fail('DESKTOP_SHELL_UNSAVED', '面板有未保存的修改，已保持打开；请用户先保存或放弃修改')
    return { changed: true, page: pageId, previous: { detached: true, window: previous } }
  }

  /** infOS 自有窗口 ID → 十进制 HWND；与截图、窗口列表共用（见 shellWindowIds.ts）。 */
  nativeWindowId(target: string): string {
    return nativeWindowId(this.host, target)
  }

  nativeWindowIds(): Map<string, string> {
    return nativeWindowIds(this.host)
  }

  private resolveTarget(value: unknown): ShellTarget {
    return resolveShellTarget(this.host, value)
  }

  private async setWindow(args: Record<string, unknown>) {
    const target = this.resolveTarget(args.target)
    const rect = readPartialRect(args.bounds)
    const alwaysOnTop = typeof args.alwaysOnTop === 'boolean' ? args.alwaysOnTop : undefined
    if (args.alwaysOnTop !== undefined && alwaysOnTop === undefined)
      fail('DESKTOP_SHELL_INVALID_PATCH', '没有可修改的窗口属性')
    if (
      args.opacity !== undefined &&
      (typeof args.opacity !== 'number' ||
        !Number.isFinite(args.opacity) ||
        args.opacity < 0 ||
        args.opacity > 1)
    )
      fail('DESKTOP_SHELL_INVALID_PATCH', '没有可修改的窗口属性')
    const opacity = args.opacity === undefined ? undefined : normalizeOpacity(args.opacity)
    const focus = args.focus === true
    const recover = args.recover === true
    const desktopLayer = typeof args.desktopLayer === 'boolean' ? args.desktopLayer : undefined
    if (args.desktopLayer !== undefined && desktopLayer === undefined)
      fail('DESKTOP_SHELL_INVALID_PATCH', '没有可修改的窗口属性')
    if (
      !rect &&
      !recover &&
      alwaysOnTop === undefined &&
      opacity === undefined &&
      !focus &&
      desktopLayer === undefined
    )
      fail('DESKTOP_SHELL_INVALID_PATCH', '没有可修改的窗口属性')

    const { win, page, card } = target
    if (desktopLayer !== undefined && !page && !card)
      fail('DESKTOP_SHELL_INVALID_TARGET', '只有桌面面板和卡片可以贴到桌面')
    const previous = this.describe(target.id, win)
    const changed: string[] = []
    // 先处理取消贴底，之后才能移动；开启贴底放在最后（贴底后不能再移动）。
    // 卡片的贴底设置可能与窗口状态不同（上次挂接失败），取消时总是写回设置。
    if (desktopLayer === false && (previous.desktopLayer || card))
      this.setDesktopLayer(target, false)
    if ((rect || recover) && previous.desktopLayer && desktopLayer !== false)
      fail('DESKTOP_SHELL_PINNED', '窗口贴在桌面上，请先取消贴到桌面再移动或缩放')
    let restoredFrom: string[] = []
    let verification: AppliedCheck<ShellRect> | undefined
    if (rect || recover) {
      // 全屏或最大化时 setBounds 不生效：先恢复为普通窗口，再以恢复后的位置为基准。
      restoredFrom = await restoreNormalState(win)
      const base = restoredFrom.length ? win.getBounds() : previous.bounds
      const merged = recover
        ? centeredRect(defaultWindowSize(target), this.host.workAreaNear(base))
        : normalizeShellRect({ ...base, ...rect }, card ? CARD_MIN_SIZE : undefined)
      if (!merged) fail('DESKTOP_SHELL_INVALID_BOUNDS', '窗口位置或大小无效')
      const expected = card
        ? this.host.cards.place(card, merged)
        : clampRectToArea(merged, this.host.workAreaNear(merged))
      if (!card) win.setBounds(expected)
      // 读回实际位置，没生效时抛出带原因的错误，不报告虚假的成功。
      verification = verifyAppliedBounds(win, expected)
      changed.push('bounds')
    }
    if (alwaysOnTop !== undefined || opacity !== undefined) {
      const patch: DetachedPanelPatch = {
        ...(alwaysOnTop !== undefined ? { alwaysOnTop } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
      }
      // 面板的置顶与透明度经 DetachedPanels 修改，以便保存到布局。
      if (page) this.host.panels.set(page, patch)
      else if (card) this.host.cards.set(card, patch)
      else {
        if (patch.alwaysOnTop !== undefined) win.setAlwaysOnTop(patch.alwaysOnTop)
        if (patch.opacity !== undefined) win.setOpacity(patch.opacity)
      }
      if (alwaysOnTop !== undefined) changed.push('alwaysOnTop')
      if (opacity !== undefined) changed.push('opacity')
    }
    if (desktopLayer === true && !previous.desktopLayer) this.setDesktopLayer(target, true)
    if (desktopLayer !== undefined && desktopLayer !== previous.desktopLayer)
      changed.push('desktopLayer')
    if (focus) {
      if (page) this.host.panels.focus(page)
      else {
        if (win.isMinimized()) win.restore()
        if (!win.isVisible()) win.show()
        win.focus()
      }
      changed.push('focus')
    }
    return {
      target: target.id,
      changed,
      ...(restoredFrom.length ? { restoredFrom } : {}),
      ...(verification ? { verification } : {}),
      previous,
      current: this.describe(target.id, win),
    }
  }

  /** 贴底或取消；卡片的设置会保存，面板只在本次运行内有效。不支持时抛错，窗口保持原样。 */
  private setDesktopLayer(
    target: { win: BrowserWindow; page?: MainPageId; card?: string },
    enabled: boolean,
  ): void {
    if (target.card) {
      if (!this.host.desktopLayer)
        fail(
          'DESKTOP_SHELL_LAYER_UNAVAILABLE',
          '无法贴到桌面：只支持 Windows，或没有找到桌面图标层',
        )
      this.host.cards.setDesktopLayer(target.card, enabled)
      return
    }
    if (!this.host.desktopLayer?.set(target.win, enabled))
      fail('DESKTOP_SHELL_LAYER_UNAVAILABLE', '无法贴到桌面：只支持 Windows，或没有找到桌面图标层')
  }

  private async reset() {
    const previous = this.host.panels.states().map((state) => state.pageId)
    const { remaining } = await this.host.panels.reset()
    return { changed: previous.length > 0, previous: { detached: previous }, remaining }
  }

  private async applyTheme(args: Record<string, unknown>) {
    const themeId = args.themeId ?? ''
    if (themeId !== '' && !isCustomThemeId(themeId))
      fail('DESKTOP_SHELL_INVALID_THEME', '主题 ID 无效：{0}', [String(themeId)])
    const previous = await this.host.readCustomTheme()
    // 广播到 infOS 的全部窗口，由前端 useCustomTheme().select 应用（含主题声明的深浅模式）。
    const targets = new Set<BrowserWindow>(this.host.panels.openWindows())
    const main = this.host.mainWindow()
    if (main) targets.add(main)
    for (const win of targets) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send(DESKTOP_SHELL_CHANNELS.customTheme, themeId)
    }
    return { changed: previous !== themeId, previous, current: themeId }
  }

  // ─── 卡片（阶段 4） ────────────────────────────────

  private cardWindow(id: string): ShellWindowInfo | null {
    const win = this.host.cards.windowOf(id)
    return win ? this.describe(desktopCardTarget(id), win) : null
  }

  /** 卡片操作；参数在 DesktopCards 中校验（名称、HTML 大小、位置）。 */
  private async card(args: Record<string, unknown>) {
    const cards = this.host.cards
    const action = args.action
    if (action === 'list') return { cards: cards.list() }
    if (action === 'create') {
      const card = await createHomeCard(cards, args)
      return { changed: true, card, window: this.cardWindow(card.id) }
    }
    if (action === 'read') return cards.read(args.cardId)
    const before = cards.read(args.cardId).card
    const id = before.id
    switch (action) {
      case 'update': {
        const card = cards.update(id, args)
        return {
          changed: true,
          card,
          previous: { name: before.name, updatedAt: before.updatedAt },
        }
      }
      case 'save': {
        const saved = args.saved !== false
        const card = cards.save(id, saved)
        return { changed: before.saved !== saved, card, previous: { saved: before.saved } }
      }
      case 'open': {
        const card = cards.show(id)
        return { changed: !before.open, card, window: this.cardWindow(id) }
      }
      case 'close': {
        if (!before.open) return { changed: false, card: before }
        // 未收藏的卡片关闭后进「最近关闭」：deleted 恒为 false，recentlyClosed 为 true。
        return { changed: true, ...cards.close(id), previous: { open: true, saved: before.saved } }
      }
      case 'delete': {
        cards.remove(id)
        return {
          changed: true,
          deleted: true,
          previous: { open: before.open, saved: before.saved },
        }
      }
      default:
        return fail('DESKTOP_SHELL_INVALID_PATCH', '不支持的卡片操作：{0}', [String(action)])
    }
  }

  // ─── 撤回 ──────────────────────────────────────────

  /** 记录改动前的布局；操作失败或没有变化时不记录。 */
  private async recorded<T>(operation: () => Promise<T>): Promise<T> {
    const snapshot = this.capture()
    const result = await operation()
    if (isLayoutChange(result)) {
      this.snapshots.push(snapshot)
      if (this.snapshots.length > SHELL_UNDO_LIMIT) this.snapshots.shift()
    }
    return result
  }

  private capture(): ShellSnapshot {
    const main = this.host.mainWindow()
    return {
      main: main && !main.isDestroyed() ? main.getBounds() : null,
      panels: this.host.panels.states().map((state) => {
        const win = this.host.panels.windowOf(state.pageId)
        return {
          pageId: state.pageId,
          bounds: win && !win.isDestroyed() ? win.getBounds() : null,
          alwaysOnTop: state.alwaysOnTop,
          opacity: state.opacity,
        }
      }),
    }
  }

  /**
   * 恢复最近一份快照：先合回快照中没有的面板（尊重未保存修改，失败时保留快照并报错），
   * 再摘出快照中有的面板，最后恢复位置、置顶、透明度与主窗口位置。
   */
  private async undo() {
    const snapshot = this.snapshots.at(-1)
    if (!snapshot)
      fail(
        'DESKTOP_SHELL_NOTHING_TO_UNDO',
        '没有可撤回的外壳改动（只记录本次运行中角色的窗口改动，不含主题）',
      )
    const previous = this.capture()
    const wanted = new Map(snapshot.panels.map((panel) => [panel.pageId, panel]))
    const steps: string[] = []

    for (const { pageId } of previous.panels) {
      if (wanted.has(pageId)) continue
      if (!(await this.host.panels.attachGracefully(pageId)))
        fail(
          'DESKTOP_SHELL_UNSAVED',
          '面板 {0} 有未保存的修改，撤回已停止；请用户先保存或放弃修改后再撤回',
          [pageTitle(pageId)],
        )
      steps.push(`attach:${pageId}`)
    }

    const open = new Set(this.host.panels.states().map((state) => state.pageId))
    for (const panel of snapshot.panels) {
      const { pageId } = panel
      if (!open.has(pageId)) {
        const bounds = panel.bounds
          ? clampRectToArea(panel.bounds, this.host.workAreaNear(panel.bounds))
          : undefined
        this.host.panels.detach({ pageId, ...(bounds ? { bounds } : {}) })
        steps.push(`detach:${pageId}`)
      } else if (panel.bounds) {
        const win = this.host.panels.windowOf(pageId)
        if (win && placeWindow(win, panel.bounds, (rect) => this.host.workAreaNear(rect)))
          steps.push(`bounds:${pageId}`)
      }
      const state = this.host.panels.states().find((item) => item.pageId === pageId)
      const patch: DetachedPanelPatch = {
        ...(state?.alwaysOnTop !== panel.alwaysOnTop ? { alwaysOnTop: panel.alwaysOnTop } : {}),
        ...(state?.opacity !== panel.opacity ? { opacity: panel.opacity } : {}),
      }
      if (state && Object.keys(patch).length) {
        this.host.panels.set(pageId, patch)
        steps.push(`set:${pageId}`)
      }
    }

    const main = this.host.mainWindow()
    if (
      snapshot.main &&
      main &&
      !main.isDestroyed() &&
      placeWindow(main, snapshot.main, (rect) => this.host.workAreaNear(rect))
    )
      steps.push('bounds:main')

    this.snapshots.pop()
    return {
      changed: steps.length > 0,
      steps,
      previous,
      current: this.capture(),
      remaining: this.snapshots.length,
    }
  }
}
