import { capturePerceptionImage, redactPerceptionImage } from './home/perceptionImage'
import { finishScreenshot } from './desktopAwareness'
import { filterPerceptionText, filterWindow, sensitiveWindow } from './home/perceptionFilter'
import { homeSettings } from './home/homeSettings'
/**
 * @file 桌面观察：截图并登记 observationId，供后续操作引用。从 desktopControl 拆出。
 *
 * 观察有三种视角（`scope`）：
 * - `window`：传了 windowId。先把目标窗口切到前台（infOS 自己的窗口除外），再按窗口区域截图；
 * - `region`：在参考截图上框选局部重新截取（局部放大），沿用参考观察的目标窗口；
 * - `screen`：没传 windowId 的整屏观察，只供查看，不绑定前台窗口，不能被点击、输入引用。
 *
 * 动作后的回读截图沿用动作前的视角（`ObserveView`），不再一律变成整屏。
 * 结果统一附带截图像素、DIP 与物理像素之间的换算（desktopCoordinateMapping.ts）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md
 */

import { t as __t } from '../utils/i18n'
import { randomUUID } from 'node:crypto'
import { screen } from 'electron'
import type { DesktopElementInfo, DesktopWindowInfo } from '@infos/shared'
import { windowsDesktop } from './windowsDesktop'
import { buildCoordinateMapping } from './desktopCoordinateMapping'
import type { DesktopRect } from './desktopCoordinates'
import { elevatedBlock, explainCaptureFailure, windowStateNotices } from './desktopCaptureFailure'
import { captureObservedImage, type CaptureMethod } from './desktopWindowCapture'
import { DEFAULT_MAX_WIDTH } from './desktopImageEncode'
import { desktopVisionSettings } from './desktopVisionSettings'
import { mapScreenshotRegion, screenshotMaxWidth } from './screenshotGeometry'
import { buildObservationResult, observationDrift } from './desktopObservationResult'
import { annotatedDataUrl, buildLayers } from './desktopObserveLayers'
import type { ElementMapEntry } from './desktopElementMap'
import type { DesktopCaller } from './desktopControl'
import { rememberObservation } from './desktopObservationIndex'

export type ObservationScope = 'screen' | 'window' | 'region'

export interface Observation {
  id: string
  owner: string
  epoch: number
  createdAt: number
  scope: ObservationScope
  window: DesktopWindowInfo
  elements: DesktopElementInfo[]
  displayId: string
  geometry: string
  /** 截图区域（桌面 DIP）。 */
  bounds: DesktopRect
  width: number
  height: number
  /** 画面指纹：批准后核对画面是否变了。 */
  fingerprint: Uint8Array
  /** 观察期间画面没有变化，可供点击、输入等注入操作引用；否则只能用于局部放大等只读观察。 */
  actionable: boolean
  /** 不能操作的原因（稳定错误码开头），注入操作引用时原样抛出。 */
  blocked?: string
  /** 截图方法：screen（屏幕裁剪）或窗口自身画面（printwindow / wgc）；局部放大与回读沿用。 */
  capture: CaptureMethod
  /** 带编号的元素图（includeElements / ocr 时）；以后可按编号操作，见 desktopElementMap.resolveElementRef。 */
  elementMap: ElementMapEntry[]
  /** 控件树读到上限被截断：回读「某段字已消失」不能下结论。 */
  elementsTruncated?: boolean
}

/** 动作后回读：沿用动作前的视角。 */
export interface ObserveView {
  scope: 'window' | 'region'
  windowId: string
  displayId?: string
  crop?: DesktopRect
  capture?: CaptureMethod
}

/** desktopControl 提供的观察所需能力。 */
export interface ObserveHost {
  epoch(): number
  geometry(): string
  owner(caller: DesktopCaller): string
  reference(id: unknown, caller: DesktopCaller, purpose: 'view'): Observation
  register(observation: Observation): void
  waitUntilIdle(caller: DesktopCaller): Promise<void>
}

