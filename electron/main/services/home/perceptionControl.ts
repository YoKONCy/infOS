import type { PerceptionAction, PerceptionDisabledReason, PerceptionSettings, PerceptionState } from '@infos/shared'

/** 先撤销代次再执行停止回调；持久化失败时本进程仍保持停止。 */
export class PerceptionControl {
  private generation = Date.now() * 1000
  private emergencyStopped = false
  private readonly reasons = new Set<PerceptionDisabledReason>()
  private readonly listeners = new Set<() => void>()
  private details: Pick<PerceptionState, 'counts' | 'chatHidden'> = { counts: null }

  updateDetails(patch: Partial<typeof this.details>): void { this.details = { ...this.details, ...patch } }
  constructor(
    private readonly read: () => PerceptionSettings,
    private readonly write: (patch: Partial<PerceptionSettings>) => void,
    private readonly now: () => number = Date.now,
  ) {}

  state(): PerceptionState {
    const settings = { ...this.read() }
    settings.hardStopped ||= this.emergencyStopped
    const reasons = new Set(this.reasons)
    if (!settings.enabled) reasons.add('disabled')
    if (settings.hardStopped) reasons.add('hard-stopped')
    if (settings.pausedUntil > this.now()) reasons.add('paused')
    return { generation: this.generation, settings, disabledReasons: [...reasons], collecting: reasons.size === 0, ...this.details }
  }

  onInvalidate(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  invalidate(): void {
    this.generation++
    for (const listener of this.listeners) listener()
  }

  setReason(reason: PerceptionDisabledReason, active: boolean): void {
    if (this.reasons.has(reason) === active) return
    if (active) this.reasons.add(reason)
    else this.reasons.delete(reason)
    this.invalidate()
  }

  action(input: PerceptionAction): PerceptionState {
    if (!input || typeof input !== 'object') throw new Error('PERCEPTION_ACTION_INVALID')
    let patch: Partial<PerceptionSettings>
    switch (input.type) {
      case 'stop-all':
        this.emergencyStopped = true
        this.invalidate()
        patch = { hardStopped: true }
        break
      case 'resume': patch = { hardStopped: false, pausedUntil: 0 }; break
      case 'pause-hour': patch = { pausedUntil: this.now() + 3_600_000 }; break
      case 'set-enabled':
        if (typeof input.enabled !== 'boolean') throw new Error('PERCEPTION_ACTION_INVALID')
        patch = { enabled: input.enabled }; break
      case 'set-switch':
        if (!['windowTitles', 'screenImages', 'sound', 'proactive', 'watchAlong'].includes(input.key) || typeof input.enabled !== 'boolean')
          throw new Error('PERCEPTION_ACTION_INVALID')
        patch = { [input.key]: input.enabled }; break
      default: throw new Error('PERCEPTION_ACTION_INVALID')
    }
    this.write(patch)
    if (input.type === 'resume') this.emergencyStopped = false
    this.invalidate()
    return this.state()
  }
}
