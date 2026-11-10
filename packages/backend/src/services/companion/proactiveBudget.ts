import type { PerceptionState, ProactiveSettings } from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'

export type ProactiveKind = 'companion' | 'autonomous' | 'wake' | 'watch'
export type ProactiveLevel = 'low' | 'medium' | 'high'
const levels = { low: {gap: 60, limit: 6}, medium: {gap: 30, limit: 12}, high: {gap: 15, limit: 24} }
interface Reservation {id: string; kind: ProactiveKind; at: number; settled: boolean; spoken: boolean; cancelled?: boolean}
interface Ledger {
  day: string; timeZone: string; used: number; wake: number; watch: number; spoken: number
  lastWake: number; lastSpeech: number; lastInteraction: number; unanswered: number
  reservations: Reservation[]
}

/** 三路共用一个串行事务。先持久占位再调用；取消与沉默不退款，唯一编号防重结算。 */
export class ProactiveBudget {
  private ledger: Ledger = {day: '', timeZone: '', used: 0, wake: 0, watch: 0, spoken: 0, lastWake: 0, lastSpeech: 0, lastInteraction: 0, unanswered: 0, reservations: []}
  private serial: Promise<unknown> = Promise.resolve()
  private typingUntil = 0
  constructor(private readonly config: ConfigRepository, private readonly settings: () => ProactiveSettings, private readonly now = Date.now) {}
  async initialize(legacyUsed: number): Promise<void> {
    const saved = await this.config.getJson<Ledger>('perception.budget')
    if (saved && Array.isArray(saved.reservations) && Number.isFinite(saved.used)) this.ledger = {...this.ledger, ...saved}
    this.rollDay()
    if (!saved) this.ledger.used = legacyUsed
    await this.save()
  }
  private transact<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.serial.catch(() => {}).then(operation)
    this.serial = pending; return pending
  }
  private rollDay(): void {
    const timeZone = this.settings().timeZone
    const day = new Intl.DateTimeFormat('en-CA', {timeZone}).format(new Date(this.now()))
    if (this.ledger.day !== day || this.ledger.timeZone !== timeZone) {
      this.ledger = {...this.ledger, day, timeZone, used: 0, wake: 0, watch: 0, spoken: 0,
        reservations: this.ledger.reservations.filter(item => this.now() - item.at < 3_600_000)}
    }
  }
  private save(): Promise<void> { return this.config.set('perception.budget', JSON.stringify(this.ledger)).then(() => {}) }
  input(active: boolean): void { this.typingUntil = active ? this.now() + 15_000 : 0 }
  activity(): Promise<void> {
    this.ledger.lastInteraction = this.now(); this.ledger.unanswered = 0
    return this.transact(() => this.save())
  }
  /** 打字时谁都不开口；刚聊完 10 分钟不开口只管主动回合，陪看聊一句后不能沉默 10 分钟。 */
  canDeliver(watching = false): boolean { return this.now() >= this.typingUntil && (watching || this.now() - this.ledger.lastInteraction >= 600_000) }
  counts(level: ProactiveLevel = 'medium'): NonNullable<PerceptionState['counts']> {
    this.rollDay()
    return {day: this.ledger.day, timeZone: this.ledger.timeZone, spoken: this.ledger.spoken, perceptionWake: this.ledger.wake, watchAlong: this.ledger.watch,
      wakeLimit: levels[level].limit, budgetUsed: this.ledger.used, budgetLimit: this.settings().maxDailyRuns}
  }
  reserve(id: string, kind: ProactiveKind, level: ProactiveLevel = 'medium', pace = {minIntervalSec: 180, maxPerHour: 20}): Promise<boolean> {
    return this.transact(async () => {
      this.rollDay()
      const watch = kind === 'watch'
      if (this.ledger.reservations.some(item => item.id === id) || !this.canDeliver(watch)) return false
      const now = this.now()
      if (!watch && this.ledger.used >= this.settings().maxDailyRuns) return false
      const hour = Number(new Intl.DateTimeFormat('en', {timeZone: this.settings().timeZone, hour: '2-digit', hourCycle: 'h23'}).format(new Date(now)))
      const night = hour < 7 || hour >= 23 ? 3 : 1
      if (kind === 'wake' && (this.ledger.wake >= levels[level].limit || now - this.ledger.lastWake < levels[level].gap * 60_000 * (this.ledger.unanswered >= 2 ? 2 : 1) * night)) return false
      const recent = this.ledger.reservations.filter(item => item.kind === kind && now - item.at < 3_600_000)
      if (watch && (recent.length >= Math.min(60, Math.max(1, pace.maxPerHour)) || this.tooSoon(recent, now, pace.minIntervalSec))) return false
      const before = structuredClone(this.ledger)
      if (watch) this.ledger.watch++
      else this.ledger.used++
      if (kind === 'wake') { this.ledger.wake++; this.ledger.lastWake = now }
      this.ledger.reservations.push({id, kind, at: now, settled: false, spoken: false})
      this.ledger.reservations = this.ledger.reservations.slice(-3000)
      try { await this.save(); return true } catch (error) { this.ledger = before; throw error }
    })
  }
  /** 只和上一次跟看插话比；被打断的只隔 30 秒。 */
  private tooSoon(recent: Reservation[], now: number, minIntervalSec: number): boolean {
    const last = recent.filter(item => item.kind === 'watch').at(-1)
    if (!last) return false
    return now - last.at < (last.cancelled ? 30 : Math.max(60, minIntervalSec)) * 1000
  }
  settle(id: string, spoken: boolean, cancelled = false): Promise<void> {
    return this.transact(async () => {
      const item = this.ledger.reservations.find(value => value.id === id)
      if (!item || item.settled) return
      item.settled = true; item.spoken = spoken; item.cancelled = cancelled
      if (spoken) { this.ledger.spoken++; this.ledger.unanswered++; this.ledger.lastSpeech = this.now() }
      await this.save()
    })
  }
}
