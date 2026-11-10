/**
 * @file 截不到图、操作不了时说清原因：窗口最小化、被遮挡、权限更高、截图权限被拒等。
 *
 * 原来截图失败一律只说「无法获取屏幕内容」，角色不知道该怎么办。这里把截图接口的稳定错误码
 * （见 desktopAwareness.captureScreenDetailed）与目标窗口状态（C# `State`）合在一起，
 * 给出稳定错误码 + 中文原因 + 下一步建议。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 错误码
 */

import { t as __t } from '../utils/i18n'
import type { DesktopWindowState } from '@infos/shared'

const text = (source: string) => __t('electron.ui.desktopControl', source)

/** 截图失败：目标窗口最小化时改报 `DESKTOP_WINDOW_MINIMIZED`，其余保留截图接口的错误码。 */
export function explainCaptureFailure(error: unknown, state?: DesktopWindowState): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (state?.minimized)
    return new Error(
      `DESKTOP_WINDOW_MINIMIZED: ${text('目标窗口已最小化，截不到它的画面。传 windowId 观察时系统会先把它还原并切到前台；如果切换被拦下，请让用户把窗口还原后再试。')}`,
    )
  if (/^[A-Z_]+:/.test(message)) return error instanceof Error ? error : new Error(message)
  return new Error(`SCREEN_CAPTURE_FAILED: ${message}`)
}

/**
 * 截到了图，但画面可能混入其他窗口时的提示。切到前台后仍可能被置顶窗口（桌宠、置顶卡片等）挡住，
 * 所以只看窗口实际状态。
 */
export function windowStateNotices(
  state: DesktopWindowState | undefined,
  method: 'screen' | 'printwindow' | 'wgc' = 'screen',
): string[] {
  if (!state?.occluded) return []
  if (method !== 'screen')
    return [
      text(
        '目标窗口被其他窗口挡住了一部分；截图是窗口自身的画面，被挡住的部分也截到了。注意：点击被挡住的位置会点到上层窗口上，操作前请先让它露出来。',
      ),
    ]
  return [
    text(
      '目标窗口被其他窗口挡住了一部分，截图里那部分是上层窗口的内容。可以传 windowId 重新观察（会先切到前台），或请用户挪开挡住的窗口。',
    ),
  ]
}

/** 目标程序权限更高时不能操作：模拟输入会被 Windows 静默拦下，结果无法确认。 */
export function elevatedBlock(state: DesktopWindowState | undefined): string | undefined {
  if (!state?.elevated) return undefined
  return `DESKTOP_TARGET_ELEVATED: ${text('目标程序以管理员权限运行，Windows 会拦下 infOS 的模拟点击和输入。可以看；操作需要用户自己来，或以管理员身份运行 infOS。')}`
}
