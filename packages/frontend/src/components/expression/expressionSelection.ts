/**
 * 选中文字的全局监听。
 *
 * 消息可能有上百条，所以整个页面只挂一组 document 监听，选中落在哪个已登记的
 * 气泡里就通知哪个气泡。流式中的气泡不登记，选中自然不可用。
 */
import { shallowRef } from 'vue'
import { REPLY_TEXT_SELECTOR } from './expressionQuoteMatch'

export interface ReplySelection {
  bubble: HTMLElement
  quote: string
  rect: { top: number; bottom: number; left: number; right: number }
}

export const activeSelection = shallowRef<ReplySelection | null>(null)

const roots = new Set<HTMLElement>()
let pointerDown = false
let timer: ReturnType<typeof setTimeout> | undefined

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement
}

/** 读取当前选中：必须从气泡的回复正文开始，到同一气泡内结束。 */
export function readReplySelection(): ReplySelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const startBlock = elementOf(range.startContainer)?.closest(REPLY_TEXT_SELECTOR)
  const bubble = startBlock?.closest<HTMLElement>('.msg-bubble-assistant')
  if (!bubble || !roots.has(bubble)) return null
  const endBlock = elementOf(range.endContainer)?.closest(REPLY_TEXT_SELECTOR)
  // 三击选段时终点落在下一个元素的开头，也算选中了这一段。
  if (!(endBlock && bubble.contains(endBlock)) && range.endOffset !== 0) return null
  const quote = selection.toString().trim()
  if (!quote) return null
  const { top, bottom, left, right } = range.getBoundingClientRect()
  return { bubble, quote, rect: { top, bottom, left, right } }
}

function evaluate(): void {
  activeSelection.value = readReplySelection()
}

function schedule(delay: number): void {
  clearTimeout(timer)
  timer = setTimeout(evaluate, delay)
}

function onPointerDown(): void {
  pointerDown = true
}
function onPointerUp(): void {
  pointerDown = false
  schedule(10)
}
/** 拖选途中不弹出；键盘和触屏选中没有抬起事件，靠短暂防抖。 */
function onSelectionChange(): void {
  if (pointerDown) {
    if (window.getSelection()?.isCollapsed) activeSelection.value = null
    return
  }
  schedule(160)
}
function dismiss(): void {
  activeSelection.value = null
}
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') dismiss()
}

export function registerSelectionRoot(bubble: HTMLElement): () => void {
  if (!roots.size) {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('contextmenu', dismiss, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
  }
  roots.add(bubble)
  return () => {
    roots.delete(bubble)
    if (activeSelection.value?.bubble === bubble) activeSelection.value = null
    if (roots.size) return
    clearTimeout(timer)
    pointerDown = false
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('pointerup', onPointerUp, true)
    document.removeEventListener('pointercancel', onPointerUp, true)
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('contextmenu', dismiss, true)
    window.removeEventListener('scroll', dismiss, true)
    window.removeEventListener('resize', dismiss)
  }
}
