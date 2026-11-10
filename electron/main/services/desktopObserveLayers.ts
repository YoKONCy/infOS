/**
 * @file 观察结果里的文字与界面层：UIA 界面结构（带文字）与 OCR 文字合成带编号的元素图；
 * UIA 读到的太少时自动补 OCR；可选在截图上叠加编号。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 元素图
 */

import { t as __t } from '../utils/i18n'
import { nativeImage } from 'electron'
import type { DesktopElementInfo, DesktopTextInfo } from '@infos/shared'
import type { CoordinateMapping } from './desktopCoordinateMapping'
import { recognizeImage, type OcrOutcome } from './desktopOcr'
import { isSparse, uiLines } from './desktopUiText'
import { buildElementMap, formatElementMap, type ElementMapEntry } from './desktopElementMap'
import { annotateBitmap } from './desktopAnnotate'
import { encodeImage, type ScreenshotScope } from './desktopImageEncode'

export interface LayerInput {
  /** 要求读界面结构（includeElements）。 */
  includeElements: boolean
  /** 要求识别文字（ocr）。 */
  ocr: boolean
  elements: DesktopElementInfo[]
  texts: DesktopTextInfo[]
  /** 桥接因上限提前结束遍历。 */
  truncated?: boolean
  /** 原始清晰度的画面（文字识别用）。 */
  native?: Electron.NativeImage
  mapping: CoordinateMapping
  signal?: AbortSignal
  recognize?: typeof recognizeImage
}

export interface Layers {
  /** 并入观察结果的字段（elementMap、ocr）。 */
  fields: Record<string, unknown>
  /** 元素图条目，登记在观察里供以后按编号操作。 */
  entries: ElementMapEntry[]
}

const text = (source: string) => __t('electron.ui.desktopControl', source)

/** 需要原始清晰度画面的情形：要求识别文字，或读界面结构（读到的太少时要补 OCR）。 */
export function needsNativeImage(input: { includeElements: boolean; ocr: boolean }): boolean {
  return input.ocr || input.includeElements
}

/** 组装元素图与 OCR 状态；OCR 不可用时只说明原因，元素图照常由 UIA 给出。 */
export async function buildLayers(input: LayerInput): Promise<Layers> {
  if (!input.includeElements && !input.ocr) return { fields: {}, entries: [] }
  const lines = input.includeElements ? uiLines(input.elements, input.texts, input.mapping) : []
  const autoOcr = input.includeElements && !input.ocr && isSparse(lines)
  let ocr: OcrOutcome | undefined
  if ((input.ocr || autoOcr) && input.native)
    ocr = await (input.recognize ?? recognizeImage)(input.native, input.mapping.physical, {
      signal: input.signal,
    })
  const map = buildElementMap(lines, ocr?.available ? ocr.lines : [], input.mapping)
  const formatted = formatElementMap(map.entries)
  const notices = [
    ...(autoOcr ? [text('界面结构里读到的文字很少（可能是自绘界面），已自动用 OCR 补上。')] : []),
    ...(ocr && !ocr.available ? [`${text('文字识别不可用：')}${ocr.reason}`] : []),
  ]
  const fields: Record<string, unknown> = {
    elementMap: {
      format: text(
        '每行一个元素：编号 类型(*=可操作) "文字" [x,y,w,h] elementId 支持的操作 = 当前值；坐标为截图坐标，OcrText 为文字识别结果',
      ),
      lines: formatted.text,
      count: map.entries.length,
      ...(formatted.truncated || map.truncated || input.truncated ? { truncated: true } : {}),
      ...(notices.length ? { notice: notices.join('\n') } : {}),
    },
  }
  if (ocr)
    fields.ocr = ocr.available
      ? {
          available: true,
          language: ocr.language,
          lines: ocr.lines.length,
          ...(autoOcr ? { auto: true } : {}),
        }
      : { available: false, reason: ocr.reason }
  return { fields, entries: map.entries }
}

/** 在输出截图上叠加元素编号，重新编码；没有条目时返回 undefined。 */
export function annotatedDataUrl(
  image: Electron.NativeImage,
  entries: ElementMapEntry[],
  quality: number,
  scope: ScreenshotScope,
): string | undefined {
  if (!entries.length) return undefined
  const size = image.getSize()
  const bitmap = Buffer.from(image.toBitmap())
  annotateBitmap({ bitmap, width: size.width, height: size.height }, entries)
  return encodeImage(nativeImage.createFromBitmap(bitmap, size), quality, scope).dataUrl
}
