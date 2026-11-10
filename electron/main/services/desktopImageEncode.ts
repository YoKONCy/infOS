/**
 * @file 截图的分辨率与编码：不再一律缩到 1280 宽，改用体积更小的格式。
 *
 * - 分辨率按视角取默认上限：整屏才明显缩小；窗口按自身大小（原始像素，超过上限才缩）；
 *   局部放大保持原始清晰度。调用方显式给 maxWidth 时以它为准；
 * - 编码同时生成 JPEG 与 PNG，取更小的那个：照片、渐变多的画面 JPEG 小得多，
 *   纯色界面和大段文字 PNG 往往更小而且无损，文字边缘不会糊；
 * - 局部放大多半是为了看清小字，JPEG 质量至少取 TEXT_MIN_QUALITY。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 截图
 */

/** 各视角的默认最大宽度（像素）。 */
export const DEFAULT_MAX_WIDTH = { screen: 1600, window: 1920, region: 2560 } as const
/** 局部放大时 JPEG 的最低质量。 */
export const TEXT_MIN_QUALITY = 90

export type ScreenshotScope = keyof typeof DEFAULT_MAX_WIDTH

export interface EncodedImage {
  dataUrl: string
  format: 'jpeg' | 'png'
  bytes: number
}

/** 两种编码取更小的；一样大时用无损的 PNG。 */
export function pickSmaller(png: Buffer, jpeg: Buffer): EncodedImage {
  const usePng = png.length <= jpeg.length
  const data = usePng ? png : jpeg
  return {
    dataUrl: `data:image/${usePng ? 'png' : 'jpeg'};base64,${data.toString('base64')}`,
    format: usePng ? 'png' : 'jpeg',
    bytes: data.length,
  }
}

/** 视角对应的 JPEG 质量：局部放大不低于 TEXT_MIN_QUALITY。 */
export function encodeQuality(quality: number, scope?: ScreenshotScope): number {
  return Math.round(scope === 'region' ? Math.max(quality, TEXT_MIN_QUALITY) : quality)
}

/** 编码一张截图：`quality` 为空时保持原来的 PNG。 */
export function encodeImage(
  image: Electron.NativeImage,
  quality?: number,
  scope?: ScreenshotScope,
): EncodedImage {
  if (quality === undefined) {
    const png = image.toPNG()
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      format: 'png',
      bytes: png.length,
    }
  }
  return pickSmaller(image.toPNG(), image.toJPEG(encodeQuality(quality, scope)))
}
