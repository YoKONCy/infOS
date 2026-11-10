/**
 * @file 卡片页面发来的请求：白名单数据读取、打开功能页、标题栏信息，以及每分钟请求限额。
 *       从 desktopCardManager 拆出，便于单独阅读；发送者身份由调用方（IPC 通道）校验。
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 */

import { t as __t } from '../utils/i18n'
import {
  DESKTOP_CARD_LIMITS,
  isDesktopCardDataName,
  type DesktopCardDataName,
  type DesktopCardMeta,
} from '../../../packages/shared/src/desktopCards'
import { isMainPageId } from '../../../packages/shared/src/desktopShell'
import { fail, type DesktopCardsHost } from './desktopCardModel'

export class DesktopCardRequests {
  private readonly requests = new Map<string, number[]>()

  constructor(
    private readonly now: () => number,
    private readonly host: () => DesktopCardsHost | null,
  ) {}

  /** 卡片删除后清掉它的请求记录。 */
  forget(id: string): void {
    this.requests.delete(id)
  }

  /** 每张卡片每分钟最多 30 次请求（数据读取与打开页面）。 */
  private consume(id: string): void {
    const now = this.now()
    const recent = (this.requests.get(id) ?? []).filter((time) => now - time < 60_000)
    if (recent.length >= DESKTOP_CARD_LIMITS.requestsPerMinute) {
      this.requests.set(id, recent)
      fail('DESKTOP_CARD_RATE_LIMITED', '卡片请求过于频繁，请稍后再试')
    }
    recent.push(now)
    this.requests.set(id, recent)
  }

  async data(id: string, name: unknown): Promise<unknown> {
    if (!isDesktopCardDataName(name))
      fail('DESKTOP_CARD_INVALID_DATA', '卡片不能读取该数据：{0}', [String(name)])
    this.consume(id)
    return this.readData(name)
  }

  private async readData(name: DesktopCardDataName): Promise<unknown> {
    if (name === 'time') {
      const date = new Date(this.now())
      return { now: date.toISOString(), timezoneOffset: date.getTimezoneOffset() }
    }
    const host = this.host()
    return {
      mode: host?.themeMode() ?? 'light',
      custom: (await host?.readCustomTheme()) ?? null,
    }
  }

  openPage(id: string, pageId: unknown): void {
    if (!isMainPageId(pageId))
      fail('DESKTOP_CARD_INVALID_PAGE', '页面不存在：{0}', [String(pageId)])
    this.consume(id)
    this.host()?.openPage(pageId)
  }

  /** 标题栏信息与文案（文案由主进程翻译，卡片页面无需 i18n）。 */
  static info(card: DesktopCardMeta) {
    const label = (text: string) => __t('electron.ui.desktopShell', text)
    return {
      name: card.name,
      homeBound: Boolean(card.homeBinding),
      saved: card.saved,
      alwaysOnTop: card.alwaysOnTop,
      labels: {
        save: label('收藏卡片（退出后保留）'),
        unsave: label('取消收藏'),
        pin: label('置顶'),
        close: label('关闭卡片'),
        drag: __t('home.cards', '拖动卡片'),
        error: __t('home.cards', '卡片运行出错'),
        dismiss: __t('home.cards', '隐藏错误'),
        retry: __t('home.cards', '重新加载'),
        unbound: __t('home.cards', '这张卡片尚未绑定对话，请让她重新创建。'),
        failed: __t('home.cards', '卡片通道暂不可用，请稍后重新加载。'),
      },
    }
  }
}
