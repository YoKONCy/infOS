/**
 * @file 桌面预制件（受信任的内置卡片）的主进程注册表与分派。
 *
 *       - 实现 DesktopCards 的预制件钩子：页面文档、窗口打开 / 释放、位置换算；
 *       - 按注册表声明的能力开放功能：未声明 `fullscreen-yield` 的预制件不参与全屏让开，
 *         未声明 `file-icons` 的不能读图标，以此类推；
 *       - 预制件页面的请求（视图、图标、动作）与 Agent 的 `prefab` 外壳操作都在这里按种类分派。
 *
 *       新增预制件：实现 `PrefabKindHandler` 并在构造函数的 handlers 中登记，同时在共享注册表
 *       （packages/shared/src/desktopPrefabs.ts）与 preload 视图注册表各加一项。
 *
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type { BrowserWindow } from 'electron'
import {
  desktopPrefabHas,
  isDesktopPrefabKind,
  type DesktopCardMeta,
  type DesktopPrefabCapability,
  type DesktopPrefabKind,
} from '../../../packages/shared/src/desktopCards'
import type { ShellRect } from '../../../packages/shared/src/desktopShell'
import { fail, type DesktopCardPrefabHooks } from '../windows/desktopCardModel'
import type { DesktopCards } from '../windows/desktopCardManager'
import type { FullscreenYield } from './fullscreenYield'
import { prefabDocument } from './prefabDocument'
import { runFenceAgent, type DesktopEntriesReader } from './fence/fenceAgent'
import { runFenceGesture, runFencePageAction } from './fence/fencePageActions'
import type { DesktopFences } from './fence/fenceService'

/** 每种预制件在主进程要实现的部分。 */
export interface PrefabKindHandler {
  opened(card: DesktopCardMeta, win: BrowserWindow): void
  released(id: string): void
  persistBounds(card: DesktopCardMeta, rect: ShellRect): ShellRect
  windowBounds(card: DesktopCardMeta, rect: ShellRect): ShellRect
  /** 页面视图（不含路径等敏感信息）。 */
  view(id: string): unknown
  icon(id: string, itemId: unknown, variant?: unknown): Promise<string | null>
  action(id: string, action: unknown, payload: unknown): Promise<unknown>
  /** 页面内的窗口手势（移动、缩放）；只作用于 id 对应的窗口。 */
  gesture(id: string, phase: unknown, payload: unknown): void
  /** 把项目作为系统文件拖出去；只作用于 id 对应的框。 */
  dragOut(id: string, itemId: unknown): Promise<void>
  /** Agent 的外壳操作（身份由后端注入的 `__homeScope` 决定）。 */
  agent(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

export class DesktopPrefabs implements DesktopCardPrefabHooks {
  private readonly handlers: Record<DesktopPrefabKind, PrefabKindHandler>
  private readonly windows = new Map<string, BrowserWindow>()

  constructor(
    private readonly cards: Pick<DesktopCards, 'get'>,
    readonly fences: DesktopFences,
    private readonly fullscreen: FullscreenYield | null,
    desktop: DesktopEntriesReader,
  ) {
    this.handlers = {
      fence: {
        opened: (card, win) => fences.opened(card, win),
        released: (id) => fences.released(id),
        persistBounds: (card, rect) => fences.persistBounds(card, rect),
        windowBounds: (card, rect) => fences.windowBounds(card, rect),
        view: (id) => fences.view(id),
        icon: (id, itemId, variant) => fences.icon(id, itemId, variant),
        action: (id, action, payload) => runFencePageAction(fences, id, action, payload),
        gesture: (id, phase, payload) => runFenceGesture(fences, id, phase, payload),
        dragOut: (id, itemId) => fences.dragOut(id, itemId),
        agent: (args) => runFenceAgent(fences, args, desktop),
      },
    }
  }

  private handler(card: DesktopCardMeta): PrefabKindHandler {
    if (!card.prefab) fail('DESKTOP_PREFAB_REQUIRED', '这张卡片不是预制件：{0}', [card.id])
    return this.handlers[card.prefab.kind]
  }

  /** 预制件卡片；普通卡片一律拒绝（普通卡片拿不到预制件能力）。 */
  prefabCard(id: unknown): DesktopCardMeta {
    const card = this.cards.get(id)
    this.handler(card)
    return card
  }

  /** 预制件是否声明了能力；未声明时报错。 */
  require(card: DesktopCardMeta, capability: DesktopPrefabCapability): void {
    if (!desktopPrefabHas(card.prefab, capability))
      fail('DESKTOP_PREFAB_FORBIDDEN', '这个预制件没有声明该能力：{0}', [capability])
  }

  // ─── DesktopCards 钩子 ────────────────────────────

  document(card: DesktopCardMeta): string {
    return prefabDocument(card)
  }

  opened(card: DesktopCardMeta, win: BrowserWindow): void {
    this.windows.set(card.id, win)
    if (desktopPrefabHas(card.prefab, 'fullscreen-yield'))
      this.fullscreen?.track(win, () => {
        try {
          // 贴在桌面底层的窗口在最下面，不需要让开。
          return !this.cards.get(card.id).desktopLayer
        } catch {
          return false
        }
      })
    this.handler(card).opened(card, win)
  }

  released(id: string): void {
    const win = this.windows.get(id)
    if (win) this.fullscreen?.untrack(win)
    this.windows.delete(id)
    // 卡片删除后已查不到种类，各种类自行忽略不认识的 ID。
    for (const handler of Object.values(this.handlers)) handler.released(id)
  }

  persistBounds(card: DesktopCardMeta, rect: ShellRect): ShellRect {
    return this.handler(card).persistBounds(card, rect)
  }

  windowBounds(card: DesktopCardMeta, rect: ShellRect): ShellRect {
    return this.handler(card).windowBounds(card, rect)
  }

  // ─── 页面请求（发送者身份由 IPC 层确认） ─────────────

  view(id: string): unknown {
    return this.handler(this.prefabCard(id)).view(id)
  }

  icon(id: string, itemId: unknown, variant?: unknown): Promise<string | null> {
    const card = this.prefabCard(id)
    this.require(card, 'file-icons')
    return this.handler(card).icon(id, itemId, variant)
  }

  action(id: string, action: unknown, payload: unknown): Promise<unknown> {
    const card = this.prefabCard(id)
    if (action === 'launch') this.require(card, 'launch-registered')
    if (action === 'drop') this.require(card, 'drop-reference')
    if (action === 'collapse') this.require(card, 'collapse')
    return this.handler(card).action(id, action, payload)
  }

  gesture(id: string, phase: unknown, payload: unknown): void {
    const card = this.prefabCard(id)
    this.require(card, 'window-gesture')
    this.handler(card).gesture(id, phase, payload)
  }

  dragOut(id: string, itemId: unknown): Promise<void> {
    const card = this.prefabCard(id)
    this.require(card, 'drag-out')
    return this.handler(card).dragOut(id, itemId)
  }

  // ─── Agent 外壳操作 ────────────────────────────────

  invoke(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isDesktopPrefabKind(args.kind))
      fail('DESKTOP_PREFAB_KIND', '未知的预制件种类：{0}', [String(args.kind ?? '')])
    return this.handlers[args.kind].agent(args)
  }
}
