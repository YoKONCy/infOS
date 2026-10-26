import { t as __t } from '../../lib/i18n'
/**
 * screenVision — 屏幕截图工具
 *
 * 为 Agent 提供视觉感知能力。
 * 通过「截图提供者」抽象层解耦：
 *   - Electron 桌面端: desktopCapturer / IPC 注入
 *   - 其他环境: 可替换为 native addon (screenshot-desktop) 或远程截图服务
 * 截图结果以 base64 data URI 形式返回，reactLoop 提取后转为 image_url 内容块注入 LLM。
 *
 * @module packages/backend/src/tools/screenVision
 */

import type { BuiltinTool } from '../index'
import type { ToolContext } from '../../services/agent/toolRegistry'
import { createLogger } from '../../lib/logger'

const logger = createLogger('ScreenVision')

export interface ScreenshotCoordinateContext {
  observationId?: string
  referenceObservationId?: string
  sourceCoordinateSpace?: 'desktop-dip'
  displayId: string
  coordinateSpace: 'screenshot'
  screenshotWidth: number
  screenshotHeight: number
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

export interface ScreenshotCapture {
  base64: string
  coordinateContext?: ScreenshotCoordinateContext
}

/** 截图提供者接口 */
export interface ScreenshotProvider {
  /** 截取当前屏幕，返回 PNG 与坐标上下文 */
  capture(input?: Record<string, unknown>, context?: ToolContext): Promise<ScreenshotCapture | null>
}

/** 模块引用 */
let _screenshotProvider: ScreenshotProvider | null = null

/** 设置截图提供者 */
export function setScreenshotProvider(provider: ScreenshotProvider | null): void {
  _screenshotProvider = provider
}

// ── take_screenshot 工具 ──

export const takeScreenshotTool: BuiltinTool = {
  name: 'take_screenshot',

  async execute(args, context) {
    if (!_screenshotProvider) {
      return JSON.stringify({
        error: '截图服务未初始化。当前环境可能不支持屏幕截图。',
      })
    }

    const count = Math.min(Math.max(1, (args.count as number) ?? 1), 3)

    try {
      const screenshots: ScreenshotCapture[] = []

      for (let i = 0; i < count; i++) {
        const capture = await _screenshotProvider.capture(args, context)
        if (capture) {
          screenshots.push(capture)
        } else {
          logger.warn(__t('logs.tools', '第 {0} 张截图获取失败', [i + 1]))
        }

        // 多张截图之间间隔 500ms (捕捉动态变化)
        if (i < count - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }

      if (screenshots.length === 0) {
        return JSON.stringify({ error: '截图获取失败，请稍后重试' })
      }

      logger.info(__t('logs.tools', '已获取 {0} 张截图', [screenshots.length]))

      return JSON.stringify({
        success: true,
        observationId: screenshots[0]?.coordinateContext?.observationId,
        screenshots: screenshots.map((capture, i) => ({
          index: i,
          dataUri: `data:image/png;base64,${capture.base64}`,
          ...(capture.coordinateContext ? { coordinateContext: capture.coordinateContext } : {}),
        })),
        message: __t('server.tools', '已获取 {0} 张屏幕截图', [screenshots.length]),
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(__t('logs.tools', '截图失败: {0}', [errMsg]))
      return JSON.stringify({ error: `截图失败: ${errMsg}` })
    }
  },
}
