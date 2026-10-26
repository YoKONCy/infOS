import { t as __t } from '../utils/i18n'

export interface ScreenshotSize {
  width: number
  height: number
}

export interface ScreenshotRect extends ScreenshotSize {
  x: number
  y: number
}

/** 选区使用参考截图的像素坐标，拒绝越界而不悄悄改变观察范围。 */
export function screenshotRegion(value: unknown, size: ScreenshotSize): ScreenshotRect {
  const rect = value as ScreenshotRect | null
  if (
    !rect ||
    Array.isArray(rect) ||
    ![rect.x, rect.y, rect.width, rect.height, size.width, size.height].every(
      (part) => typeof part === 'number' && Number.isFinite(part),
    ) ||
    size.width <= 0 ||
    size.height <= 0 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > size.width ||
    rect.y + rect.height > size.height
  )
    throw new Error(
      __t('errors.electron', 'SCREENSHOT_REGION_INVALID: 选区必须是参考画面内的有效矩形'),
    )
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

/** 矩形按像素边界映射；点击坐标仍由各执行器按自己的观察协议处理。 */
export function mapScreenshotRegion(
  region: unknown,
  reference: ScreenshotSize,
  bounds: ScreenshotRect,
): ScreenshotRect {
  const rect = screenshotRegion(region, reference)
  return {
    x: bounds.x + (rect.x * bounds.width) / reference.width,
    y: bounds.y + (rect.y * bounds.height) / reference.height,
    width: (rect.width * bounds.width) / reference.width,
    height: (rect.height * bounds.height) / reference.height,
  }
}

export function screenshotMaxWidth(value: unknown, fallback = 1280): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 320 || value > 2560)
    throw new Error(
      __t('errors.electron', 'SCREENSHOT_SIZE_INVALID: maxWidth 必须是 320 到 2560 的整数'),
    )
  return value
}

/** 向外取整覆盖边缘像素，并返回实际裁剪范围以供坐标回映。 */
export function screenshotPixelRect(rect: ScreenshotRect, size: ScreenshotSize): ScreenshotRect {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(size.width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(size.height, Math.ceil(rect.y + rect.height))
  return screenshotRegion({ x, y, width: right - x, height: bottom - y }, size)
}
