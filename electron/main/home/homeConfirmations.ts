/**
 * 右下角确认通知的状态（不依赖 Electron，便于测试）。
 *
 * 规则（见 .docs/home/authorization.md）：
 * - 只显示后端给的 choices，不自己补「以后允许」；固定规则只有 once / deny 时就只有这两个按钮。
 * - 选 session / permanent 前必须先展示 grantTargets（将被保存的文件夹或应用），用户再点一次「确认保存」才提交。
 * - 过期、已应答、状态不是 pending 的请求不显示；到期自动消失。
 * - 应答只走 POST /confirmations/:id/answer；后端不会自动批准，这里也不会替用户应答。
 */

import type { HomeChoice, HomeConfirmation } from '../../../packages/shared/src/home'
import type { HomeApiCall } from './homeApiCore'

export interface ConfirmationCard {
  id: string
  confirmation: HomeConfirmation
  /** 用户点了 session / permanent，正在核对将保存的范围。 */
  reviewing?: Exclude<HomeChoice, 'once' | 'deny'>
  busy?: boolean
  error?: string
}

export interface ConfirmationQueueDeps {
  api: HomeApiCall
  now(): number
  /** 状态变化（新增、核对、过期、应答）后通知窗口重绘。 */
  changed(): void
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

const MAX_CARDS = 5

export class ConfirmationQueue {
  private readonly cards = new Map<string, ConfirmationCard>()
  private readonly timers = new Map<string, unknown>()

  constructor(private readonly deps: ConfirmationQueueDeps) {}

  list(): ConfirmationCard[] {
    return [...this.cards.values()].sort(
      (a, b) => a.confirmation.createdAt - b.confirmation.createdAt,
    )
  }

  /** SSE confirmation 事件或重新拉取得到的待确认请求。 */
  upsert(confirmation: HomeConfirmation): void {
    if (!valid(confirmation)) return
    if (confirmation.status !== 'pending' || confirmation.expiresAt <= this.deps.now()) {
      this.remove(confirmation.id)
      this.deps.changed()
      return
    }
    const existing = this.cards.get(confirmation.id)
    // 同一请求的新版本（revision 不同）要重新核对，不能沿用旧的「正在核对」。
    const keep = existing && existing.confirmation.revision === confirmation.revision
    this.cards.set(confirmation.id, {
      id: confirmation.id,
      confirmation,
      ...(keep ? { reviewing: existing.reviewing } : {}),
    })
    this.schedule(confirmation)
    while (this.cards.size > MAX_CARDS) this.remove(this.list()[0]!.id)
    this.deps.changed()
  }

  /** 断线重连或启动后：用后端当前的待确认列表替换本地状态。 */
  async refresh(): Promise<void> {
    const pending = await this.deps.api<HomeConfirmation[]>('GET', '/confirmations')
    const ids = new Set(pending.map((row) => row.id))
    for (const id of [...this.cards.keys()]) if (!ids.has(id)) this.remove(id)
    for (const row of pending) this.upsert(row)
    this.deps.changed()
  }

  /**
   * 用户点了某个按钮。once / deny 直接提交；session / permanent 先进入核对，
   * 展示 grantTargets，等用户点「确认保存」（confirm=true）才提交。
   */
  async choose(id: string, choice: HomeChoice, confirm = false): Promise<void> {
    const card = this.cards.get(id)
    if (!card || card.busy) return
    if (!card.confirmation.choices.includes(choice)) throw new Error('HOME_CHOICE_NOT_OFFERED')
    if (card.confirmation.expiresAt <= this.deps.now()) {
      this.remove(id)
      this.deps.changed()
      return
    }
    if (
      (choice === 'session' || choice === 'permanent') &&
      !(confirm && card.reviewing === choice)
    ) {
      card.reviewing = choice
      card.error = undefined
      this.deps.changed()
      return
    }
    card.busy = true
    card.error = undefined
    this.deps.changed()
    try {
      await this.deps.api('POST', `/confirmations/${encodeURIComponent(id)}/answer`, { choice })
      this.remove(id)
      // 「这个应用以后都允许 / 这次会话都允许」：应用一并合并进本会话的声明（只增不减）。
      const { app } = card.confirmation.intent
      if (app && (choice === 'session' || choice === 'permanent'))
        await this.deps
          .api('POST', '/declarations', {
            scope: { agentId: card.confirmation.agentId, sessionId: card.confirmation.sessionId },
            input: { paths: [], apps: [app], mode: 'merge' },
          })
          .catch(() => undefined)
    } catch (error) {
      card.busy = false
      card.error = error instanceof Error ? error.message : String(error)
      // 后端说已过期或不存在：请求已经作废，直接收起。
      if (/HOME_EXPIRED|HOME_NOT_FOUND|NOT_FOUND/.test(card.error)) this.remove(id)
    }
    this.deps.changed()
  }

  /** 核对 grantTargets 时点「返回」。 */
  back(id: string): void {
    const card = this.cards.get(id)
    if (!card) return
    card.reviewing = undefined
    this.deps.changed()
  }

  clear(): void {
    for (const id of [...this.cards.keys()]) this.remove(id)
    this.deps.changed()
  }

  private schedule(confirmation: HomeConfirmation): void {
    const old = this.timers.get(confirmation.id)
    if (old !== undefined) this.deps.clearTimer(old)
    this.timers.set(
      confirmation.id,
      this.deps.setTimer(
        () => {
          this.remove(confirmation.id)
          this.deps.changed()
        },
        Math.max(0, confirmation.expiresAt - this.deps.now()),
      ),
    )
  }

  private remove(id: string): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) this.deps.clearTimer(timer)
    this.timers.delete(id)
    this.cards.delete(id)
  }
}

const CHOICES = new Set<HomeChoice>(['once', 'session', 'permanent', 'deny'])

/** SSE 数据来自网络：结构不完整的请求一律丢弃，宁可不显示也不显示错的按钮。 */
function valid(value: HomeConfirmation): boolean {
  return (
    !!value &&
    typeof value.id === 'string' &&
    !!value.id &&
    typeof value.expiresAt === 'number' &&
    typeof value.createdAt === 'number' &&
    !!value.intent &&
    typeof value.intent.action === 'string' &&
    Array.isArray(value.intent.paths) &&
    Array.isArray(value.reasons) &&
    Array.isArray(value.choices) &&
    value.choices.length > 0 &&
    value.choices.every((choice) => CHOICES.has(choice)) &&
    Array.isArray(value.grantTargets)
  )
}