const text = (source: string, args?: unknown[]) => __t('electron.ui.desktopControl', source, args)

/** 显示器布局指纹（编号、范围、缩放）；布局变了，引用旧观察的操作要求重新观察。 */
export function displayGeometry(): string {
  return JSON.stringify(
    screen.getAllDisplays().map((display) => [display.id, display.bounds, display.scaleFactor]),
  )
}

/**
 * 观察前把目标窗口切到前台。infOS 自己的窗口不切（只看）；用户正在打字时不抢焦点；
 * 切换被 Windows 拦下时不报错，返回原因，截图照常进行但不能用于操作。
 */
async function focusTarget(
  host: ObserveHost,
  windowId: string,
  caller: DesktopCaller,
): Promise<string | undefined> {
  const target = await windowsDesktop.request<DesktopWindowInfo>(
    'window',
    { windowId },
    caller.signal,
  )
  if (target.pid === process.pid) return undefined
  try {
    await host.waitUntilIdle(caller)
    await windowsDesktop.request('focus', { windowId }, caller.signal)
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('DESKTOP_USER_BUSY'))
      return `DESKTOP_USER_BUSY: ${text('用户正在操作电脑，没有切换窗口，这张图只供查看。等用户停下后重新观察即可操作。')}`
    if (message.startsWith('DESKTOP_FOCUS_DENIED'))
      return `DESKTOP_FOCUS_DENIED: ${text('Windows 没有允许把目标窗口切到前台（前台锁）。可以请用户点一下目标窗口，或稍后用 activate_window 再试；这张图只供查看。')}`
    throw error
  }
}

