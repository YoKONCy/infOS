/**
 * @file 「眼睛」的偏好：截图质量、观察有效期、文字识别语言。
 *
 * 存在「桌面与家」的统一配置 `desktop-home.json` 的 vision 分区里（旧的 `desktop-vision.json`
 * 会在第一次读取时并入并删除，见 home/homeSettings.ts）。这里保留原来的读取入口，调用方不用改。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 截图
 */

import type { DesktopHomeVision } from '@infos/shared'
import { homeSettings, type HomeSettingsStore } from './home/homeSettings'
import { HOME_SCHEMA, normalizeSection } from './home/homeSettingsSchema'

export const VISION_SETTING_LIMITS = {
  imageQuality: HOME_SCHEMA.vision.imageQuality,
  observationTtlSec: HOME_SCHEMA.vision.observationTtlSec,
} as const

/** 把任意输入规整成合法设置：缺失或非法的字段用默认值，超出范围的截到边界。 */
export function normalizeVisionSettings(value: unknown): DesktopHomeVision {
  return normalizeSection('vision', value)
}

export class DesktopVisionSettingsStore {
  constructor(private readonly store: HomeSettingsStore = homeSettings) {}

  get(): DesktopHomeVision {
    return this.store.section('vision')
  }

  update(patch: unknown): DesktopHomeVision {
    return this.store.update('vision', patch).vision
  }
}

export const desktopVisionSettings = new DesktopVisionSettingsStore()
