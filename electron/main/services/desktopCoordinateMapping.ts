/**
 * @file 截图像素、桌面逻辑像素（DIP）与物理像素之间的换算，随每次观察结果返回。
 *
 * - 截图坐标：本次截图里的像素，`automation_execute` 默认坐标系；
 * - DIP：Electron 的桌面逻辑坐标（`coordinateContext.bounds`）；
 * - 物理像素：Windows 屏幕真实像素。`get_mouse_position`、控件 `bounds` 与 `coordinateSpace: desktop` 都是它。
 *
 * 125%、150% 等 DPI 缩放下三者不同；这里按观察区域给出线性换算（区域总在一块显示器内，换算是线性的），
 * 与 `resolveDesktopPoint` 的映射口径一致：两端像素对齐，比例为 (尺寸-1)/(截图尺寸-1)。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 坐标
 */

import type { DesktopRect } from './desktopCoordinates'

/** 线性换算：目标 = offset + 截图坐标 × scale。 */
export interface LinearMapping {
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
}

export interface CoordinateMapping {
  screenshot: { width: number; height: number }
  dip: DesktopRect
  physical: DesktopRect
  /** 显示器 DPI 缩放（1.25 即 125%）。 */
  scaleFactor: number
  screenshotToDip: LinearMapping
  screenshotToPhysical: LinearMapping
}

const round = (value: number) => Math.round(value * 10000) / 10000

function linear(target: DesktopRect, width: number, height: number): LinearMapping {
  return {
    scaleX: round(width > 1 ? Math.max(0, target.width - 1) / (width - 1) : 0),
    scaleY: round(height > 1 ? Math.max(0, target.height - 1) / (height - 1) : 0),
    offsetX: round(target.x),
    offsetY: round(target.y),
  }
}

/** 由截图尺寸、观察区域的 DIP 与物理矩形组装换算。 */
export function buildCoordinateMapping(input: {
  width: number
  height: number
  bounds: DesktopRect
  physical: DesktopRect
  scaleFactor: number
}): CoordinateMapping {
  return {
    screenshot: { width: input.width, height: input.height },
    dip: input.bounds,
    physical: input.physical,
    scaleFactor: input.scaleFactor,
    screenshotToDip: linear(input.bounds, input.width, input.height),
    screenshotToPhysical: linear(input.physical, input.width, input.height),
  }
}

/** 物理像素点 → 截图坐标（取整）；用于把鼠标位置换到截图上。 */
export function physicalToScreenshot(
  mapping: CoordinateMapping,
  point: { x: number; y: number },
): { x: number; y: number } {
  const { scaleX, scaleY, offsetX, offsetY } = mapping.screenshotToPhysical
  return {
    x: Math.round(scaleX ? (point.x - offsetX) / scaleX : 0),
    y: Math.round(scaleY ? (point.y - offsetY) / scaleY : 0),
  }
}

/** 物理像素矩形 → 截图坐标矩形；用于把控件 bounds 换到截图上。 */
export function physicalRectToScreenshot(
  mapping: CoordinateMapping,
  rect: DesktopRect,
): DesktopRect {
  const topLeft = physicalToScreenshot(mapping, rect)
  const bottomRight = physicalToScreenshot(mapping, {
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  })
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  }
}
