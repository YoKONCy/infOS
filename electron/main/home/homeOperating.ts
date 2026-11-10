/**
 * 「她在操作」标记的显示规则（不依赖 Electron，便于测试）。
 *
 * - 她正在操作别的程序（phase=running）时显示，并写出目标窗口；
 * - 两个动作之间的短暂空闲不收起，空闲超过 LINGER 才收起，避免闪烁；
 * - 暂停、不可用时立刻收起（停止已经生效）。
 */

import type { DesktopControlState } from '../../../packages/shared/src/types/desktopAutomation'

export const OPERATING_LINGER_MS = 8_000

export interface OperatingView {
  visible: boolean
  target?: string
  shortcut: string
}

export class OperatingIndicator {
  private lastRunningAt = Number.NEGATIVE_INFINITY
  private target?: string

  update(state: DesktopControlState, now: number): OperatingView {
    if (state.phase === 'running') {
      this.lastRunningAt = now
      this.target = state.targetTitle || this.target
    } else if (state.phase !== 'idle') {
      this.lastRunningAt = Number.NEGATIVE_INFINITY
      this.target = undefined
    }
    const visible = now - this.lastRunningAt < OPERATING_LINGER_MS
    return {
      visible,
      ...(visible && this.target ? { target: this.target } : {}),
      shortcut: state.stopShortcut,
    }
  }
}
