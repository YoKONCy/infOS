/**
 * @file 录入停止快捷键期间的窗口监听：窗口失焦、刷新或销毁时自动结束录入。
 * @platform ELECTRON
 */

import { BrowserWindow, type WebContents } from 'electron'

/** 开始监听；返回解除监听的函数。只有当前聚焦的窗口能录入。 */
export function watchShortcutCapture(owner: WebContents, finish: () => void): () => void {
  const win = BrowserWindow.fromWebContents(owner)
  if (!win?.isFocused()) throw new Error('请在当前窗口录入快捷键')
  owner.once('destroyed', finish)
  owner.once('did-start-loading', finish)
  win.once('blur', finish)
  return () => {
    owner.removeListener('destroyed', finish)
    owner.removeListener('did-start-loading', finish)
    win.removeListener('blur', finish)
  }
}
