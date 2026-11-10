/**
 * 浮层定位的纯计算：只吃数字、不碰 DOM，方便单测覆盖各种边界。
 * 坐标系都是视口坐标（getBoundingClientRect 的结果），配合 position: fixed 使用。
 */

export interface AnchorRect {
  top: number
  bottom: number
  left: number
  right: number
}

export interface DropdownPlacementInput {
  anchor: AnchorRect
  /** 浮层内容的自然高度（含边框，不受 max-height 限制）。 */
  contentHeight: number
  /** 浮层宽度；放不下时会被压到视口内。 */
  width: number
  viewportWidth: number
  /** 实际可见高度（手机软键盘弹出时小于布局高度）。 */
  viewportHeight: number
  /** 布局视口高度，用来换算 CSS bottom；默认等于 viewportHeight。 */
  layoutHeight?: number
  /** 内容再多也不超过这个高度，多出来的内部滚动。 */
  preferredMaxHeight?: number
  /** 贴着触发器放时至少要有这么高，否则改为压在触发器上。 */
  minHeight?: number
  gap?: number
  margin?: number
}

export interface DropdownPlacement {
  /** below/above 贴着触发器；overlay 表示上下都放不下，压在触发器上并贴近视口。 */
  side: 'below' | 'above' | 'overlay'
  /** top 和 bottom 只有一个有值：向上翻用 bottom 锚定，内容变矮时仍紧贴触发器。 */
  top: number | null
  bottom: number | null
  left: number
  width: number
  maxHeight: number
}

export function computeDropdownPlacement(input: DropdownPlacementInput): DropdownPlacement {
  const {
    anchor,
    contentHeight,
    viewportWidth,
    viewportHeight,
    layoutHeight = viewportHeight,
    preferredMaxHeight = 240,
    minHeight = 96,
    gap = 4,
    margin = 8,
  } = input
  const width = Math.max(0, Math.min(input.width, viewportWidth - margin * 2))
  const left = Math.max(margin, Math.min(anchor.left, viewportWidth - width - margin))
  const desired = Math.min(contentHeight, preferredMaxHeight)
  const below = viewportHeight - anchor.bottom - gap - margin
  const above = anchor.top - gap - margin

  const placeBelow = (maxHeight: number): DropdownPlacement => ({
    side: 'below',
    top: anchor.bottom + gap,
    bottom: null,
    left,
    width,
    maxHeight,
  })
  const placeAbove = (maxHeight: number): DropdownPlacement => ({
    side: 'above',
    top: null,
    bottom: layoutHeight - anchor.top + gap,
    left,
    width,
    maxHeight,
  })

  if (below >= desired) return placeBelow(desired)
  if (above >= desired) return placeAbove(desired)

  // 上下都放不下：哪边大放哪边，内部滚动。
  const larger = Math.max(below, above)
  if (larger >= Math.min(desired, minHeight)) {
    return below >= above ? placeBelow(larger) : placeAbove(larger)
  }

  // 两边都小得没法用（窗口极矮或触发器已在视口外）：压在触发器上，保证选项能点到。
  const maxHeight = Math.max(0, Math.min(desired, viewportHeight - margin * 2))
  const top = Math.max(margin, Math.min(anchor.bottom + gap, viewportHeight - margin - maxHeight))
  return { side: 'overlay', top, bottom: null, left, width, maxHeight }
}

/** 右键菜单这类跟随鼠标的浮层：把左上角推回视口内。 */
export function clampMenuPoint(input: {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  margin?: number
}): { x: number; y: number } {
  const { x, y, width, height, viewportWidth, viewportHeight, margin = 8 } = input
  return {
    x: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  }
}

/** 触发器是否还落在所有裁剪区域内；滚出去之后浮层就不该继续悬在原地。 */
export function isAnchorVisible(anchor: AnchorRect, clips: readonly AnchorRect[]): boolean {
  if (anchor.bottom <= anchor.top || anchor.right <= anchor.left) return false
  return clips.every(
    (clip) =>
      anchor.bottom > clip.top &&
      anchor.top < clip.bottom &&
      anchor.right > clip.left &&
      anchor.left < clip.right,
  )
}

/** 收集元素祖先里会裁剪它的矩形；碰到 fixed 祖先就停，再往上的 overflow 对它不生效。 */
export function collectClipRects(element: Element): AnchorRect[] {
  const clips: AnchorRect[] = []
  for (
    let current = element.parentElement;
    current && current !== document.body;
    current = current.parentElement
  ) {
    const style = getComputedStyle(current)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      clips.push(current.getBoundingClientRect())
    }
    if (style.position === 'fixed') break
  }
  return clips
}
