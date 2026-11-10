/**
 * @file 带错误码与画面指纹的截屏（从 desktopAwareness.ts 原样挪出，减少合并上游时的冲突）。
 *
 * `captureScreen` 仍在 desktopAwareness.ts，内部改为调用这里的 `captureScreenDetailed`；
 * desktopAwareness.ts 原样转出本文件的导出，调用方不需要改引用。
 *
 * @platform ELECTRON
 */
import { t as __t } from '../utils/i18n'
import { desktopCapturer, screen } from 'electron'
import type { DesktopRect } from './desktopCoordinates'
import type { ScreenshotResult } from './desktopAwareness'
import { bitmapFingerprint, fingerprintSize } from './desktopFrame'
import { screenshotMaxWidth, screenshotPixelRect } from './screenshotGeometry'
import { encodeImage, type ScreenshotScope } from './desktopImageEncode'

/** 带画面指纹的截图结果（见 desktopFrame.ts）；只在主进程内部使用，不返回给角色。 */
export interface DetailedScreenshot extends ScreenshotResult {
  fingerprint: Uint8Array
  /** `keepNative` 时附带：按显示器原始像素密度截取、未缩小的画面（文字识别用）。 */
  native?: Electron.NativeImage
  /** 输出尺寸的画面（叠加元素编号时重新编码用）。 */
  image?: Electron.NativeImage
  /** 图片编码与体积（字节）。 */
  imageFormat?: 'jpeg' | 'png'
  imageBytes?: number
}

export interface CaptureOptions {
  displayId?: string
  bounds?: DesktopRect
  /** false 时不生成 PNG（只要指纹，用于等画面稳定），dataUrl 为空字符串。 */
  encode?: boolean
  /** 按原始像素密度截取并在结果里附带未缩小的画面（文字识别用）；输出图片仍受 maxWidth 限制。 */
  keepNative?: boolean
  /** JPEG 质量；给出时 JPEG 与 PNG 取更小的，不给时保持 PNG。 */
  quality?: number
  /** 视角：局部放大（region）时 JPEG 质量不低于文字所需。 */
  scope?: ScreenshotScope
}

/**
 * 与 captureScreen 相同，但失败时抛出带稳定错误码的异常，结果另带画面指纹：
 * - `SCREEN_CAPTURE_DENIED`：系统没有提供任何可截取的屏幕（截图权限被拒、处于安全桌面或远程会话已断开）；
 * - `SCREEN_CAPTURE_SOURCE_MISSING`：找不到目标显示器的截图源；
 * - `SCREEN_CAPTURE_REGION_INVALID`：窗口或选区不在目标显示器内（常见于窗口最小化）；
 * - `SCREEN_CAPTURE_EMPTY`：截图为空；`SCREEN_CAPTURE_FAILED`：截图接口本身出错。
 */
