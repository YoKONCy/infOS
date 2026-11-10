/**
 * @file 持续盯窗口的实际接线：用桥接读窗口状态、按三级退路截图、用 Electron nativeImage 缩放与编码。
 *
 * 只读：不切前台、不占输入席位；被遮挡时截窗口自身画面，最小化时跳过这一帧。
 *
 * @platform WINDOWS
 * @see desktopWatch.ts
 */

import { nativeImage } from 'electron'
import type { DesktopCaller } from './desktopControl'
import { desktopControl } from './desktopControl'
import { encodeImage } from './desktopImageEncode'
import { desktopVisionSettings } from './desktopVisionSettings'
import { DesktopWatch, FRAME_MAX_WIDTH, type WatchFrame } from './desktopWatch'
import { capturePerceptionImage } from './home/perceptionImage'
import { perceptionControl } from './home/perceptionState'
import { windowsDesktop } from './windowsDesktop'
import { fitWatchSize } from './desktopWatchDiff'
import { onDesktopObservationStop } from './desktopObservationLifecycle'
import { t } from '../utils/i18n'

export async function captureWatchFrame(
  windowId: string,
  signal?: AbortSignal,
  expectedPid?: number,
): Promise<WatchFrame | undefined> {
  const info = await windowsDesktop.observe(windowId, false, signal)
  if (expectedPid !== undefined && info.window.pid !== expectedPid)
    throw new Error('DESKTOP_WINDOW_GONE')
  if (info.state?.minimized) return undefined
  if (
    info.window.bounds.width <= 0 ||
    info.window.bounds.height <= 0 ||
    info.window.bounds.width * info.window.bounds.height > 32 * 1024 * 1024
  )
    throw new Error(
      `DESKTOP_WATCH_FRAME_LIMIT: ${t('electron.ui.desktopControl', '画面尺寸超出安全上限。')}`,
    )
  // 盯窗口是她明确发起的，不受「带上屏幕图」开关约束。
  const captured = await capturePerceptionImage(windowId, signal, true)
  if (!captured) return undefined
  let image = captured.image
  const bounded = fitWatchSize(image.getSize().width, image.getSize().height, FRAME_MAX_WIDTH)
  if (bounded.width !== image.getSize().width || bounded.height !== image.getSize().height)
    image = image.resize({ ...bounded, quality: 'best' })
  const size = image.getSize()
  return {
    bitmap: image.toBitmap(),
    pid: info.window.pid,
    width: size.width,
    height: size.height,
    physical: captured.physical,
    at: Date.now(),
  }
}

export const desktopWatch = new DesktopWatch({
  capture: captureWatchFrame,
  shrink: (frame, width) => {
    const image = nativeImage
      .createFromBitmap(Buffer.from(frame.bitmap), { width: frame.width, height: frame.height })
      .resize({ ...fitWatchSize(frame.width, frame.height, width), quality: 'good' })
    const size = image.getSize()
    return { bitmap: image.toBitmap(), ...size }
  },
  encode: (bitmap, width, height, maxWidth) => {
    let image = nativeImage.createFromBitmap(Buffer.from(bitmap), { width, height })
    if (width > maxWidth) image = image.resize({ width: maxWidth, quality: 'best' })
    return {
      dataUri: encodeImage(image, desktopVisionSettings.get().imageQuality, 'region').dataUrl,
      ...image.getSize(),
    }
  },
  available: () => {
    try {
      desktopControl.assertAvailable(undefined, 'observe')
      return true
    } catch {
      return false
    }
  },
})
onDesktopObservationStop((reason) => desktopWatch.stopAll(t('electron.ui.desktopControl', reason)))

/** 盯窗口按「角色 + 会话」区分：同一会话里跨多轮对话持续有效。 */
export function watchOwner(caller: DesktopCaller): string {
  return `${caller.agentId ?? 'system'}:${caller.threadId ?? caller.taskId ?? 'desktop'}`
}

/** take_screenshot 的 watch 参数是否存在（对象）。 */
export function isWatchRequest(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
