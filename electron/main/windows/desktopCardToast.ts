/**
 * @file 桌面卡片的桌面通知
 * @description `window.infosCard.toast(message)` 的主进程实现：以卡片名称为标题，发出 infOS 的系统通知。
 *              卡片 HTML 不可信：正文去掉控制字符并限制长度，每张卡片每分钟有次数上限，
 *              不能自定义图标、声音、点击动作或标题，避免冒充系统或其他程序的通知。
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 */

import { Notification } from 'electron'
import { DESKTOP_CARD_LIMITS } from '../../../packages/shared/src/desktopCards'
import { fail } from './desktopCardModel'

// eslint-disable-next-line no-control-regex -- 通知正文去掉不可见控制字符（保留换行）。
const CONTROL_CHARACTERS = /[\x00-\x09\x0b-\x1f\x7f]/g

/** 校验并整理通知正文；不是字符串、为空或超过上限时抛出 DESKTOP_CARD_INVALID_TOAST。 */
export function normalizeCardToast(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(CONTROL_CHARACTERS, ' ').trim() : ''
  if (!text || text.length > DESKTOP_CARD_LIMITS.toastMessage)
    fail('DESKTOP_CARD_INVALID_TOAST', '通知内容为空或超过 {0} 字', [
      DESKTOP_CARD_LIMITS.toastMessage,
    ])
  return text
}

function showSystemNotification(title: string, body: string): void {
  if (!Notification.isSupported()) fail('DESKTOP_CARD_TOAST_UNAVAILABLE', '当前系统不支持桌面通知')
  new Notification({ title, body, silent: true }).show()
}

export class DesktopCardToasts {
  private readonly recent = new Map<string, number[]>()

  constructor(
    private readonly notify: (title: string, body: string) => void = showSystemNotification,
    private readonly now: () => number = Date.now,
  ) {}

  /** 以卡片名称为标题发出通知；超过每分钟上限时抛出 DESKTOP_CARD_RATE_LIMITED。 */
  show(cardId: string, cardName: string, message: unknown): void {
    const body = normalizeCardToast(message)
    const now = this.now()
    const recent = (this.recent.get(cardId) ?? []).filter((time) => now - time < 60_000)
    if (recent.length >= DESKTOP_CARD_LIMITS.toastsPerMinute) {
      this.recent.set(cardId, recent)
      fail('DESKTOP_CARD_RATE_LIMITED', '卡片请求过于频繁，请稍后再试')
    }
    recent.push(now)
    this.recent.set(cardId, recent)
    this.notify(cardName, body)
  }
}

/** 全局单例 */
export const desktopCardToasts = new DesktopCardToasts()
