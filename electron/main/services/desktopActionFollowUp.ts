/**
 * @file 动作前后的衔接：批准后直接执行前的核对、动作后等画面稳定、按原视角回读。从 desktopControl 拆出。
 *
 * - 批准后：不再一律要求重新观察。核对目标窗口没变、把它切回前台（审批框抢走了焦点），
 *   再比对批准前后的画面；只有画面确实变了才要求重新观察（`DESKTOP_APPROVED_REOBSERVE`）。
 * - 动作后：等画面稳定（连续两次差异足够小，上限可配置）再截图，截图沿用动作前的视角（窗口或局部）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md
 */

import { t as __t } from '../utils/i18n'
import { screen } from 'electron'
import type { DesktopWindowInfo } from '@infos/shared'
import { resolveDesktopPoint } from './desktopCoordinates'
import { windowsDesktop } from './windowsDesktop'
import { FRAME_CHANGED_THRESHOLD, frameDifference } from './desktopFrame'
import { waitForStableFrame, type SettleResult } from './desktopSettle'
import { captureObservedImage } from './desktopWindowCapture'
import {
  captureObservation,
  type Observation,
  type ObserveHost,
  type ObserveView,
} from './desktopObserve'
import type { DesktopCaller } from './desktopControl'

/** 采样画面指纹用的截图宽度：只为比较，越小越快。 */
const SAMPLE_WIDTH = 320

/** 按观察的区域与截图方法采样一次画面指纹（窗口自身画面的观察仍截窗口自身）。 */
export async function sampleObservedFrame(observation: Observation): Promise<Uint8Array> {
  const frame = await captureObservedImage({
    windowId: observation.window.windowId,
    displayId: observation.displayId,
    crop: observation.bounds,
    preferWindow: observation.capture !== 'screen',
    maxWidth: SAMPLE_WIDTH,
    encode: false,
  })
  return frame.raw.fingerprint
}

/** 目标窗口已关闭时的稳定错误。 */
export function windowGoneError(): Error {
  return new Error(
    `DESKTOP_WINDOW_GONE: ${__t('electron.ui.desktopControl', '目标窗口已经关闭。请用 get_active_windows 重新找窗口，再观察后操作。')}`,
  )
}

/** 观察时的目标窗口现在的样子；窗口已关闭时抛 DESKTOP_WINDOW_GONE。 */
export async function currentWindow(observation: Observation): Promise<DesktopWindowInfo> {
  const windows = await windowsDesktop.windows()
  const current = windows.find((window) => window.windowId === observation.window.windowId)
  if (!current) throw windowGoneError()
  return current
}

export function sameWindow(left: DesktopWindowInfo, right: DesktopWindowInfo): boolean {
  return left.pid === right.pid && JSON.stringify(left.bounds) === JSON.stringify(right.bounds)
}

const reobserve = (reason: string) =>
  new Error(
    `DESKTOP_APPROVED_REOBSERVE: ${__t('electron.ui.desktopControl', '用户已批准，但{0}，请重新观察后再执行。', [reason])}`,
  )

/**
 * 用户刚在审批框里批准：审批框抢走了焦点，用户点按钮也算一次操作。
 * 目标窗口没变、切回前台成功、画面与观察时一致，就直接执行；否则要求重新观察。
 */
export async function confirmAfterApproval(
  observation: Observation,
  signal?: AbortSignal,
): Promise<void> {
  const current = await currentWindow(observation)
  if (!sameWindow(current, observation.window))
    throw reobserve(__t('electron.ui.desktopControl', '批准期间目标窗口移动或换了程序'))
  if (current.pid !== process.pid)
    await windowsDesktop.request('focus', { windowId: current.windowId }, signal)
  let changed: boolean
  try {
    changed =
      frameDifference(observation.fingerprint, await sampleObservedFrame(observation)) >
      FRAME_CHANGED_THRESHOLD
  } catch {
    changed = true
  }
  if (changed) throw reobserve(__t('electron.ui.desktopControl', '批准期间画面已经变了'))
}

/** 鼠标动作的物理坐标：按观察的截图换算；mouse_up 用当前光标位置。 */
export async function mouseArguments(
  observation: Observation,
  input: Record<string, unknown>,
): Promise<Record<string, number>> {
  const display = { id: observation.displayId, bounds: observation.bounds, scaleFactor: 1 }
  const point = (x: unknown, y: unknown) =>
    resolveDesktopPoint(
      {
        x,
        y,
        coordinateSpace: input.coordinateSpace ?? 'screenshot',
        screenshotWidth: observation.width,
        screenshotHeight: observation.height,
      },
      display,
      (value) => screen.dipToScreenPoint({ x: Math.round(value.x), y: Math.round(value.y) }),
    )
  const start =
    input.action === 'mouse_up'
      ? await windowsDesktop.request<{ x: number; y: number }>('position')
      : point(input.x, input.y)
  if (input.action !== 'drag') return { ...start }
  const end = point(input.x2, input.y2)
  return { ...start, x2: end.x, y2: end.y }
}

/** 动作后的视角：局部放大的观察沿用同一块区域，窗口观察沿用同一个窗口。 */
export function followUpView(observation: Observation): ObserveView {
  return observation.scope === 'region'
    ? {
        scope: 'region',
        windowId: observation.window.windowId,
        displayId: observation.displayId,
        crop: observation.bounds,
        capture: observation.capture,
      }
    : { scope: 'window', windowId: observation.window.windowId, capture: observation.capture }
}

/** 动作后：等画面稳定，再按原视角截图并登记新的观察。 */
export async function settleAndRecapture(
  host: ObserveHost,
  observation: Observation,
  input: Record<string, unknown>,
  caller: DesktopCaller,
): Promise<{ next: Record<string, unknown>; settle: SettleResult }> {
  const settle = await waitForStableFrame({
    sample: () => sampleObservedFrame(observation),
    maxMs: input.settleTimeoutMs as number | undefined,
    signal: caller.signal,
  })
  const options = { includeElements: input.includeElements === true }
  try {
    const next = await captureObservation(host, options, caller, followUpView(observation))
    return { next, settle }
  } catch (error) {
    // 动作关掉或最小化了目标窗口（例如点了关闭按钮）：这是正常结果，改看整屏并说明。
    const message = error instanceof Error ? error.message : String(error)
    if (!/^DESKTOP_WINDOW_(GONE|MINIMIZED):/.test(message)) throw error
    const next = await captureObservation(host, options, caller)
    return {
      next: {
        ...next,
        targetClosed: true,
        notice: [
          __t('electron.ui.desktopControl', '目标窗口在动作后关闭或最小化了，以下是整屏画面。'),
          next.notice,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      settle,
    }
  }
}
