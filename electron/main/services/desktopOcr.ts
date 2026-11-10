/**
 * @file 文字识别（OCR）：把截图交给 Windows 自带的 Windows.Media.Ocr，返回文字和每行、每词的框。
 *
 * - 识别用的是原始清晰度的画面（不是发给模型的缩小图）；画面较小时先放大两倍再识别，小字更准；
 * - 框统一换算成物理像素，再经第 0 步的 `physicalRectToScreenshot` 换到截图坐标；
 * - 识别不可用（没装语言包、视觉组件编译失败、WinRT 调用失败）时返回 `available: false` 与原因，
 *   不让整个观察失败；只有取消会向上抛。
 *
 * @platform WINDOWS
 * @see .docs/B02_DESKTOP_AUTOMATION.md 文字层
 */

import { app, type NativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesktopRect } from './desktopCoordinates'
import { physicalRectToScreenshot, type CoordinateMapping } from './desktopCoordinateMapping'
import { desktopVisionSettings } from './desktopVisionSettings'
import { ensureVisionHelper } from './windowsVisionHelper'
import { windowsDesktop } from './windowsDesktop'

export interface OcrWord {
  text: string
  /** 物理像素。 */
  box: DesktopRect
}

export interface OcrLine {
  text: string
  /** 物理像素：本行所有词框的并集。 */
  box: DesktopRect
  words: OcrWord[]
}

export type OcrOutcome =
  | { available: true; language: string; lines: OcrLine[] }
  | { available: false; reason: string }

/** 识别前放大的上限：画面宽不超过它时放大两倍（Windows OCR 对小字号识别率明显偏低）。 */
export const OCR_UPSCALE_MAX_WIDTH = 1600
/** 结果里文字层的上限：行数与总字数，超出时截断并标注。 */
export const OCR_MAX_LINES = 300
export const OCR_MAX_CHARS = 12_000

/** 视觉助手的缓存目录（编译好的 DLL）。 */
export function visionCacheDir(): string {
  return path.join(app.getPath('userData'), 'desktop-bridge')
}

function union(boxes: DesktopRect[]): DesktopRect {
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * 解析助手输出（`LANG\t语言`、`LINE\t行文字\t词@x,y,w,h;...`）。
 * `toPhysical` 把识别图片上的像素框换成物理像素。
 */
export function parseOcrOutput(
  raw: string,
  toPhysical: (box: DesktopRect) => DesktopRect,
): { language: string; lines: OcrLine[] } {
  let language = ''
  const lines: OcrLine[] = []
  for (const row of raw.split(/\r?\n/)) {
    const [kind, first = '', second = ''] = row.split('\t')
    if (kind === 'LANG') language = first
    if (kind !== 'LINE') continue
    const words: OcrWord[] = []
    for (const item of second.split(';')) {
      const at = item.lastIndexOf('@')
      if (at <= 0) continue
      const [x, y, width, height] = item
        .slice(at + 1)
        .split(',')
        .map(Number)
      if (![x, y, width, height].every(Number.isFinite) || width! <= 0 || height! <= 0) continue
      words.push({
        text: item.slice(0, at),
        box: toPhysical({ x: x!, y: y!, width: width!, height: height! }),
      })
    }
    const text = first.trim()
    if (!text || !words.length) continue
    lines.push({ text, box: union(words.map((word) => word.box)), words })
  }
  return { language, lines }
}

/** 识别图片像素 → 物理像素（图片覆盖整块 `physical` 矩形，`scale` 为识别前的放大倍数）。 */
export function imageBoxToPhysical(
  box: DesktopRect,
  image: { width: number; height: number },
  physical: DesktopRect,
): DesktopRect {
  const sx = physical.width / image.width
  const sy = physical.height / image.height
  const round = (value: number) => Math.round(value)
  return {
    x: round(physical.x + box.x * sx),
    y: round(physical.y + box.y * sy),
    width: round(box.width * sx),
    height: round(box.height * sy),
  }
}

/**
 * 识别一张画面。`physical` 是这张画面覆盖的物理像素矩形。
 * 取消（`DESKTOP_CANCELLED`）向上抛，其他失败一律返回 `available: false` 和原因。
 */
export async function recognizeImage(
  image: NativeImage,
  physical: DesktopRect,
  options: { language?: string; signal?: AbortSignal; cacheDir?: string } = {},
): Promise<OcrOutcome> {
  let helper: string
  try {
    helper = await ensureVisionHelper(options.cacheDir ?? visionCacheDir())
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const size = image.getSize()
  const source =
    size.width <= OCR_UPSCALE_MAX_WIDTH
      ? image.resize({ width: size.width * 2, height: size.height * 2, quality: 'best' })
      : image
  const scaled = source.getSize()
  const dir = path.join(os.tmpdir(), 'infos-desktop')
  const file = path.join(dir, `ocr-${randomUUID()}.bgra`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, source.toBitmap())
    const result = await windowsDesktop.request<{ raw: string }>(
      'ocr',
      {
        helper,
        path: file,
        width: scaled.width,
        height: scaled.height,
        // 没指定时用「桌面与家」里设的识别语言，空字符串表示跟随系统。
        language: options.language || desktopVisionSettings.get().ocrLanguage || undefined,
      },
      options.signal,
    )
    const parsed = parseOcrOutput(result.raw, (box) => imageBoxToPhysical(box, scaled, physical))
    return { available: true, ...parsed }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('DESKTOP_CANCELLED') || options.signal?.aborted) throw error
    return { available: false, reason: message }
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/** 文字层的紧凑文本：每行 `[x,y,w,h] 文字`（截图坐标），按从上到下、从左到右排列。 */
export function formatOcrLines(
  lines: OcrLine[],
  mapping: CoordinateMapping,
): { text: string; truncated: boolean } {
  const rows: string[] = []
  let chars = 0
  for (const line of lines) {
    const box = physicalRectToScreenshot(mapping, line.box)
    const row = `[${box.x},${box.y},${box.width},${box.height}] ${line.text}`
    if (rows.length >= OCR_MAX_LINES || chars + row.length > OCR_MAX_CHARS)
      return { text: rows.join('\n'), truncated: true }
    rows.push(row)
    chars += row.length + 1
  }
  return { text: rows.join('\n'), truncated: false }
}
