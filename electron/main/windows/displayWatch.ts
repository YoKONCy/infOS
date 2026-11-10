/**
 * @file 显示器变化监听：拔掉显示器或分辨率、缩放变化后回调，用来把跑到屏幕外的卡片和面板拉回来。
 *
 * `screen` 模块要等应用就绪后才能使用，因此在 `app.whenReady()` 之后注册；
 * 应用退出（`will-quit`）时自动解绑，也可以用返回的函数提前解绑。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 屏幕外修正
 */

import { app, screen } from 'electron'

const EVENTS = ['display-removed', 'display-metrics-changed'] as const

export function watchDisplayChanges(onChange: () => void): () => void {
  let disposed = false
  let bound = false
  const listener = () => onChange()
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (bound)
      for (const event of EVENTS) screen.removeListener(event as 'display-removed', listener)
  }
  void app.whenReady().then(() => {
    if (disposed) return
    for (const event of EVENTS) screen.on(event as 'display-removed', listener)
    bound = true
  })
  app.once('will-quit', dispose)
  return dispose
}