export async function captureObservation(
  host: ObserveHost,
  input: Record<string, unknown>,
  caller: DesktopCaller,
  view?: ObserveView,
): Promise<Record<string, unknown>> {
  const epoch = host.epoch()
  const geometry = host.geometry()
  if (input.region !== undefined && !input.observationId)
    throw new Error(
      __t('errors.electron', 'SCREENSHOT_REFERENCE_REQUIRED: 区域截图需要有效的参考截图编号'),
    )
  const reference =
    !view && input.region !== undefined
      ? host.reference(input.observationId, caller, 'view')
      : undefined
  const region = reference
    ? mapScreenshotRegion(input.region, reference, reference.bounds)
    : undefined
  if (
    reference &&
    ((input.windowId !== undefined && input.windowId !== reference.window.windowId) ||
      (input.displayId !== undefined && String(input.displayId) !== reference.displayId))
  )
    throw new Error('DESKTOP_OBSERVATION_STALE: 目标窗口已变化，请重新观察')
  const requestedWindow = typeof input.windowId === 'string' ? input.windowId : undefined
  const scope: ObservationScope = view
    ? view.scope
    : reference
      ? reference.scope === 'screen'
        ? 'screen'
        : 'region'
      : requestedWindow
        ? 'window'
        : 'screen'
  // 不再一律缩到 1280 宽：整屏才缩小，窗口按自身大小，局部放大保持原始清晰度。
  const maxWidth = screenshotMaxWidth(input.maxWidth, DEFAULT_MAX_WIDTH[scope])
  await windowsDesktop.start()
  const windowId = view?.windowId ?? reference?.window.windowId ?? requestedWindow
  let blocked = reference?.blocked
  if (!view && !reference && requestedWindow)
    blocked = await focusTarget(host, requestedWindow, caller)
  const info = await windowsDesktop.observe(windowId, input.includeElements === true, caller.signal)
  // 局部放大时参考窗口已移动：照常截取，结果标注为窗口移动，不中断只读观察。
  const referenceMoved =
    !!reference &&
    (info.window.pid !== reference.window.pid ||
      JSON.stringify(info.window.bounds) !== JSON.stringify(reference.window.bounds))
  const displayId = view?.displayId ?? reference?.displayId ?? input.displayId
  const display =
    displayId != null
      ? screen.getAllDisplays().find((candidate) => String(candidate.id) === String(displayId))
      : screen.getDisplayMatching(screen.screenToDipRect(null, info.window.bounds))
  if (!display)
    throw new Error(__t('errors.electron', 'DESKTOP_DISPLAY_NOT_FOUND: 目标显示器已断开'))
  const crop =
    view?.crop ??
    region ??
    (scope === 'window' ? screen.screenToDipRect(null, info.window.bounds) : undefined)
  const wants = { includeElements: input.includeElements === true, ocr: input.ocr === true }
  // 先过滤完整窗口，再裁出局部；窗口以外的像素不能进入任何观察出口。
  const quality = desktopVisionSettings.get().imageQuality
  const perception = homeSettings.section('perception')
  const unavailable = () => new Error(__t('errors.electron', 'PERCEPTION_IMAGE_UNAVAILABLE: 这张图没能通过本机打码，所以不发。可能是文字识别不可用或超时，或者窗口刚刚变了'))
  if (sensitiveWindow(info.window, perception))
    throw new Error(__t('errors.electron', 'PERCEPTION_SENSITIVE_WINDOW: 这个窗口在涂黑名单里，不能看'))
  if (info.state?.minimized) throw explainCaptureFailure(new Error('DESKTOP_WINDOW_MINIMIZED'), info.state)
  const inherited = view?.capture ?? reference?.capture
  // 整屏观察和在整屏上框选局部没有窗口可截，截完同样过打码；窗口观察只用窗口自身的画面。
  const wholeScreen = scope === 'screen' || (scope === 'region' && inherited === 'screen')
  let image: Electron.NativeImage
  let physical: DesktopRect
  let method: CaptureMethod
  if (wholeScreen) {
    const shot = await captureObservedImage({
      displayId: String(display.id),
      crop,
      preferWindow: false,
      maxWidth,
      keepNative: true,
      encode: false,
      scope,
      state: info.state,
      signal: caller.signal,
    })
    const source = shot.raw.native ?? shot.raw.image
    physical = shot.raw.physical ?? screen.dipToScreenRect(null, shot.raw.bounds)
    const safe = source && (await redactPerceptionImage(source, physical, caller.signal))
    if (!safe) throw unavailable()
    image = safe
    method = 'screen'
  } else {
    const safeFrame = await capturePerceptionImage(info.window.windowId, caller.signal, true)
    if (!safeFrame) throw unavailable()
    image = safeFrame.image
    physical = safeFrame.physical
    method = safeFrame.method
  }
  if (crop && !wholeScreen) {
    const wanted = screen.dipToScreenRect(null, crop)
    const left = Math.max(physical.x, wanted.x), top = Math.max(physical.y, wanted.y)
    const right = Math.min(physical.x + physical.width, wanted.x + wanted.width)
    const bottom = Math.min(physical.y + physical.height, wanted.y + wanted.height)
    if (right <= left || bottom <= top) throw new Error('DESKTOP_OBSERVATION_STALE')
    const size = image.getSize()
    const x = Math.floor((left - physical.x) * size.width / physical.width)
    const y = Math.floor((top - physical.y) * size.height / physical.height)
    image = image.crop({x, y, width: Math.min(size.width - x, Math.max(1, Math.ceil((right-left)*size.width/physical.width))), height: Math.min(size.height-y, Math.max(1, Math.ceil((bottom-top)*size.height/physical.height)))})
    physical = {x: left, y: top, width: right-left, height: bottom-top}
  }
  const captured = { method, failures: [] as string[], raw: {
    ...finishScreenshot(image, { display, bounds: screen.screenToDipRect(null, physical) }, maxWidth, { keepNative: true, quality, scope }),
    physical,
  } }
  info.window = filterWindow(info.window, perception)
  info.elements = info.elements.map(element => Object.fromEntries(Object.entries(element).map(([key, value]) => [key, typeof value === 'string' && key !== 'id' ? filterPerceptionText(value) : value])) as typeof element)
  info.texts = info.texts?.map(item => ({ ...item, text: filterPerceptionText(item.text) }))
  const raw = captured.raw
  if (caller.signal?.aborted) throw new Error('DESKTOP_CANCELLED: 桌面操作已取消')
  const current = await windowsDesktop.request<DesktopWindowInfo>(
    'window',
    { windowId: info.window.windowId },
    caller.signal,
  )
  // 观察期间控制权、显示器布局或窗口位置变化时，只读截图照常返回并标注 stale；
  // 仍登记为只读观察（可继续局部放大），但不能被点击、输入等注入操作引用。
  const drift = observationDrift({
    epochChanged: epoch !== host.epoch(),
    geometryChanged: geometry !== host.geometry(),
    windowChanged:
      referenceMoved ||
      current.pid !== info.window.pid ||
      JSON.stringify(current.bounds) !== JSON.stringify(info.window.bounds),
  })
  if (scope !== 'screen') blocked ??= elevatedBlock(info.state)
  if (scope === 'screen')
    blocked ??= `DESKTOP_WINDOW_REQUIRED: ${text('整屏观察只供查看。要操作某个程序，请用 get_active_windows 找到它的 windowId，再用 take_screenshot 传 windowId 观察（系统会先把它切到前台）。')}`
  const mapping = buildCoordinateMapping({
    ...raw,
    physical: raw.physical ?? screen.dipToScreenRect(null, raw.bounds),
  })
  // 文字与界面层：OCR 用原始清晰度的画面；不可用时只说明原因，不影响观察本身。
  const layers = await buildLayers({
    ...wants,
    elements: info.elements,
    texts: info.texts ?? [],
    truncated: info.truncated,
    native: raw.native,
    mapping,
    signal: caller.signal,
  })
  // 复查窗口不能再次枚举控件，否则会清空本次观察的控件引用。
  const observation: Observation = {
    id: randomUUID(),
    owner: host.owner(caller),
    epoch,
    createdAt: Date.now(),
    scope,
    window: info.window,
    elements: info.elements,
    displayId: raw.displayId,
    geometry,
    bounds: raw.bounds,
    width: raw.width,
    height: raw.height,
    fingerprint: raw.fingerprint,
    actionable: !drift && !blocked,
    ...(blocked ? { blocked } : {}),
    capture: captured.method,
    elementMap: layers.entries,
    ...(info.truncated ? { elementsTruncated: true } : {}),
  }
  host.register(observation)
  rememberObservation(observation)
  const {
    fingerprint: _fingerprint,
    native: _native,
    physical: _physical,
    image: _image,
    imageFormat: _format,
    imageBytes: _bytes,
    ...screenshot
  } = raw
  const notices = [
    ...windowStateNotices(info.state, captured.method),
    ...(blocked ? [blocked.replace(/^[A-Z_]+: /, '')] : []),
  ]
  // 可选：在截图上叠加元素编号（与元素图的编号一致）。
  const annotated =
    input.annotate === true && raw.image
      ? annotatedDataUrl(raw.image, layers.entries, quality, scope)
      : undefined
  if (annotated) screenshot.dataUrl = annotated
  const result = buildObservationResult({
    observationId: observation.id,
    referenceObservationId: reference?.id,
    drift,
    raw: screenshot,
    window: drift ? current : info.window,
    scope,
    mapping,
    blocked,
    notices,
    ...(info.state ? { state: info.state } : {}),
    layers: {
      capture: {
        method: captured.method,
        ...(raw.imageFormat ? { format: raw.imageFormat, bytes: raw.imageBytes } : {}),
        ...(captured.failures.length ? { fallbacks: captured.failures } : {}),
      },
      ...layers.fields,
    },
  })
  if (drift || blocked) return result
  return {
    ...result,
    message: text('已观察桌面。操作时引用 observationId；坐标以本次截图为准。'),
  }
}
