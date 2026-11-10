/** @platform ELECTRON 卡片事件到桌宠的轻量提示，不触发模型或创建窗口。 */
import type { BrowserWindow } from 'electron'
import type { DesktopCards } from '../windows/desktopCardManager'
import { HOME_PET_CHANNEL, type HomePetPreset } from '../../../packages/shared/src/homePet'
import { getBackendOrigin } from '../services/clientConnection'
import { onHomeEvent } from './homeEvents'

export class HomePetCards {
  private last = new Map<string, number>()
  private revisions = new Map<string, number>()
  constructor(
    private cards: Pick<DesktopCards, 'get'>,
    private pet: () => BrowserWindow | null,
    private origin: () => string,
    private now = Date.now,
  ) {}

  data(value: { cardId: string; revision: number }): void {
    if (typeof value.cardId !== 'string' || !Number.isSafeInteger(value.revision)) return
    const key = `${this.origin()}/${value.cardId}`
    if (value.revision <= (this.revisions.get(key) ?? -1)) return
    this.revisions.set(key, value.revision)
    this.notify(value.cardId, 'notice')
  }

  notify(cardId: string, preset: HomePetPreset): void {
    const win = this.pet()
    if (!win || win.isDestroyed() || !win.isVisible() || win.webContents.isDestroyed()) return
    try {
      const binding = this.cards.get(cardId).homeBinding
      if (!binding || binding.origin !== this.origin()) return
      const now = this.now()
      if (now - (this.last.get(binding.scope.agentId) ?? -Infinity) < 10_000) return
      this.last.set(binding.scope.agentId, now)
      win.webContents.send(HOME_PET_CHANNEL, { agentId: binding.scope.agentId, cardId, preset })
    } catch {
      // 已删除、旧卡片和其他后端的事件不产生提示。
    }
  }
}

let current: HomePetCards | undefined
export function notifyHomePetCard(cardId: string, preset: HomePetPreset): void {
  current?.notify(cardId, preset)
}

export function startHomePetCards(
  cards: Pick<DesktopCards, 'get'>,
  pet: () => BrowserWindow | null,
): () => void {
  const client = new HomePetCards(cards, pet, getBackendOrigin)
  current = client
  const stop = [
    onHomeEvent('card-data', (value) => client.data(value)),
    onHomeEvent('card-message', (value) => client.notify(value.cardId, 'acknowledge')),
  ]
  return () => {
    stop.forEach((cancel) => cancel())
    if (current === client) current = undefined
  }
}
