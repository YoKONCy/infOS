/** 陪看时钟由画面或声音活动推进，发言使用滚动小时配额和最小间隔。 */
export interface CompanionPace {
  minIntervalSec: number
  maxPerHour: number
  pauseAfterSec: number
}

export const DEFAULT_LATENCY_MS = 30_000
const HOUR_MS = 3_600_000

export interface InterjectDecision {
  allowed: boolean
  reason?: 'paused' | 'interval' | 'hourly'
  nextInSec?: number
  usedThisHour: number
}

export class CompanionClock {
  private observedAt: number
  private advancedAt: number
  private elapsedMs = 0
  private paused = false
  private deliveredAt: number[] = []
  private deliveryEstimate: number | undefined

  constructor(private pace: CompanionPace, startedAt: number) {
    this.observedAt = startedAt
    this.advancedAt = startedAt
  }

  setPace(pace: CompanionPace): void {
    this.pace = pace
  }

  tick(now: number): void {
    if (!Number.isFinite(now) || now <= this.advancedAt) return
    const activeUntil = this.observedAt + this.pace.pauseAfterSec * 1000
    if (!this.paused) {
      this.elapsedMs += Math.max(0, Math.min(now, activeUntil) - this.advancedAt)
      this.paused = now >= activeUntil
    }
    this.advancedAt = now
  }

  activity(at: number): void {
    if (!Number.isFinite(at) || at < this.observedAt) return
    this.tick(at)
    this.observedAt = at
    this.paused = false
  }

  pause(now: number): void {
    this.tick(now)
    this.paused = true
  }

  isPlaying(now: number): boolean {
    this.tick(now)
    return !this.paused
  }

  mediaSec(now: number): number {
    this.tick(now)
    return Math.round(this.elapsedMs / 1000)
  }

  canInterject(now: number): InterjectDecision {
    this.deliveredAt = this.deliveredAt.filter((at) => at > now - HOUR_MS)
    const usedThisHour = this.deliveredAt.length
    if (!this.isPlaying(now)) return { allowed: false, reason: 'paused', usedThisHour }
    const last = this.deliveredAt.at(-1)
    const intervalEnds = last === undefined ? now : last + this.pace.minIntervalSec * 1000
    if (intervalEnds > now) return {
      allowed: false, reason: 'interval', usedThisHour,
      nextInSec: Math.ceil((intervalEnds - now) / 1000),
    }
    if (usedThisHour >= this.pace.maxPerHour) return {
      allowed: false, reason: 'hourly', usedThisHour,
      nextInSec: Math.max(1, Math.ceil(((this.deliveredAt[0] ?? now) + HOUR_MS - now) / 1000)),
    }
    return { allowed: true, usedThisHour }
  }

  recordInterjection(at: number): void {
    if (Number.isFinite(at)) this.deliveredAt.push(at)
  }

  /** 指数平滑只描述本机生成延迟，单次异常的权重受限。 */
  recordLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const sample = Math.min(ms, 120_000)
    this.deliveryEstimate = this.deliveryEstimate === undefined
      ? sample : this.deliveryEstimate * 0.75 + sample * 0.25
  }

  latencyMs(): number {
    return Math.round(this.deliveryEstimate ?? DEFAULT_LATENCY_MS)
  }

  describe(now: number): Record<string, unknown> {
    const playing = this.isPlaying(now)
    const watchedSec = this.mediaSec(now)
    const replyLatencySec = Math.round(this.latencyMs() / 1000)
    return {
      state: playing ? 'playing' : 'paused', watchedSec, replyLatencySec,
      ...(playing ? { replyLandsAtSec: watchedSec + replyLatencySec } : {}),
    }
  }
}
