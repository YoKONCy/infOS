/**
 * @file 收纳框指针手势的纯逻辑：判定一次按下是点击、双击还是拖动，按动画帧节流，
 *       以及项目拖动时的走向（拖出框外还是框内排序）。
 *       不依赖 DOM 与 Electron，便于单元测试；fenceView 只负责把指针事件喂进来。
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type { FenceViewItem } from '../../../packages/shared/src/desktopFence'

/** 标题栏：移动超过这么多像素才算拖动，避免手抖把点击变成拖动。 */
export const FENCE_DRAG_THRESHOLD_PX = 4
/** 两次点击的最长间隔（毫秒）。 */
export const FENCE_DOUBLE_CLICK_MS = 500
/** 两次点击的最大距离（像素）。 */
export const FENCE_DOUBLE_CLICK_SLOP_PX = 4

/**
 * 背景的最小不透明度（约 3/255，肉眼看不出）。逐像素全透明的地方，系统可能把点击和拖放
 * 穿透给后面的窗口；透明度调到 0 时框仍要能拖动、能接收拖入和右键。
 */
export const FENCE_MIN_HIT_ALPHA = 0.012

/** 背景透明度（0–100）→ 实际绘制的不透明度：0 也保留最小值，窗口不会被穿透。 */
export function fenceBackgroundAlpha(percent: number): number {
  return Math.max(percent / 100, FENCE_MIN_HIT_ALPHA)
}

/** 系统拖拽返回后再等这么久（毫秒）才算结束：放下事件和主进程的返回谁先到页面并不确定。 */
export const FENCE_OWN_DRAG_GRACE_MS = 800

/**
 * 按住项目拖动时走哪条路：
 * - `native`：系统文件拖拽，能拖进聊天窗口和别的程序；登记项放回本框就是排序；
 * - `sort`：文件拖不出去（缺失、隐藏或受保护）的登记项，只能在框内排序；
 * - `none`：不能拖。
 */
export type FenceDragMode = 'native' | 'sort' | 'none'

export function fenceDragMode(item: Pick<FenceViewItem, 'dragOut' | 'fromFolder'>): FenceDragMode {
  if (item.dragOut) return 'native'
  return item.fromFolder ? 'none' : 'sort'
}

/** 本框发起的一次拖拽。 */
export interface FenceOwnDrag {
  id: string
  mode: Exclude<FenceDragMode, 'none'>
  fromFolder: boolean
}

/**
 * 拖到本框上方时的光标效果。系统拖拽只允许复制和引用（Electron 的 startDrag 不提供移动，
 * 所以文件不会被挪走），排序也要用 `link`，否则放不下；映射项目在框里没有位置可放，显示不可放下。
 */
export function fenceDragOverEffect(own: FenceOwnDrag | null): 'link' | 'move' | 'none' {
  if (!own) return 'link'
  if (own.mode === 'sort') return 'move'
  return own.fromFolder ? 'none' : 'link'
}

export type FenceDropOutcome =
  | { kind: 'register' }
  | { kind: 'ignore' }
  | { kind: 'reorder'; order: string[] }

/**
 * 放到本框上时做什么：别处来的文件登记为引用；本框发起的绝不再登记，登记项调整顺序，
 * 映射项目、放回原位或顺序没变时什么都不做（不把排序方式改成手动）。
 * 放到框外时目标是别的程序，这里收不到事件，本框也就不会有变化。
 */
export function fenceDropOutcome(
  own: FenceOwnDrag | null,
  overId: string | undefined,
  items: readonly Pick<FenceViewItem, 'id' | 'fromFolder'>[],
): FenceDropOutcome {
  if (!own) return { kind: 'register' }
  if (own.fromFolder || overId === own.id) return { kind: 'ignore' }
  const before = items.filter((item) => !item.fromFolder).map((item) => item.id)
  if (!before.includes(own.id)) return { kind: 'ignore' }
  const order = before.filter((id) => id !== own.id)
  const to = overId ? order.indexOf(overId) : -1
  order.splice(to < 0 ? order.length : to, 0, own.id)
  return order.every((id, index) => id === before[index])
    ? { kind: 'ignore' }
    : { kind: 'reorder', order }
}