export async function captureScreenDetailed(
  maxWidth = 1280,
  options: CaptureOptions = {},
): Promise<DetailedScreenshot> {
  maxWidth = screenshotMaxWidth(maxWidth)
  const display = options.displayId
    ? screen.getAllDisplays().find((item) => String(item.id) === options.displayId)
    : screen.getPrimaryDisplay()
  if (!display)
    throw new Error(__t('errors.electron', 'DESKTOP_DISPLAY_NOT_FOUND: 目标显示器已断开'))
  let bounds = { ...display.bounds }
  if (options.bounds) {
    const requested = options.bounds
    if (
      ![requested.x, requested.y, requested.width, requested.height].every(Number.isFinite) ||
      requested.width <= 0 ||
      requested.height <= 0
    )
      throw new Error(
        __t('errors.electron', 'SCREENSHOT_REGION_INVALID: 选区必须是参考画面内的有效矩形'),
      )
    const left = Math.max(bounds.x, requested.x)
    const top = Math.max(bounds.y, requested.y)
    const right = Math.min(bounds.x + bounds.width, requested.x + requested.width)
    const bottom = Math.min(bounds.y + bounds.height, requested.y + requested.height)
    if (right <= left || bottom <= top)
      throw new Error(
        __t('errors.electron', 'SCREEN_CAPTURE_REGION_INVALID: 窗口或选区不在目标显示器内'),
      )
    bounds = { x: left, y: top, width: right - left, height: bottom - top }
  }
  // 以选区宽度决定采样密度，避免先缩小整屏后再放大局部小字。
  const density = options.keepNative
    ? display.scaleFactor
    : Math.min(display.scaleFactor, maxWidth / bounds.width)
  const targetWidth = Math.max(1, Math.ceil(display.bounds.width * density))
  const targetHeight = Math.max(
    1,
    Math.round((targetWidth * display.bounds.height) / display.bounds.width),
  )
  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: targetWidth, height: targetHeight },
    })
  } catch (error) {
    throw new Error(
      __t('errors.electron', 'SCREEN_CAPTURE_FAILED: 系统截图接口出错：{0}', [
        error instanceof Error ? error.message : String(error),
      ]),
    )
  }

  if (sources.length === 0)
    throw new Error(
      __t(
        'errors.electron',
        'SCREEN_CAPTURE_DENIED: 系统没有提供可截取的屏幕，可能是截图权限被拒、正处于锁屏或管理员确认界面，或远程桌面已断开',
      ),
    )

  const primary = sources.find((source) => String(source.display_id) === String(display.id))
  if (!primary)
    throw new Error(
      __t('errors.electron', 'SCREEN_CAPTURE_SOURCE_MISSING: 没有找到目标显示器的截图源'),
    )
  let thumbnail = primary.thumbnail
  if (options.bounds) {
    const size = thumbnail.getSize()
    const displayBounds = display.bounds
    const pixels = screenshotPixelRect(
      {
        x: ((bounds.x - displayBounds.x) * size.width) / displayBounds.width,
        y: ((bounds.y - displayBounds.y) * size.height) / displayBounds.height,
        width: (bounds.width * size.width) / displayBounds.width,
        height: (bounds.height * size.height) / displayBounds.height,
      },
      size,
    )
    // 坐标原点与实际裁切像素一致，避免小数舍入造成点击偏移。
    bounds = {
      x: displayBounds.x + (pixels.x * displayBounds.width) / size.width,
      y: displayBounds.y + (pixels.y * displayBounds.height) / size.height,
      width: (pixels.width * displayBounds.width) / size.width,
      height: (pixels.height * displayBounds.height) / size.height,
    }
    thumbnail = thumbnail.crop(pixels)
  }
  return finishScreenshot(thumbnail, { display, bounds }, maxWidth, options)
}

/**
 * 截到画面后的统一收尾：限制输出宽度、生成指纹与图片编码、附带原始画面（keepNative）。
 * 屏幕裁剪与窗口自身截图（desktopWindowCapture.ts）共用。`bounds` 为画面覆盖的桌面 DIP 矩形。
 */
export function finishScreenshot(
  image: Electron.NativeImage,
  source: { display: Electron.Display; bounds: DesktopRect },
  maxWidth: number,
  options: Pick<CaptureOptions, 'encode' | 'keepNative' | 'quality' | 'scope'> = {},
): DetailedScreenshot {
  let thumbnail = image
  const native = options.keepNative ? thumbnail : undefined
  if (thumbnail.getSize().width > maxWidth)
    thumbnail = thumbnail.resize({ width: maxWidth, quality: 'best' })
  const size = thumbnail.getSize()
  if (size.width <= 0 || size.height <= 0 || thumbnail.isEmpty())
    throw new Error(
      __t('errors.electron', 'SCREEN_CAPTURE_EMPTY: 截图结果为空，可能是截图权限被拒或画面受保护'),
    )
  const grid = fingerprintSize(size.width, size.height)
  const small = thumbnail.resize({ ...grid, quality: 'good' })
  const smallSize = small.getSize()
  const { display } = source
  const encoded =
    options.encode === false ? undefined : encodeImage(thumbnail, options.quality, options.scope)

  return {
    fingerprint: bitmapFingerprint(small.toBitmap(), smallSize.width, smallSize.height),
    ...(native ? { native } : {}),
    image: thumbnail,
    dataUrl: encoded?.dataUrl ?? '',
    ...(encoded ? { imageFormat: encoded.format, imageBytes: encoded.bytes } : {}),
    width: size.width,
    height: size.height,
    displayId: String(display.id),
    bounds: source.bounds,
    workArea: { ...display.workArea },
    scaleFactor: display.scaleFactor,
    timestamp: Date.now(),
  }
}
