import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { HomeScope } from '../../../packages/shared/src/home'
import { isNewHomeCardData, type HomeCardData } from '../../../packages/shared/src/homeCardChannel'
import { DESKTOP_CARD_CHANNELS } from '../../../packages/shared/src/desktopCards'
import type { DesktopCards } from '../windows/desktopCardManager'

type Request = <T>(endpoint: string, scope: HomeScope, input: unknown) => Promise<T>

/** 真实交互凭据一次消费；发送节流与卡片归属在主进程再次核对。 */
export class HomeCardBridge {
  private gestures = new WeakMap<WebContents, number>()
  private sent = new Map<string, number[]>()
  private revisions = new WeakMap<WebContents, number>()
  private syncing = new WeakMap<WebContents, Promise<HomeCardData>>()
  private reads = new WeakMap<WebContents, number[]>()

  constructor(
    private cards: Pick<DesktopCards, 'get' | 'idOf' | 'windowOf' | 'openWindows'>,
    private request: Request,
    private origin: () => string,
    private now = Date.now,
  ) {}

  interaction(sender: WebContents): void {
    this.owner(sender)
    this.gestures.set(sender, this.now())
  }

  private owner(sender: WebContents) {
    const id = this.cards.idOf(sender)
    if (!id) throw new Error('DESKTOP_CARD_FORBIDDEN')
    const binding = this.cards.get(id).homeBinding
    if (!binding || binding.origin !== this.origin()) throw new Error('HOME_CARD_UNBOUND')
    return { id, scope: binding.scope }
  }

  async get(sender: WebContents, reconnect = false): Promise<HomeCardData> {
    const running = this.syncing.get(sender)
    if (running) return running
    const { id, scope } = this.owner(sender)
    const origin = this.origin()
    const recent = (this.reads.get(sender) ?? []).filter((time) => this.now() - time < 60_000)
    if (!reconnect && recent.length >= 30) throw new Error('DESKTOP_CARD_RATE_LIMITED')
    if (!reconnect) this.reads.set(sender, [...recent, this.now()])
    const pending = (async () => {
      await this.request('/cards/bind', scope, id)
      if (this.origin() !== origin || this.cards.idOf(sender) !== id)
        throw new Error('HOME_CARD_UNBOUND')
      const row = await this.request<{ revision: number; data: Record<string, unknown> }>(
        '/cards',
        scope,
        { action: 'get', cardId: id },
      )
      if (this.origin() !== origin || this.cards.idOf(sender) !== id)
        throw new Error('HOME_CARD_UNBOUND')
      const value = { cardId: id, revision: row.revision, data: row.data }
      if (!isNewHomeCardData(value, id, -1)) throw new Error('HOME_CARD_INVALID_DATA')
      this.deliver(sender, value)
      return value
    })().finally(() => this.syncing.delete(sender))
    this.syncing.set(sender, pending)
    return pending
  }

  async send(sender: WebContents, input: unknown): Promise<{ messageId: string }> {
    const { id, scope } = this.owner(sender)
    const origin = this.origin()
    const gesture = this.gestures.get(sender)
    this.gestures.delete(sender)
    if (gesture === undefined || this.now() - gesture > 1000)
      throw new Error('DESKTOP_CARD_USER_ACTIVATION_REQUIRED')
    const text = typeof input === 'string' ? input.trim() : ''
    if (!text || text.length > 8000) throw new Error('HOME_CARD_INVALID_MESSAGE')
    const now = this.now()
    const recent = (this.sent.get(id) ?? []).filter((time) => now - time < 60_000)
    if (recent.length >= 6 || (recent.length && now - recent[recent.length - 1]! < 1000))
      throw new Error('DESKTOP_CARD_RATE_LIMITED')
    recent.push(now)
    this.sent.set(id, recent)
    const messageId = randomUUID()
    await this.request('/cards/bind', scope, id)
    if (this.origin() !== origin || this.cards.idOf(sender) !== id)
      throw new Error('HOME_CARD_UNBOUND')
    await this.request('/cards/messages', scope, { cardId: id, text, messageId })
    return { messageId }
  }

  data(value: HomeCardData): void {
    const win = this.cards.windowOf(value.cardId)
    if (!win) return
    try {
      this.owner(win.webContents)
      this.deliver(win.webContents, value)
    } catch {
      // 未绑定及属于其他后端的窗口不接收数据。
    }
  }

  message(value: { cardId: string; messageId: string; sessionId: string }): void {
    const win = this.cards.windowOf(value.cardId)
    if (!win) return
    try {
      const { scope } = this.owner(win.webContents)
      if (scope.sessionId === value.sessionId && typeof value.messageId === 'string')
        win.webContents.send(DESKTOP_CARD_CHANNELS.homeMessage, { messageId: value.messageId })
    } catch {
      // 只向原卡片报告后端已收取，绝不让前端重复入队。
    }
  }

  refresh(): void {
    for (const win of this.cards.openWindows())
      void this.get(win.webContents, true).catch(() => undefined)
  }

  private deliver(sender: WebContents, value: HomeCardData): void {
    if (
      sender.isDestroyed() ||
      !isNewHomeCardData(value, value.cardId, this.revisions.get(sender) ?? -1)
    )
      return
    this.revisions.set(sender, value.revision)
    sender.send(DESKTOP_CARD_CHANNELS.homeData, value)
  }
}
