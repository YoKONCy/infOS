/**
 * @file 持续盯窗口的画面差分：逐帧比较找出变化格子，合并成变化块，相近的块去重。纯函数。
 *
 * 思路按 Watch Buddy（jpetree331/mcp-watch-buddy）公开 README 描述的做法自己实现（未参考其源码）：
 * 逐帧比较 → 只取变化区域 → 多块拼成一张带坐标说明的图 → 相近的去重。
 * 像素比较用 pixelmatch（ISC）：先把画面长边限制到 DIFF_WIDTH 再比。
 *
 * @platform ELECTRON
 * @see desktopWatch.ts
 */

import pixelmatch from 'pixelmatch'
import type { DesktopRect } from './desktopCoordinates'

/** 比较用的画面长边上限（像素）。 */
export const DIFF_WIDTH = 480
/** 同时约束长边，不能把又窄又高的窗口放大成巨型比较图。 */
export function fitWatchSize(width: number, height: number, maxSide = DIFF_WIDTH) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    throw new Error('DESKTOP_WATCH_FRAME_INVALID')
  const scale = Math.min(1, maxSide / width, maxSide / height)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

/** 感知哈希只筛候选；最后逐像素核对，避免把不同颜色或细小数字的区域合成一块。 */
export function sameBlockPixels(
  bitmap: Uint8Array,
  width: number,
  a: DesktopRect,
  b: DesktopRect,
): boolean {
  if (a.width !== b.width || a.height !== b.height) return false
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width * 4; x++) {
      if (bitmap[((a.y + y) * width + a.x) * 4 + x] !== bitmap[((b.y + y) * width + b.x) * 4 + x])
        return false
    }
  return true
}
/** 格子边长（比较画面上的像素）；一格里变化像素不少于 CELL_MIN_PIXELS 才算这格变了（滤掉光标闪烁等噪点）。 */
export const CELL = 12
export const CELL_MIN_PIXELS = 3

export interface Grid {
  width: number
  height: number
  columns: number
  rows: number
}

export function gridFor(width: number, height: number): Grid {
  return { width, height, columns: Math.ceil(width / CELL), rows: Math.ceil(height / CELL) }
}

/**
 * 两帧之间变化了的格子（1 = 变了）。帧是同尺寸的 4 通道位图；
 * pixelmatch 不区分 RGBA/BGRA 的通道顺序带来的权重差异可以忽略。
 */
export function changedCells(
  previous: Uint8Array,
  next: Uint8Array,
  grid: Grid,
  threshold = 0.1,
): Uint8Array {
  const output = new Uint8Array(grid.width * grid.height * 4)
  pixelmatch(previous, next, output, grid.width, grid.height, { threshold, diffMask: true })
  const counts = new Uint16Array(grid.columns * grid.rows)
  for (let y = 0; y < grid.height; y++)
    for (let x = 0; x < grid.width; x++)
      if (output[(y * grid.width + x) * 4 + 3]! > 0)
        counts[Math.floor(y / CELL) * grid.columns + Math.floor(x / CELL)]!++
  return Uint8Array.from(counts, (count) => (count >= CELL_MIN_PIXELS ? 1 : 0))
}

export function countCells(cells: Uint8Array): number {
  let total = 0
  for (const cell of cells) total += cell
  return total
}

function touches(a: DesktopRect, b: DesktopRect, gap: number): boolean {
  return (
    a.x <= b.x + b.width + gap &&
    b.x <= a.x + a.width + gap &&
    a.y <= b.y + b.height + gap &&
    b.y <= a.y + a.height + gap
  )
}

function unite(a: DesktopRect, b: DesktopRect): DesktopRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/**
 * 变化格子 → 变化块（以格子为单位的矩形）：相邻或间隔不超过 `gap` 格的合并成一块，
 * 反复合并直到没有相互挨着的块。按面积从大到小返回。
 */
export function mergeBlocks(cells: Uint8Array, grid: Grid, gap = 1): DesktopRect[] {
  let blocks: DesktopRect[] = []
  for (let row = 0; row < grid.rows; row++)
    for (let column = 0; column < grid.columns; column++)
      if (cells[row * grid.columns + column])
        blocks.push({ x: column, y: row, width: 1, height: 1 })
  let merged = true
  while (merged) {
    merged = false
    const next: DesktopRect[] = []
    for (const block of blocks) {
      const target = next.find((other) => touches(other, block, gap))
      if (target) {
        Object.assign(target, unite(target, block))
        merged = true
      } else next.push({ ...block })
    }
    blocks = next
  }
  return blocks.sort((a, b) => b.width * b.height - a.width * a.height)
}

/** 格子矩形 → 帧像素矩形（外扩 `pad` 格，裁到帧内）；`scale` 为帧宽 / 比较画面宽。 */
export function blockToFrame(
  block: DesktopRect,
  grid: Grid,
  scale: number,
  frame: { width: number; height: number },
  pad = 1,
): DesktopRect {
  const left = Math.max(0, Math.floor((block.x - pad) * CELL * scale))
  const top = Math.max(0, Math.floor((block.y - pad) * CELL * scale))
  const right = Math.min(frame.width, Math.ceil((block.x + block.width + pad) * CELL * scale))
  const bottom = Math.min(frame.height, Math.ceil((block.y + block.height + pad) * CELL * scale))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/** 8×8 平均哈希（64 位，以 16 进制字符串表示）：用于判断两块画面是不是几乎一样。 */
export function averageHash(bitmap: Uint8Array, width: number, rect: DesktopRect): string {
  const values: number[] = []
  for (let row = 0; row < 8; row++)
    for (let column = 0; column < 8; column++) {
      const x = rect.x + Math.min(rect.width - 1, Math.floor(((column + 0.5) * rect.width) / 8))
      const y = rect.y + Math.min(rect.height - 1, Math.floor(((row + 0.5) * rect.height) / 8))
      const offset = (y * width + x) * 4
      values.push(bitmap[offset]! + bitmap[offset + 1]! + bitmap[offset + 2]!)
    }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  let bits = 0n
  for (const value of values) bits = (bits << 1n) | (value > mean ? 1n : 0n)
  return bits.toString(16).padStart(16, '0')
}

/** 两个平均哈希相差的位数。 */
export function hashDistance(a: string, b: string): number {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let count = 0
  while (diff) {
    count += Number(diff & 1n)
    diff >>= 1n
  }
  return count
}
