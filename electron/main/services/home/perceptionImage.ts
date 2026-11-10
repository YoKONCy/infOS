import { nativeImage, type NativeImage } from 'electron'
import type { DesktopRect } from '../desktopCoordinates'
import { recognizeImage } from '../desktopOcr'
import { captureWindowFrame } from '../desktopWindowCapture'
import { windowsDesktop } from '../windowsDesktop'
import { perceptionControl } from './perceptionState'
import { filterPerceptionText, sensitiveWindow } from './perceptionFilter'
import type { PerceptionWindow } from './perceptionCoordinator'

/** 识别失败关闭出口。对整行扩大 4 像素遮盖，避免缩放留下字符边缘。 */
export async function redactPerceptionImage(image: NativeImage, physical: DesktopRect, signal?: AbortSignal): Promise<NativeImage | undefined> {
  const generation = perceptionControl.state().generation
  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(6000)])
  try {
    const result = await recognizeImage(image, physical, { signal: boundedSignal })
    if (!result.available || boundedSignal.aborted || generation !== perceptionControl.state().generation) return undefined
    const { width, height } = image.getSize()
    const pixels = image.toBitmap()
    for (const line of result.lines) {
      if (filterPerceptionText(line.text) === line.text) continue
      const left = Math.max(0, Math.floor((line.box.x - physical.x) * width / physical.width) - 4)
      const top = Math.max(0, Math.floor((line.box.y - physical.y) * height / physical.height) - 4)
      const right = Math.min(width, Math.ceil((line.box.x + line.box.width - physical.x) * width / physical.width) + 4)
      const bottom = Math.min(height, Math.ceil((line.box.y + line.box.height - physical.y) * height / physical.height) + 4)
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const offset = (y * width + x) * 4
        pixels[offset] = 0; pixels[offset + 1] = 0; pixels[offset + 2] = 0; pixels[offset + 3] = 255
      }
    }
    return nativeImage.createFromBitmap(pixels, { width, height })
  } catch { return undefined }
}

/**
 * 即时核对身份，只截窗口自身的画面，不允许屏幕裁剪退路，所以被别的窗口挡住也不会截到别的窗口。
 * explicit 用于她明确调用的看屏幕工具和普通盯窗口：不受「带上屏幕图」开关和软暂停约束；
 * 涂黑名单、打码和识别失败不发照常生效。
 */
export async function capturePerceptionImage(windowId: string, signal?: AbortSignal, explicit = false): Promise<{image: NativeImage; physical: DesktopRect; window: PerceptionWindow; method: 'printwindow' | 'wgc'} | undefined> {
  const state = perceptionControl.state()
  if (explicit ? state.settings.hardStopped : state.disabledReasons.some(reason => reason !== 'disabled' && reason !== 'paused') || !state.settings.screenImages) return undefined
  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)])
  try {
    const before = await windowsDesktop.observe(windowId, false, boundedSignal)
    const window = before.window as PerceptionWindow
    if ((!explicit && !window.processGeneration) || sensitiveWindow(window, state.settings) || !before.state || before.state.minimized) return undefined
    const capture = await captureWindowFrame(windowId, boundedSignal)
    if (!capture.frame) return undefined
    const image = await redactPerceptionImage(capture.frame.image, capture.frame.physical, boundedSignal)
    const after = await windowsDesktop.observe(windowId, false, boundedSignal)
    if (!image || !after.state || after.state.minimized || sensitiveWindow(after.window, perceptionControl.state().settings)
      || state.generation !== perceptionControl.state().generation || (after.window as PerceptionWindow).processGeneration !== window.processGeneration
      || JSON.stringify(after.window.bounds) !== JSON.stringify(window.bounds)) return undefined
    return { image, physical: capture.frame.physical, window, method: capture.frame.method }
  } catch { return undefined }
}
