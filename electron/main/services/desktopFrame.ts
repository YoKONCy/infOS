/**
 * @file 画面指纹：把截图缩成小灰度网格，用来判断两次画面差多少。
 *
 * 用途：动作后等画面稳定再截图（连续两次差异足够小）；批准期间画面是否变了。
 * 只比较亮度、不比较像素级细节，光标闪烁、抗锯齿差异只带来很小的差值。
 * 本模块是纯函数，不依赖 Electron，便于单独测试。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 动作后的画面
 */

/** 指纹网格的列数；行数按画面宽高比计算，最多同样多。 */
export const FRAME_GRID = 32
/** 连续两次采样差异不超过它，视为画面已稳定（0–1，平均亮度差占满量程的比例）。 */
export const FRAME_STABLE_THRESHOLD = 0.004
/** 不同分辨率之间比较（观察截图与批准后采样）时，差异超过它视为画面已变化。 */
export const FRAME_CHANGED_THRESHOLD = 0.03

/** 指纹网格尺寸：宽固定为 FRAME_GRID，高按比例且至少 1。 */
export function fingerprintSize(width: number, height: number): { width: number; height: number } {
  const ratio = width > 0 ? height / width : 1
  return {
    width: FRAME_GRID,
    height: Math.max(1, Math.min(FRAME_GRID, Math.round(FRAME_GRID * ratio))),
  }
}

/**
 * 从 BGRA 位图（Electron `NativeImage.toBitmap()` 的格式）按块平均亮度生成指纹。
 * 位图应已缩到 `fingerprintSize` 附近；这里仍按块平均，任何尺寸都能得到同样大小的网格。
 */
export function bitmapFingerprint(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const grid = fingerprintSize(width, height)
  const result = new Uint8Array(grid.width * grid.height)
  for (let row = 0; row < grid.height; row++)
    for (let column = 0; column < grid.width; column++) {
      const left = Math.floor((column * width) / grid.width)
      const right = Math.max(left + 1, Math.floor(((column + 1) * width) / grid.width))
      const top = Math.floor((row * height) / grid.height)
      const bottom = Math.max(top + 1, Math.floor(((row + 1) * height) / grid.height))
      let sum = 0
      let count = 0
      for (let y = top; y < Math.min(bottom, height); y++)
        for (let x = left; x < Math.min(right, width); x++) {
          const offset = (y * width + x) * 4
          // BGRA → 亮度（ITU-R BT.601 权重）
          sum += 0.114 * bitmap[offset]! + 0.587 * bitmap[offset + 1]! + 0.299 * bitmap[offset + 2]!
          count++
        }
      result[row * grid.width + column] = count ? Math.round(sum / count) : 0
    }
  return result
}

/** 两个指纹的平均亮度差（0–1）；尺寸不同（画面宽高比变了）视为完全不同。 */
export function frameDifference(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length || left.length === 0) return 1
  let total = 0
  for (let index = 0; index < left.length; index++) total += Math.abs(left[index]! - right[index]!)
  return total / left.length / 255
}
