/**
 * 红色下划线：用 CSS Custom Highlight 画，不改动 DOM。
 *
 * Markdown 正文是 v-html 渲染的，往里面插元素会被下一次渲染冲掉，也可能破坏流式更新。
 * 高亮只保存 Range，正文变化时重新匹配；只有带句子的已完成消息才挂观察器，
 * 流式消息和没有批注的消息没有任何额外开销。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { locateQuote } from './expressionQuoteMatch'
import type { ExpressionMark, ExpressionMarkKind } from './expressionTypes'

const HIGHLIGHT_NAMES: Record<ExpressionMarkKind, string> = {
  good: 'expression-good',
  robotic: 'expression-robotic',
}

function sharedHighlight(kind: ExpressionMarkKind): Highlight | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined')
    return null
  const name = HIGHLIGHT_NAMES[kind]
  let highlight = CSS.highlights.get(name)
  if (!highlight) {
    highlight = new Highlight()
    CSS.highlights.set(name, highlight)
  }
  return highlight
}

export function useQuoteHighlights(
  bubble: Ref<HTMLElement | null>,
  marks: Ref<readonly ExpressionMark[]>,
) {
  /** 匹配到的句子；没进这里的句子只显示在气泡下方。 */
  const located = ref<ReadonlySet<string>>(new Set())
  const ranges = new Map<string, { range: Range; kind: ExpressionMarkKind }>()
  let observer: MutationObserver | undefined
  let frame = 0

  function clear(): void {
    for (const { range, kind } of ranges.values()) sharedHighlight(kind)?.delete(range)
    ranges.clear()
  }

  function apply(): void {
    frame = 0
    clear()
    const root = bubble.value
    const found = new Set<string>()
    if (root) {
      for (const mark of marks.value) {
        if (!mark.quote) continue
        const range = locateQuote(root, mark.quote)
        if (!range) continue
        found.add(mark.id)
        ranges.set(mark.id, { range, kind: mark.kind })
        sharedHighlight(mark.kind)?.add(range)
      }
    }
    if (found.size !== located.value.size || [...found].some((id) => !located.value.has(id)))
      located.value = found
  }

  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(apply)
  }

  function stop(): void {
    observer?.disconnect()
    observer = undefined
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }

  watch(
    [bubble, marks],
    () => {
      stop()
      const root = bubble.value
      const quoted = marks.value.some((mark) => mark.quote)
      if (!root || !quoted) {
        clear()
        if (located.value.size) located.value = new Set()
        return
      }
      apply()
      // 正文可能晚于批注渲染（异步解析、切页恢复），变化时重新匹配。
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(schedule)
        observer.observe(root, { childList: true, subtree: true, characterData: true })
      }
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(() => {
    stop()
    clear()
  })

  /** 点击下划线时找到对应批注。 */
  function markAtPoint(x: number, y: number): string | null {
    if (!ranges.size) return null
    const caret = caretAt(x, y)
    if (!caret) return null
    for (const [id, { range }] of ranges) {
      try {
        if (range.comparePoint(caret.node, caret.offset) === 0) return id
      } catch {
        // 节点已不在同一文档树：等下一次重新匹配。
      }
    }
    return null
  }

  return { located, markAtPoint }
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const position = doc.caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  const range = doc.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}
