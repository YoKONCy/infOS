/**
 * @file 窗口截图三级退路：PrintWindow → Windows.Graphics.Capture → 屏幕区域裁剪，带黑帧检测。
 *
 * - 窗口没被遮挡时直接裁屏幕（最快，和用户看到的完全一致）；
 * - 被遮挡（或参考观察本来就是窗口自身画面）时先用 PrintWindow 截窗口自身的画面，
 *   截出全黑（UWP、WinUI、DirectComposition 常见）再用 WGC，都不行才退回屏幕裁剪并说明会混入上层窗口；
 * - 三级都失败时抛第 0 步的错误码（最小化 → DESKTOP_WINDOW_MINIMIZED 等），并附上前两级各自的原因。
 *
 * 思路移植自 Yu-tao-Li/dsh-computer-use-win（MIT），见 THIRD_PARTY_NOTICES.md。
 *
 * @platform WINDOWS
 * @see .docs/B02_DESKTOP_AUTOMATION.md 截图
 */

import { nativeImage, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesktopWindowState } from '@infos/shared'
import type { DesktopRect } from './desktopCoordinates'
import {
  captureScreenDetailed,
  finishScreenshot,
  type DetailedScreenshot,
} from './desktopAwareness'
import { explainCaptureFailure } from './desktopCaptureFailure'
import type { ScreenshotScope } from './desktopImageEncode'
import { visionCacheDir } from './desktopOcr'
import { ensureVisionHelper } from './windowsVisionHelper'
import { windowsDesktop } from './windowsDesktop'

export type CaptureMethod = 'screen' | 'printwindow' | 'wgc'

/** 黑帧判定：抽样点的三个颜色通道都不超过它。 */
export const BLACK_LEVEL = 10

/** 抽样约 64×64 个点，全部接近纯黑即视为没截到画面（PrintWindow 对 DirectComposition 界面的典型结果）。 */
export function isBlackFrame(bgra: Uint8Array, width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return true
  const stepX = Math.max(1, Math.floor(width / 64))
  const stepY = Math.max(1, Math.floor(height / 64))
  for (let y = 0; y < height; y += stepY)
    for (let x = 0; x < width; x += stepX) {
      const offset = (y * width + x) * 4
      if (
        bgra[offset]! > BLACK_LEVEL ||
        bgra[offset + 1]! > BLACK_LEVEL ||
        bgra[offset + 2]! > BLACK_LEVEL
      )
        return false
    }
  return true
}

/** GDI 绘制的内容在 32 位位图里 alpha 常为 0；统一改为不透明，避免编码成图片后变黑或透明。 */
export function makeOpaque(bgra: Uint8Array): void {
  for (let offset = 3; offset < bgra.length; offset += 4) bgra[offset] = 255
}

export interface WindowFrame {
  image: Electron.NativeImage
  /** 画面覆盖的物理像素矩形。 */
  physical: DesktopRect
  method: 'printwindow' | 'wgc'
}

/** 依次用 PrintWindow、WGC 截窗口自身的画面；都失败时 frame 为空，failures 里是各自的原因。 */
export async function captureWindowFrame(
  windowId: string,
  signal?: AbortSignal,
): Promise<{ frame?: WindowFrame; failures: string[] }> {
  const failures: string[] = []
  const dir = path.join(os.tmpdir(), 'infos-desktop')
  for (const method of ['printwindow', 'wgc'] as const) {
    const file = path.join(dir, `capture-${randomUUID()}.bgra`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const helper = method === 'wgc' ? await ensureVisionHelper(visionCacheDir()) : undefined
      const result = await windowsDesktop.request<{
        width: number
        height: number
        rect: DesktopRect
      }>('capture', { windowId, method, path: file, helper }, signal)
      const pixels = fs.readFileSync(file)
      if (pixels.length < result.width * result.height * 4)
        throw new Error('DESKTOP_CAPTURE_INCOMPLETE: 画面数据不完整')
      if (method === 'printwindow' && isBlackFrame(pixels, result.width, result.height))
        throw new Error('DESKTOP_CAPTURE_BLACK: 截到的是全黑画面')
      makeOpaque(pixels)
      const image = nativeImage.createFromBitmap(pixels, {
        width: result.width,
        height: result.height,
      })
      return { frame: { image, physical: result.rect, method }, failures }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('DESKTOP_CANCELLED') || signal?.aborted) throw error
      // 最小化或窗口已关闭时后面的方法也不会成功，直接交给屏幕裁剪给出第 0 步的错误码。
      failures.push(`${method}: ${message}`)
      if (/^DESKTOP_WINDOW_(MINIMIZED|GONE)/.test(message)) break
    } finally {
      fs.rmSync(file, { force: true })
    }
  }
  return { failures }
}

