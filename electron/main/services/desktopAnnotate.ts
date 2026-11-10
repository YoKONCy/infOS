/**
 * @file 在截图上叠加元素编号：每个条目画一圈框，左上角贴一个带编号的小标签。
 *
 * 直接改 BGRA 位图（Electron `NativeImage.toBitmap()` 的格式），不依赖画布；数字用 3×5 点阵放大绘制。
 * 可操作控件用洋红色，UIA 文字用蓝色，OCR 文字用橙色。纯函数，便于单独测试。
 *
 * @platform ELECTRON
 * @see desktopElementMap.ts
 */

import type { ElementMapEntry } from './desktopElementMap'

/** 3×5 点阵数字，每行 3 位，自上而下。 */
const DIGITS = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
]

/** 数字放大倍数与间距（像素）。 */
const SCALE = 2
const PAD = 2

type Color = readonly [number, number, number]
export const ANNOTATION_COLORS = {
  actionable: [230, 40, 200] as Color,
  uia: [40, 110, 240] as Color,
  ocr: [245, 140, 20] as Color,
}

export interface Canvas {
  bitmap: Uint8Array
  width: number
  height: number
}

function setPixel(canvas: Canvas, x: number, y: number, [r, g, b]: Color): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return
  const offset = (y * canvas.width + x) * 4
  canvas.bitmap[offset] = b
  canvas.bitmap[offset + 1] = g
  canvas.bitmap[offset + 2] = r
  canvas.bitmap[offset + 3] = 255
}

export function fillRect(
  canvas: Canvas,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Color,
): void {
  for (let row = y; row < y + height; row++)
    for (let column = x; column < x + width; column++) setPixel(canvas, column, row, color)
}

export function strokeRect(
  canvas: Canvas,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Color,
  line = 2,
): void {
  fillRect(canvas, x, y, width, line, color)
  fillRect(canvas, x, y + height - line, width, line, color)
  fillRect(canvas, x, y, line, height, color)
  fillRect(canvas, x + width - line, y, line, height, color)
}

/** 编号标签的尺寸。 */
export function labelSize(n: number): { width: number; height: number } {
  const digits = String(n).length
  return { width: digits * 4 * SCALE - SCALE + PAD * 2, height: 5 * SCALE + PAD * 2 }
}

/** 画带底色的编号标签，左上角在 (x, y)。 */
export function drawLabel(canvas: Canvas, x: number, y: number, n: number, color: Color): void {
  const size = labelSize(n)
  fillRect(canvas, x, y, size.width, size.height, color)
  const white: Color = [255, 255, 255]
  ;[...String(n)].forEach((digit, index) => {
    const glyph = DIGITS[Number(digit)]!
    const left = x + PAD + index * 4 * SCALE
    for (let row = 0; row < 5; row++)
      for (let column = 0; column < 3; column++)
        if (glyph[row * 3 + column] === '1')
          fillRect(canvas, left + column * SCALE, y + PAD + row * SCALE, SCALE, SCALE, white)
  })
}

/** 在截图位图上叠加元素图的框和编号（坐标为截图坐标）。 */
export function annotateBitmap(canvas: Canvas, entries: ElementMapEntry[]): void {
  for (const entry of entries) {
    const color = entry.actionable
      ? ANNOTATION_COLORS.actionable
      : entry.source === 'ocr'
        ? ANNOTATION_COLORS.ocr
        : ANNOTATION_COLORS.uia
    const { x, y, width, height } = entry.box
    if (width <= 0 || height <= 0) continue
    strokeRect(canvas, x, y, width, height, color, entry.actionable ? 2 : 1)
    const label = labelSize(entry.n)
    // 标签贴在框的左上角外侧；上方放不下时放到框内。
    drawLabel(canvas, x, y - label.height >= 0 ? y - label.height : y, entry.n, color)
  }
}
