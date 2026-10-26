import { describe, expect, it } from 'vitest'
import { mapScreenshotRegion, screenshotPixelRect, screenshotRegion } from './screenshotGeometry'

describe('区域截图坐标', () => {
  it('把缩小截图中的选区映射到负原点显示器，并支持继续选取局部', () => {
    const bounds = mapScreenshotRegion(
      { x: 100, y: 50, width: 200, height: 100 },
      { width: 800, height: 450 },
      { x: -1600, y: 0, width: 1600, height: 900 },
    )
    expect(bounds).toEqual({ x: -1400, y: 100, width: 400, height: 200 })
    expect(
      mapScreenshotRegion(
        { x: 40, y: 20, width: 80, height: 40 },
        { width: 400, height: 200 },
        bounds,
      ),
    ).toEqual({ x: -1360, y: 120, width: 80, height: 40 })
  })

  it('高 DPI 裁剪向外覆盖边缘像素，并在图像边缘收口', () => {
    expect(
      screenshotPixelRect(
        { x: 20.25, y: 10.75, width: 30.5, height: 20.5 },
        { width: 200, height: 100 },
      ),
    ).toEqual({ x: 20, y: 10, width: 31, height: 22 })
    expect(
      screenshotPixelRect(
        { x: 199.4, y: 99.3, width: 0.6, height: 0.7 },
        { width: 200, height: 100 },
      ),
    ).toEqual({ x: 199, y: 99, width: 1, height: 1 })
  })

  it.each([
    { x: -1, y: 0, width: 20, height: 20 },
    { x: 190, y: 0, width: 11, height: 20 },
    { x: 0, y: 0, width: 0, height: 20 },
    { x: Number.NaN, y: 0, width: 20, height: 20 },
    { x: 0, y: 0, width: Infinity, height: 20 },
    { x: '0', y: 0, width: 20, height: 20 },
  ])('拒绝越界或非法选区：%j', (region) => {
    expect(() => screenshotRegion(region, { width: 200, height: 100 })).toThrow(
      'SCREENSHOT_REGION_INVALID',
    )
  })
})
