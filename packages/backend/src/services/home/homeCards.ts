import { randomUUID } from 'node:crypto'
import type { HomeScope } from '@infos/shared'
import type { HomeRepository } from '../../repositories/home.repo'
import type { HomeActivityService } from './homeActivity'
import { HomeError } from './homeErrors'

export interface HomeCard extends HomeScope {
  id: string
  revision: number
  data: Record<string, unknown>
}
export interface CardMessage extends HomeScope {
  id: string
  cardId: string
  text: string
  createdAt: number
  state: 'queued' | 'delivered'
  deliveredAt?: number
  routedAt?: number
}
function validateData(data: Record<string, unknown>) {
  const visit = (value: unknown, depth: number) => {
    if (depth > 12) throw new HomeError('HOME_LIMIT')
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          throw new HomeError('HOME_INVALID')
        visit(child, depth + 1)
      }
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 64 * 1024) throw new HomeError('HOME_LIMIT')
  visit(data, 0)
}
export class HomeCardService {
  private delivery?: (message: CardMessage) => Promise<void>
  private routing = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  constructor(
    private repo: HomeRepository,
    private activity: HomeActivityService,
    private now = Date.now,
  ) {}
  /** 绑定只能由可信主进程提交，卡片脚本不能自行选择会话或认领其他卡片。 */
  bind(scope: HomeScope, cardId: string) {
    const current = this.repo.get<HomeCard>('card', cardId)
    if (current && (current.agentId !== scope.agentId || current.sessionId !== scope.sessionId))
      throw new HomeError('HOME_CONFLICT')
    const row: HomeCard = current ?? { ...scope, id: cardId, revision: 0, data: {} }
    this.repo.put('card', row)
    return row
  }
  get(scope: HomeScope, id: string) {
    const row = this.repo.get<HomeCard>('card', id)
    if (!row || row.agentId !== scope.agentId || row.sessionId !== scope.sessionId)
      throw new HomeError('HOME_NOT_FOUND')
    return row
  }
  send(scope: HomeScope, cardId: string, text: string, id: string = randomUUID()) {
    this.get(scope, cardId)
    if (!text.trim() || text.length > 8000) throw new HomeError('HOME_INVALID')
    const existing = this.repo.get<CardMessage>('card-message', id)
    if (existing) {
      if (
        existing.agentId !== scope.agentId ||
        existing.sessionId !== scope.sessionId ||
        existing.cardId !== cardId ||
        existing.text !== text
      )
        throw new HomeError('HOME_CONFLICT')
      return existing
    }
    if (
      this.repo
        .list<CardMessage>('card-message', scope.agentId, scope.sessionId)
        .filter((row) => row.state === 'queued').length >= 100
    )
      throw new HomeError('HOME_LIMIT')
    const message: CardMessage = {
      ...scope,
      id,
      cardId,
      text,
      createdAt: this.now(),
      state: 'queued',
    }
    this.repo.put('card-message', message, message.createdAt)
    this.activity.emit({
      type: 'card-message',
      data: { cardId, messageId: message.id, sessionId: scope.sessionId },
    })
    return message
  }
  /** 与持久会话队列共用消息 ID，崩溃重试不会多发一条用户消息。 */
  setDelivery(delivery: (message: CardMessage) => Promise<void>) {
    this.delivery = delivery
    const pump = () => {
      for (const row of this.repo
        .list<CardMessage>('card-message')
        .filter((item) => !item.routedAt)
        .slice(0, 100))
        void this.route(row).catch(() => {})
    }
    this.timer = setInterval(pump, 5000)
    this.timer.unref?.()
    pump()
    return () => {
      clearInterval(this.timer)
      this.delivery = undefined
    }
  }
  async route(message: CardMessage) {
    if (!this.delivery || message.routedAt || this.routing.has(message.id)) return
    this.routing.add(message.id)
    try {
      await this.delivery(message)
      const current = this.repo.get<CardMessage>('card-message', message.id)
      if (current) this.repo.put('card-message', { ...current, routedAt: this.now() })
    } finally {
      this.routing.delete(message.id)
    }
  }
  messages(scope: HomeScope) {
    return this.repo
      .list<CardMessage>('card-message', scope.agentId, scope.sessionId)
      .filter((row) => row.state === 'queued')
  }
  acknowledge(scope: HomeScope, id: string) {
    const row = this.repo.get<CardMessage>('card-message', id)
    if (!row || row.agentId !== scope.agentId || row.sessionId !== scope.sessionId)
      throw new HomeError('HOME_NOT_FOUND')
    this.repo.put('card-message', { ...row, state: 'delivered', deliveredAt: this.now() })
  }
  patch(scope: HomeScope, cardId: string, revision: number, patch: Record<string, unknown>) {
    const current = this.get(scope, cardId)
    if (current.revision !== revision)
      throw new HomeError('HOME_CONFLICT', { revision: current.revision })
    validateData(patch)
    const data = { ...current.data, ...patch }
    validateData(data)
    const row = { ...current, data, revision: current.revision + 1 }
    this.repo.put('card', row)
    this.activity.emit({ type: 'card-data', data: { cardId, revision: row.revision, data } })
    return row
  }
}
