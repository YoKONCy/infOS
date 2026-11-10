export interface PerceptionPermitInput {
  sequence: number
  generation: number
  expiresAt: number
  hardStopped: boolean
  companionAllowed: boolean
}

/** 首次桌面连接前只遵守持久硬停止；陪伴许可失联后到期，自主行动不依赖租约。 */
export class PerceptionPermit {
  private sequence = 0
  private until = 0
  private seen = false
  private hardStopped = false
  private generation?: number
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly revoked: (all: boolean) => void, private readonly now: () => number = Date.now) {}
  restore(hardStopped: boolean): void { this.hardStopped = hardStopped }
  get stopped(): boolean { return this.hardStopped }
  get allowed(): boolean { return !this.hardStopped && (!this.seen || this.until > this.now()) }
  allows(mode: string): boolean { return mode === 'autonomous' ? !this.hardStopped : this.allowed }
  update(input: PerceptionPermitInput): boolean {
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= this.sequence) return false
    this.sequence = input.sequence
    this.seen = true
    const changed = this.generation !== undefined && this.generation !== input.generation
    this.generation = input.generation
    this.hardStopped = input.hardStopped
    clearTimeout(this.timer)
    this.until = input.companionAllowed && !input.hardStopped ? Math.min(input.expiresAt, this.now() + 15_000) : 0
    if (this.hardStopped) this.revoked(true)
    else if (!this.allowed || changed) this.revoked(false)
    if (this.allowed) {
      this.timer = setTimeout(() => { this.until = 0; this.revoked(false) }, this.until - this.now())
      this.timer.unref?.()
    }
    return true
  }
  dispose(): void { clearTimeout(this.timer) }
}