/** 把窗口画面裁到一块物理像素区域（局部放大）；区域超出画面时取交集。 */
export function cropWindowFrame(frame: WindowFrame, region: DesktopRect): WindowFrame | undefined {
  const size = frame.image.getSize()
  const sx = size.width / frame.physical.width
  const sy = size.height / frame.physical.height
  const left = Math.max(0, Math.floor((region.x - frame.physical.x) * sx))
  const top = Math.max(0, Math.floor((region.y - frame.physical.y) * sy))
  const right = Math.min(size.width, Math.ceil((region.x + region.width - frame.physical.x) * sx))
  const bottom = Math.min(
    size.height,
    Math.ceil((region.y + region.height - frame.physical.y) * sy),
  )
  if (right <= left || bottom <= top) return undefined
  return {
    image: frame.image.crop({ x: left, y: top, width: right - left, height: bottom - top }),
    physical: {
      x: frame.physical.x + left / sx,
      y: frame.physical.y + top / sy,
      width: (right - left) / sx,
      height: (bottom - top) / sy,
    },
    method: frame.method,
  }
}

export interface CapturedImage {
  raw: DetailedScreenshot & { physical?: DesktopRect }
  method: CaptureMethod
  /** 前几级失败的原因（退到下一级时记录）。 */
  failures: string[]
}

export interface CaptureRequest {
  windowId?: string
  displayId: string
  /** 截取区域（桌面 DIP）；整屏观察时为空。 */
  crop?: DesktopRect
  /** 先截窗口自身的画面（被遮挡或沿用窗口画面的观察）。 */
  preferWindow: boolean
  maxWidth: number
  keepNative?: boolean
  encode?: boolean
  quality?: number
  scope?: ScreenshotScope
  state?: DesktopWindowState
  signal?: AbortSignal
}

/** 观察用的截图：按需走窗口自身画面，退回屏幕裁剪；失败时给出稳定错误码和各级原因。 */
export async function captureObservedImage(request: CaptureRequest): Promise<CapturedImage> {
  const options = {
    keepNative: request.keepNative,
    encode: request.encode,
    quality: request.quality,
    scope: request.scope,
  }
  let failures: string[] = []
  if (request.preferWindow && request.windowId) {
    const result = await captureWindowFrame(request.windowId, request.signal)
    failures = result.failures
    const frame =
      result.frame && request.crop
        ? cropWindowFrame(result.frame, screen.dipToScreenRect(null, request.crop))
        : result.frame
    if (frame) {
      const bounds = screen.screenToDipRect(null, frame.physical)
      const display = screen.getDisplayMatching(bounds)
      const raw = finishScreenshot(frame.image, { display, bounds }, request.maxWidth, options)
      return { raw: { ...raw, physical: frame.physical }, method: frame.method, failures }
    }
  }
  try {
    const raw = await captureScreenDetailed(request.maxWidth, {
      displayId: request.displayId,
      bounds: request.crop,
      ...options,
    })
    return { raw, method: 'screen', failures }
  } catch (error) {
    const explained = explainCaptureFailure(error, request.state)
    if (failures.length) explained.message += `（${failures.join('；')}）`
    throw explained
  }
}
