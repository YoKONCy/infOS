/**
 * @file 带编号的元素图：把 UIA 控件、UIA 界面文字和 OCR 文字合成一份清单，每项有编号、类型、文字、框、能否操作。
 *
 * 合并规则（参考 clawdcursor 的 UI 融合做法，MIT，见 THIRD_PARTY_NOTICES.md）：
 * - OCR 行与已有条目文字相同且位置重合（IoU ≥ 0.5 或互相包含）→ 视为同一个，只留 UIA 那条；
 * - OCR 行落在没有名字的可操作控件里 → 把文字补给这个控件（图标按钮旁边的字常见这种情况）；
 * - OCR 行是某条 UIA 文字的一部分且落在它里面 → 丢弃（文档正文已经由 UIA 给出）；
 * - 其余 OCR 行作为只读的文字条目加入。
 * 最后按阅读顺序从 1 开始编号。编号只在本次观察内有效；以后「手」可以按 `observationId + 编号` 操作，
 * 用 `resolveElementRef` 取回条目、UIA 控件编号和点击点。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 元素图
 */

import type { DesktopRect } from './desktopCoordinates'
import { physicalRectToScreenshot, type CoordinateMapping } from './desktopCoordinateMapping'
import type { OcrLine } from './desktopOcr'
import { inside, normalizeText, overlap, readingOrder, type UiLine } from './desktopUiText'

/** 清单条目数与输出字数上限。 */
export const ELEMENT_MAP_MAX_ENTRIES = 400
export const ELEMENT_MAP_MAX_CHARS = 16_000

export interface ElementMapEntry {
  /** 本次观察内的编号，从 1 开始。 */
  n: number
  source: 'uia' | 'ocr'
  /** UIA 控件类型；OCR 文字为 `OcrText`。 */
  role: string
  text: string
  /** 截图坐标。 */
  box: DesktopRect
  /** 能否操作：UIA 可操作控件为 true（elementId 可直接用于 automation_execute）。 */
  actionable: boolean
  elementId?: string
  patterns?: string[]
  value?: string
  enabled?: boolean
  /** 这条文字也被 OCR 识别到（两路一致）。 */
  confirmed?: boolean
}

type Draft = Omit<ElementMapEntry, 'n'>

/** 合成元素图。`ocr` 的框是物理像素，经 mapping 换到截图坐标。 */
export function buildElementMap(
  ui: UiLine[],
  ocr: OcrLine[],
  mapping: CoordinateMapping,
): { entries: ElementMapEntry[]; truncated: boolean } {
  const drafts: Draft[] = ui.map((line) => ({
    source: 'uia',
    role: line.role,
    text: line.text,
    box: line.box,
    actionable: line.kind === 'control',
    ...(line.elementId ? { elementId: line.elementId } : {}),
    ...(line.patterns ? { patterns: line.patterns } : {}),
    ...(line.value ? { value: line.value } : {}),
    ...(line.enabled === false ? { enabled: false } : {}),
  }))
  for (const line of ocr) {
    const box = physicalRectToScreenshot(mapping, line.box)
    const key = normalizeText(line.text)
    if (!key) continue
    const same = drafts.find(
      (draft) =>
        normalizeText(draft.text) === key &&
        (overlap(draft.box, box) >= 0.5 || inside(box, draft.box) || inside(draft.box, box)),
    )
    if (same) {
      if (same.source === 'uia') same.confirmed = true
      continue
    }
    const unnamed = drafts.find(
      (draft) => draft.actionable && !draft.text.trim() && inside(box, draft.box),
    )
    if (unnamed) {
      unnamed.text = line.text
      unnamed.confirmed = true
      continue
    }
    const covered = drafts.some(
      (draft) =>
        draft.source === 'uia' && inside(box, draft.box) && normalizeText(draft.text).includes(key),
    )
    if (covered) continue
    drafts.push({ source: 'ocr', role: 'OcrText', text: line.text, box, actionable: false })
  }
  const ordered = readingOrder(drafts)
  const truncated = ordered.length > ELEMENT_MAP_MAX_ENTRIES
  return {
    entries: ordered
      .slice(0, ELEMENT_MAP_MAX_ENTRIES)
      .map((draft, index) => ({ n: index + 1, ...draft })),
    truncated,
  }
}

const quote = (text: string) => JSON.stringify(text)

/** 单条：`7 Button* "保存" [x,y,w,h] e12 invoke = "值"`；`*` 表示可操作。 */
export function formatEntry(entry: ElementMapEntry): string {
  const box = `[${entry.box.x},${entry.box.y},${entry.box.width},${entry.box.height}]`
  const parts = [
    String(entry.n),
    `${entry.role}${entry.actionable ? '*' : ''}`,
    quote(entry.text),
    box,
  ]
  if (entry.elementId) parts.push(entry.elementId)
  if (entry.patterns?.length) parts.push(entry.patterns.join(','))
  if (entry.enabled === false) parts.push('disabled')
  if (entry.value) parts.push(`= ${quote(entry.value)}`)
  return parts.join(' ')
}

/** 整份清单的紧凑文本，超过字数上限时截断。 */
export function formatElementMap(entries: ElementMapEntry[]): { text: string; truncated: boolean } {
  const rows: string[] = []
  let chars = 0
  for (const entry of entries) {
    const row = formatEntry(entry)
    if (chars + row.length > ELEMENT_MAP_MAX_CHARS)
      return { text: rows.join('\n'), truncated: true }
    rows.push(row)
    chars += row.length + 1
  }
  return { text: rows.join('\n'), truncated: false }
}

export interface ResolvedElementRef {
  entry: ElementMapEntry
  /** UIA 可操作控件的编号：按控件操作（invoke / set_value 等）时用。 */
  elementId?: string
  /** 框中心点（截图坐标）：按坐标点击时用。 */
  point: { x: number; y: number }
}

/**
 * 按编号取回元素图里的条目（给以后的「手」用：「点 7 号」）。编号不存在时抛 `DESKTOP_ELEMENT_REF_INVALID`。
 */
export function resolveElementRef(entries: ElementMapEntry[], n: unknown): ResolvedElementRef {
  const entry = entries.find((item) => item.n === n)
  if (!entry)
    throw new Error('DESKTOP_ELEMENT_REF_INVALID: 元素编号不在本次观察的元素图里，请重新观察')
  return {
    entry,
    ...(entry.elementId ? { elementId: entry.elementId } : {}),
    point: {
      x: Math.round(entry.box.x + entry.box.width / 2),
      y: Math.round(entry.box.y + entry.box.height / 2),
    },
  }
}
