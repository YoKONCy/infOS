import { t as __t } from '../utils/i18n'
import type { DesktopElementInfo, DesktopWindowInfo, DesktopWindowState } from '@infos/shared'
import type { ScreenshotResult } from './desktopAwareness'
import type { CoordinateMapping } from './desktopCoordinateMapping'

/** 观察期间画面可能变化的原因；只读截图照常返回，但不登记为可供注入操作引用的观察。 */
export type ObservationDrift = 'control' | 'geometry' | 'window'

export interface ObservationDriftInput {
  epochChanged: boolean
  geometryChanged: boolean
  windowChanged: boolean
}

/** 按优先级给出漂移原因：控制权变化 > 显示器布局变化 > 窗口移动；没有变化返回 undefined。 */
export function observationDrift(input: ObservationDriftInput): ObservationDrift | undefined {
  if (input.epochChanged) return 'control'
  if (input.geometryChanged) return 'geometry'
  if (input.windowChanged) return 'window'
  return undefined
}

function driftNotice(drift: ObservationDrift): string {
  if (drift === 'control')
    return __t(
      'electron.ui.desktopControl',
      '截图期间检测到用户操作或控制权变化，画面可能已经变化。本次截图仅供查看；如需点击或输入，请重新观察。',
    )
  if (drift === 'geometry')
    return __t(
      'electron.ui.desktopControl',
      '截图期间显示器布局发生变化，画面可能已经变化。本次截图仅供查看；如需点击或输入，请重新观察。',
    )
  return __t(
    'electron.ui.desktopControl',
    '截图期间目标窗口发生移动，画面可能已经变化。本次截图仅供查看；如需点击或输入，请重新观察。',
  )
}

export interface ObservationResultInput {
  /** 本次观察编号；有漂移时仍返回，但只能用于局部放大等只读观察。 */
  observationId?: string
  referenceObservationId?: string
  drift?: ObservationDrift
  raw: ScreenshotResult
  window?: DesktopWindowInfo
  elements?: DesktopElementInfo[]
  /** 观察视角：screen（整屏，只供查看）/ window / region。 */
  scope?: 'screen' | 'window' | 'region'
  /** 截图像素、DIP 与物理像素之间的换算。 */
  mapping?: CoordinateMapping
  /** 不能用于操作的原因（稳定错误码开头）；有值时 actionable 为 false。 */
  blocked?: string
  /** 其他提示（例如窗口被遮挡）。 */
  notices?: string[]
  state?: DesktopWindowState
  /** 附加的文字与界面层（OCR 文字层、元素图等），原样并入结果。 */
  layers?: Record<string, unknown>
}

/**
 * 组装只读观察结果。结构化字段供后续扩展（OCR 文字层、UIA 界面结构可并列加入）：
 * - `observation`：编号、是否可供注入操作引用（actionable）、观察时间、目标窗口与画面是否在观察期间变化；
 * - 漂移时附带 stale / staleReason / notice，画面照常返回，elements 不返回（控件位置可能已失效）。
 */
export function buildObservationResult(input: ObservationResultInput): Record<string, unknown> {
  const { raw, drift, observationId } = input
  const notices = [
    ...(drift
      ? [
          observationId
            ? `${driftNotice(drift)}${__t('electron.ui.desktopControl', '可以用本次 observationId 继续局部放大。')}`
            : driftNotice(drift),
        ]
      : []),
    ...(input.notices ?? []),
  ]
  return {
    success: true,
    ...(observationId ? { observationId } : {}),
    observation: {
      ...(observationId ? { id: observationId } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      actionable: !drift && !input.blocked,
      ...(input.blocked ? { blockedCode: input.blocked.split(':')[0] } : {}),
      ...(input.state ? { windowState: input.state } : {}),
      observedAt: new Date(raw.timestamp || Date.now()).toISOString(),
      changedDuringObservation: !!drift,
      ...(drift ? { changeReason: drift } : {}),
      ...(input.window
        ? { windowId: input.window.windowId, windowBounds: input.window.bounds }
        : {}),
    },
    ...(drift ? { stale: true, staleReason: drift } : {}),
    ...(input.window ? { window: input.window } : {}),
    ...(input.elements && !drift ? { elements: input.elements } : {}),
    ...(input.layers ?? {}),
    screenshots: [
      {
        index: 0,
        dataUri: raw.dataUrl,
        coordinateContext: {
          ...(observationId ? { observationId } : {}),
          ...(input.referenceObservationId
            ? { referenceObservationId: input.referenceObservationId }
            : {}),
          displayId: raw.displayId,
          coordinateSpace: 'screenshot',
          sourceCoordinateSpace: 'desktop-dip',
          screenshotWidth: raw.width,
          screenshotHeight: raw.height,
          bounds: raw.bounds,
          workArea: raw.workArea,
          scaleFactor: raw.scaleFactor,
          ...(input.mapping ? { mapping: input.mapping } : {}),
        },
      },
    ],
    ...(notices.length ? { notice: notices.join('\n') } : {}),
  }
}
