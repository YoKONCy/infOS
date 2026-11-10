/**
 * @file 界面结构的紧凑文本：可操作控件与界面文字按阅读顺序排成一行一条，节省 token。
 *
 * 每行格式：
 * - 可操作控件：`e12 Button "保存" [x,y,w,h] invoke`，带当前值时追加 `= 值`；
 * - 界面文字：`Text "已连接" [x,y,w,h]`。
 * 坐标一律是截图坐标（经第 0 步的 physicalRectToScreenshot 换算）。
 * 同一位置重复的文字（列表项和它里面的文本控件常常同名）只保留一条。
 * UIA 读到的内容很少时（自绘界面、游戏、远程桌面），调用方据 `isSparse` 自动补上 OCR。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 界面结构
 */

import type { DesktopElementInfo, DesktopTextInfo } from '@infos/shared'
import type { DesktopRect } from './desktopCoordinates'
import { physicalRectToScreenshot, type CoordinateMapping } from './desktopCoordinateMapping'

/** 输出总字数上限；超出时截断并标注。 */
export const UI_TEXT_MAX_CHARS = 16_000
/** 少于这么多条带文字的内容、或文字总数少于 SPARSE_MIN_CHARS，视为 UIA 读到的太少。 */
export const SPARSE_MIN_ITEMS = 5
export const SPARSE_MIN_CHARS = 20

export interface UiLine {
  kind: 'control' | 'text'
  role: string
  text: string
  /** 截图坐标。 */
  box: DesktopRect
  elementId?: string
  patterns?: string[]
  value?: string
  enabled?: boolean
}

/** 规整文字用于比较：去空白、统一大小写。 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** 交并比（IoU）。 */
export function overlap(a: DesktopRect, b: DesktopRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  const inter = width * height
  return inter / (a.width * a.height + b.width * b.height - inter)
}

/** a 是否基本落在 b 里面（至少 80% 面积）。 */
export function inside(a: DesktopRect, b: DesktopRect): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 && width * height >= 0.8 * a.width * a.height
}

/** 阅读顺序：先按行（中心点相差不到半行高视为同一行），行内从左到右。 */
export function readingOrder<T extends { box: DesktopRect }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ay = a.box.y + a.box.height / 2
    const by = b.box.y + b.box.height / 2
    const row = Math.max(4, Math.min(a.box.height, b.box.height) / 2)
    return Math.abs(ay - by) > row ? ay - by : a.box.x - b.box.x
  })
}

/** 把 UIA 控件与文字换到截图坐标，去掉同一位置的重复文字，按阅读顺序排好。 */
export function uiLines(
  elements: DesktopElementInfo[],
  texts: DesktopTextInfo[],
  mapping: CoordinateMapping,
): UiLine[] {
  const lines: UiLine[] = elements.map((element) => ({
    kind: 'control',
    role: element.role,
    text: element.name,
    box: physicalRectToScreenshot(mapping, element.bounds),
    elementId: element.id,
    patterns: element.patterns,
    ...(element.value ? { value: element.value } : {}),
    enabled: element.enabled,
  }))
  for (const item of texts) {
    const box = physicalRectToScreenshot(mapping, item.bounds)
    const key = normalizeText(item.text)
    const duplicate = lines.some(
      (line) =>
        normalizeText(line.text) === key &&
        (overlap(line.box, box) >= 0.5 || inside(box, line.box) || inside(line.box, box)),
    )
    if (!duplicate) lines.push({ kind: 'text', role: item.role, text: item.text, box })
  }
  return readingOrder(lines)
}

/** UIA 读到的内容是否太少（需要 OCR 补上）。 */
export function isSparse(lines: UiLine[]): boolean {
  const withText = lines.filter((line) => line.text.trim() || line.value?.trim())
  const chars = withText.reduce(
    (sum, line) => sum + line.text.length + (line.value?.length ?? 0),
    0,
  )
  return withText.length < SPARSE_MIN_ITEMS || chars < SPARSE_MIN_CHARS
}

const quote = (text: string) => JSON.stringify(text)

/** 单行文本表示。 */
export function formatUiLine(line: UiLine): string {
  const box = `[${line.box.x},${line.box.y},${line.box.width},${line.box.height}]`
  if (line.kind === 'text') return `${line.role} ${quote(line.text)} ${box}`
  const parts = [line.elementId, line.role, quote(line.text), box, (line.patterns ?? []).join(',')]
  if (line.enabled === false) parts.push('disabled')
  if (line.value) parts.push(`= ${quote(line.value)}`)
  return parts.filter(Boolean).join(' ')
}

/** 整体文本，超过字数上限时截断。 */
export function formatUiLines(lines: UiLine[]): { text: string; truncated: boolean } {
  const rows: string[] = []
  let chars = 0
  for (const line of lines) {
    const row = formatUiLine(line)
    if (chars + row.length > UI_TEXT_MAX_CHARS) return { text: rows.join('\n'), truncated: true }
    rows.push(row)
    chars += row.length + 1
  }
  return { text: rows.join('\n'), truncated: false }
}
