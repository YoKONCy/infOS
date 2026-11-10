/**
 * @file 把多个变化块拼成一张图：按行排放（放不下就换行），块之间留空隙，每块左上角贴编号标签。
 *
 * 块按原始清晰度拼接，不缩放（文字要看得清）；整张图超过上限时由调用方再整体缩小。纯函数，BGRA 位图。
 *
 * @platform ELECTRON
 * @see desktopWatch.ts
 */

import type { DesktopRect } from './desktopCoordinates'
import { drawLabel, fillRect, labelSize, type Canvas } from './desktopAnnotate'

/** 拼图最大宽度、块间空隙（像素）。 */
export const ATLAS_MAX_WIDTH = 1600
export const ATLAS_GAP = 8
const BACKGROUND = [40, 40, 48] as const
const LABEL = [230, 40, 200] as const

export interface AtlasPiece {
  n: number
  /** 块在源帧里的位置。 */
  source: DesktopRect
}

export interface AtlasPlacement {
  n: number
  /** 块在拼图里的位置（不含标签）。 */
  atlas: DesktopRect
}

/** 计算排放位置：每块上方留标签高度；宽度超过 ATLAS_MAX_WIDTH 时换行。 */
export function layoutAtlas(pieces: AtlasPiece[]): {
  width: number
  height: number
  placements: AtlasPlacement[]
} {
  const placements: AtlasPlacement[] = []
  const labelHeight = labelSize(pieces.length).height
  let x = ATLAS_GAP
  let y = ATLAS_GAP
  let rowHeight = 0
  let width = 0
  for (const piece of pieces) {
    const w = piece.source.width
    const h = piece.source.height + labelHeight
    if (x > ATLAS_GAP && x + w + ATLAS_GAP > ATLAS_MAX_WIDTH) {
      x = ATLAS_GAP
      y += rowHeight + ATLAS_GAP
      rowHeight = 0
    }
    placements.push({
      n: piece.n,
      atlas: { x, y: y + labelHeight, width: w, height: piece.source.height },
    })
    x += w + ATLAS_GAP
    rowHeight = Math.max(rowHeight, h)
    width = Math.max(width, x)
  }
  return { width: Math.max(width, 1), height: y + rowHeight + ATLAS_GAP, placements }
}

/** 按排放位置从源帧复制像素、画编号，得到拼图位图。 */
export function renderAtlas(
  frame: Canvas,
  pieces: AtlasPiece[],
  layout: ReturnType<typeof layoutAtlas>,
): Canvas {
  const canvas: Canvas = {
    bitmap: new Uint8Array(layout.width * layout.height * 4),
    width: layout.width,
    height: layout.height,
  }
  fillRect(canvas, 0, 0, canvas.width, canvas.height, BACKGROUND)
  pieces.forEach((piece, index) => {
    const target = layout.placements[index]!.atlas
    for (let row = 0; row < piece.source.height; row++) {
      const from = ((piece.source.y + row) * frame.width + piece.source.x) * 4
      const to = ((target.y + row) * canvas.width + target.x) * 4
      canvas.bitmap.set(frame.bitmap.subarray(from, from + piece.source.width * 4), to)
    }
    drawLabel(canvas, target.x, target.y - labelSize(piece.n).height, piece.n, LABEL)
  })
  return canvas
}