export type FencePressMove = 'none' | 'begin' | 'drag'
export type FencePressEnd = 'none' | 'dragged' | 'click' | 'double-click'

export interface FencePressOptions {
  /** 这次按下是否允许拖动（贴在桌面上时不允许，但仍能双击改名）。 */
  draggable: boolean
  /** 是否按在标题文字上（只有标题上的双击才改名）。 */
  onTitle: boolean
}

/**
 * 一个控件上的按下 → 移动 → 松开：
 * - 移动超过阈值后才开始拖动，拖动过的按下不算点击；
 * - 没移动的按下才算点击，连续两次、间隔和距离都够近、且都在标题上才算双击；
 * - 拖动或双击之后清空上一次点击，第三下不会再触发一次双击。
 */
export class FencePress {
  private start: { x: number; y: number } | null = null
  private options: FencePressOptions = { draggable: true, onTitle: false }
  private moved = false
  private dragging = false
  private delta = { dx: 0, dy: 0 }
  private lastClick: { x: number; y: number; time: number } | null = null

  constructor(private readonly threshold: number = FENCE_DRAG_THRESHOLD_PX) {}

  get active(): boolean {
    return this.start !== null
  }

  get isDragging(): boolean {
    return this.dragging
  }

  /** 相对按下位置的累计增量（屏幕坐标），发给主进程。 */
  get total(): { dx: number; dy: number } {
    return { ...this.delta }
  }

  down(x: number, y: number, options: FencePressOptions): void {
    this.start = { x, y }
    this.options = options
    this.moved = false
    this.dragging = false
    this.delta = { dx: 0, dy: 0 }
  }

  move(x: number, y: number): FencePressMove {
    if (!this.start) return 'none'
    const dx = x - this.start.x
    const dy = y - this.start.y
    this.delta = { dx, dy }
    if (this.dragging) return 'drag'
    if (Math.hypot(dx, dy) < Math.max(this.threshold, Number.MIN_VALUE)) return 'none'
    this.moved = true
    if (!this.options.draggable) return 'none'
    this.dragging = true
    return 'begin'
  }

  up(x: number, y: number, time: number): FencePressEnd {
    if (!this.start) return 'none'
    const { moved, dragging } = this
    const { onTitle } = this.options
    this.start = null
    this.dragging = false
    if (dragging || moved) {
      this.lastClick = null
      return dragging ? 'dragged' : 'none'
    }
    const last = this.lastClick
    const isDouble =
      !!last &&
      onTitle &&
      time - last.time <= FENCE_DOUBLE_CLICK_MS &&
      Math.hypot(x - last.x, y - last.y) <= FENCE_DOUBLE_CLICK_SLOP_PX
    if (isDouble) {
      this.lastClick = null
      return 'double-click'
    }
    this.lastClick = onTitle ? { x, y, time } : null
    return 'click'
  }

  /** 指针被系统收回（pointercancel 等）：返回是否正在拖动，由调用方结束手势。 */
  cancel(): boolean {
    const dragging = this.dragging
    this.start = null
    this.dragging = false
    this.lastClick = null
    return dragging
  }
}

/** 按动画帧节流：一帧内只发送最新的值；`take` 取走未发送的值（结束时由最终值代替）。 */
export function frameThrottle<T>(
  schedule: (run: () => void) => void,
  send: (value: T) => void,
): { push(value: T): void; take(): T | undefined } {
  let pending: { value: T } | null = null
  let scheduled = false
  return {
    push(value) {
      pending = { value }
      if (scheduled) return
      scheduled = true
      schedule(() => {
        scheduled = false
        if (!pending) return
        const { value: latest } = pending
        pending = null
        send(latest)
      })
    },
    take() {
      const value = pending?.value
      pending = null
      return value
    },
  }
}
